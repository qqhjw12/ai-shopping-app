// PDP 数据层：统一 ProductDetail 模型、mock 画廊、localStorage 缓存与收藏状态。
// 当前阶段用本地 mock 兜底；后续接真实 API 时，保持这里的导出接口不变即可平滑替换。
// 关键模型字段：id / name / price / originalPrice / images[] / skus[] / stock /
//              shippingNote / returnNote / rating / reviewCount。
import { productArtSvg } from '../art.js';
import { api } from '../api.js';
import { PRODUCT_DETAIL_MOCKS } from '../mock/productDetails.js';
import { getMockReviews } from '../mock/productReviews.js';

const DETAIL_CACHE_KEY = 'maison_pdp_cache_v2';
const FAVORITES_KEY = 'maison_pdp_favorites_v1';
const MAX_CACHED_DETAILS = 8;
const IMAGE_LABELS = ['正面', '细节', '质感'];
const IMAGE_FOCUS = ['50% 50%', '46% 34%', '56% 74%'];

const DEFAULT_SHIPPING = '顺丰包邮 · 付款后 48 小时内发出';
const DEFAULT_RETURN = '7 天无理由退换 · 支持上门取件';

// 本地匿名身份： persisted 的用户 id，用于服务端区分「谁投了票 / 谁写了评价」。
// 不能固定用 anonymous，否则所有访客共享同一份投票与评价归属。
const USER_ID_KEY = 'maison_user_id_v1';

export function getUserId() {
  const existing = readJSON(USER_ID_KEY, '');
  if (existing && String(existing).trim()) return String(existing);
  const uid = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeJSON(USER_ID_KEY, uid);
  return uid;
}

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
 * 归一化评价：补齐 reviewCard 需要的字段，并保留每条自带的极性侧写 aspects。
 * 网关真实评价没有 aspects（只有 rating/content），此时 AI 摘要会走词典模式。
 */
