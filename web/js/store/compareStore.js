// 商品对比擂台的数据层：列表仓储（按 scopeId() 隔离）+ 维度表构建（纯函数）。
// 视图层只读这里的结果，不自己判断「哪个最优 / 哪些有差异」。
import { scopeId } from './userScope.js';
import { getAncestors, getCategoryById, CATEGORY_TREE } from './categoryTree.js';
import { ATTR_GROUP_BY_L1 } from './products.js';
import {
  COMPARE_MAX, COMPARE_STORAGE_PREFIX, AFTERSALE_FALLBACK,
  NUMERIC_DIMENSIONS, TEXT_DIMENSIONS,
  CORE_ATTR_BY_GROUP, CORE_ATTR_FALLBACK, CORE_ATTR_MAX_ROWS,
  AI_INDEX_WEIGHTS, AI_INDEX_CAPS, LEGACY_L1_ALIAS,
} from './compareConfig.js';

/* ==================== 纯函数：字段读取（容忍两套商品源） ==================== */
/* 网关商品、mock 商品、演示商品字段命名不同：这里统一成一套读法，
 * 不做默认值编造 —— 缺数据就是 0 / '—'，页面上看得出来。 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 价格：SKU 最低价优先于主价格（有规格时用户实际能买到的最低门槛）。 */
export function priceOf(p) {
  if (!p) return 0;
  const skus = Array.isArray(p.skus) ? p.skus : [];
  const prices = skus.map((s) => num(s && s.price)).filter((n) => n > 0);
  return prices.length ? Math.min(...prices) : num(p.price);
}

/** 库存：totalStock → stock → SKU 库存之和，取第一个非零来源。 */
export function stockOf(p) {
  if (!p) return 0;
  if (p.totalStock != null) return Math.max(0, num(p.totalStock));
  if (p.stock != null) return Math.max(0, num(p.stock));
  const skus = Array.isArray(p.skus) ? p.skus : [];
  return skus.reduce((s, k) => s + Math.max(0, num(k && k.stock)), 0);
}

export function reviewsOf(p) {
  if (!p) return 0;
  return Math.max(0, num(p.reviewCount != null ? p.reviewCount : p.reviewsCount));
}

export function aftersaleOf(p) {
  const note = p && typeof p.returnNote === 'string' ? p.returnNote.trim() : '';
  return note || AFTERSALE_FALLBACK;
}

/** 一级类目 id：分类树祖先链 → 旧类目别名 → 类目名匹配，全部走真实数据。 */
export function l1Of(p) {
  if (!p) return null;
  const chain = getAncestors(p.categoryId);
  if (chain.length) return chain[chain.length - 1].id;
  const node = getCategoryById(p.categoryId);
  if (node) {
    const up = getAncestors(node.id);
    return up.length ? up[up.length - 1].id : node.id;
  }
  if (p.categoryId && LEGACY_L1_ALIAS[p.categoryId]) return LEGACY_L1_ALIAS[p.categoryId];
  const name = String(p.category || '').trim();
  if (!name) return null;
  if (LEGACY_L1_ALIAS[name]) return LEGACY_L1_ALIAS[name];
  const hit = CATEGORY_TREE.find((n) => n.name === name);
  return hit ? hit.id : null;
}

/**
 * 属性组：只有商品真的有 attributes 时才归组。
 * 演示商品没有 attributes，硬套一个组会让对比页出现一整行「—」，
 * 所以让它落到「分类 / 品牌」兜底维度更诚实。
 */
export function attrGroupOf(p) {
  const attrs = p && p.attributes && typeof p.attributes === 'object' ? p.attributes : null;
  if (!attrs || !Object.keys(attrs).length) return null;
  const l1 = l1Of(p);
  return (l1 && ATTR_GROUP_BY_L1[l1]) || null;
}

function attrValue(p, key) {
  const attrs = p && p.attributes && typeof p.attributes === 'object' ? p.attributes : null;
  if (attrs && attrs[key] != null && String(attrs[key]).trim() !== '') return String(attrs[key]);
  // 兜底维度读顶层真实字段（分类 / 品牌），不编造
  if (p && (key === 'category' || key === 'brand') && p[key]) return String(p[key]);
  return '—';
}

