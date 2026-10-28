// 购物车 + 匿名 userId。
// 购物车以服务端（SQLite）为真相源：同一账号换设备/清缓存不丢。
// 网关不可达时（GitHub Pages 演示模式）自动回落到 localStorage，行为与原来一致。
import { api } from './api.js';
import { getCurrentUser } from './user.js';

const CART_KEY = 'shop_cart';
const UID_KEY = 'uid';

/**
 * 当前身份：登录用户优先，其次会话级匿名 ID。
 * 这一处的口径决定了购物车 / 订单 / 收藏的归属——登录后它们会自动挂到账户名下，
 * 退出登录则回落到匿名 ID，不会串到别人的数据上。
 */
export function getUserId() {
  const user = getCurrentUser();
  if (user && user.id) return user.id;
  let id = sessionStorage.getItem(UID_KEY);
  if (!id) {
    id = 'u_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem(UID_KEY, id);
  }
  return id;
}

/* ---------- 本地镜像（同步读写，保证 UI 立刻响应） ---------- */

const listeners = new Set();

export function onCartChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function keyOf(productId, skuId) {
  return skuId ? `${productId}::${skuId}` : String(productId);
}

function readLocal() {
  try {
    const arr = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLocal(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  listeners.forEach((fn) => {
    try {
      fn(cart);
    } catch {
      /* 单个订阅者出错不影响其他订阅者 */
    }
  });
}

/* ---------- 对外同步接口（保持与旧实现同名，现有调用点无需改动） ---------- */

export function getCart() {
  return readLocal();
}

export function cartCount() {
  return getCart().reduce((n, i) => n + i.qty, 0);
}

export function cartTotal() {
  return getCart().reduce((s, i) => s + i.price * i.qty, 0);
}

export function addToCart(product, qty = 1, skuId = null) {
  const cart = readLocal();
  const key = keyOf(product.id, skuId || product.skuId);
  const found = cart.find((i) => (i.__key || i.id) === key);
  if (found) {
    found.qty += qty;
  } else {
    cart.push({
      // 旧代码按 productId 使用 id；itemId 为服务端主键，用于增删改
      id: product.id,
      productId: product.id,
      skuId: skuId || null,
      itemId: null,
      __key: key,
      name: product.name,
      price: product.price,
      pic: product.pic || '',
      coverColor: product.coverColor || '',
      brand: product.brand || '',
      spec: product.spec || '',
      categoryId: product.categoryId || '',
      // 库存要跟着进购物袋：数量夹逼（抽屉/结算页的 + 上限）完全依赖这个值，
      // 漏存会让本地加购的商品读不到库存，从而"想买多少买多少"，直到下单才被服务端驳回
      stock: product.stock,
      qty,
    });
  }
  writeLocal(cart);
  pushAdd(product.id, skuId || null, qty);
  return cart;
}

export function setQty(id, qty) {
  const key = String(id);
  const cart = readLocal();
  const it = cart.find((i) => (i.__key || i.id) === key || String(i.productId) === key || String(i.itemId) === key);
  if (!it) return cart;
  if (qty <= 0) return removeFromCart(id);
  it.qty = qty;
  writeLocal(cart);
  if (it.itemId) {
    api('/api/cart', { method: 'PATCH', body: { userId: getUserId(), itemId: it.itemId, qty }, retries: 0 })
      .then((d) => d && Array.isArray(d.items) && mergeServer(d))
      .catch(() => {});
  }
  return cart;
}

/**
 * 撤销删除：把整条购物袋记录原样放回（含服务端同步）。
 * 与 addToCart 的区别在于——它恢复的是被删前的快照（数量、itemId 原样），
 * 而不是「再买一件」，避免撤销时数量被重复累加。
 */
export function restoreCartItem(snapshot) {
  if (!snapshot) return getCart();
  const cart = readLocal();
  const key = snapshot.__key || keyOf(snapshot.productId, snapshot.skuId);
  if (cart.some((i) => (i.__key || i.id) === key)) return cart;
  cart.push({ ...snapshot, __key: key });
  writeLocal(cart);
  pushAdd(snapshot.productId, snapshot.skuId || null, snapshot.qty);
  return cart;
}

export function removeFromCart(id) {
  const key = String(id);
  const cart = readLocal();
  const it = cart.find((i) => (i.__key || i.id) === key || String(i.productId) === key || String(i.itemId) === key);
  const next = cart.filter((i) => i !== it);
  writeLocal(next);
  if (it && it.itemId) {
    api(`/api/cart?userId=${encodeURIComponent(getUserId())}&itemId=${it.itemId}`, { method: 'DELETE', retries: 0 })
      .catch(() => {});
  }
  return next;
}

export function clearCart() {
  writeLocal([]);
  api(`/api/cart?userId=${encodeURIComponent(getUserId())}`, { method: 'DELETE', retries: 0 }).catch(() => {});
}

/* ---------- 服务端同步 ---------- */

/** 服务端购物车 → 本地镜像（保留服务端主键，供后续增删改） */
function mergeServer(d) {
  if (!d || !Array.isArray(d.items)) return;
  const items = d.items.map((s) => ({
    id: s.productId,
    productId: s.productId,
    skuId: s.skuId || null,
    itemId: s.id,
    __key: keyOf(s.productId, s.skuId),
    name: s.name,
    price: s.price,
    pic: '',
    coverColor: s.coverColor || '',
    brand: s.brand || '',
    spec: s.spec || '',
    stock: s.stock,
    insufficient: s.insufficient,
    qty: s.qty,
  }));
  writeLocal(items);
}

function pushAdd(productId, skuId, qty) {
  api('/api/cart', {
    method: 'POST',
    body: { userId: getUserId(), productId, skuId, qty },
    retries: 0,
  })
    .then((d) => mergeServer(d))
    .catch(() => {
      /* 演示模式 / 离线：本地镜像已生效，静默降级 */
    });
}

/** 离线期间累加的购物车，恢复连接后补传 */
async function pushLocal() {
  const cart = readLocal();
  if (!cart.length) return;
  const userId = getUserId();
  for (const i of cart) {
    try {
      await api('/api/cart', {
        method: 'POST',
        body: { userId, productId: i.productId, skuId: i.skuId, qty: i.qty },
        retries: 0,
      });
    } catch {
      return; // 网关仍不可用，停止重试
    }
  }
}

/**
 * 启动时拉取服务端购物车。
 * 服务端有数据则以服务端为准；服务端为空而本地有离线数据时补传。
 * @returns {Promise<Array|null>} null 表示网关不可达（演示模式）
 */
export async function loadCart() {
  try {
    const d = await api(`/api/cart?userId=${encodeURIComponent(getUserId())}`, { retries: 0 });
    if (d && Array.isArray(d.items)) {
      if (d.items.length) mergeServer(d);
      else await pushLocal();
    }
    return getCart();
  } catch {
    return null;
  }
}
