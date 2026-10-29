// 最近浏览：进入商品详情页时自动记一条，首页横向轨道展示最近 6–8 个。
//
// 存商品快照而不是只存 id：首页要在没有任何商品请求的情况下直接画出轨道，
// 只存 id 就得为了 8 张卡再打一轮接口，首屏被拖慢。
// 按用户隔离，与收藏同一套作用域（store/userScope.js）。
import { scopeId } from './userScope.js';

const STORE_KEY = 'maison_recent_v1';
const MAX_KEEP = 24; // 多留一些，首页只取前 8

const listeners = new Set();

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
    /* 隐私模式写不进去：本次会话仍能看到，下次进入自然丢失，可接受 */
  }
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* 忽略单个订阅者异常 */
    }
  });
}

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
    viewedAt: Date.now(),
  };
}

/**
 * 记录一次详情页访问。
 * 同款去重（重复看同一件只保留最新一条并置顶），避免轨道被一个商品刷满。
 */
export function recordVisit(product) {
  const id = product && product.id != null ? String(product.id) : '';
  if (!id) return [];
  const all = readAll();
  const key = scopeId();
  const list = Array.isArray(all[key]) ? all[key] : [];
  const next = [snapshot({ ...product, id }), ...list.filter((i) => String(i.id) !== id)].slice(0, MAX_KEEP);
  all[key] = next;
  writeAll(all);
  return next;
}

/** 最近浏览（最新在前） */
export function listRecent(limit = 8) {
  const all = readAll();
  const arr = all[scopeId()];
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, Math.max(0, limit));
}

export function clearRecent() {
  const all = readAll();
  all[scopeId()] = [];
  writeAll(all);
}

export function onRecentChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