/* ==================== 纯函数：AI 推荐指数 ==================== */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * AI 推荐指数 0–100：只吃商品自身真实字段，与「跟谁比」无关，
 * 所以加一件 / 换一件不会让已展示的分数漂移。
 */
export function aiIndex(p) {
  const r = clamp(num(p && p.rating), 0, AI_INDEX_CAPS.rating) / AI_INDEX_CAPS.rating;
  const s = clamp(num(p && p.sales), 0, AI_INDEX_CAPS.sales) / AI_INDEX_CAPS.sales;
  const v = clamp(reviewsOf(p), 0, AI_INDEX_CAPS.reviews) / AI_INDEX_CAPS.reviews;
  const score = AI_INDEX_WEIGHTS.rating * r
    + AI_INDEX_WEIGHTS.sales * s
    + AI_INDEX_WEIGHTS.reviews * v;
  return Math.round(clamp(score, 0, 1) * 100);
}

/* ==================== 纯函数：维度表 ==================== */

function coreRows(products) {
  const groups = [...new Set(products.map(attrGroupOf).filter(Boolean))];
  if (groups.length === 1) {
    const g = CORE_ATTR_BY_GROUP[groups[0]];
    if (g) return g.keys.map((k) => ({ key: `attr:${k}`, label: k, read: (p) => attrValue(p, k) }));
  }
  if (groups.length > 1) {
    // 混合品类：按配置声明顺序取并集，行数封顶，避免表格被撑爆
    const keys = [];
    Object.values(CORE_ATTR_BY_GROUP).forEach((g) => {
      g.keys.forEach((k) => { if (!keys.includes(k)) keys.push(k); });
    });
    return keys.slice(0, CORE_ATTR_MAX_ROWS)
      .map((k) => ({ key: `attr:${k}`, label: k, read: (p) => attrValue(p, k) }));
  }
  return CORE_ATTR_FALLBACK.map((f) => ({
    key: `core:${f.key}`, label: f.label, read: (p) => attrValue(p, f.key),
  }));
}

/**
 * 构建对比维度表。
 * 数值维度带 better（决定最优项高亮方向），文本维度 better 为 null（不做高低判断）。
 */
export function buildDimensions(products = []) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const rows = [];
  NUMERIC_DIMENSIONS.forEach((d) => {
    const read = d.key === 'price' ? priceOf
      : d.key === 'stock' ? stockOf
        : d.key === 'sales' ? ((p) => Math.max(0, num(p && p.sales)))
          : ((p) => Math.max(0, num(p && p.rating)));
    rows.push({ ...d, kind: 'number', read });
  });
  coreRows(list).forEach((r) => rows.push({
    ...r, kind: 'text', better: null, format: 'text',
  }));
  TEXT_DIMENSIONS.forEach((d) => rows.push({
    ...d, kind: 'text', read: aftersaleOf,
  }));
  rows.push({
    key: 'aiIndex', label: 'AI 推荐指数', kind: 'score', better: 'higher',
    format: 'score', read: aiIndex,
  });
  return rows;
}

/**
 * 每个维度里的「最优项」下标集合。
 * 只有声明了 better 且至少 2 件商品时才判优；并列时全部标出。
 */
export function bestIndexes(dim, products) {
  if (!dim || !dim.better || !Array.isArray(products) || products.length < 2) return [];
  const values = products.map((p) => Number(dim.read(p)));
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return [];
  const target = dim.better === 'lower' ? Math.min(...valid) : Math.max(...valid);
  const out = [];
  values.forEach((v, i) => { if (Number.isFinite(v) && v === target) out.push(i); });
  return out.length === values.length ? [] : out; // 全体相同 → 没有「最优」
}

/** 该维度在所选商品之间是否存在差异（「只看差异项」据此过滤）。 */
export function isDifferent(dim, products) {
  if (!Array.isArray(products) || products.length < 2) return false;
  const seen = new Set(products.map((p) => String(dim.read(p))));
  return seen.size > 1;
}

