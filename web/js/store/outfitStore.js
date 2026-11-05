// AI 搭配师的数据层：按一级类目策略挑选搭配商品、算套装价、生成理由。
// 全部纯函数、零 DOM、零副作用 —— 不落盘（搭配只服务当前这一屏）。
import { l1Of, priceOf, stockOf } from './compareStore.js';
import { getCategoryById } from './categoryTree.js';
import {
  OUTFIT_RULES, OUTFIT_STRATEGY_BY_L1, DEFAULT_STRATEGY,
  OUTFIT_REASONS, COLOR_FAMILIES,
} from './outfitConfig.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** FNV-1a 变体：确定性、同 seed 同结果，避免每次刷新搭配都变。 */
export function hash(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 主商品该走哪套搭配策略；未收录的一级类目走默认策略。 */
export function strategyFor(product) {
  const l1 = l1Of(product);
  const hit = l1 && OUTFIT_STRATEGY_BY_L1[l1];
  return hit ? { key: l1, ...hit } : { key: l1 || '(unknown)', ...DEFAULT_STRATEGY };
}

function candidatesFor(pool, product, targetL1) {
  const list = Array.isArray(pool) ? pool : [];
  const out = list.filter((p) => p
    && String(p.id) !== String(product.id)
    && l1Of(p) === targetL1
    && stockOf(p) > 0);
  // 每类目只取前 N 件参与挑选：全库 1300+ 件时也别做无谓的全量排序
  return out.slice(0, OUTFIT_RULES.perTargetScan);
}

/**
 * 挑搭配商品：每个目标类目取 1 件，2–4 件封顶。
 * 结果一定来自传入的 pool，绝不凭空造商品。
 * opts.variant 是「重新搭配」的换批随机源，缺省时同商品结果稳定。
 */
export function pickMates(pool, product, opts = {}) {
  const list = Array.isArray(pool) ? pool : [];
  if (!product || !list.length) return [];
  const strategy = strategyFor(product);
  const variant = opts.variant == null ? '' : String(opts.variant);
  const max = clamp(Number(opts.max) || OUTFIT_RULES.maxMates, OUTFIT_RULES.minMates, OUTFIT_RULES.maxMates);
  const want = clamp(
    Number(opts.count) || (OUTFIT_RULES.minMates + (hash(`${product.id}:${variant}:n`) % (OUTFIT_RULES.maxMates - OUTFIT_RULES.minMates + 1))),
    OUTFIT_RULES.minMates,
    max,
  );
  const used = new Set([String(product.id)]);
  const picked = [];
  strategy.targets.forEach((target) => {
    if (picked.length >= want) return;
    const cands = candidatesFor(list, product, target).filter((p) => !used.has(String(p.id)));
    if (!cands.length) return;
    const pick = cands[hash(`${product.id}:${variant}:${target}`) % cands.length];
    used.add(String(pick.id));
    picked.push(pick);
  });
  return picked.slice(0, max);
}

/* ==================== 理由：按真实数据判定关系，再套句式 ==================== */

function colorFamilyOf(product) {
  const attrs = product && product.attributes ? product.attributes : null;
  if (!attrs) return null;
  const value = attrs['颜色'];
  if (!value) return null;
  const hit = COLOR_FAMILIES.find((f) => f.values.some((v) => String(value).includes(v)));
  return hit ? { id: hit.id, name: hit.name, value: String(value) } : null;
}

export function fillReason(template, ctx = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (
    ctx[k] == null || ctx[k] === '' ? m : String(ctx[k])
  ));
}

/** 商品的可读类目名：末级分类名优先，其次类目名字段，最后退回「配件」。 */
function categoryNameOf(p) {
  if (!p) return '配件';
  const node = getCategoryById(p.categoryId);
  if (node && node.name) return node.name;
  const raw = String(p.subCategory || p.category || '').trim();
  return raw || '配件';
}

/**
 * 这件商品在这套策略下「真实成立」的全部理由候选。
 * 对外导出是为了让构建断言能逐条核对：不该出现的关系绝不出现。
 */
