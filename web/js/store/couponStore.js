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
//
// 跨设备同步口径（syncWallet）：
//   - 服务端是「核销 / 顺延」的唯一真源：另一台设备用掉的券，本地必须跟着变已使用；
//     返还顺延过的到期时间，本地必须接受服务端的值，而不是自己再算一遍。
//   - 本地是「离线操作」的缓冲：离线领的券、离线下单核销的券，同步时补推给服务端。
//   - 只增不删：任何一侧有、另一侧没有的券都不丢，宁可多一张也不让用户觉得券消失了。
import { api, isMissingEndpoint } from '../api.js';

const WALLET_PREFIX = 'maison_coupons::';
const MAX_WALLET = 40;
const DAY = 86400000;

/**
 * 取消订单返还时，有效期顺延的天数。
 * 必须与网关 ai-gateway/src/services/couponRules.js 的 REFUND_GRACE_DAYS 同值：
 * 两边算得不一样，同一张券在两台设备上会显示不同到期日。
 */
export const REFUND_GRACE_DAYS = 7;

/** 同一张券最多顺延几次（防「下单→取消」循环白刷有效期），与网关 MAX_EXTENSIONS 同值 */
export const MAX_EXTENSIONS = 3;

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

// 运行时目录：内置目录是离线兜底，联网后由 fetchCatalog 用服务端配置覆盖
// （运营改面额/文案不用发版）。id 与网关 coupons 表严格一致，否则同一张券
// 在「券中心」和「网关卡包」里会变成两只券，同步时凭空多出一堆重复。
let runtimeCatalog = COUPON_CATALOG.map((c) => ({ ...c }));
let catalogIndex = new Map(runtimeCatalog.map((c) => [c.id, c]));

/** 当前生效的券目录（离线=内置，联网=服务端） */
export function currentCatalog() {
  return runtimeCatalog;
}

/**
 * 「这不是故障」的安静判定：静态托管 404 / 离线 / 无 status 的网络异常都属于演示模式，
 * 不该在控制台刷警告——真正要排查的是 4xx 业务拒绝和 5xx。
 */
function quietError(e) {
  return !e || isMissingEndpoint(e) || e.kind === 'offline' || !e.status;
}

export function catalogCoupon(couponId) {
  return catalogIndex.get(String(couponId || '')) || null;
}

/** 拉服务端券目录并覆盖内置目录；离线/静态站时静默返回内置目录 */
export async function fetchCatalog() {
  try {
    const d = await api('/api/coupons/catalog', { retries: 0 });
    const rows = Array.isArray(d && d.coupons) ? d.coupons.filter((r) => r && r.couponId) : [];
    if (!rows.length) return { list: runtimeCatalog, online: false };
    runtimeCatalog = rows.map((r) => {
      const local = catalogIndex.get(String(r.couponId)) || {};
      return {
        id: String(r.couponId),
        title: r.title || local.title || '优惠券',
        kind: r.kind || local.kind || 'cash',
        threshold: Number(r.threshold) || 0,
        amount: Number(r.amount) || 0,
        validDays: Number(r.validDays) || Number(local.validDays) || 30,
        scopeText: r.scopeText || local.scopeText || '全场通用',
        // note 是运营话术，网关表里没有，保留本地那份
        note: local.note || '',
      };
    });
    catalogIndex = new Map(runtimeCatalog.map((c) => [c.id, c]));
    return { list: runtimeCatalog, online: true };
  } catch (e) {
    if (!quietError(e)) console.warn('[coupons] 券目录拉取失败，继续用内置目录', e && e.message);
    return { list: runtimeCatalog, online: false };
  }
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

  // 网关补写：失败不影响本地领取结果（静态托管下 /api/* 一定 404，属预期）。
  // 成功后用服务端的实例 id 与到期时间回填——各设备看到的到期日必须一致，
  // 否则「这台显示还剩 29 天、那台显示 30 天」。
  let online = false;
  try {
    const d = await api('/api/coupons', { method: 'POST', body: { userId, couponId }, retries: 0 });
    online = true;
    const server = d && d.coupon;
    if (server) {
      const raw = readRaw(userId);
      const mine = raw.find((c) => c.id === inst.id);
      if (mine) {
        if (server.id != null) mine.serverId = server.id;
        if (Number(server.expiresAt)) mine.expiresAt = Number(server.expiresAt);
        if (server.scopeText) mine.scopeText = server.scopeText;
        writeRaw(userId, raw);
      }
    }
  } catch (e) {
    if (!quietError(e)) console.warn('[coupons] 领取同步失败，已存本地', e && e.message);
  }
  return { ok: true, coupon: { ...inst, state: 'unused' }, online };
}

