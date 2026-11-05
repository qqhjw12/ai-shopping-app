/**
 * blindboxStore.js —— AI 盲盒 / 每日一签数据层。
 *
 * 分层：
 *   · 纯函数区（canonicalPrefs / filterByPreferences / dailyPool / recommend /
 *     openBox / swapBox / openFortune / rerollFortune / normalizeState…）
 *     不碰存储、不碰 DOM，接收商品池作为参数，Node 构建检查可直接 import 断言；
 *   · 仓储区（load / save / subscribe）按 `scopeId()` 分桶，key =
 *     `maison_blindbox_v1::<scope>`，状态里带本地日期 date，跨天自动重置；
 *   · 动作区（doOpenBox / doSwap / doFortune / doRerollFortune / doAcceptFortune）
 *     编排「积分扣减 → 状态变更 → 落盘 → 通知」，是视图层唯一入口。
 *
 * 商品池由调用方传入（全站统一来自 views.js 的 getProducts()），本文件绝不
 * 自带一份商品数据：开出的商品一定能进详情、加购、收藏，不会出现「与商品库无关」。
 *
 * 按用户和日期隔离：同一个 key 按用户分桶，date 变化时当日次数与一签状态整体重置。
 */
import {
  BB_STORAGE_PREFIX, PREF_DIMENSIONS, MAX_PREFERENCES,
  BLINDBOX_RULES as R, REASON_TEMPLATES, FORTUNE_QUOTES, BB_LEDGER_DESC,
} from './blindboxConfig.js';
import { scopeId } from './userScope.js';
import { dateKey } from './pointsStore.js';
import { spendPoints } from './pointsSpend.js';

/* ==================== 纯函数：确定性随机 ==================== */

/** FNV-1a 字符串哈希 → uint32 */
export function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：同一 seed 永远给同一序列，便于「当日推荐池」稳定与 Node 断言 */
export function rng(seed) {
  let a = hashStr(seed) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickBySeed(list, seed, excluded = []) {
  if (!Array.isArray(list) || !list.length) return null;
  const ex = new Set(excluded.map(String));
  const fresh = list.filter((p) => !ex.has(String(p && p.id)));
  const pool = fresh.length ? fresh : list;
  return pool[Math.floor(rng(seed)() * pool.length)];
}

/* ==================== 纯函数：偏好与商品文本 ==================== */

export function textOf(p) {
  if (!p) return '';
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : '';
  return [p.name, p.category, p.subCategory, p.brand, p.highlight, p.description, tags]
    .filter(Boolean).join(' ');
}

/** 只保留配置里存在的维度/选项，且最多 MAX_PREFERENCES 个（防止绕过次数与规则） */
export function canonicalPrefs(prefs) {
  const out = {};
  for (const dim of PREF_DIMENSIONS) {
    const id = prefs && prefs[dim.key];
    if (!id || !dim.options.some((o) => o.id === id)) continue;
    if (Object.keys(out).length >= MAX_PREFERENCES) break;
    out[dim.key] = id;
  }
  return out;
}

export function prefsEntries(prefs) {
  const clean = canonicalPrefs(prefs);
  const out = [];
  for (const dim of PREF_DIMENSIONS) {
    const opt = dim.options.find((o) => o.id === clean[dim.key]);
    if (opt) out.push({ dim, opt });
  }
  return out;
}

export function prefsLabel(prefs) {
  return prefsEntries(prefs).map((e) => e.opt.label).join(' · ') || '不设限';
}

function activeConditions(prefs) {
  const conds = [];
  for (const { dim, opt } of prefsEntries(prefs)) {
    if (dim.key === 'budget') {
      conds.push((p) => {
        const v = Number(p && p.price);
        return Number.isFinite(v) && v >= opt.min && v < opt.max;
      });
    } else if (opt.match instanceof RegExp) {
      conds.push((p) => opt.match.test(textOf(p)));
    }
  }
  return conds;
}

/**
 * 按偏好过滤：多个维度是 AND。商品库里某些组合可能为空，
 * 于是「逐个放宽条件 → 最后退回全库」，保证永远有结果且结果始终来自商品库。
 */
export function filterByPreferences(pool, prefs) {
  const list = Array.isArray(pool) ? pool : [];
  const conds = activeConditions(prefs);
  if (!conds.length || !list.length) return { items: list.slice(), relaxed: false };
  for (let n = conds.length; n > 0; n -= 1) {
    const items = list.filter((p) => conds.slice(0, n).every((c) => c(p)));
    if (items.length) return { items, relaxed: n < conds.length };
  }
  return { items: list.slice(), relaxed: true };
}

/** 当日推荐池：按 用户 + 日期 确定性洗牌取前 size 个，同一天刷新不变 */
export function dailyPool(pool, scope, today, size = R.dailyPoolSize) {
  const list = Array.isArray(pool) ? pool.slice() : [];
  if (!list.length) return [];
  const r = rng(`${scope}|${today}|daily-pool`);
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    const t = list[i]; list[i] = list[j]; list[j] = t;
  }
  return list.slice(0, Math.max(1, size));
}

