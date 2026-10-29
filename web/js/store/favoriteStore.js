// 收藏（心愿单）数据层：本地优先 + 按用户隔离 + 网关可用时 best-effort 同步。
//
// 为什么本地优先：收藏必须「刷新不丢、断网不丢、静态演示站也能用」。
// localStorage 是唯一真相源，服务端只做镜像（换设备时由收藏页反向并回本地）。
// 之所以存商品快照而不是只存 id：offline 打开收藏页时拿不到商品详情，
// 只存 id 就只能渲染一排空壳。
import { api } from '../api.js';
import { getUserId } from '../state.js';
import { scopeId } from './userScope.js';

const STORE_KEY = 'maison_favorites_v2';
const LEGACY_KEY = 'maison_pdp_favorites_v1'; // 旧版详情页只存 id 的收藏列表

const listeners = new Set();

/* ---------------- 底层读写 ---------------- */

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* 隐私模式 / 配额满：写不进去也不该让点击抛异常，下次交互还会再试 */
  }
  notify();
}

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  });
}

/* ---------------- 快照 ---------------- */

// 只留渲染商品卡需要的字段：卡片（productCard）读什么，这里就存什么。
function snapshot(p) {
  return {
    id: String(p.id),
    name: p.name || '',
    price: p.price,
    originalPrice: p.originalPrice,
    pic: p.pic || '',
    category: p.category || '',
    categoryId: p.categoryId || '',
    brand: p.brand || '',
    coverColor: p.coverColor || '',
    rating: p.rating,
    totalStock: p.totalStock,
    stock: p.stock,
    highlight: p.highlight || '',
    spec: p.spec || '',
    addedAt: Date.now(),
  };
}

/* ---------------- 旧数据迁移 ---------------- */

// 上一版收藏只存在 maison_pdp_favorites_v1（纯 id 数组，不分用户）。
// 首次读到时把它们归入当前作用域，再删掉旧键，避免「升级后收藏凭空消失」。
function migrateLegacy() {
  let legacy = null;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  } catch {
    legacy = null;
  }
  if (!Array.isArray(legacy) || !legacy.length) return;

  const all = readAll();
  const key = scopeId();
  const list = Array.isArray(all[key]) ? all[key] : [];
  const have = new Set(list.map((i) => String(i.id)));
  legacy.forEach((rawId, i) => {
    const id = String(rawId);
    // 只有 id 没有快照：渲染时由收藏页补商品信息，补不到就丢弃
    if (!have.has(id)) list.push({ id, addedAt: Date.now() - i });
  });
  all[key] = list;
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 删不掉也无所谓：migrate 是幂等的，下次读到同样的 id 会被去重 */
  }
  writeAll(all);
}

migrateLegacy();

/* ---------------- 查询 ---------------- */

/** 收藏列表（新加的在前） */
export function listFavorites() {
  const all = readAll();
  const arr = all[scopeId()];
  if (!Array.isArray(arr)) return [];
  return arr
    .slice()
    .sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
}

export function favoriteIds() {
  return listFavorites().map((i) => String(i.id));
}

export function isFavorite(id) {
  if (id == null) return false;
  return favoriteIds().includes(String(id));
}

export function favoriteCount() {
  return listFavorites().length;
}

/** 订阅收藏变化（顶栏角标、收藏页共用） */
export function onFavoritesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ---------------- 增删 ---------------- */

export function addFavorite(product, { silent = false } = {}) {
  const id = product && product.id != null ? String(product.id) : '';
  if (!id) return false;
  const all = readAll();
  const key = scopeId();
  const list = Array.isArray(all[key]) ? all[key] : [];
  if (list.some((i) => String(i.id) === id)) return false;
  all[key] = [snapshot({ ...product, id }), ...list];
  writeAll(all);
  if (!silent) notify();
  return true;
}

export function removeFavorite(id, { silent = false } = {}) {
  const target = String(id);
  const all = readAll();
  const key = scopeId();
  const list = Array.isArray(all[key]) ? all[key] : [];
  const next = list.filter((i) => String(i.id) !== target);
  if (next.length === list.length) return false;
  all[key] = next;
  writeAll(all);
  if (!silent) notify();
  return true;
}

/**
 * 切换收藏，返回切换后的状态（true = 已收藏）。
 * 服务端只做镜像：失败不影响本地结果，也不冒泡到 UI。
 */
export function toggleFavorite(product) {
  const id = product && product.id != null ? String(product.id) : '';
  if (!id) return false;
  const next = !isFavorite(id);
  if (next) addFavorite(product);
  else removeFavorite(id);
  syncServer(id);
  return next;
}

function syncServer(productId) {
  api('/api/favorites', {
    method: 'POST',
    body: { userId: getUserId(), productId },
    retries: 0,
  }).catch(() => {
    /* 演示模式 / 离线：本地已生效，服务端下次连上再并回 */
  });
}
