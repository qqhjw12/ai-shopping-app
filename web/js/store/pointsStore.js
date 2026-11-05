/**
 * pointsStore.js —— 积分账户 / 流水 / 任务状态数据层（纯函数规则 + localStorage 仓储）。
 *
 * 分层：
 *   · 纯函数区（dateKey / levelOf / signIn / claimTask / applyBehavior…）不碰存储、不碰 DOM，
 *     Node 构建检查可直接 import 断言；
 *   · 仓储区（load / save / recordBehavior / doSignIn / doClaim）按 scopeId() 分桶持久化，
 *     并通知订阅者重绘；
 *   · 依赖方向单向：本文件 → pointsConfig.js / userScope.js；绝不反向 import 任何视图模块。
 *
 * 按用户隔离：storage key = `maison_points_v1::<scopeId()>`，
 * 已登录用 `u:<用户 id>`，未登录用持久匿名 id `l:<…>`，换账号即换桶。
 */
import {
  STORAGE_PREFIX, LEDGER_MAX, SIGNIN_HISTORY_MAX, CALENDAR_DAYS,
  SIGNIN_RULES, LEVELS, LEDGER_TYPES, TASK_DEFS, TASK_STATUS, BEHAVIOR_TASKS,
} from './pointsConfig.js';
import { scopeId } from './userScope.js';

/* ==================== 纯函数：日期 ==================== */

/** 本地日期 YYYY-MM-DD（不用 toISOString，避免 UTC 偏移把「今天」算错） */
export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 在 YYYY-MM-DD 上偏移 delta 天 */
export function offsetDateKey(key, delta) {
  const [y, m, d] = String(key).split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + delta));
}

/** 所在周的周一日期（周一 = 0） */
export function weekKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
  return offsetDateKey(key, -dow);
}

/** 任务周期键：daily=当天，weekly=本周一，once=常量 */
export function periodKeyOf(type, today) {
  if (type === 'daily') return today;
  if (type === 'weekly') return `w:${weekKey(today)}`;
  return 'once';
}

/** 最近 n 天（旧 → 新），供签到日历使用 */
export function calendarDays(today, n = CALENDAR_DAYS) {
  return Array.from({ length: n }, (_, i) => offsetDateKey(today, i - (n - 1)));
}

/* ==================== 纯函数：等级与签到规则 ==================== */

export function levelOf(totalEarned) {
  let cur = LEVELS[0];
  for (const l of LEVELS) if (Number(totalEarned) >= l.min) cur = l;
  return cur;
}

/** 等级进度：ratio ∈ [0,1]，Lv5 恒为 1；remain 为距下一级差值 */
export function levelProgress(totalEarned) {
  const current = levelOf(totalEarned);
  const idx = LEVELS.findIndex((l) => l.level === current.level);
  const next = LEVELS[idx + 1] || null;
  if (!next) return { current, next: null, ratio: 1, remain: 0 };
  const ratio = Math.max(0, Math.min(1, (Number(totalEarned) - current.min) / (next.min - current.min)));
  return { current, next, ratio, remain: Math.max(0, next.min - Number(totalEarned)) };
}

/** 签到奖励：基础分 + 连续里程碑加成（7 天档优先于 3 天档） */
export function signInReward(streak) {
  const n = Number(streak) || 0;
  const hit = SIGNIN_RULES.milestones.find((m) => n > 0 && n % m.every === 0);
  const bonus = hit ? hit.bonus : 0;
  return { base: SIGNIN_RULES.base, bonus, label: hit ? hit.label : '', total: SIGNIN_RULES.base + bonus };
}

/* ==================== 纯函数：状态构造与规整 ==================== */

export function createState(userId = scopeId(), today = dateKey()) {
  return {
    userId,
    account: {
      points: 0, level: 1, totalEarned: 0,
      signInStreak: 0, lastSignInDate: '', signInDates: [],
    },
    ledger: [],
    tasks: Object.fromEntries(TASK_DEFS.map((t) => [t.id, {
      progress: 0, status: TASK_STATUS.ACTIVE,
      periodKey: periodKeyOf(t.type, today), claimedAt: null,
    }])),
    dedupe: {},
    updatedAt: new Date().toISOString(),
  };
}

