// 优惠券规则：服务端唯一口径。
//
// 与前端 web/js/store/couponStore.js 里的同名常量/函数是一对孪生实现——
// 两边必须同值，否则「服务端算 7 天、前端算 5 天」会让同一张券在两台设备上
// 显示不同的到期日。改动请同时改两处（前端那份在 couponStore.js 顶部有对应注释）。
//
// 为什么服务端要算：取消订单返还是「改数据」，不是「只改展示」。
// 前端算完只影响本机，另一台设备下次同步会被服务端的旧到期时间覆盖回去。

/** 取消订单返还时，有效期顺延的天数 */
export const REFUND_GRACE_DAYS = 7;

/** 同一张券最多顺延几次：防「下单→取消」循环白刷有效期 */
export const MAX_EXTENSIONS = 3;

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
 * 返还后的新到期时间：从「原到期时间」与「现在」两者较晚者起算，顺延 REFUND_GRACE_DAYS 天。
 *
 * 关键点是取 max：已经过期的券退还时，从原到期日往后顺延得到的仍是过去的时间，
 * 用户拿回来一张立刻过期的废券。取 now 兜底后，过期券返还即恢复可用，
 * 未过期的券则是在原有剩余天数上继续加。
 *
 * @returns {{expiresAt: number, extended: boolean}}
 */
export function refundExpiry(currentExpiresAt, extensionCount = 0, now = Date.now()) {
  const remain = Number(currentExpiresAt) || 0;
  if ((Number(extensionCount) || 0) >= MAX_EXTENSIONS) {
    return { expiresAt: remain, extended: false };
  }
  const base = Math.max(remain, now);
  return { expiresAt: base + REFUND_GRACE_DAYS * 86400000, extended: true };
}