/* ---------------- 未完成操作的发件箱 ---------------- */

// 下单核销 / 取消返都是「本地先改、异步上云」。
// 直接 fire-and-forget 有一个必然翻车点：下单成功立刻跳成功页，fetch 被导航中止，
// 于是「本机显示已使用、别的设备还是未使用」。所以这些操作先落发件箱，
// 再尽力发一次（keepalive 让请求活过跳转），没送达的下次 syncWallet 重放。
const OPS_PREFIX = 'maison_coupon_ops::';
const MAX_OPS = 20;

function opsKey(userId) {
  return `${OPS_PREFIX}${userId || 'anonymous'}`;
}

function readOps(userId) {
  try {
    const arr = JSON.parse(localStorage.getItem(opsKey(userId)) || '[]');
    return Array.isArray(arr) ? arr.filter((o) => o && o.type) : [];
  } catch {
    return [];
  }
}

function writeOps(userId, list) {
  try {
    localStorage.setItem(opsKey(userId), JSON.stringify(list.slice(-MAX_OPS)));
  } catch {
    /* 配额满：发件箱写不进去也不该让页面崩，本次仍会尝试直接发送 */
  }
}

function enqueueOp(userId, op) {
  writeOps(userId, [...readOps(userId), { ...op, at: Date.now() }]);
}

function settleOp(userId, op) {
  writeOps(userId, readOps(userId).filter((o) => !(o.type === op.type && o.couponId === op.couponId && o.orderId === op.orderId)));
}

async function sendOp(userId, op) {
  if (op.type === 'use') {
    await api('/api/coupons/use', {
      method: 'POST', retries: 0, keepalive: true,
      body: { userId, couponId: op.couponId, orderId: op.orderId || '' },
    });
    return;
  }
  if (op.type === 'refund') {
    await api('/api/coupons/refund', {
      method: 'POST', retries: 0, keepalive: true,
      body: { userId, orderId: op.orderId || '' },
    });
    return;
  }
  throw new Error(`unknown coupon op: ${op.type}`);
}

/** 重放发件箱。返回 { flushed, left }：left 是仍没送达的条数（离线/无后端就留着）。 */
export async function flushCouponOps(userId) {
  const ops = readOps(userId);
  if (!ops.length) return { flushed: 0, left: 0 };
  let flushed = 0;
  const left = [];
  for (const op of ops) {
    try {
      await sendOp(userId, op);
      flushed += 1;
    } catch (e) {
      // 409/400 = 服务端已经处于目标状态（重复核销、券已被别处用掉），这条算结案
      if (e && (e.status === 409 || e.status === 400)) continue;
      if (!quietError(e)) console.warn('[coupons] 补发失败，留待下次', op.type, e && e.message);
      left.push(op);
    }
  }
  writeOps(userId, left);
  return { flushed, left: left.length };
}

/** 落发件箱 + 立刻试一次；返回的 promise 只是尽力而为，不阻塞调用方 */
function deliver(userId, op) {
  if (!userId) return Promise.resolve(false);
  enqueueOp(userId, op);
  return sendOp(userId, op)
    .then(() => {
      settleOp(userId, op);
      return true;
    })
    .catch((e) => {
      if (e && (e.status === 409 || e.status === 400)) {
        settleOp(userId, op);
        return true;
      }
      if (!quietError(e)) console.warn('[coupons] 同步失败，已留待补发', op.type, e && e.message);
      return false;
    });
}