/* ==================== 纯函数：推荐理由 ==================== */

function ctxFor(p, prefs) {
  const tags = Array.isArray(p.tags) ? p.tags : [];
  return {
    prefs: prefsLabel(prefs),
    name: p.name || '这件好物',
    category: p.category || p.subCategory || '在售目录',
    brand: p.brand || 'MAISON',
    price: `¥${Number(p.price || 0).toLocaleString('zh-CN')}`,
    tag: (tags[0] || p.category || '精选'),
  };
}

export function fillReason(text, ctx) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => {
    const v = ctx[k];
    return v == null || v === '' ? '…' : String(v);
  }).replace(/\s+/g, ' ').trim();
}

/** 12 种句式里挑一种，并排除上一次用过的，避免连续两次一模一样 */
export function pickReason(ctx, seed, lastId = '') {
  const list = REASON_TEMPLATES.filter((t) => t.id !== lastId);
  const tpl = list[Math.floor(rng(`${seed}|reason`)() * list.length)] || REASON_TEMPLATES[0];
  return { reasonId: tpl.id, reason: fillReason(tpl.text, ctx) };
}

/** 从「按偏好过滤后的商品库」中抽 1 个，排除当天已开出的，并生成一行 AI 理由 */
export function recommend(pool, prefs, seed, excluded = [], lastReasonId = '') {
  const { items, relaxed } = filterByPreferences(pool, prefs);
  const product = pickBySeed(items, seed, excluded);
  if (!product) return null;
  const picked = pickReason(ctxFor(product, prefs), seed, lastReasonId);
  return { product, relaxed, ...picked };
}

/* ==================== 纯函数：状态构造与规整 ==================== */

