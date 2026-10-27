// PDP 数据层：统一 ProductDetail 模型、mock 画廊、localStorage 缓存与收藏状态。
// 当前阶段用本地 mock 兜底；后续接真实 API 时，保持这里的导出接口不变即可平滑替换。
// 关键模型字段：id / name / price / originalPrice / images[] / skus[] / stock /
//              shippingNote / returnNote / rating / reviewCount。
import { productArtSvg } from '../art.js';
import { PRODUCT_DETAIL_MOCKS } from '../mock/productDetails.js';

const DETAIL_CACHE_KEY = 'maison_pdp_cache_v2';
const FAVORITES_KEY = 'maison_pdp_favorites_v1';
const MAX_CACHED_DETAILS = 8;
const IMAGE_LABELS = ['正面', '细节', '质感'];
const IMAGE_FOCUS = ['50% 50%', '46% 34%', '56% 74%'];

const DEFAULT_SHIPPING = '顺丰包邮 · 付款后 48 小时内发出';
const DEFAULT_RETURN = '7 天无理由退换 · 支持上门取件';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 把程序化商品图转成可供 <img src> 使用的内联资源，避免画廊依赖外部图床。 */
function makeArtImage(product, seed) {
  const svg = productArtSvg({ ...product, id: `${product.id || 'product'}-gallery-${seed}` });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 生成画廊视图。
 * - 有真实主图：用同一主图的三种取景（正面 / 细节 / 质感）做成 mock 画廊；
 * - 无真实主图：用同一类目视觉生成三张程序化静帧。
 * 返回对象供 PDP 使用 object-position，后续换真实 images[] 时可直接传入 { src, alt }。
 */
function buildGallery(product, mock) {
  const labels = mock?.imageLabels?.length ? mock.imageLabels : IMAGE_LABELS;
  const fallbackSrc = makeArtImage(product, 'fallback');
  const views = labels.slice(0, 3);
  if (product.pic) {
    return views.map((label, index) => ({
      src: product.pic,
      alt: `${product.name || '商品'} · ${label}`,
      label,
      focus: IMAGE_FOCUS[index] || '50% 50%',
      fallbackSrc,
    }));
  }
  return views.map((label, index) => ({
    src: makeArtImage(product, index),
    alt: `${product.name || '商品'} · ${label}`,
    label,
    focus: '50% 50%',
    fallbackSrc,
  }));
}

function normalizeSkus(product) {
  const raw = Array.isArray(product.skus) && product.skus.length
    ? product.skus
    : [{
        id: `${product.id || 'product'}-default`,
        spec: '标准款',
        price: product.price,
        stock: product.stock ?? product.totalStock ?? 0,
        status: 'on_sale',
      }];
  return raw.map((sku, index) => ({
    ...sku,
    id: sku.id || `${product.id || 'product'}-s${index + 1}`,
    spec: sku.spec || `规格 ${index + 1}`,
    price: Number(sku.price ?? product.price ?? 0),
    stock: Number(sku.stock ?? 0),
    status: sku.status || 'on_sale',
  }));
}

/**
 * 把任意商品（API / demo / mock）收敛为 PDP 的 ProductDetail。
 * 既保留旧字段（pic、reviews、reviewsCount 等），又补齐本步骤要求的标准字段。
 */
export function normalizeProductDetail(baseProduct = {}) {
  const id = String(baseProduct.id || '');
  const mock = PRODUCT_DETAIL_MOCKS[id] || {};
  const product = { ...mock, ...baseProduct, id };
  const skus = normalizeSkus(product);
  const images = buildGallery(product, mock);
  const summedStock = skus.reduce((sum, sku) => sum + (Number(sku.stock) || 0), 0);
  const stock = Number(product.stock ?? product.totalStock ?? summedStock) || 0;
  const reviewCount = Number(product.reviewCount ?? product.reviewsCount ?? 0) || 0;
  return {
    ...product,
    images,
    skus,
    stock,
    rating: Number(product.rating) || 0,
    reviewCount,
    reviewsCount: Number(product.reviewsCount ?? reviewCount) || reviewCount,
    shippingNote: product.shippingNote || mock.shippingNote || DEFAULT_SHIPPING,
    returnNote: product.returnNote || mock.returnNote || DEFAULT_RETURN,
    skuGroupLabel: product.skuGroupLabel || mock.skuGroupLabel || '选择规格',
    fallbackImage: images[0]?.fallbackSrc || images[0]?.src || '',
  };
}

/** 三个内置 mock 商品的独立兜底，保证商品列表不可用时也能打开 PDP。 */
export function createMockProductDetail(id) {
  const mock = PRODUCT_DETAIL_MOCKS[String(id)];
  return mock ? normalizeProductDetail({ ...mock }) : null;
}

export function readCachedProductDetail(id) {
  const cache = readJSON(DETAIL_CACHE_KEY, {});
  const entry = cache[String(id)];
  return entry && entry.detail ? entry.detail : null;
}

export function cacheProductDetail(detail) {
  if (!detail || !detail.id) return;
  const cache = readJSON(DETAIL_CACHE_KEY, {});
  cache[String(detail.id)] = { savedAt: Date.now(), detail };
  const entries = Object.entries(cache)
    .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0))
    .slice(0, MAX_CACHED_DETAILS);
  writeJSON(DETAIL_CACHE_KEY, Object.fromEntries(entries));
}

export function isFavoriteProduct(id) {
  const favorites = readJSON(FAVORITES_KEY, []);
  return Array.isArray(favorites) && favorites.includes(String(id));
}

/** 收藏即时落入 localStorage，并在 UI 同步；服务端同步由调用方 best-effort 完成。 */
export function toggleFavoriteProduct(id) {
  const key = String(id);
  const current = readJSON(FAVORITES_KEY, []);
  const favorites = Array.isArray(current) ? current : [];
  const exists = favorites.includes(key);
  writeJSON(FAVORITES_KEY, exists ? favorites.filter((item) => item !== key) : [...favorites, key]);
  return !exists;
}

export function getFavoriteProductIds() {
  const favorites = readJSON(FAVORITES_KEY, []);
  return Array.isArray(favorites) ? favorites : [];
}