/**
 * 下单核销：把这张券标记为已使用（挂上订单号）。
 * 只核销「未使用」的那一张，已过期的券不会被误标成已使用。
 * 联网时同步给服务端，别的设备下次同步才知道这张券已经花掉了。
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

  // 不 await：下单流程不该被网络卡住；可靠性交给发件箱 + keepalive
  deliver(userId, { type: 'use', couponId: id, orderId: String(orderId || '') });
  return { ...hit, state: 'used' };
}

/**
 * 返还后的新到期时间：从「原到期时间」与「现在」两者较晚者起算，顺延 REFUND_GRACE_DAYS 天。
 *
 * 取 max 是关键：券在订单占用的这段时间里可能已经过期，
 * 只按原到期日加 7 天会退给用户一张当场就过期的废券。
 * 取 now 兜底后，过期券返还即恢复可用，未过期的券则在剩余天数上继续加。
 *
 * 与网关 couponRules.refundExpiry 同口径（含顺延次数上限）。
 * @returns {{expiresAt:number, extended:boolean, extensionCount:number}}
 */
export function refundExpiry(currentExpiresAt, extensionCount = 0, now = Date.now()) {
  const remain = Number(currentExpiresAt) || 0;
  const used = Number(extensionCount) || 0;
  if (used >= MAX_EXTENSIONS) return { expiresAt: remain, extended: false, extensionCount: used };
  const base = Math.max(remain, now);
  return { expiresAt: base + REFUND_GRACE_DAYS * DAY, extended: true, extensionCount: used + 1 };
}

/**
 * 取消订单返还：按订单号把券退回未使用，并把有效期顺延 REFUND_GRACE_DAYS 天。
 *
 * 顺延是「补偿」不是「奖励」：用户因为订单取消才晚拿到券，
 * 剩余可用时间不该比下单前更短。每张券最多顺延 MAX_EXTENSIONS 次，
 * 超过上限的券仍然退回未使用，只是不再延长——否则「下单→取消」可以无限刷有效期。
 *
 * @returns {{restored:number, extended:number, coupons:Array}}
 */
export function refundCouponsByOrder(userId, orderId) {
  const id = String(orderId || '');
  if (!id) return { restored: 0, extended: 0, coupons: [] };
  const list = readRaw(userId);
  const now = Date.now();
  const hit = list.filter((c) => c.status === 'used' && String(c.orderId || '') === id);
  let extended = 0;
  hit.forEach((c) => {
    const ex = refundExpiry(c.expiresAt, c.extensionCount, now);
    c.status = 'unused';
    c.usedAt = null;
    c.orderId = null;
    c.refundedAt = new Date(now).toISOString();
    if (ex.extended) {
      c.expiresAt = ex.expiresAt;
      c.extensionCount = ex.extensionCount;
      c.graceDays = REFUND_GRACE_DAYS;
      extended += 1;
    }
  });
  if (hit.length) writeRaw(userId, list);

  if (hit.length && userId) {
    // 服务端才是顺延的真源：本地这份只是先让页面立刻正确，
    // 下次 syncWallet 会用服务端的 expiresAt 覆盖回来。
    deliver(userId, { type: 'refund', orderId: id });
  }
  return { restored: hit.length, extended, coupons: hit.map((c) => ({ ...c, state: couponState(c) })) };
}

/* ---------------- 网关联通（跨设备同步） ---------------- */

/** 服务端实例 → 本地实例。到期时间直接取服务端的毫秒时间戳，不在本地重算。 */
function fromRemote(r, now) {
  const catalog = catalogCoupon(r.couponId) || {};
  const state = r.state || (r.status === 'used' ? 'used' : 'unused');
  return {
    id: stampId(now + Math.floor(Math.random() * 1000)),
    serverId: r.id == null ? null : r.id,
    couponId: String(r.couponId),
    title: r.title || catalog.title || '优惠券',
    kind: r.kind || catalog.kind || 'cash',
    threshold: Number(r.threshold) || 0,
    amount: Number(r.amount) || 0,
    scopeText: r.scopeText || catalog.scopeText || '全场通用',
    status: state === 'used' ? 'used' : 'unused',
    claimedAt: Number(r.claimedAt) ? new Date(Number(r.claimedAt)).toISOString() : new Date(now).toISOString(),
    expiresAt: Number(r.expiresAt) || expiresOf(catalog, now),
    orderId: r.orderId || null,
    extensionCount: Number(r.extensionCount) || 0,
    fromServer: true,
  };
}