export function createState(scope = scopeId(), today = dateKey()) {
  return {
    scope,
    date: today,
    box: {
      opened: false, draws: 0, swaps: 0, pointSwaps: 0,
      prefs: {}, current: null, history: [], lastReasonId: '',
    },
    fortune: {
      date: '', quoteId: '', quote: '', productId: '',
      accepted: false, rerolls: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));

/** 读盘规整：跨天整体重置；补齐缺字段；把越界次数夹回硬上限 */
export function normalizeState(raw, scope = scopeId(), today = dateKey()) {
  const base = createState(scope, today);
  if (!raw || typeof raw !== 'object' || raw.date !== today) return base;

  const rb = (raw.box && typeof raw.box === 'object') ? raw.box : {};
  const rf = (raw.fortune && typeof raw.fortune === 'object') ? raw.fortune : {};
  const current = rb.current && typeof rb.current === 'object'
    ? {
      productId: String(rb.current.productId || ''),
      reason: String(rb.current.reason || ''),
      reasonId: String(rb.current.reasonId || ''),
      prefs: canonicalPrefs(rb.current.prefs),
    }
    : null;

  return {
    ...base,
    ...raw,
    scope,
    date: today,
    box: {
      opened: Boolean(rb.opened) && Boolean(current),
      draws: clamp(rb.draws, R.maxDrawsPerDay),
      swaps: clamp(rb.swaps, R.freeSwaps),
      pointSwaps: clamp(rb.pointSwaps, R.maxPointSwaps),
      prefs: canonicalPrefs(rb.prefs),
      current,
      history: Array.isArray(rb.history) ? rb.history.slice(-R.historyMax).map(String) : [],
      lastReasonId: String(rb.lastReasonId || ''),
    },
    fortune: rf.date === today ? {
      date: today,
      quoteId: String(rf.quoteId || ''),
      quote: String(rf.quote || ''),
      productId: String(rf.productId || ''),
      accepted: Boolean(rf.accepted),
      rerolls: clamp(rf.rerolls, R.fortuneRerollLimit),
    } : { ...base.fortune },
    updatedAt: String(raw.updatedAt || base.updatedAt),
  };
}

/* ==================== 纯函数：配额 ==================== */

export function swapQuota(state) {
  const b = state.box;
  const freeLeft = Math.max(0, R.freeSwaps - b.swaps);
  const pointLeft = Math.max(0, R.maxPointSwaps - b.pointSwaps);
  const totalLeft = Math.max(0, R.maxDrawsPerDay - b.draws);
  return {
    freeLeft, pointLeft, totalLeft,
    canFree: b.opened && totalLeft > 0 && freeLeft > 0,
    canPoints: b.opened && totalLeft > 0 && freeLeft === 0 && pointLeft > 0,
    exhausted: b.opened && (totalLeft === 0 || (freeLeft === 0 && pointLeft === 0)),
  };
}

export function canRerollFortune(state, today = dateKey()) {
  return state.fortune.date === today
    && Boolean(state.fortune.quoteId)
    && state.fortune.rerolls < R.fortuneRerollLimit;
}

/* ==================== 纯函数：盲盒动作 ==================== */

function writeBox(state, rec, prefs, today) {
  const b = state.box;
  b.opened = true;
  b.draws += 1;
  b.prefs = canonicalPrefs(prefs);
  b.current = {
    productId: String(rec.product.id),
    reason: rec.reason,
    reasonId: rec.reasonId,
    prefs: b.prefs,
  };
  b.history = [...b.history, String(rec.product.id)].slice(-R.historyMax);
  b.lastReasonId = rec.reasonId;
  state.updatedAt = new Date().toISOString();
  return {
    state,
    result: {
      ok: true, product: rec.product, reason: rec.reason,
      reasonId: rec.reasonId, relaxed: rec.relaxed, today,
    },
  };
}

/** 每日首次开盒（幂等：当天已开过就直接返回已有结果） */
export function openBox(state, pool, prefs = {}, today = dateKey()) {
  const st = normalizeState(state, state.scope, today);
  const b = st.box;
  if (b.opened && b.current) {
    return { state: st, result: { ok: false, reason: 'already' } };
  }
  if (b.draws >= R.maxDrawsPerDay) {
    return { state: st, result: { ok: false, reason: 'limit' } };
  }
  const seed = `${st.scope}|${today}|box|${b.draws}`;
  const rec = recommend(pool, prefs, seed, b.history, b.lastReasonId);
  if (!rec) return { state: st, result: { ok: false, reason: 'empty-pool' } };
  return writeBox(st, rec, prefs, today);
}

/**
 * 「换一个」：免费额度用尽后才允许走积分兑换（viaPoints）。
 * 纯函数只改状态，不碰积分；积分扣减由动作区在调用前完成。
 */
export function swapBox(state, pool, prefs = {}, today = dateKey(), viaPoints = false) {
  const st = normalizeState(state, state.scope, today);
  const q = swapQuota(st);
  if (viaPoints ? !q.canPoints : !q.canFree) {
    return { state: st, result: { ok: false, reason: 'limit' } };
  }
  const seed = `${st.scope}|${today}|box|${st.box.draws}`;
  const rec = recommend(pool, prefs, seed, st.box.history, st.box.lastReasonId);
  if (!rec) return { state: st, result: { ok: false, reason: 'empty-pool' } };
  const out = writeBox(st, rec, prefs, today);
  if (viaPoints) out.state.box.pointSwaps += 1;
  else out.state.box.swaps += 1;
  return out;
}

/* ==================== 纯函数：每日一签 ==================== */

function quoteByIdx(i) { return { quoteId: `q${i}`, quote: FORTUNE_QUOTES[i] }; }

function pickQuote(seed, excludeId = '') {
  const list = FORTUNE_QUOTES.map((_, i) => i).filter((i) => `q${i}` !== excludeId);
  const i = list[Math.floor(rng(`${seed}|quote`)() * list.length)] || 0;
  return quoteByIdx(i);
}

/** 每天首次打开生成一次：一句签文 + 一件「今日好物」（从当日推荐池取） */
export function openFortune(state, pool, today = dateKey()) {
  const st = normalizeState(state, state.scope, today);
  if (st.fortune.date === today && st.fortune.quoteId && st.fortune.productId) {
    return { state: st, result: { ok: false, reason: 'already' } };
  }
  const poolOfDay = dailyPool(pool, st.scope, today);
  const product = pickBySeed(poolOfDay, `${st.scope}|${today}|fortune`);
  if (!product) return { state: st, result: { ok: false, reason: 'empty-pool' } };
  const q = pickQuote(`${st.scope}|${today}`);
  st.fortune = {
    date: today, quoteId: q.quoteId, quote: q.quote,
    productId: String(product.id), accepted: false, rerolls: 0,
  };
  st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: true, ...q, product } };
}

