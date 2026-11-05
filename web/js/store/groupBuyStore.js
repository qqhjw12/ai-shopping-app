// 拼团仓储层：建团 / 模拟好友参团 / 状态推导 / 倒计时 / 结算草稿，全部按 scopeId() 隔离。
//
// 三条硬设计：
//   1) 状态不落盘、只推导。groupStatus(group, now) 由「成员数 vs 成团人数」和
//      「now vs deadlineAt」两个事实算出，刷新/改系统时间都不会出现「已满员却显示待成团」。
//   2) 团价由单买价 × 档位折扣实时算，且写进团对象快照。用户看到的团价 == 加进购物袋的价格，
//      不存在「标 8 折、结算按原价」这种虚标。
//   3) 时间只有一个入口（now 参数默认 Date.now()），纯函数都能在 Node 里断言，
//      不依赖任何 DOM 或定时器。
import {
  GB_DURATION_MS,
  GB_FRIEND_FALLBACK,
  GB_FRIEND_NAMES,
  GB_MAX_GROUPS,
  GB_NO_PREFIX,
  GB_NO_SEQ_LEN,
  GB_OWNER_FALLBACK,
  GB_STATUS,
  GB_STORAGE_PREFIX,
  GB_TICK_MS,
  GB_TIERS,
  GB_URGENT_MS,
} from './groupBuyConfig.js';
import { scopeId } from './userScope.js';

const CHECKOUT_PREFIX = 'maison_groupbuy_checkout_v1::';

/** 结算草稿有效期：超过这个时间还没下单就作废，避免「上次拼团结算」把后来的普通订单也标成拼团。 */
export const GB_CHECKOUT_TTL_MS = 30 * 60 * 1000;

/* ==================== 纯函数：价格与档位 ==================== */

/** 按档位折扣算团价（分位四舍五入到 0.01，展示与结算用同一个数）。 */
export function gbPriceOf(price, discount) {
  const p = Number(price);
  const d = Number(discount);
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (!Number.isFinite(d) || d <= 0) return Math.round(p * 100) / 100;
  return Math.round(p * (1 - d) * 100) / 100;
}

/** 省下的金额。 */
export function gbSaveOf(price, groupPrice) {
  const gap = Number(price) - Number(groupPrice);
  return gap > 0 ? Math.round(gap * 100) / 100 : 0;
}

/** 折扣百分点（0.18 → 18），用于「省 18%」文案。 */
export function gbDiscountPct(discount) {
  const d = Number(discount);
  return Number.isFinite(d) && d > 0 ? Math.round(d * 100) : 0;
}

/** 按成团人数取档位；非法人数回落到默认档位。 */
export function tierBySize(size) {
  const n = Number(size);
  return GB_TIERS.find((t) => t.size === n) || GB_TIERS.find((t) => t.size === 3) || GB_TIERS[0];
}

/* ==================== 纯函数：团号与状态 ==================== */

function pad(n, len) {
  const s = String(n);
  return s.length >= len ? s.slice(-len) : '0'.repeat(len - s.length) + s;
}

/** 团号：GB + yyMMdd + 4 位当日序号（同一天内递增，重复时自动进位）。 */
export function newGroupNo(list, now = Date.now()) {
  const d = new Date(now);
  const day = `${pad(d.getFullYear() % 100, 2)}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`;
  const used = new Set(
    (Array.isArray(list) ? list : [])
      .map((g) => String(g && g.no ? g.no : ''))
      .filter((no) => no.startsWith(`${GB_NO_PREFIX}${day}`))
      .map((no) => Number(no.slice(GB_NO_PREFIX.length + day.length)) || 0),
  );
  let seq = 1;
  while (used.has(seq)) seq += 1;
  return `${GB_NO_PREFIX}${day}${pad(seq, GB_NO_SEQ_LEN)}`;
}

/**
 * 三态推导：满员即成团（成团是终态，过了截止时间也不会退回失败）；
 * 未满员且已过截止时间即失败；其余为待成团。
 */