/**
 * 双向合并（纯函数，可单测）——「本地券包 × 网关卡包」→ 合并后的券包 + 待补推操作。
 *
 * 冲突裁决就三条：
 *   1) 服务端已核销 → 本地跟着置为已使用（另一台设备下的单，这边必须认）；
 *   2) 本地已核销、服务端还是未使用 → 分两种情况，靠「本机有没有还没送达的核销操作」区分：
 *      · 发件箱里还有这张券的 use 未确认 → 是本机离线核销没推上去，补推；
 *      · 发件箱是空的 → 说明核销早就送达了、服务端现在未使用只能是因为「订单被取消返还了」，
 *        于是本地跟着退回未使用。少了这层区分，取消订单后另一台设备会永远显示「已使用」。
 *   3) 到期时间 / 顺延次数一律取服务端的值。顺延是服务端改的数据，
 *      本地自己算出来的只会是「领取时间 + 有效天数」，同步时必须被覆盖回去。
 *
 * 不做删除：任一侧独有都保留，仅把「本地有服务端没有的券」记进 toPush 补推。
 *
 * @param {Array} localList 本地券包
 * @param {Array} remoteList 服务端卡包（含已用/已过期）
 * @param {number} [now]
 * @param {Array<{type:string, couponId?:string, orderId?:string}>} [pendingOps] 发件箱里未确认的操作
 * @returns {{list:Array, adopted:Array, toPush:string[], toUse:Array<{couponId:string, orderId:string}>}}
 */
export function mergeWallet(localList, remoteList, now = Date.now(), pendingOps = []) {
  const list = (Array.isArray(localList) ? localList : [])
    .filter((c) => c && c.couponId)
    .map((c) => ({ ...c }));
  const remote = (Array.isArray(remoteList) ? remoteList : []).filter((r) => r && r.couponId);
  const pendingUse = new Set(
    (Array.isArray(pendingOps) ? pendingOps : [])
      .filter((o) => o && o.type === 'use' && o.couponId)
      .map((o) => String(o.couponId)),
  );
  const adopted = [];
  const toPush = [];
  const toUse = [];

  // 同一张目录券可能有多张实例（用掉过又领了一次）：拿「未使用」那张当对账对象，
  // 因为领取判重、结算选券都是按未使用那张算的。
  const primary = new Map();
  list.forEach((c, i) => {
    const id = String(c.couponId);
    const cur = primary.get(id);
    if (cur === undefined) {
      primary.set(id, i);
      return;
    }
    if (couponState(list[cur], now) !== 'unused' && couponState(c, now) === 'unused') primary.set(id, i);
  });

  const seen = new Set();
  remote.forEach((r) => {
    const id = String(r.couponId);
    if (seen.has(id)) return;
    seen.add(id);
    const remoteUsed = (r.state || (r.status === 'used' ? 'used' : 'unused')) === 'used';
    const idx = primary.get(id);

    if (idx === undefined) {
      const inst = fromRemote(r, now);
      list.push(inst);
      primary.set(id, list.length - 1);
      adopted.push(inst);
      return;
    }

    const cur = list[idx];
    const localState = couponState(cur, now);
    if (remoteUsed && localState !== 'used') {
      cur.status = 'used';
      cur.orderId = r.orderId || cur.orderId || null;
      cur.usedAt = cur.usedAt || new Date(now).toISOString();
      adopted.push(cur);
    } else if (!remoteUsed && localState === 'used') {
      if (pendingUse.has(id)) {
        // 本机的核销还没送达 → 补推
        toUse.push({ couponId: id, orderId: String(cur.orderId || '') });
      } else {
        // 核销送达过了，服务端现在说未使用 = 订单被取消、券已返还 → 本地跟着退回。
        // 不这么做的话，另一台设备会永远把这张券显示成「已使用」。
        cur.status = 'unused';
        cur.orderId = null;
        cur.usedAt = null;
        cur.refundedAt = cur.refundedAt || new Date(now).toISOString();
        adopted.push(cur);
      }
    }

    const exp = Number(r.expiresAt) || 0;
    if (exp && exp !== Number(cur.expiresAt || 0)) {
      cur.expiresAt = exp;
      adopted.push(cur);
    }
    if (r.extensionCount != null && Number(r.extensionCount) !== Number(cur.extensionCount || 0)) {
      cur.extensionCount = Number(r.extensionCount);
    }
    if (r.id != null && cur.serverId == null) cur.serverId = r.id;
    // 文案以服务端为准（运营改了券名，券包里的旧名要跟着换）
    if (r.title) cur.title = r.title;
    if (r.scopeText) cur.scopeText = r.scopeText;
  });

  // 本地有、服务端一张都没有的券 → 补推领取。
  // 已核销的也要先补领再补核销：服务端没有这张券，直接推核销会「核销了个不存在的券」。
  list.forEach((c) => {
    const id = String(c.couponId);
    if (seen.has(id)) return;
    toPush.push(id);
    if (couponState(c, now) === 'used') toUse.push({ couponId: id, orderId: String(c.orderId || '') });
  });

  return { list, adopted, toPush, toUse };
}