/** 读盘规整：补齐缺失字段 + 按周期重置每日/每周任务 + 状态自洽 */
export function normalizeState(raw, userId = scopeId(), today = dateKey()) {
  const base = createState(userId, today);
  if (!raw || typeof raw !== 'object') return base;
  const srcTasks = (raw.tasks && typeof raw.tasks === 'object') ? raw.tasks : {};
  const srcDedupe = (raw.dedupe && typeof raw.dedupe === 'object') ? raw.dedupe : {};
  const st = {
    ...base,
    ...raw,
    userId,
    account: { ...base.account, ...(raw.account || {}) },
    ledger: Array.isArray(raw.ledger) ? [...raw.ledger] : [],
    tasks: Object.fromEntries(TASK_DEFS.map((t) => [t.id, { ...(srcTasks[t.id] || base.tasks[t.id]) }])),
    dedupe: Object.fromEntries(Object.entries(srcDedupe).map(([k, v]) => [k, {
      periodKey: v && v.periodKey,
      ids: Array.isArray(v && v.ids) ? [...v.ids] : [],
    }])),
  };
  st.account.signInDates = Array.isArray(st.account.signInDates) ? [...st.account.signInDates] : [];
  st.account.points = Number(st.account.points) || 0;
  st.account.totalEarned = Number(st.account.totalEarned) || 0;
  st.account.signInStreak = Number(st.account.signInStreak) || 0;
  st.account.lastSignInDate = String(st.account.lastSignInDate || '');
  st.account.level = levelOf(st.account.totalEarned).level;

  TASK_DEFS.forEach((def) => {
    const cur = st.tasks[def.id];
    const pk = periodKeyOf(def.type, today);
    if (def.type !== 'once' && cur.periodKey !== pk) {
      st.tasks[def.id] = {
        progress: 0, status: TASK_STATUS.ACTIVE, periodKey: pk, claimedAt: null,
      };
      return;
    }
    if (def.type === 'once') cur.periodKey = 'once';
    if (cur.status === TASK_STATUS.DONE) {
      cur.progress = def.target;
      return;
    }
    cur.progress = Math.min(def.target, Number(cur.progress) || 0);
    cur.status = cur.progress >= def.target ? TASK_STATUS.CLAIMABLE : TASK_STATUS.ACTIVE;
  });
  return st;
}

