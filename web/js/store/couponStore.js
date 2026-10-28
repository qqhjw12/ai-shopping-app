// 优惠券域：券目录（券中心可领）+ 我的券包（按用户隔离）+ 结算可用性推导。
//
// 三个概念必须分清，否则页面之间会互相打架：
//   1) 券目录 COUPON_CATALOG —— 「市面上有哪些券」，只读，来自运营配置 / 网关 coupons 表；
//   2) 我的券包 wallet —— 「我手里有哪些券」，每张是一条实例，带领取时间、到期时间、使用状态；
//   3) 结算可用性 decorateMine —— 只在某一笔订单的金额下才有意义（门槛够了才可用），
//      所以永远按当前商品总额实时重算，不把 usable / worth 落盘。
//
// 券的面额口径（与网关 /api/coupons 完全同构）：
//   - kind: 'cash' 满减券（amount = 直减金额）
//           'discount' 折扣券（amount = 减免百分比，10 表示 9 折）
//   - threshold: 使用门槛（按商品总额判断，不含运费）
//
// 状态口径：
//   - 落盘只存 'unused' / 'used'；'expired' 不落盘，一律由「当前时间 > expiresAt」推导。
//     这样过期不依赖任何一次定时任务，打开页面看到的永远是真实状态。
//   - 领取判重与网关一致：同一 couponId 只要还有一张「未使用」的就不许重复领
//     （用掉 / 过期之后可以再领一次，符合真实电商的复领规则）。
import { api, isMissingEndpoint } from '../api.js';

const WALLET_PREFIX = 'maison_coupons::';
const MAX_WALLET = 40;
const DAY = 86400000;

/**
 * 券目录：券中心列表就是它。
 * validDays 是「领取后多少天到期」（真实系统里通常由运营配死有效期，
 * 这里用相对天数，保证任何时候打开演示站都能看到「即将过期」这类真实状态）。
 */
export const COUPON_CATALOG = [
  {
    id: 'demo-c30',
    title: '新人礼 · 满 99 减 30',
    kind: 'cash',
    threshold: 99,
    amount: 30,
    validDays: 30,
    scopeText: '全场通用',
    note: '新客首单专属，可与会员折扣叠加',
  },
  {
    id: 'demo-c80',
    title: '会员日 · 满 599 减 80',
    kind: 'cash',
    threshold: 599,
    amount: 80,
    validDays: 15,
    scopeText: '全场通用',
    note: '每月会员日发放，数量有限',
  },
  {
    id: 'demo-c90',
    title: '尊享 9 折 · 满 199 可用',
    kind: 'discount',
    threshold: 199,
    amount: 10,
    validDays: 30,
    scopeText: '全场通用',
    note: '按商品总额的 10% 抵扣，上不封顶',
  },
  {
    id: 'cp-home50',
    title: '家居专场 · 满 399 减 50',
    kind: 'cash',
    threshold: 399,
    amount: 50,
    validDays: 20,
    scopeText: '家居生活类商品',
    note: '限家居生活馆内商品使用',
  },
  {
    id: 'cp-bag20',
    title: '箱包配饰 · 满 259 减 20',
    kind: 'cash',
    threshold: 259,
    amount: 20,
    validDays: 45,
    scopeText: '箱包配饰类商品',
    note: '每单限用一张',
  },
  {
    id: 'cp-big150',
    title: '尊享大额 · 满 1299 减 150',
    kind: 'cash',
    threshold: 1299,
    amount: 150,
    validDays: 7,
    scopeText: '全场通用',
    note: '大额订单专享，领取后 7 天内有效',
  },
];

/**
 * 兼容层：早期结算页直接拿这三张演示券算可用性。
 * 保留导出，语义等同「目录里的前三张」，老断言与老调用不用改。
 */
export const DEMO_COUPONS = COUPON_CATALOG.slice(0, 3).map((c) => ({
  id: c.id, couponId: c.id, title: c.title, kind: c.kind, threshold: c.threshold, amount: c.amount,
}));

const CATALOG_BY_ID = new Map(COUPON_CATALOG.map((c) => [c.id, c]));

/**
 * 「这不是故障」的安静判定：静态托管 404 / 离线 / 无 status 的网络异常都属于演示模式，
 * 不该在控制台刷警告——真正要排查的是 4xx 业务拒绝和 5xx。
 */