/** 再抽一次：排除当前签文与好物，每日限 1 次（积分扣减在动作区完成） */
export function rerollFortune(state, pool, today = dateKey()) {
  const st = normalizeState(state, state.scope, today);
  if (!canRerollFortune(st, today)) {
    return { state: st, result: { ok: false, reason: 'limit' } };
  }
  const poolOfDay = dailyPool(pool, st.scope, today);
  const product = pickBySeed(poolOfDay, `${st.scope}|${today}|fortune|${st.fortune.rerolls + 1}`,
    [st.fortune.productId]);
  if (!product) return { state: st, result: { ok: false, reason: 'empty-pool' } };
  const q = pickQuote(`${st.scope}|${today}|r${st.fortune.rerolls + 1}`, st.fortune.quoteId);
  st.fortune = {
    date: today, quoteId: q.quoteId, quote: q.quote,
    productId: String(product.id), accepted: false,
    rerolls: st.fortune.rerolls + 1,
  };
  st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: true, ...q, product } };
}

export function acceptFortune(state, today = dateKey()) {
  const st = normalizeState(state, state.scope, today);
  if (st.fortune.date !== today || !st.fortune.productId || st.fortune.accepted) {
    return { state: st, result: { ok: false, reason: 'already' } };
  }
  st.fortune.accepted = true;
  st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: true, productId: st.fortune.productId } };
}

/** 状态里只存商品 id：视图层拿到商品池后按 id 还原完整商品对象 */
export function resolveProduct(pool, id) {
  if (!id || !Array.isArray(pool)) return null;
  return pool.find((p) => String(p.id) === String(id)) || null;
}

/* ==================== 仓储层：localStorage 按用户隔离 ==================== */

export function storageKey(scope = scopeId()) {
  return `${BB_STORAGE_PREFIX}${scope}`;
}

export function load(today = dateKey()) {
  const s = scopeId();
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey(s)) || 'null');
  } catch {
    raw = null;
  }
  return normalizeState(raw, s, today);
}

export function save(state) {
  try {
    localStorage.setItem(storageKey(state.scope || scopeId()), JSON.stringify(state));
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
    try { window.dispatchEvent(new CustomEvent('blindbox:changed', { detail })); } catch { /* noop */ }
  }
}

/* ==================== 动作区：视图层唯一入口 ==================== */

export function getSnapshot() { return load(); }

/** 首次进入自动生成当日一签；已生成则原样返回（幂等） */
export function doFortune(pool) {
  const st = load();
  const { state, result } = openFortune(st, pool);
  if (result.ok) { save(state); notify({ kind: 'fortune', result }); }
  return result;
}

/**
 * 一签再抽：先在内存里算出新签（纯函数），成功后才真实扣积分、最后落盘。
 * 顺序保证「抽不成就一分不扣」，不需要任何退款补偿逻辑。
 */
export function doRerollFortune(pool) {
  const st = load();
  if (!canRerollFortune(st)) return { ok: false, reason: 'limit' };
  const { state, result } = rerollFortune(st, pool);
  if (!result.ok) return { ok: false, reason: result.reason };
  const paid = spendPoints(R.fortuneRerollCost, BB_LEDGER_DESC.fortune);
  if (!paid.ok) return { ok: false, reason: paid.reason };
  save(state);
  notify({ kind: 'fortune-reroll', result });
  return result;
}

export function doAcceptFortune() {
  const st = load();
  const { state, result } = acceptFortune(st);
  if (result.ok) { save(state); notify({ kind: 'fortune-accept', result }); }
  return result;
}

export function doOpenBox(pool, prefs = {}) {
  const st = load();
  const { state, result } = openBox(st, pool, prefs);
  if (result.ok) { save(state); notify({ kind: 'box-open', result }); }
  return result;
}

/** 换一个：免费额度优先；用尽后扣 20 积分兑换 1 次，全程受每日硬上限约束 */
export function doSwap(pool, prefs = {}) {
  const st = load();
  const q = swapQuota(st);
  const viaPoints = !q.canFree && q.canPoints;
  if (!q.canFree && !q.canPoints) return { ok: false, reason: 'limit' };
  const { state, result } = swapBox(st, pool, prefs, dateKey(), viaPoints);
  if (!result.ok) return { ok: false, reason: result.reason };
  if (viaPoints) {
    const paid = spendPoints(R.pointsPerSwap, BB_LEDGER_DESC.swap);
    if (!paid.ok) return { ok: false, reason: paid.reason };
  }
  save(state);
  notify({ kind: 'box-swap', result });
  return result;
}