/**
 * 卡包同步：拉服务端全量（含已用/已过期）→ 与本地双向合并 → 补推本地离线操作。
 *
 * 本地先出（秒开），成功后再覆盖：所以调用方拿到的是同步后的最新列表。
 * 服务端不可达（静态托管 / 离线）时安静返回本地结果，online 标 false。
 *
 * @returns {{list:Array, online:boolean, pushed:number, adopted:number}}
 */
export async function syncWallet(userId) {
  const local = listWallet(userId);
  if (!userId) return { list: local, online: false, pushed: 0, adopted: 0 };
  // 先把欠着的核销/返发送出去，再拉服务端状态。
  // 顺序反了会把「刚花掉的券」当成「服务端还没用」再推一遍（幂等能兜住，但白跑）。
  await flushCouponOps(userId).catch(() => {});
  let remote = null;
  try {
    const d = await api(`/api/coupons?userId=${encodeURIComponent(userId)}&all=1`, { retries: 0 });
    remote = Array.isArray(d && d.coupons) ? d.coupons : null;
  } catch (e) {
    if (!quietError(e)) console.warn('[coupons] 卡包同步失败，继续用本地', e && e.message);
    return { list: local, online: false, pushed: 0, adopted: 0 };
  }
  if (!remote) return { list: local, online: true, pushed: 0, adopted: 0 };

  const merged = mergeWallet(listWallet(userId), remote, Date.now(), readOps(userId));
  writeRaw(userId, merged.list);

  // 补推：离线领的券、离线下单核销的券。失败就留着，下次同步再试（幂等）。
  let pushed = 0;
  let latest = remote;
  for (const cid of merged.toPush) {
    try {
      const d = await api('/api/coupons', { method: 'POST', body: { userId, couponId: cid }, retries: 0 });
      if (d && Array.isArray(d.coupons)) latest = d.coupons;
      pushed += 1;
    } catch (e) {
      // 409 = 服务端其实已经有了（本地判断与服务端有偏差），不算失败
      if (e && e.status === 409) pushed += 1;
      else if (!quietError(e)) console.warn('[coupons] 补推领取失败', cid, e && e.message);
    }
  }
  for (const op of merged.toUse) {
    try {
      const d = await api('/api/coupons/use', { method: 'POST', body: { userId, ...op }, retries: 0 });
      if (d && Array.isArray(d.coupons)) latest = d.coupons;
      pushed += 1;
    } catch (e) {
      if (!quietError(e)) console.warn('[coupons] 补推核销失败', op.couponId, e && e.message);
    }
  }

  // 补推后服务端才有正式实例 id 与到期时间，再合一次让本地数据定型
  if (pushed && latest !== remote) {
    const settled = mergeWallet(listWallet(userId), latest, Date.now(), readOps(userId));
    writeRaw(userId, settled.list);
  }
  return { list: listWallet(userId), online: true, pushed, adopted: merged.adopted.length };
}

/**
 * 兼容层：早期结算页用 hydrateWallet，语义已升级为「双向同步」。
 * 保留这个名字，老调用方（结算页 / 券中心）不用改也能拿到同步结果。
 */
export async function hydrateWallet(userId) {
  return syncWallet(userId);
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
