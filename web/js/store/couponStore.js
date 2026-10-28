// 优惠券 store：结算页「自动选最优券」的数据层。
//
// 设计口径（与网关 /api/coupons 完全同构）：
//   - kind: 'cash' 满减券（amount = 直减金额）
//           'discount' 折扣券（amount = 减免百分比，10 表示 9 折）
//   - threshold: 使用门槛（按商品总额判断，不含运费）
//   - worth: 当前金额下这张券实际省多少钱（不可用恒为 0）
//
// 数据来源：API 优先（网关按 userId 实时返回卡包），静态托管 / 离线 /
// 网关 404 时回退到一组演示券——两种模式下结算页行为一致，
// 演示模式也能演示「自动选最优、不可用显示差额」的完整交互。
import { api, isMissingEndpoint } from '../api.js';

/** 演示券：三档门槛 + 一张折扣券，覆盖「最优是满减还是折扣」两种场景 */
export const DEMO_COUPONS = [
  { id: 'demo-c30', couponId: 'demo-c30', title: '新人礼 · 满 99 减 30', kind: 'cash', threshold: 99, amount: 30 },
  { id: 'demo-c80', couponId: 'demo-c80', title: '会员日 · 满 599 减 80', kind: 'cash', threshold: 599, amount: 80 },
  { id: 'demo-c90', couponId: 'demo-c90', title: '尊享 9 折 · 满 199 可用', kind: 'discount', threshold: 199, amount: 10 },
];

/** 当前金额下这张券值多少钱（与网关 listCoupons 同一公式） */
export function worthOf(coupon, amount) {
  const c = coupon || {};
  const a = Math.max(0, Number(amount) || 0);
  if (a < (Number(c.threshold) || 0)) return 0;
  if (c.kind === 'discount') return Math.floor((a * Number(c.amount || 0)) / 100);
  return Math.max(0, Number(c.amount) || 0);
}

/** 统一 decorate：补 usable / worth（以传入金额本地实时重算，不信任缓存值） */
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

/**
 * 拉取卡包：网关优先，回退演示券。
 * 返回原始券列表（不带可用性），由调用方按当前金额 decorate。
 */
export async function fetchCoupons(userId) {
  if (userId) {
    try {
      const d = await api(`/api/coupons?userId=${encodeURIComponent(userId)}`, { retries: 0 });
      if (d && Array.isArray(d.coupons) && d.coupons.length) return d.coupons;
    } catch (e) {
      // 静态托管 404 是预期路径（无后端）；其他错误记一条 warning 便于排查
      if (e && !isMissingEndpoint(e)) console.warn('[coupons] 网关取券失败，回退演示券', e && e.message);
    }
  }
  return DEMO_COUPONS.map((c) => ({ ...c }));
}
