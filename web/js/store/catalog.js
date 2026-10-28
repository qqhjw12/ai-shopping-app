// 目录检索层：关键词匹配 / 多维筛选 / 排序 / URL 编解码 / 分面计数。
//
// 设计口径：
//   1) 纯函数，不碰 DOM、不发请求 —— 便于 scripts/check-web.mjs 直接断言，
//      也让「列表页 / 搜索页 / 分类页」共用同一套语义，不会出现两处规则打架。
//   2) URL 是筛选状态的唯一真源：parseFilters(query) → 渲染 → buildQuery(filters)
//      写回 hash。刷新、分享、前进后退都能还原到同一屏。
//   3) 分面计数用「排除自身维度」的口径（选价格时不看价格对颜色的影响），
//      这样用户能看到「再选另一个颜色会有多少件」，而不是永远看到 0。

/* ---------------- 排序 ---------------- */
export const SORTS = [
  { id: 'default', label: '综合' },
  { id: 'price_asc', label: '价格升序' },
  { id: 'price_desc', label: '价格降序' },
  { id: 'sales', label: '销量' },
  { id: 'new', label: '上新' },
];

/* ---------------- 价格档位（左闭右开，避免相邻档位重叠计数） ---------------- */
export const PRICE_BANDS = [
  { id: 'p100', label: '¥100 以下', min: null, max: 100 },
  { id: 'p100_500', label: '¥100–500', min: 100, max: 500 },
  { id: 'p500_1000', label: '¥500–1000', min: 500, max: 1000 },
  { id: 'p1000_3000', label: '¥1000–3000', min: 1000, max: 3000 },
  { id: 'p3000', label: '¥3000 以上', min: 3000, max: null },
];

export const bandById = (id) => PRICE_BANDS.find((b) => b.id === id) || null;

/* ---------------- 属性：颜色族 + 规格 ----------------
 * 商品只有 SKU 的 spec 文本（如「深空灰 / 12+256G」「黑 / M」「750ml / 单瓶」），
 * 没有结构化属性字段。这里做两件事：
 *   - 含颜色字样的片段归一到色系（深空灰→灰、曜金黑→黑），保证同色不同名能合并；
 *   - 其余片段当作规格（容量 / 尺码 / 版本），原样保留，量太杂时由 UI 截断。
 * 取「最后一个颜色字」判族：中文色名是「修饰 + 色」的结构，最后一个字才是主色。
 */
const COLOR_FAMILIES = [
  ['黑', '黑'], ['白', '白'], ['灰', '灰'], ['银', '银'], ['金', '金'],
  ['蓝', '蓝青'], ['绿', '绿'], ['红', '红'], ['粉', '粉玫'], ['紫', '紫'],
  ['橙', '橙橘'], ['棕', '棕咖驼'], ['米', '米杏奶'],
];
const COLOR_CHAR_ORDER = ['黑', '白', '灰', '银', '金', '蓝', '青', '绿', '红', '粉', '玫', '紫', '橙', '橘', '棕', '咖', '驼', '米', '杏', '奶'];
const CHAR_TO_FAMILY = (() => {
  const map = {};
  for (const [family, chars] of COLOR_FAMILIES) {
    for (const ch of chars) map[ch] = family;
  }
  return map;
})();

/** 从一段文本里判断色系；不含颜色字返回 null */
export function colorFamily(text) {
  const s = String(text || '');
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const fam = CHAR_TO_FAMILY[s[i]];
    if (fam && COLOR_CHAR_ORDER.includes(s[i])) return fam;
  }
  return null;
}

const traitsCache = new Map();

/** 商品的属性集合：{ colors:[色系], sizes:[规格片段] } */
export function skuTraits(p) {
  const key = String(p && p.id);
  if (traitsCache.has(key)) return traitsCache.get(key);
  const colors = new Set();
  const sizes = new Set();
  const skus = Array.isArray(p && p.skus) ? p.skus : [];
  skus.forEach((s) => {
    String((s && s.spec) || '').split('/').forEach((seg) => {
      const t = seg.trim();
      if (!t) return;
      const fam = colorFamily(t);
      // 颜色片段一般很短（深空灰 / 曜金黑）；长片段多半是描述性规格，避免误判
      if (fam && t.length <= 6) colors.add(fam);
      else sizes.add(t);
    });
  });
  const out = { colors: [...colors], sizes: [...sizes] };
  traitsCache.set(key, out);
  return out;
}