function quietError(e) {
  return !e || isMissingEndpoint(e) || e.kind === 'offline' || !e.status;
}

export function catalogCoupon(couponId) {
  return CATALOG_BY_ID.get(String(couponId || '')) || null;
}

/* ---------------- 金额规则（纯函数，可单测） ---------------- */

/** 当前金额下这张券值多少钱（与网关 listCoupons 同一公式） */
export function worthOf(coupon, amount) {
  const c = coupon || {};
  const a = Math.max(0, Number(amount) || 0);
  if (a < (Number(c.threshold) || 0)) return 0;
  if (c.kind === 'discount') return Math.floor((a * Number(c.amount || 0)) / 100);
  return Math.max(0, Number(c.amount) || 0);
}

/**
 * 统一 decorate：补 usable / worth（以传入金额本地实时重算，不信任缓存值）。
 * 注意 worth 永远 ≤ 当前商品总额，结算页再经 computeAmounts 二次夹逼，
 * 所以「券面额大于订单金额」不会算出负数应付。
 */
export function decorate(list, amount) {
  const a = Math.max(0, Number(amount) || 0);
  return (Array.isArray(list) ? list : []).map((c) => {
    const worth = worthOf(c, a);
    return {
      id: c.id,
      couponId: c.couponId || c.id,
      title: c.title || '优惠券',
      kind: c.kind || 'cash',
      threshold: Number(c.threshold) || 0,
      amount: Number(c.amount) || 0,
      usable: a >= (Number(c.threshold) || 0) && (Number(c.amount) || 0) > 0,
      worth,
    };
  });
}

/**
 * 最优券 id：可用券里省得最多的；平手时优先门槛高的（更"贵"的券先花掉）。
 * 返回 null 表示没有可用券（或列表为空）。
 */
export function bestCouponId(coupons) {
  let best = null;
  for (const c of coupons || []) {
    if (!c.usable || !(c.worth > 0)) continue;
    if (!best || c.worth > best.worth || (c.worth === best.worth && c.threshold > best.threshold)) best = c;
  }
  return best ? best.id : null;
}

/** 距离可用还差多少钱（不可用券展示「再买 ¥X 可用」用） */
export function gapToThreshold(coupon, amount) {
  const c = coupon || {};
  return Math.max(0, (Number(c.threshold) || 0) - (Math.max(0, Number(amount) || 0)));
}

/** 面额展示：满减写「¥30」，折扣写「9 折」 */
export function fmtCouponValue(coupon) {
  const c = coupon || {};
  const n = Number(c.amount) || 0;
  if (c.kind === 'discount') return `${trimNum((100 - n) / 10)} 折`;
  return `¥${trimNum(n)}`;
}

function trimNum(n) {
  return String(Math.round(Number(n) * 10) / 10).replace(/\.0$/, '');
}

/* ---------------- 券包读写 ---------------- */

function key(userId) {
  return `${WALLET_PREFIX}${userId || 'anonymous'}`;
}

function readRaw(userId) {
  try {
    const arr = JSON.parse(localStorage.getItem(key(userId)) || '[]');
    return Array.isArray(arr) ? arr.filter((c) => c && c.couponId) : [];
  } catch {
    return [];
  }
}

function writeRaw(userId, list) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(list.slice(0, MAX_WALLET)));
  } catch {
    /* 配额写满不该让领券变成抛错——内存结果仍可用，只是刷新后可能丢 */
  }
  notify(userId);
}

/* ---------------- 状态推导 ---------------- */

/** 实例的真实状态：used > expired > unused（expired 由到期时间推导，不落盘） */
export function couponState(inst, now = Date.now()) {
  const c = inst || {};
  if (c.status === 'used') return 'used';
  if (Number(c.expiresAt) && now > Number(c.expiresAt)) return 'expired';
  return 'unused';
}

export const STATE_TEXT = { unused: '未使用', used: '已使用', expired: '已过期' };