/** 一次性算好整张表：视图层拿到就能画，不再自己判断。 */
export function buildTable(products = []) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const dims = buildDimensions(list);
  return {
    products: list,
    rows: dims.map((dim) => ({
      key: dim.key,
      label: dim.label,
      kind: dim.kind,
      better: dim.better,
      format: dim.format,
      values: list.map((p) => dim.read(p)),
      best: bestIndexes(dim, list),
      different: isDifferent(dim, list),
    })),
    comparable: list.length >= 2,
  };
}

/* ==================== 纯函数：对比列表状态 ==================== */

export function createState(scope = scopeId()) {
  return { scope, ids: [], updatedAt: new Date().toISOString() };
}

export function normalizeState(raw, scope = scopeId()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ids = Array.isArray(r.ids)
    ? r.ids.map((id) => String(id == null ? '' : id)).filter(Boolean)
    : [];
  // 去重 + 截断：脏数据（手改 localStorage、旧版本多存）一律收敛到上限内
  return {
    scope: String(r.scope || scope),
    ids: [...new Set(ids)].slice(0, COMPARE_MAX),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
  };
}

/** 加入对比：重复 / 超上限都明确拒绝，由视图层给对应提示。 */
export function addId(state, id) {
  const st = normalizeState(state, state.scope);
  const key = String(id == null ? '' : id);
  if (!key) return { state: st, result: { ok: false, reason: 'invalid', count: st.ids.length } };
  if (st.ids.includes(key)) {
    return { state: st, result: { ok: false, reason: 'duplicate', count: st.ids.length } };
  }
  if (st.ids.length >= COMPARE_MAX) {
    return { state: st, result: { ok: false, reason: 'full', count: st.ids.length } };
  }
  st.ids = [...st.ids, key];
  st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: true, reason: 'added', count: st.ids.length } };
}

export function removeId(state, id) {
  const st = normalizeState(state, state.scope);
  const key = String(id == null ? '' : id);
  const before = st.ids.length;
  st.ids = st.ids.filter((x) => x !== key);
  if (st.ids.length !== before) st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: st.ids.length !== before, count: st.ids.length } };
}

export function clearIds(state) {
  const st = normalizeState(state, state.scope);
  const had = st.ids.length > 0;
  st.ids = [];
  if (had) st.updatedAt = new Date().toISOString();
  return { state: st, result: { ok: had, count: 0 } };
}

/** 按对比顺序还原商品对象；库里找不到的 id 直接跳过（下架不阻塞页面）。 */
export function resolveProducts(pool, ids) {
  const list = Array.isArray(pool) ? pool : [];
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    const hit = list.find((p) => String(p.id) === String(id));
    if (hit) out.push(hit);
  });
  return out;
}

/* ==================== 仓储层：localStorage 按用户隔离 ==================== */

export function storageKey(scope = scopeId()) {
  return `${COMPARE_STORAGE_PREFIX}${scope}`;
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
    try { window.dispatchEvent(new CustomEvent('compare:changed', { detail })); } catch { /* noop */ }
  }
}

/* ==================== 动作区：视图层唯一入口 ==================== */

export function getSnapshot() { return load(); }

export function isComparing(state, id) {
  return Boolean(state) && state.ids.includes(String(id == null ? '' : id));
}

/** 加入 / 移除的开关语义：商品卡上的按钮点一次加入，再点一次移出。 */
export function toggleCompare(id) {
  const st = load();
  const removing = isComparing(st, id);
  const { state, result } = removing ? removeId(st, id) : addId(st, id);
  if (!result.ok) return result;
  if (!save(state)) return { ok: false, reason: 'storage', count: st.ids.length };
  notify({ kind: removing ? 'remove' : 'add', id: String(id), result });
  return result;
}

export function doRemove(id) {
  const st = load();
  const { state, result } = removeId(st, id);
  if (!result.ok) return result;
  if (!save(state)) return { ok: false, reason: 'storage', count: st.ids.length };
  notify({ kind: 'remove', id: String(id), result });
  return result;
}

export function doClear() {
  const st = load();
  const { state, result } = clearIds(st);
  if (!result.ok) return result;
  if (!save(state)) return { ok: false, reason: 'storage', count: 0 };
  notify({ kind: 'clear', result });
  return result;
}