export function reasonCandidates(product, mate, strategy = strategyFor(product)) {
  const tpl = (id) => OUTFIT_REASONS.find((r) => r.id === id);
  const mainPrice = priceOf(product);
  const matePrice = priceOf(mate);
  const base = {
    scene: strategy.scene,
    from: strategy.label,
    to: categoryNameOf(mate),
    mainPrice: `¥${mainPrice.toLocaleString()}`,
    matePrice: `¥${matePrice.toLocaleString()}`,
    brand: (mate && mate.brand) || (product && product.brand) || '',
  };
  const say = (id, extra = {}) => ({ id, text: fillReason(tpl(id).text, { ...base, ...extra }) });

  const out = [];
  const c1 = colorFamilyOf(product);
  const c2 = colorFamilyOf(mate);
  if (c1 && c2 && c1.id === c2.id) out.push(say('same-color', { color: c1.name }));
  if (product && mate && product.brand && product.brand === mate.brand) out.push(say('same-brand'));
  if (mainPrice > 0 && matePrice > 0) {
    const diff = Math.round((Math.abs(mainPrice - matePrice) / Math.max(mainPrice, matePrice)) * 100);
    if (diff <= 30) out.push(say('near-price', { diff }));
    else out.push(say('price-ladder'));
  }
  if (l1Of(mate) !== l1Of(product)) out.push(say('category-pair'));
  if (stockOf(product) > 0 && stockOf(mate) > 0) out.push(say('ready-stock'));
  out.push(say('same-scene'));
  return out;
}

/**
 * 选一条理由：先算出「这件商品真实成立的所有关系」，再按 id 确定性挑一条。
 * 关键约束：候选里每条都必须成立才允许出现，绝不为了文采编造关系。
 * opts.avoid 传同一套装的已用句式集合，避免三件商品写出三句一模一样的话。
 */
export function pickReason(product, mate, strategy = strategyFor(product), opts = {}) {
  const pool = reasonCandidates(product, mate, strategy);
  let cands = pool;
  const avoid = opts.avoid instanceof Set ? opts.avoid : null;
  if (avoid && avoid.size) {
    const rest = pool.filter((r) => !avoid.has(r.id));
    if (rest.length) cands = rest; // 有替代就不重复；确实只有一种成立时允许复用
  }
  return cands[hash(`${product && product.id}:${mate && mate.id}:r`) % cands.length]
    || { id: 'same-scene', text: fillReason(OUTFIT_REASONS.find((r) => r.id === 'same-scene').text, { scene: strategy.scene }) };
}

/** 整套的搭配理由：同一套装内尽量不重复句式。 */
export function reasonList(product, mates, strategy = strategyFor(product)) {
  const used = new Set();
  return (Array.isArray(mates) ? mates : []).map((m) => {
    const r = pickReason(product, m, strategy, { avoid: used });
    used.add(r.id);
    return r;
  });
}

/* ==================== 套装价 ==================== */

const money = (n) => Math.round(n * 100) / 100;

/**
 * 套装总价：原价合计 × 折扣，四舍五入到分。
 * 原价、折后、省多少三个数都返回，页面上摊开写，不做「虚标原价」。
 */
export function outfitTotals(product, mates, discount = OUTFIT_RULES.discount) {
  const mainPrice = priceOf(product);
  const matePrices = (Array.isArray(mates) ? mates : []).map(priceOf);
  const subtotal = money(mainPrice + matePrices.reduce((s, n) => s + n, 0));
  const total = money(subtotal * discount);
  return {
    mainPrice,
    matePrices,
    subtotal,
    total,
    saving: money(subtotal - total),
    discount,
    discountLabel: OUTFIT_RULES.discountLabel,
  };
}

/* ==================== 单个替换 ==================== */

/**
 * 把第 index 件搭配换成同类目的另一件（排除主商品与套装内已用的）。
 * 找不到替代时如实返回 ok:false，由视图层提示，不静默重复同一件。
 */
export function replaceMate(pool, product, mates, index) {
  const list = Array.isArray(mates) ? mates.slice() : [];
  if (!product || index < 0 || index >= list.length) return { ok: false, reason: 'index' };
  const old = list[index];
  const used = new Set([
    String(product.id),
    String(old.id),
    ...list.filter((_, i) => i !== index).map((m) => String(m.id)),
  ]);
  const targetL1 = l1Of(old);
  const cands = (Array.isArray(pool) ? pool : []).filter((p) => p
    && l1Of(p) === targetL1
    && !used.has(String(p.id))
    && stockOf(p) > 0);
  if (!cands.length) return { ok: false, reason: 'no-alternative' };
  const pick = cands[hash(`${old.id}:next`) % cands.length];
  list[index] = pick;
  return { ok: true, mates: list, product: pick };
}

/** 整套加购清单：主商品在前，搭配在后；同 id 去重。 */
export function outfitCartList(product, mates) {
  const ids = new Set();
  const out = [];
  [product, ...(Array.isArray(mates) ? mates : [])].forEach((p) => {
    if (!p) return;
    const id = String(p.id);
    if (ids.has(id)) return;
    ids.add(id);
    out.push(p);
  });
  return out;
}