/** 库存：优先 totalStock，缺失时累加 SKU 库存，再缺失视为有货 */
export function stockOf(p) {
  if (Number.isFinite(Number(p && p.totalStock))) return Number(p.totalStock);
  const skus = Array.isArray(p && p.skus) ? p.skus : [];
  if (!skus.length) return 1;
  return skus.reduce((n, s) => n + (Number(s && s.stock) || 0), 0);
}

/* ---------------- 关键词 ---------------- */

/** 单个词在商品里的命中权重（0 = 未命中） */
function hitWeight(token, fields) {
  let w = 0;
  if (fields.name.includes(token)) w += fields.name.startsWith(token) ? 4 : 3;
  if (fields.tags.includes(token)) w += 2;
  if (fields.brand.includes(token)) w += 1.5;
  if (fields.category.includes(token)) w += 1.2;
  if (fields.description.includes(token)) w += 1;
  return w;
}

/**
 * 关键词评分：空格分词后「每个词都要命中」（AND 语义），命中位置/字段决定权重。
 * 返回 0 表示不匹配。
 */
export function scoreProduct(p, query) {
  const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const fields = {
    name: String(p.name || '').toLowerCase(),
    tags: (Array.isArray(p.tags) ? p.tags : []).join(' ').toLowerCase(),
    brand: String(p.brand || '').toLowerCase(),
    category: `${p.category || ''} ${p.subCategory || ''}`.toLowerCase(),
    description: String(p.description || '').toLowerCase(),
  };
  let score = 0;
  for (const t of tokens) {
    const w = hitWeight(t, fields);
    if (!w) return 0;
    score += w;
  }
  return score;
}

/* ---------------- 筛选 ---------------- */

export const EMPTY_FILTERS = {
  q: '',
  cats: [],
  subs: [],
  brands: [],
  price: [],
  colors: [],
  sizes: [],
  stock: false,
  sort: 'default',
  min: null,
  max: null,
};

/** 价格是否落在任一选中档位 / 自定义区间内 */
function priceMatch(price, f) {
  if (f.min != null || f.max != null) {
    if (f.min != null && !(price >= f.min)) return false;
    if (f.max != null && !(price <= f.max)) return false;
  }
  if (!f.price.length) return true;
  return f.price.some((id) => {
    const b = bandById(id);
    if (!b) return true;
    if (b.min != null && !(price >= b.min)) return false;
    if (b.max != null && !(price < b.max)) return false;
    return true;
  });
}

/**
 * 只过滤不排序（排序另放，便于分面计数时复用）。
 * 多选语义：同维度内 OR，跨维度 AND。
 */
export function filterOnly(all, f) {
  const out = [];
  const q = String(f.q || '').trim();
  for (const p of all) {
    if (f.cats.length && !f.cats.includes(p.categoryId)) continue;
    if (f.subs.length && !f.subs.includes(p.subCategoryId)) continue;
    if (f.brands.length && !f.brands.includes(p.brand)) continue;
    if (!priceMatch(Number(p.price) || 0, f)) continue;
    if (f.stock && !(stockOf(p) > 0)) continue;
    if (f.colors.length || f.sizes.length) {
      const t = skuTraits(p);
      if (f.colors.length && !f.colors.some((c) => t.colors.includes(c))) continue;
      if (f.sizes.length && !f.sizes.some((s) => t.sizes.includes(s))) continue;
    }
    let score = 0;
    if (q) {
      score = scoreProduct(p, q);
      if (!score) continue;
    }
    out.push(score ? { ...p, _score: score } : p);
  }
  return out;
}

/** 排序（返回新数组） */
export function sortProducts(list, sort, q) {
  const arr = [...list];
  const salesDesc = (a, b) => (Number(b.sales) || 0) - (Number(a.sales) || 0);
  switch (sort) {
    case 'price_asc':
      return arr.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0) || salesDesc(a, b));
    case 'price_desc':
      return arr.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0) || salesDesc(a, b));
    case 'sales':
      return arr.sort(salesDesc);
    case 'new':
      // 目录没有上架时间字段，用 id 倒序代表「入库先后」（数值化比较，避免 'p9' > 'p10'）
      return arr.sort((a, b) => String(b.id).localeCompare(String(a.id), 'en', { numeric: true }));
    default:
      // 综合：有关键词时按相关度，否则按销量 + 评分
      if (String(q || '').trim()) {
        return arr.sort((a, b) => (b._score || 0) - (a._score || 0) || salesDesc(a, b));
      }
      return arr.sort((a, b) => salesDesc(a, b) || (Number(b.rating) || 0) - (Number(a.rating) || 0));
  }
}

