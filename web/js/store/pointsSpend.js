/**
 * pointsSpend.js —— 积分消费适配层（本步骤新增，不改签到和任务系统）。
 *
 * 为什么单独一个文件：规格要求「再抽一次消耗 20 积分」「用积分兑换次数」，
 * 但本步骤明确「不改签到和任务系统」。既有 pointsStore.js 只有赚取类动作
 * （signIn / claimTask / applyBehavior），没有消费入口，而它的 load/save 与
 * LEDGER_TYPES.REDEEM（「兑换」）本来就是公开的、且早已预留。
 * 因此这里只做一件事：用公开仓储 API 完成一次真实的余额扣减 + 兑换流水，
 * 不触碰 pointsConfig.js / pointsStore.js / points.js 的任何一行。
 *
 * 口径与奖励底座保持一致：
 *   · 只扣当前可用积分 points，累计获得 totalEarned 与 level 不变（等级按累计获得算）；
 *   · 流水 type = 「兑换」，amount 为负，字段与既有 addPoints 完全同构；
 *   · 落盘后派发 points:changed，已打开的积分页会跟着刷新。
 */
import { load, save, dateKey } from './pointsStore.js';
import { LEDGER_TYPES, LEDGER_MAX } from './pointsConfig.js';

/**
 * 扣减积分并写一条兑换流水。
 * @param {number} amount 正整数积分
 * @param {string} description 流水描述
 * @returns {{ok:boolean, reason?:string, balance?:number, entry?:object}}
 */
export function spendPoints(amount, description) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    return { ok: false, reason: 'invalid' };
  }
  const st = load();
  if (st.account.points < n) {
    return { ok: false, reason: 'insufficient', balance: st.account.points };
  }

  st.account.points -= n;
  const today = dateKey();
  const entry = {
    id: `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    userId: st.userId,
    type: LEDGER_TYPES.REDEEM,
    amount: -n,
    description: String(description || '积分兑换'),
    createdAt: new Date().toISOString(),
    date: today,
  };
  st.ledger.unshift(entry);
  st.ledger = st.ledger.slice(0, LEDGER_MAX);
  st.updatedAt = new Date().toISOString();

  if (!save(st)) return { ok: false, reason: 'storage', balance: st.account.points + n };

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
    && typeof CustomEvent !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('points:changed', {
        detail: { kind: 'spend', amount: n, entry },
      }));
    } catch { /* 事件派发失败不影响已落盘的扣减 */ }
  }
  return { ok: true, balance: st.account.points, entry };
}

/**
 * 冲正一次已成功的 spendPoints：把余额加回并移除对应的「兑换」流水。
 * 只在下游玩法状态落盘失败时调用，避免留下「扣了积分但次数/结果没变」的窗口。
 * 不写一条新的正额流水（流水是用户可见的账本，冲正应当让这次消费像没发生过）。
 * @param {object} entry spendPoints 成功时返回的流水条目
 */
export function refundPoints(entry) {
  if (!entry || !entry.id || !Number.isFinite(entry.amount) || entry.amount >= 0) {
    return { ok: false, reason: 'invalid' };
  }
  const st = load();
  const at = st.ledger.findIndex((x) => x && x.id === entry.id);
  if (at < 0) return { ok: false, reason: 'not-found' };

  st.account.points -= entry.amount; // amount 为负，减负即加回
  st.ledger.splice(at, 1);
  st.updatedAt = new Date().toISOString();
  if (!save(st)) return { ok: false, reason: 'storage' };

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function'
    && typeof CustomEvent !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('points:changed', {
        detail: { kind: 'refund', amount: -entry.amount, entry },
      }));
    } catch { /* 事件派发失败不影响已落盘的冲正 */ }
  }
  return { ok: true, balance: st.account.points };
}

/** 只读余额，供按钮禁用态使用 */
export function pointsBalance() {
  return load().account.points;
}