export function groupStatus(group, now = Date.now()) {
  const g = group || {};
  const size = Math.max(1, Number(g.size) || 1);
  const joined = Array.isArray(g.members) ? g.members.length : 0;
  if (joined >= size) return GB_STATUS.FORMED;
  const deadline = Date.parse(g.deadlineAt || '');
  if (Number.isFinite(deadline) && now > deadline) return GB_STATUS.FAILED;
  return GB_STATUS.OPEN;
}

/** 还差几人成团（已满员返回 0）。 */
export function remainingSlots(group) {
  const g = group || {};
  const size = Math.max(1, Number(g.size) || 1);
  const joined = Array.isArray(g.members) ? g.members.length : 0;
  return Math.max(0, size - joined);
}

/** 距截止还剩多少毫秒（已成团返回 -1，表示不再计时）。 */
export function remainingMs(group, now = Date.now()) {
  const g = group || {};
  if (groupStatus(g, now) === GB_STATUS.FORMED) return -1;
  const deadline = Date.parse(g.deadlineAt || '');
  if (!Number.isFinite(deadline)) return 0;
  return Math.max(0, deadline - now);
}

/** 倒计时文本 HH:MM:SS；已结束显示 00:00:00（由调用方配合状态文案）。 */
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}

/** 剩余时间是否进入紧张态（用于变色，不改结构）。 */
export function isUrgent(group, now = Date.now()) {
  const left = remainingMs(group, now);
  return left >= 0 && left <= GB_URGENT_MS;
}

/* ==================== 纯函数：成员与规范化 ==================== */

/** 从昵称池里取一个本团还没用过的名字；全用完了就带序号续命。 */
export function pickFriendName(group) {
  const g = group || {};
  const used = new Set((Array.isArray(g.members) ? g.members : []).map((m) => String(m && m.name)));
  const free = GB_FRIEND_NAMES.find((n) => !used.has(n));
  if (free) return free;
  const base = GB_FRIEND_FALLBACK;
  let i = 1;
  while (used.has(`${base}${i}`)) i += 1;
  return `${base}${i}`;
}

/** 参团（纯函数）：满员 / 已截止都明确拒绝，由视图层给对应提示。 */
export function addMember(group, name, now = Date.now()) {
  const g = normalizeGroup(group);
  if (groupStatus(g, now) === GB_STATUS.FORMED) {
    return { group: g, result: { ok: false, reason: 'formed', joined: g.members.length } };
  }
  if (groupStatus(g, now) === GB_STATUS.FAILED) {
    return { group: g, result: { ok: false, reason: 'expired', joined: g.members.length } };
  }
  const nickname = String(name || '').trim() || pickFriendName(g);
  g.members = [...g.members, { name: nickname, owner: false, joinedAt: new Date(now).toISOString() }];
  g.updatedAt = new Date(now).toISOString();
  const formed = g.members.length >= g.size;
  return {
    group: g,
    result: { ok: true, reason: formed ? 'formed' : 'joined', joined: g.members.length, name: nickname },
  };
}

/** 脏数据收敛：手改 localStorage、旧版本字段缺失都落到可用结构。 */
export function normalizeGroup(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const size = GB_TIERS.some((t) => t.size === Number(r.size)) ? Number(r.size) : 3;
  const tier = tierBySize(size);
  const unitPrice = Math.max(0, Number(r.unitPrice) || 0);
  const members = (Array.isArray(r.members) ? r.members : [])
    .map((m) => ({
      name: String((m && m.name) || '').slice(0, 24) || '好友',
      owner: Boolean(m && m.owner),
      joinedAt: typeof (m && m.joinedAt) === 'string' ? m.joinedAt : new Date().toISOString(),
    }))
    .slice(0, size);
  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString();
  const deadlineAt = typeof r.deadlineAt === 'string'
    ? r.deadlineAt
    : new Date(Date.parse(createdAt) + GB_DURATION_MS).toISOString();
  return {
    id: String(r.id || ''),
    no: String(r.no || ''),
    productId: String(r.productId || ''),
    product: {
      id: String((r.product && r.product.id) || r.productId || ''),
      name: String((r.product && r.product.name) || ''),
      pic: String((r.product && r.product.pic) || ''),
      coverColor: String((r.product && r.product.coverColor) || ''),
      price: unitPrice,
    },
    size,
    discount: Number.isFinite(Number(r.discount)) ? Number(r.discount) : tier.discount,
    unitPrice,
    groupPrice: Math.max(0, Number(r.groupPrice) || gbPriceOf(unitPrice, tier.discount)),
    members,
    createdAt,
    deadlineAt,
    sharedAt: typeof r.sharedAt === 'string' ? r.sharedAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : createdAt,
  };
}