/** 过滤 + 排序（列表渲染的唯一入口） */
export function applyFilters(all, f) {
  return sortProducts(filterOnly(all, f), f.sort, f.q);
}

/* ---------------- 分面计数 ---------------- */

const tally = (list, pick) => {
  const map = new Map();
  for (const p of list) {
    const keys = pick(p);
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
      if (k == null || k === '') return;
      map.set(k, (map.get(k) || 0) + 1);
    });
  }
  return map;
};

/**
 * 每个维度在「其它维度已生效」的前提下计数，供胶囊上显示条数。
 * 没有关键词/筛选时等价于全量统计，不会多做无用功。
 */
export function facetCounts(all, f) {
  const noCat = filterOnly(all, { ...f, cats: [], subs: [] });
  const noSub = filterOnly(all, { ...f, subs: [] });
  const noPrice = filterOnly(all, { ...f, price: [], min: null, max: null });
  const noColor = filterOnly(all, { ...f, colors: [] });
  const noSize = filterOnly(all, { ...f, sizes: [] });
  const noStock = filterOnly(all, { ...f, stock: false });
  return {
    cats: tally(noCat, (p) => p.categoryId),
    subs: tally(noSub, (p) => p.subCategoryId),
    brands: tally(filterOnly(all, { ...f, brands: [] }), (p) => p.brand),
    price: tally(noPrice, (p) => PRICE_BANDS.filter((b) => priceMatch(Number(p.price) || 0, { ...EMPTY_FILTERS, price: [b.id] })).map((b) => b.id)),
    colors: tally(noColor, (p) => skuTraits(p).colors),
    sizes: tally(noSize, (p) => skuTraits(p).sizes),
    inStock: noStock.filter((p) => stockOf(p) > 0).length,
    total: noStock.length,
  };
}

/** 热门搜索词：从真实数据里挑出现次数最多的子类，保证点了一定有结果 */
export function hotSearches(all, n = 8) {
  const map = tally(all, (p) => p.subCategory || p.category);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh'))
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

/* ---------------- URL 编解码 ---------------- */

const splitList = (v) => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 解析 hash query → 筛选状态（对非法值宽容：不认识就忽略） */
export function parseFilters(query = {}) {
  const sort = SORTS.some((s) => s.id === query.sort) ? query.sort : 'default';
  return {
    q: String(query.q || '').trim(),
    cats: splitList(query.cat),
    subs: splitList(query.sub),
    brands: splitList(query.brand),
    price: splitList(query.price).filter((id) => bandById(id)),
    colors: splitList(query.color),
    sizes: splitList(query.size),
    stock: query.stock === '1' || query.stock === 'true',
    sort,
    min: toNum(query.min),
    max: toNum(query.max),
  };
}

/** 筛选状态 → 查询串（只写非空项，保持 URL 干净可分享；默认排序不写入） */
export function buildQuery(f) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.cats.length) p.set('cat', f.cats.join(','));
  if (f.subs.length) p.set('sub', f.subs.join(','));
  if (f.brands.length) p.set('brand', f.brands.join(','));
  if (f.price.length) p.set('price', f.price.join(','));
  if (f.colors.length) p.set('color', f.colors.join(','));
  if (f.sizes.length) p.set('size', f.sizes.join(','));
  if (f.stock) p.set('stock', '1');
  if (f.sort && f.sort !== 'default') p.set('sort', f.sort);
  if (f.min != null) p.set('min', f.min);
  if (f.max != null) p.set('max', f.max);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** 已选条件个数（关键词不算，关键词有自己的展示位） */
export function countActive(f) {
  return f.cats.length + f.subs.length + f.brands.length + f.price.length
    + f.colors.length + f.sizes.length + (f.stock ? 1 : 0)
    + (f.min != null || f.max != null ? 1 : 0);
}

/** 清空筛选但保留关键词与排序（搜索页「清空筛选」不该顺手清掉搜索词） */
export function clearedFilters(f) {
  return { ...EMPTY_FILTERS, q: f.q, sort: f.sort };
}

/** 切换数组型筛选值：有则去掉，无则加上 */
export function toggleValue(list, value) {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/* ---------------- 价格档位文案 ---------------- */

export function bandLabel(min, max) {
  if (min != null && max != null) return `¥${min}–${max}`;
  if (min != null) return `¥${min} 以上`;
  if (max != null) return `¥${max} 以下`;
  return '';
}
