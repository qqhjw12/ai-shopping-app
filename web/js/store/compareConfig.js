// 商品对比擂台的唯一规则源：维度定义、最优方向、AI 推荐指数权重、上限与文案。
// 零 DOM、零依赖，Node 侧可直接 import 断言；组件层不允许写死任何数值。

/** 同时对比的商品上限（规格：最多 4 个，超出提示移除）。 */
export const COMPARE_MAX = 4;

/** 对比列表的 localStorage 前缀，按 scopeId() 分桶。 */
export const COMPARE_STORAGE_PREFIX = 'maison_compare_v1::';

/** 售后权益兜底文案，与详情页 .pdp-service-copy 同口径。 */
export const AFTERSALE_FALLBACK = '7 天无理由退换 · 支持上门取件';

/**
 * 数值维度：better 决定「最优项」高亮方向。
 * price 越低越好，其余越高越好；没有 better 的维度不做高亮。
 */
export const NUMERIC_DIMENSIONS = [
  { key: 'price', label: '价格', better: 'lower', format: 'price' },
  { key: 'rating', label: '评分', better: 'higher', format: 'rating' },
  { key: 'sales', label: '销量', better: 'higher', format: 'count' },
  { key: 'stock', label: '库存', better: 'higher', format: 'stock' },
];

/** 售后权益：文本维度，无优劣方向。 */
export const TEXT_DIMENSIONS = [
  { key: 'aftersale', label: '售后权益', better: null, format: 'text' },
];

/**
 * 核心属性按「属性组」切换维度 —— 键名必须与 mock 商品 attributes 的真实键一致，
 * 不允许凭空造字段。属组来自 products.js 的 ATTR_GROUP_BY_L1。
 */
export const CORE_ATTR_BY_GROUP = {
  apparel: { label: '款式属性', keys: ['颜色', '尺码'] },
  beauty: { label: '配方属性', keys: ['规格', '香型'] },
  food: { label: '食品属性', keys: ['规格', '口味'] },
  digital: { label: '规格属性', keys: ['规格', '颜色'] },
  book: { label: '出版属性', keys: ['装帧', '开本'] },
};

/** 无属性数据时的兜底维度：读商品真实顶层字段，不编造。 */
export const CORE_ATTR_FALLBACK = [
  { key: 'category', label: '分类' },
  { key: 'brand', label: '品牌' },
];

/**
 * 旧演示商品的一级类目别名（16 个老类目 → 现行 25 个一级分类）。
 * 演示库用的是上一代类目体系（id 如 phone / home），不映射的话
 * 「按一级分类给核心属性 / 给搭配策略」对这批商品会全部失效。
 */
export const LEGACY_L1_ALIAS = {
  phone: 'mobile',
  computer: 'computer',
  audio: 'music',
  appliance: 'appliance',
  apparel: 'womenswear',
  food: 'food',
  home: 'smart-home',
  sports: 'sports',
  beauty: 'beauty',
  baby: 'mother-baby',
  book: 'books-culture',
  kitchen: 'appliance',
  pet: 'pet',
  auto: 'auto-parts',
  health: 'fitness',
  stationery: 'stationery',
};

/** 混合品类时最多展示的核心属性行数，避免表格被撑爆。 */
export const CORE_ATTR_MAX_ROWS = 3;

/**
 * AI 推荐指数：全部来自商品真实字段，权重显式写出，归一化到 0–100。
 * 口径必须在对页面可见（AI_INDEX_NOTE），不允许「虚标」。
 */
export const AI_INDEX_WEIGHTS = { rating: 0.6, sales: 0.25, reviews: 0.15 };
export const AI_INDEX_CAPS = { rating: 5, sales: 2400, reviews: 3200 };
export const AI_INDEX_NOTE = 'AI 推荐指数 = 评分 60% + 销量 25% + 评价数 15%，归一化到 0–100，仅供参考';

/** 页面与悬浮条文案集中管理。 */
export const COMPARE_COPY = {
  eyebrow: 'COMPARE ARENA',
  title: '对比擂台',
  lead: '最多同时放 4 件，逐项摊平看。标青的是这一项的最优项。',
  dockCta: '去对比',
  addLabel: '加入对比',
  addedLabel: '已加入',
  fullHint: '对比位已满（4 个），先移除一件',
  duplicateHint: '这件已经在对比里了',
  empty: '对比台还空着 · 从商品卡或详情页点「加入对比」',
  emptyCta: '去挑几件',
  diffToggle: '只看差异项',
  clearAll: '清空对比',
  remove: '移除',
  allSame: '所选商品在各维度上完全一致，没有差异项可看',
  oneHint: '再放一件才有可比性',
  note: AI_INDEX_NOTE,
  attrSwitched: '核心属性按品类自动切换',
  missing: '所选商品已不在当前商品库中，已自动跳过',
  loading: '正在载入对比商品…',
  loadFailed: '商品库暂时没有响应，刷新页面再试',
};
