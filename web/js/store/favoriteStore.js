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
  // silent 用于「从服务端并回」：数据本来就是服务端的，回写只是幂等空转，省一次请求
  if (!silent) syncServer({ op: 'add', id });
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
  if (!silent) syncServer({ op: 'remove', id });
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
  return next;
}

/* ---------------- 服务端同步：显式语义 + 离线操作队列 ---------------- */

// 旧版删除也走 POST toggle：本地取消一条「服务端本来就没有」的收藏时，
// toggle 会把它加回去——删除被反转成了新增。现在增删各自显式，且全部幂等。
const PENDING_KEY = 'maison_fav_pending_v1';

function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writePending(list) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    /* 写不进去就放弃重放：下次操作失败还会再入队 */
  }
}

function sendOp(op) {
  // userId 在操作发生那一刻记下并随操作重放：排队期间用户切了账号，
  // 也不能把 A 的收藏操作打到 B 的服务端镜像上。
  return api('/api/favorites', {
    method: 'POST',
    body: { userId: op.userId, productId: op.id, action: op.op },
    retries: 0,
  });
}

/** 商品不存在 / 参数非法：这类操作永远不可能成功，重放没有意义 */
function isDeadOp(e) {
  return Boolean(e) && (e.status === 400 || e.status === 404);
}

function syncServer({ op, id }) {
  const record = { op, id, userId: getUserId(), at: Date.now() };
  sendOp(record)
    .then(() => {
      // 成功即代表这条（及更早的）同类操作已收敛到服务端：清掉该商品的全部排队，
      // 否则「add 排队 + remove 成功」的组合会在重放时把已删除的收藏复活。
      writePending(readPending().filter((x) => x.id !== record.id || x.userId !== record.userId));
    })
    .catch((e) => {
      if (isDeadOp(e)) return;
      const list = readPending();
      list.push(record);
      writePending(list);
      /* 演示模式 / 离线：本地已生效，联网后 flushFavorites() 按顺序重放 */
    });
}

/**
 * 重放离线期间的收藏操作（按发生顺序）。
 * 服务端 add/remove 幂等（INSERT OR IGNORE / DELETE），重复重放安全；
 * 返回成功补推的条数。
 */
export async function flushFavorites() {
  const pending = readPending();
  if (!pending.length) return 0;
  const remaining = [];
  for (const record of pending) {
    try {
      await sendOp(record);
    } catch (e) {
      if (!isDeadOp(e)) remaining.push(record);
    }
  }
  writePending(remaining);
  return pending.length - remaining.length;
}