function stampId(seed) {
  return `w_${seed.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 领券时刻 → 到期时间（毫秒）。目录里的 validDays 优先，缺失按 30 天兜底。 */
function expiresOf(catalog, at = Date.now()) {
  const days = Number(catalog && catalog.validDays) || 30;
  return at + days * DAY;
}

/* ---------------- 读取 ---------------- */

/** 我的券包（同步读本地 + 推导状态），按到期时间升序（快过期的排前面） */
export function listWallet(userId) {
  return readRaw(userId)
    .map((c) => ({ ...c, state: couponState(c) }))
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'unused' ? -1 : b.state === 'unused' ? 1 : 0;
      return Number(a.expiresAt || 0) - Number(b.expiresAt || 0);
    });
}

/** 分状态取券 */
export function walletByState(userId, state) {
  return listWallet(userId).filter((c) => c.state === state);
}

/** 计数：未使用 / 已使用 / 已过期 */
export function walletStats(userId) {
  const list = listWallet(userId);
  return {
    unused: list.filter((c) => c.state === 'unused').length,
    used: list.filter((c) => c.state === 'used').length,
    expired: list.filter((c) => c.state === 'expired').length,
    total: list.length,
  };
}

/** 这张券目录券是否已在卡包里（有未使用的一张即视为已领取，与网关判重一致） */
export function hasClaimed(userId, couponId) {
  const id = String(couponId || '');
  return readRaw(userId).some((c) => String(c.couponId) === id && couponState(c) === 'unused');
}

/* ---------------- 变更 ---------------- */

/**
 * 领券：本地先落盘（离线也能领），网关联通时再补一次 POST。
 * 返回 { ok, error, coupon }；重复领取返回 { ok:false, error:'该券已在卡包中' }。
 */
export async function claimCoupon(userId, couponId) {
  const catalog = catalogCoupon(couponId);
  if (!catalog) return { ok: false, error: '优惠券不存在' };
  if (!userId) return { ok: false, error: '请先登录再领取' };
  if (hasClaimed(userId, couponId)) return { ok: false, error: '该券已在卡包中' };

  const list = readRaw(userId);
  const now = Date.now();
  const inst = {
    id: stampId(now),
    couponId: catalog.id,
    title: catalog.title,
    kind: catalog.kind,
    threshold: Number(catalog.threshold) || 0,
    amount: Number(catalog.amount) || 0,
    scopeText: catalog.scopeText || '全场通用',
    status: 'unused',
    claimedAt: new Date(now).toISOString(),
    expiresAt: expiresOf(catalog, now),
  };
  writeRaw(userId, [inst, ...list]);

  // 网关补写：失败不影响本地领取结果（静态托管下 /api/* 一定 404，属预期）
  let online = false;
  try {
    await api('/api/coupons', { method: 'POST', body: { userId, couponId }, retries: 0 });
    online = true;
  } catch (e) {
    if (!quietError(e)) console.warn('[coupons] 领取同步失败，已存本地', e && e.message);
  }
  return { ok: true, coupon: { ...inst, state: 'unused' }, online };
}

/**
 * 下单核销：把这张券标记为已使用（挂上订单号）。
 * 只核销「未使用」的那一张，已过期的券不会被误标成已使用。
 */
export function markCouponUsed(userId, couponId, orderId) {
  const id = String(couponId || '');
  if (!id) return null;
  const list = readRaw(userId);
  const hit = list.find((c) => String(c.couponId) === id && couponState(c) === 'unused');
  if (!hit) return null;
  hit.status = 'used';
  hit.usedAt = new Date().toISOString();
  hit.orderId = String(orderId || '');
  writeRaw(userId, list);
  return { ...hit, state: 'used' };
}

/**
 * 取消订单返还：按订单号把券退回未使用。
 * mock 口径——真实系统要防「过期券返还后又可用」的作弊，这里只做状态回退，
 * 若券已自然过期则保持过期（返还的是「未使用」状态，不是延长有效期）。
 */
export function refundCouponsByOrder(userId, orderId) {
  const id = String(orderId || '');
  if (!id) return { restored: 0, coupons: [] };
  const list = readRaw(userId);
  const hit = list.filter((c) => c.status === 'used' && String(c.orderId || '') === id);
  hit.forEach((c) => {
    c.status = 'unused';
    c.usedAt = null;
    c.orderId = null;
    c.refundedAt = new Date().toISOString();
  });
  if (hit.length) writeRaw(userId, list);
  return { restored: hit.length, coupons: hit.map((c) => ({ ...c, state: couponState(c) })) };
}

/* ---------------- 网关联通 ---------------- */

/**
 * 卡包校准：本地先出（秒开），网关返回后把「本地没有的券」补进来。
 * 只补不删——本地领取的券即使网关没有（离线领取）也不该消失。
 */
export async function hydrateWallet(userId) {
  const local = listWallet(userId);
  if (!userId) return { list: local, online: false };
  let remote = null;
  try {
    const d = await api(`/api/coupons?userId=${encodeURIComponent(userId)}`, { retries: 0 });
    remote = Array.isArray(d && d.coupons) ? d.coupons : null;
  } catch (e) {
    if (!quietError(e)) console.warn('[coupons] 卡包校准失败', e && e.message);
    remote = null;
  }
  if (!remote || !remote.length) return { list: local, online: remote !== null };

  const known = new Set(readRaw(userId).map((c) => String(c.couponId)));
  const added = [];
  const now = Date.now();
  remote.forEach((r) => {
    const cid = String(r.couponId || r.id || '');
    if (!cid || known.has(cid)) return;
    const catalog = catalogCoupon(cid) || {};
    known.add(cid);
    added.push({
      id: stampId(now + added.length),
      couponId: cid,
      title: r.title || catalog.title || '优惠券',
      kind: r.kind || catalog.kind || 'cash',
      threshold: Number(r.threshold ?? catalog.threshold) || 0,
      amount: Number(r.amount ?? catalog.amount) || 0,
      scopeText: catalog.scopeText || '全场通用',
      status: 'unused',
      claimedAt: new Date(now).toISOString(),
      expiresAt: expiresOf(catalog, now),
      fromServer: true,
    });
  });
  if (added.length) writeRaw(userId, [...added, ...readRaw(userId)]);
  return { list: listWallet(userId), online: true };
}

/* ---------------- 结算可用性 ---------------- */

/**
 * 结算页用的券视图：usable / worth / reason 全按当前商品总额实时算。
 * reason 是要展示给用户的「为什么不能用」，别只留一个灰按钮。
 */
export function decorateMine(list, amount) {
  const a = Math.max(0, Number(amount) || 0);
  return (Array.isArray(list) ? list : []).map((c) => {
    const state = c.state || couponState(c);
    const worth = worthOf(c, a);
    const usable = state === 'unused' && a >= (Number(c.threshold) || 0) && (Number(c.amount) || 0) > 0;
    let reason = '';
    if (state === 'used') reason = '已使用';
    else if (state === 'expired') reason = '已过期';
    else if (!usable) reason = `满 ${fmtYuan(Number(c.threshold) || 0)} 可用`;
    return {
      ...c,
      // 选中标识统一用 couponId：券包里同一张券目录券最多只有一张「未使用」，
      // couponId 就足以唯一定位，页面不必在两套 id（实例 id / 券目录 id）之间来回换算。
      id: String(c.couponId || c.id || ''),
      state,
      usable,
      worth: usable ? worth : 0,
      gap: usable ? 0 : gapToThreshold(c, a),
      reason,
    };
  });
}

function fmtYuan(n) {
  return `¥${Number(n).toLocaleString()}`;
}

/**
 * 结算列表排序：可用的先出（省得多在前），不可用的按「未达门槛 → 已过期 → 已使用」垫后，
 * 同层里门槛低的靠前（更容易达成的券先让人看到）。
 */
export function sortForCheckout(list) {
  const stateRank = { unused: 0, expired: 1, used: 2 };
  const rank = (c) => (stateRank[c.state] === undefined ? 3 : stateRank[c.state]);
  return [...(list || [])].sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    if (a.usable) return b.worth - a.worth || b.threshold - a.threshold;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.threshold - b.threshold;
  });
}

/* ---------------- 变更订阅 ---------------- */

const listeners = new Set();

/** 订阅券包变化（领券 / 核销 / 返还），返回取消订阅函数 */
export function onWalletChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(userId) {
  // 快照遍历：订阅者里可能触发新的写入（如重绘后再次订阅），直接遍历会无限扩散
  [...listeners].forEach((fn) => {
    try {
      fn(userId);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  });
}

/**
 * 兼容层：早期结算页用 fetchCoupons 拿券。
 * 现在返回「我的券包」（真实持有），不再返回「目录全量」——
 * 否则未领取的券也能在结算页用，券中心的领取动作就没有意义了。
 */
export async function fetchCoupons(userId) {
  const { list } = await hydrateWallet(userId);
  return list.map((c) => ({
    id: c.couponId,
    couponId: c.couponId,
    title: c.title,
    kind: c.kind,
    threshold: c.threshold,
    amount: c.amount,
    state: c.state,
    expiresAt: c.expiresAt,
  }));
}