export function normalizeState(raw, scope = scopeId()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const groups = (Array.isArray(r.groups) ? r.groups : [])
    .map(normalizeGroup)
    .filter((g) => g.id && g.productId);
  return {
    scope: String(r.scope || scope),
    groups: groups.slice(0, GB_MAX_GROUPS),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
  };
}

/* ==================== 仓储层：localStorage 按 scope 隔离 ==================== */

export function storageKey(scope = scopeId()) {
  return `${GB_STORAGE_PREFIX}${scope}`;
}

export function load() {
  const s = scopeId();
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey(s)) || 'null');
  } catch {
    raw = null;
  }
  return normalizeState(raw, s);
}

export function save(state) {
  try {
    const st = normalizeState(state, state.scope || scopeId());
    // 上限保护：超出的优先淘汰「已结束且最早截止」的团，不碰还在进行中的
    if (st.groups.length > GB_MAX_GROUPS) {
      const now = Date.now();
      const live = st.groups.filter((g) => groupStatus(g, now) === GB_STATUS.OPEN);
      const done = st.groups
        .filter((g) => groupStatus(g, now) !== GB_STATUS.OPEN)
        .sort((a, b) => String(b.deadlineAt).localeCompare(String(a.deadlineAt)));
      st.groups = [...live, ...done].slice(0, GB_MAX_GROUPS);
    }
    localStorage.setItem(storageKey(st.scope), JSON.stringify(st));
    return true;
  } catch {
    return false;
  }
}

const listeners = new Set();

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(detail) {
  listeners.forEach((fn) => { try { fn(detail); } catch { /* 订阅者异常不影响主流程 */ } });
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
    && typeof CustomEvent !== 'undefined') {
    try { window.dispatchEvent(new CustomEvent('groupbuy:changed', { detail })); } catch { /* noop */ }
  }
}

/* ==================== 动作区：视图层唯一入口 ==================== */

/** 生成一个团 id（URL 里可见，短且不含业务含义）。 */
function newGroupId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `gb_${now.toString(36)}${rand}`;
}

/** 建团：product 至少要有 id / name / price。人数必须在档位表里。 */
export function createGroup(product, size, ownerName = GB_OWNER_FALLBACK, now = Date.now()) {
  const p = product || {};
  const unitPrice = Number(p.price);
  if (!p.id || !Number.isFinite(unitPrice) || unitPrice <= 0) {
    return { ok: false, reason: 'invalid_product' };
  }
  if (!GB_TIERS.some((t) => t.size === Number(size))) {
    return { ok: false, reason: 'invalid_size' };
  }
  const st = load();
  if (st.groups.length >= GB_MAX_GROUPS) {
    // 满仓时先把已结束的团清掉，清完还满就拒绝（不静默丢用户正在进行的团）
    const nowMs = now;
    const live = st.groups.filter((g) => groupStatus(g, nowMs) === GB_STATUS.OPEN);
    if (live.length >= GB_MAX_GROUPS) return { ok: false, reason: 'full' };
    st.groups = live;
  }
  const tier = tierBySize(Number(size));
  const group = normalizeGroup({
    id: newGroupId(now),
    no: newGroupNo(st.groups, now),
    productId: String(p.id),
    product: { id: String(p.id), name: p.name || '', pic: p.pic || '', coverColor: p.coverColor || '', price: unitPrice },
    size: tier.size,
    discount: tier.discount,
    unitPrice,
    groupPrice: gbPriceOf(unitPrice, tier.discount),
    members: [{ name: String(ownerName || GB_OWNER_FALLBACK).slice(0, 24), owner: true, joinedAt: new Date(now).toISOString() }],
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + GB_DURATION_MS).toISOString(),
  });
  st.groups = [group, ...st.groups];
  if (!save(st)) return { ok: false, reason: 'storage' };
  notify({ kind: 'create', id: group.id, group });
  return { ok: true, group };
}