function normalizeReviews(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((r, index) => {
    const merged = {
      ...r,
      id: r.id ?? `rv-${index}`,
      author: r.author || '匿名用户',
      rating: Number(r.rating) || 0,
      content: r.content || '',
      created_at: r.created_at || '',
      helpful: Number(r.helpful) || 0,
      aspects: Array.isArray(r.aspects) ? r.aspects.filter((a) => a && a.text) : [],
      // 买家秀 / 追评 / 规格快照：服务端字段与本地 mock 在此统一，UI 只认这套
      images: Array.isArray(r.images) ? r.images.filter(Boolean) : [],
      skuSpec: r.skuSpec || '',
      parentId: r.parentId ?? null,
      source: r.source || 'seed',
      followUps: normalizeReviews(r.followUps || []),
    };
    // 归属标记：服务端返回 isMine，本地保存用 mine，统一后 UI 只读 mine
    merged.mine = Boolean(r.isMine || r.mine);
    return merged;
  });
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
  // 评价：优先用商品自带数据（网关 / 本地库），缺失时回落到内置 mock 评价；
  // 内置 mock 自带 aspects 极性标签，AI 摘要可据此统计要点（网关真实评价则走词典模式）。
  const reviews = normalizeReviews(
    Array.isArray(product.reviews) && product.reviews.length ? product.reviews : getMockReviews(id),
  );
  return {
    ...product,
    images,
    skus,
    reviews,
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

/* ---------------- 评价交互：有用投票 & 写评价 ---------------- */
// 当前阶段无写评价 / 投票后端，全部落在 localStorage，保持幂等：
// 同一条评价重复点击视为取消赞，同一商品的评价按时间倒序追加且上限收敛。

const REVIEW_VOTES_KEY = 'maison_pdp_review_votes_v1';
const USER_REVIEWS_KEY = 'maison_pdp_user_reviews_v1';
// 离线追评：网关不可用时把追评挂在本地，避免「写了但刷新就没了」
const LOCAL_FOLLOWUPS_KEY = 'maison_pdp_local_followups_v1';
const REVIEW_MAX_PER_PRODUCT = 20;
// 买家秀上限（与服务端 reviewRepo.REVIEW_RULES.imageMax 一致）
export const MAX_REVIEW_IMAGES = 6;

/** 已投票集合：{ [reviewId]: votedAt } —— 用于回显「已赞」状态，避免刷新后被重置。 */
export function readReviewVotes() {
  const raw = readJSON(REVIEW_VOTES_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** 投票 / 取消赞：返回投票后的布尔状态，UI 据此把本地计数 ±1，保证视觉与存储一致。 */
export function toggleReviewVote(reviewId) {
  const votes = readReviewVotes();
  const key = String(reviewId);
  if (votes[key]) delete votes[key];
  else votes[key] = Date.now();
  writeJSON(REVIEW_VOTES_KEY, votes);
  return Boolean(votes[key]);
}

/** 读取我在某个商品下写过的评价（按时间倒序，新的在前）。 */
export function readUserReviews(productId) {
  const all = readJSON(USER_REVIEWS_KEY, {});
  const list = all && all[String(productId)];
  return Array.isArray(list) ? list : [];
}

/**
 * 保存一条我写的评价。
 * 返回结构与 Review 契约一致（含 content / rating / created_at / skuSpec / aspects），
 * 因此可以直接喂给 reviewCard 与 AI 摘要统计，无需 UI 做额外适配。
 */
export function saveUserReview(productId, payload = {}) {
  const id = String(productId);
  const all = readJSON(USER_REVIEWS_KEY, {});
  const list = Array.isArray(all[id]) ? all[id] : [];
  const review = {
    id: `ur-${id}-${Date.now()}`,
    author: '我',
    rating: Math.min(5, Math.max(1, Math.round(Number(payload.rating) || 5))),
    content: String(payload.content || '').trim().slice(0, 500),
    created_at: new Date().toISOString().slice(0, 10),
    skuSpec: payload.skuSpec || '',
    // 离线草稿只保留「能直接渲染」的地址：对象键要靠服务端现签 URL，
    // 离线时签不出来，存下来只会变成一排碎图
    images: (Array.isArray(payload.images) ? payload.images : [])
      .filter((u) => typeof u === 'string' && /^(?:https?:|\/)/.test(u))
      .slice(0, MAX_REVIEW_IMAGES),
    helpful: 0,
    aspects: [],
    followUps: [],
    mine: true, // 标记「我的评价」，UI 据此高亮；在线模式由服务端 isMine 取代
  };
  all[id] = [review, ...list].slice(0, REVIEW_MAX_PER_PRODUCT);
  writeJSON(USER_REVIEWS_KEY, all);
  return review;
}

/** 本地追评：{ [productId]: [{ parentId, ...review }] } */
export function readLocalFollowUps(productId) {
  const all = readJSON(LOCAL_FOLLOWUPS_KEY, {});
  const list = all && all[String(productId)];
  return Array.isArray(list) ? list : [];
}

export function saveLocalFollowUp(productId, review) {
  const id = String(productId);
  const all = readJSON(LOCAL_FOLLOWUPS_KEY, {});
  const list = Array.isArray(all[id]) ? all[id] : [];
  all[id] = [...list, review].slice(-REVIEW_MAX_PER_PRODUCT);
  writeJSON(LOCAL_FOLLOWUPS_KEY, all);
  return review;
}

/**
 * 把「我写的评价」与「基础评价」合并给 UI：
 * - 我的评价置顶（自己刚写的要立刻看到）；
 * - 已投过票的评价在基础票数上 +1，避免「点了有用但数字不变」的割裂感。
 */
export function mergeReviews(baseReviews = [], userReviews = [], votes = {}) {
  return [...userReviews, ...baseReviews].map((r) => {
    const voted = Boolean(votes[String(r.id)]);
    return {
      ...r,
      helpful: Number(r.helpful || 0) + (voted ? 1 : 0),
      voted,
      mine: Boolean(r.mine || r.isMine),
      images: Array.isArray(r.images) ? r.images : [],
      followUps: normalizeReviews(r.followUps || []),
    };
  });
}

/**
 * 本地合成包：内置 mock + 我写的评价 + 本地追评 + 本地票。
 * 用于网关不可达时的降级（保证 UI 永不空白）。
 */
function readLocalReviewsBundle(productId) {
  const id = String(productId);
  const mine = readUserReviews(id);
  const follows = readLocalFollowUps(id);
  const votes = readReviewVotes();
  const base = getMockReviews(id);
  const reviews = mergeReviews(base, mine, votes).map((r) => {
    const mineFollows = follows.filter((f) => String(f.parentId) === String(r.id));
    return mineFollows.length
      ? { ...r, followUps: [...r.followUps, ...normalizeReviews(mineFollows)] }
      : r;
  });
  return { reviews, summary: buildReviewSummary(reviews) };
}

/* ---------------- 评价 API service（网关优先，失败降级本地） ---------------- */
// 所有写操作都先打网关；网关不可达才落 localStorage，并在返回值里标注 online=false，
// 由 UI 决定要不要提示「已离线保存」。

/** 评价列表：服务端返回已嵌套追评的评价 + 概览；失败则用本地合成包。 */
export async function fetchProductReviews(productId, opts = {}) {
  const id = String(productId);
  try {
    const q = new URLSearchParams({
      userId: getUserId(),
      filter: opts.filter || 'all',
      sort: opts.sort || 'latest',
      limit: String(opts.limit ?? 50),
      offset: String(opts.offset ?? 0),
    });
    const data = await api(`/api/products/${encodeURIComponent(id)}/reviews?${q}`, { retries: 1 });
    const reviews = normalizeReviews(data.reviews || []);
    return {
      reviews,
      summary: data.summary || buildReviewSummary(reviews),
      hasMore: Boolean(data.hasMore),
      online: true,
    };
  } catch {
    const local = readLocalReviewsBundle(id);
    return { ...local, hasMore: false, online: false };
  }
}

/** 发布评价。在线返回服务端记录；离线落本地并由 UI 提示。 */
export async function submitReview(productId, payload = {}) {
  try {
    const data = await api('/api/reviews', {
      body: {
        productId: String(productId),
        userId: getUserId(),
        author: payload.author || '我',
        rating: Number(payload.rating) || 0,
        content: String(payload.content || '').trim(),
        skuSpec: payload.skuSpec || '',
        images: payload.images || [],
      },
      retries: 1,
    });
    return { review: normalizeReviews([data])[0], online: true };
  } catch (e) {
    const saved = saveUserReview(productId, payload);
    return { review: normalizeReviews([saved])[0], online: false, reason: e.message };
  }
}

/** 追评：必须挂在已有主评价上。主评价本身是本地数据时，离线追加到本地。 */
export async function submitFollowUp({ reviewId, productId, content, images, online: parentOnline = true }) {
  const payload = {
    author: '我',
    content: String(content || '').trim(),
    images: images || [],
  };
  if (typeof reviewId === 'string' && reviewId.startsWith('ur-')) parentOnline = false;
  try {
    if (!parentOnline) throw new Error('offline-parent');
    const data = await api('/api/reviews', {
      body: { parentId: reviewId, userId: getUserId(), ...payload },
      retries: 1,
    });
    return { review: normalizeReviews([data])[0], online: true };
  } catch (e) {
    if (parentOnline) {
      // 主评价在服务端（有数字 id），离线时告知 UI 重试，不静默丢弃用户输入
      throw e;
    }
    const saved = saveLocalFollowUp(productId, {
      id: `lf-${Date.now()}`,
      parentId: reviewId,
      ...payload,
      created_at: new Date().toISOString().slice(0, 10),
      helpful: 0,
      mine: true,
    });
    return { review: normalizeReviews([saved])[0], online: false, reason: e.message };
  }
}

/**
 * 有用投票：在线时以服务端计数为准（幂等切换）；离线则本地 toggle。
 * @returns {{voted:boolean, helpful:number|null, online:boolean}} helpful 为 null 表示需 UI 本地 ±1
 */
export async function voteReview(reviewId) {
  try {
    const data = await api(`/api/reviews/${encodeURIComponent(reviewId)}/helpful`, {
      body: { userId: getUserId() },
      retries: 1,
    });
    return { voted: Boolean(data.voted), helpful: Number(data.helpful) || 0, online: true };
  } catch {
    const voted = toggleReviewVote(reviewId);
    return { voted, helpful: null, online: false };
  }
}

/**
 * 删除评价：在线调网关 DELETE（级联删追评/投票 + 回收图片对象，全部服务端完成）；
 * 离线且是本地草稿（ur- 开头）则只清本地，避免「删了却还显示」的割裂感。
 * @returns {{ok:boolean, online:boolean}}
 */
export async function deleteReview(productId, reviewId) {
  const id = String(reviewId);
  if (id.startsWith('ur-')) {
    removeUserReview(productId, id);
    return { ok: true, online: false };
  }
  await api(`/api/reviews/${encodeURIComponent(id)}?userId=${encodeURIComponent(getUserId())}`, {
    method: 'DELETE',
    retries: 1,
  });
  return { ok: true, online: true };
}

/** 从本地草稿里移除一条我写的评价（离线删除用）。 */
export function removeUserReview(productId, reviewId) {
  const id = String(productId);
  const rid = String(reviewId);
  const all = readJSON(USER_REVIEWS_KEY, {});
  if (!Array.isArray(all[id])) return;
  all[id] = all[id].filter((r) => String(r.id) !== rid);
  if (!all[id].length) delete all[id];
  writeJSON(USER_REVIEWS_KEY, all);
}

/**
 * 买家秀上传：dataURL → 网关 → 对象存储。
 * 返回 `{ key, url }`：key 是入库用的稳定标识（对象键），url 是当次可渲染的地址
 * （s3 驱动下是预签名 URL，有有效期）。**持久化只能存 key**。
 */
export async function uploadReviewImage(dataUrl) {
  const data = await api('/api/reviews/upload', { body: { data: dataUrl }, retries: 1 });
  if (!data || !data.url) throw new Error('上传失败：未返回图片地址');
  return { key: data.key || data.url, url: data.url };
}

/* ---------------- 评价概览 & AI 摘要 service ---------------- */
// 设计令牌无关的数据层：只负责产出结构与统计，UI 层自行套用 --gold / --ink 等令牌。

const AI_SUMMARY_CACHE_KEY = 'maison_pdp_ai_summary_v1';

// 词典模式：评价缺少 aspects 极性标签时（网关返回的真实评价），用关键词从正文抽取要点。
const POSITIVE_LEXICON = ['清晰', '舒服', '舒适', '安静', '细腻', '惊喜', '满意', '推荐', '方便', '流畅', '稳', '耐用', '值', '通透', '实用', '好看', '快'];
const NEGATIVE_LEXICON = ['噪音', '吵', '卡', '慢', '贵', '失望', '瑕疵', '问题', '松动', '异响', '误触', '发烫', '偏少', '缺', '不足'];

/** 评价概览：总数、均分、星级分布、好评率（4-5 星占比）。 */
export function buildReviewSummary(reviews = []) {
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  reviews.forEach((r) => {
    const star = Math.min(5, Math.max(1, Math.round(Number(r.rating) || 0)));
    distribution[star] += 1;
    sum += Number(r.rating) || 0;
  });
  const total = reviews.length;
  const positive = (distribution[5] + distribution[4]) || 0;
  return {
    total,
    avg: total ? Number((sum / total).toFixed(1)) : 0,
    distribution,
    positiveRate: total ? Math.round((positive / total) * 100) : 0,
  };
}

function topByCount(bucket, limit) {
  return Object.entries(bucket)
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || String(a.text).localeCompare(String(b.text)))
    .slice(0, limit);
}

/**
 * AI 评价摘要：本地规则引擎（当前阶段）。
 * - mode='aspect'：评价自带极性标签（内置 mock），直接统计「被提及最多的优点 / 顾虑」；
 * - mode='lexicon'：网关真实评价无标签，改用中文关键词词典从正文抽取；
 * - mode='insufficient'：无评价可依据，UI 退回首屏说明。
 * 结论均可回溯到具体评价条目，避免凭空生成。
 */
export function buildAiReviewSummary(product, reviews = []) {
  const base = buildReviewSummary(reviews);
  if (!reviews.length) {
    return { ...base, mode: 'insufficient', sampleSize: 0, highlights: [], watchouts: [], verdict: '' };
  }

  const pos = {};
  const neg = {};
  let aspectMode = false;
  reviews.forEach((r) => {
    if (r.aspects && r.aspects.length) {
      aspectMode = true;
      r.aspects.forEach((a) => {
        const bucket = a.polarity === 'neg' ? neg : pos;
        bucket[a.text] = (bucket[a.text] || 0) + 1;
      });
    }
  });
  if (!aspectMode) {
    reviews.forEach((r) => {
      const text = String(r.content || '');
      POSITIVE_LEXICON.forEach((w) => { if (text.includes(w)) pos[w] = (pos[w] || 0) + 1; });
      NEGATIVE_LEXICON.forEach((w) => { if (text.includes(w)) neg[w] = (neg[w] || 0) + 1; });
    });
  }

  const rate = base.positiveRate;
  let verdict = '整体评价较好，优点多集中在使用体验';
  if (reviews.length < 3) verdict = '样本偏少，结论仅供参考';
  else if (rate >= 90) verdict = '好评度很高，多数买家认可它的核心体验';
  else if (rate >= 75) verdict = '好评占多数，可结合下方顾虑判断是否适合你';
  else if (rate >= 60) verdict = '口碑有分化，入手前建议留意提及较多的问题';
  else verdict = '口碑偏弱，建议谨慎考虑或对比同类商品';

  return {
    ...base,
    mode: aspectMode ? 'aspect' : 'lexicon',
    sampleSize: reviews.length,
    highlights: topByCount(pos, 3),
    watchouts: topByCount(neg, 2),
    verdict,
  };
}

/**
 * AI 摘要 service：对外保持 async 契约，后续接真实 LLM 接口时只需替换本函数内部实现，
 * UI 层无需改动。当前为本地规则生成 + localStorage 结果缓存（样本数变化时重算）。
 */
export async function requestAiReviewSummary(product) {
  const reviews = (product && product.reviews) || [];
  const cache = readJSON(AI_SUMMARY_CACHE_KEY, {});
  const hit = product ? cache[String(product.id)] : null;
  if (hit && hit.summary && hit.sampleSize === reviews.length) return hit.summary;
  const summary = buildAiReviewSummary(product, reviews);
  if (product && product.id) {
    const next = readJSON(AI_SUMMARY_CACHE_KEY, {});
    next[String(product.id)] = { savedAt: Date.now(), sampleSize: reviews.length, summary };
    writeJSON(AI_SUMMARY_CACHE_KEY, next);
  }
  return summary;
}