/** 积分入账（写流水 + 重算等级），只作用于传入的 state 对象 */
function addPoints(st, amount, type, description, today) {
  const value = Number(amount) || 0;
  st.account.points += value;
  st.account.totalEarned += value;
  st.account.level = levelOf(st.account.totalEarned).level;
  st.ledger.unshift({
    id: `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    userId: st.userId,
    type,
    amount: value,
    description,
    createdAt: new Date().toISOString(),
    date: today,
  });
  st.ledger = st.ledger.slice(0, LEDGER_MAX);
  st.updatedAt = new Date().toISOString();
}

/* ==================== 纯函数：业务规则 ==================== */

/** 每日签到。返回 { state, result }；同日重复签到 result.ok=false，不加分 */
export function signIn(state, today = dateKey()) {
  const st = normalizeState(state, state.userId, today);
  const a = st.account;
  if (a.lastSignInDate === today) {
    return { state: st, result: { ok: false, reason: 'already', amount: 0 } };
  }
  const streak = a.lastSignInDate === offsetDateKey(today, -1) ? a.signInStreak + 1 : 1;
  const reward = signInReward(streak);
  a.signInStreak = streak;
  a.lastSignInDate = today;
  a.signInDates = a.signInDates.filter((d) => d !== today).concat(today).slice(-SIGNIN_HISTORY_MAX);
  addPoints(st, reward.total, LEDGER_TYPES.SIGNIN,
    `每日签到${reward.label ? ` · ${reward.label}加成` : ''}`, today);
  return {
    state: st,
    result: {
      ok: true, amount: reward.total, base: reward.base,
      bonus: reward.bonus, label: reward.label, streak,
    },
  };
}

/** 累加真实行为进度。view_product 按当日不同商品 id 去重，避免刷新同一页刷进度 */
export function applyBehavior(state, behavior, meta = {}, today = dateKey()) {
  const st = normalizeState(state, state.userId, today);
  const ids = BEHAVIOR_TASKS[behavior] || [];
  if (!ids.length) return { state: st, changed: [] };

  let dedupeHit = false;
  if (behavior === 'view_product') {
    const d = st.dedupe.view_product || { periodKey: '', ids: [] };
    if (d.periodKey !== today) { d.periodKey = today; d.ids = []; }
    const pid = String((meta && meta.productId) || '');
    if (pid && d.ids.includes(pid)) dedupeHit = true;
    else if (pid) d.ids.push(pid);
    st.dedupe.view_product = d;
  }

  const changed = [];
  if (!dedupeHit) {
    ids.forEach((id) => {
      const def = TASK_DEFS.find((t) => t.id === id);
      const t = st.tasks[id];
      if (!def || t.status === TASK_STATUS.DONE) return;
      t.progress = Math.min(def.target, t.progress + 1);
      t.status = t.progress >= def.target ? TASK_STATUS.CLAIMABLE : TASK_STATUS.ACTIVE;
      changed.push({ id, progress: t.progress, status: t.status });
    });
  }
  return { state: st, changed };
}

/** 领取任务奖励：仅「可领取」可领，领取后写流水并置「已完成」，重复领取拦截 */
export function claimTask(state, taskId, today = dateKey()) {
  const st = normalizeState(state, state.userId, today);
  const def = TASK_DEFS.find((t) => t.id === taskId);
  if (!def) return { state: st, result: { ok: false, reason: 'unknown', amount: 0 } };
  const t = st.tasks[taskId];
  if (t.status !== TASK_STATUS.CLAIMABLE) {
    return {
      state: st,
      result: { ok: false, reason: t.status === TASK_STATUS.DONE ? 'claimed' : 'not-ready', amount: 0 },
    };
  }
  t.status = TASK_STATUS.DONE;
  t.claimedAt = new Date().toISOString();
  addPoints(st, def.reward, LEDGER_TYPES.TASK, `任务奖励 · ${def.title}`, today);
  return { state: st, result: { ok: true, amount: def.reward, taskId } };
}

/* ==================== 仓储层：localStorage 按用户隔离 ==================== */

export function storageKey(userId = scopeId()) {
  return `${STORAGE_PREFIX}${userId}`;
}

export function load(today = dateKey()) {
  const uid = scopeId();
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey(uid)) || 'null');
  } catch {
    raw = null;
  }
  return normalizeState(raw, uid, today);
}

export function save(state) {
  try {
    localStorage.setItem(storageKey(state.userId || scopeId()), JSON.stringify(state));
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
    try { window.dispatchEvent(new CustomEvent('points:changed', { detail })); } catch { /* noop */ }
  }
}

/* ==================== 对外动作（埋点与页面统一入口） ==================== */

/** 真实行为埋点入口：白名单校验 → 累加进度 → 落盘 → 通知 */
export function recordBehavior(behavior, meta = {}) {
  if (!Object.prototype.hasOwnProperty.call(BEHAVIOR_TASKS, behavior)) return null;
  const st = load();
  const { state, changed } = applyBehavior(st, behavior, meta);
  save(state);
  notify({ kind: 'behavior', behavior, changed });
  return changed;
}

export function doSignIn() {
  const st = load();
  const { state, result } = signIn(st);
  if (result.ok) save(state);
  notify({ kind: 'signin', result });
  return result;
}

export function doClaim(taskId) {
  const st = load();
  const { state, result } = claimTask(st, taskId);
  if (result.ok) save(state);
  notify({ kind: 'claim', result });
  return result;
}

export function getSnapshot() {
  return load();
}