export function listGroups() {
  return load().groups;
}

export function getGroup(id) {
  const key = String(id || '');
  return load().groups.find((g) => g.id === key) || null;
}

/** 模拟好友参团（演示入口，视图层做成不显眼的次要按钮）。 */
export function simulateJoin(id, now = Date.now()) {
  const st = load();
  const idx = st.groups.findIndex((g) => g.id === String(id || ''));
  if (idx < 0) return { ok: false, reason: 'not_found' };
  const { group, result } = addMember(st.groups[idx], pickFriendName(st.groups[idx]), now);
  if (!result.ok) return result;
  st.groups[idx] = group;
  if (!save(st)) return { ok: false, reason: 'storage' };
  notify({ kind: result.reason, id: group.id, group, result });
  return { ...result, group };
}

/** 记录「已分享过」：积分奖励由视图层走 share 行为，这里只留痕，便于详情页显示分享状态。 */
export function markShared(id, now = Date.now()) {
  const st = load();
  const idx = st.groups.findIndex((g) => g.id === String(id || ''));
  if (idx < 0) return { ok: false, reason: 'not_found' };
  st.groups[idx].sharedAt = new Date(now).toISOString();
  if (!save(st)) return { ok: false, reason: 'storage' };
  notify({ kind: 'share', id: st.groups[idx].id, group: st.groups[idx] });
  return { ok: true };
}

/** 删除一个团（只给「取消我的团」用，不影响已生成的订单）。 */
export function removeGroup(id) {
  const st = load();
  const before = st.groups.length;
  st.groups = st.groups.filter((g) => g.id !== String(id || ''));
  if (st.groups.length === before) return { ok: false, reason: 'not_found' };
  if (!save(st)) return { ok: false, reason: 'storage' };
  notify({ kind: 'remove', id: String(id) });
  return { ok: true };
}

/* ==================== 结算草稿：把团价与团信息带到下单流程 ==================== */

export function checkoutKey(scope = scopeId()) {
  return `${CHECKOUT_PREFIX}${scope}`;
}

export function setPendingCheckout(group, now = Date.now()) {
  if (!group || !group.id) return false;
  const payload = {
    groupId: group.id,
    no: group.no,
    size: group.size,
    unitPrice: group.unitPrice,
    groupPrice: group.groupPrice,
    productId: group.productId,
    productName: group.product.name,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + GB_CHECKOUT_TTL_MS).toISOString(),
  };
  try {
    localStorage.setItem(checkoutKey(), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** 读结算草稿；过期一律返回 null（不清理也不行——后台标签页可能躺很久）。 */
export function pendingCheckout(now = Date.now()) {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(checkoutKey()) || 'null');
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== 'object' || !raw.groupId) return null;
  const exp = Date.parse(raw.expiresAt || '');
  if (Number.isFinite(exp) && now > exp) return null;
  return raw;
}

export function clearPendingCheckout() {
  try {
    localStorage.removeItem(checkoutKey());
    return true;
  } catch {
    return false;
  }
}

/** 倒计时调度器的唯一实现：只改文本，节点断开就自停，绝不留死循环。 */
export function startCountdown(node, group, onTick) {
  if (typeof document === 'undefined' || !node) return () => {};
  let timer = null;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const run = () => {
    // 节点被路由切换摘掉后立即收手，避免整页驻留的 interval
    if (!node.isConnected) { stop(); return; }
    if (groupStatus(group) !== GB_STATUS.OPEN) { stop(); if (typeof onTick === 'function') onTick(0, true); return; }
    if (typeof onTick === 'function') onTick(remainingMs(group), false);
  };
  run();
  if (groupStatus(group) === GB_STATUS.OPEN) timer = setInterval(run, GB_TICK_MS);
  return stop;
}
