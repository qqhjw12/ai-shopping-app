// 优惠券规则：服务端唯一口径。
//
// 顺延天数与次数上限是**运营可配**的（app_settings.coupon），不再是编译期常量：
// 「下单→取消」的补偿力度属于运营策略，按大促节奏调整不该发一次版。
// 这里只负责「怎么算」，不负责「值是多少」——值从 settingsService 来。
//
// 前端 web/js/store/couponStore.js 有一份同公式实现（离线时用缓存配置自己算），
// 公式改动请同时改两处；**数值只有服务端这一份真源**。
//
// 为什么服务端要算：取消订单返还是「改数据」，不是「只改展示」。
// 前端算完只影响本机，另一台设备下次同步会被服务端的旧到期时间覆盖回去。

import { couponRules, DEFAULT_SETTINGS } from './settingsService.js';

/**
 * 默认顺延天数。
 * 保留导出是为了兼容既有调用与文档；实际取值请用 couponRules()，
 * 运营改过配置后这里的常量就只是「默认值」而不是「生效值」。
 */
export const REFUND_GRACE_DAYS = DEFAULT_SETTINGS.coupon.refundGraceDays;

/** 默认顺延次数上限（同上：生效值请用 couponRules()） */
export const MAX_EXTENSIONS = DEFAULT_SETTINGS.coupon.maxExtensions;

export const COUPON_STATES = { unused: 'unused', used: 'used', expired: 'expired' };

/** SQLite 的 datetime 文本（UTC，形如 2026-10-28 13:00:00）→ 毫秒时间戳 */
export function parseDbTime(text) {
  if (!text) return 0;
  const s = String(text).trim().replace(' ', 'T');
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

/** 毫秒时间戳 → SQLite datetime 文本（UTC），与 datetime('now') 同格式 */
export function toDbTime(ms) {
  return new Date(Number(ms) || Date.now()).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 券实例的真实状态：used 优先，其次看是否过期（过期不落盘，永远由到期时间推导）。
 * 这样「券自然过期」不需要任何定时任务。
 */
export function stateOf(row, now = Date.now()) {
  if (!row) return COUPON_STATES.unused;
  if (row.status === 'used') return COUPON_STATES.used;
  const exp = parseDbTime(row.expires_at);
  if (exp && now > exp) return COUPON_STATES.expired;
  return COUPON_STATES.unused;
}

/**
 * 返还后的新到期时间：从「原到期时间」与「现在」两者较晚者起算，顺延 graceDays 天。
 *
 * 关键点是取 max：已经过期的券退还时，从原到期日往后顺延得到的仍是过去的时间，
 * 用户拿回来一张立刻过期的废券。取 now 兜底后，过期券返还即恢复可用，
 * 未过期的券则是在原有剩余天数上继续加。
 *
 * @param {number} currentExpiresAt 当前到期时间（毫秒）
 * @param {number} extensionCount 该券已顺延次数
 * @param {number} [now]
 * @param {{refundGraceDays:number, maxExtensions:number}} [rules] 显式传规则时照此计算（纯函数测试用）
 * @returns {{expiresAt: number, extended: boolean}}
 */
export function refundExpiry(currentExpiresAt, extensionCount = 0, now = Date.now(), rules = null) {
  const r = rules || couponRules();
  const graceDays = Math.max(0, Number(r.refundGraceDays) || 0);
  const max = Math.max(0, Number(r.maxExtensions) || 0);
  const remain = Number(currentExpiresAt) || 0;
  if ((Number(extensionCount) || 0) >= max || graceDays === 0) {
    return { expiresAt: remain, extended: false };
  }
  const base = Math.max(remain, now);
  return { expiresAt: base + graceDays * 86400000, extended: true };
}
