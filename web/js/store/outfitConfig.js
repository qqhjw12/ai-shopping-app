// AI 搭配师的唯一规则源：一级类目 → 搭配策略、套装折扣、理由句式、文案。
// 零 DOM、零依赖；组件层不允许写死折扣或类目映射。

export const OUTFIT_RULES = {
  /** 搭配商品数量下界（规格：2–4 个） */
  minMates: 2,
  maxMates: 4,
  /** 套装优惠：总价 95 折，必须把原价 / 折后 / 省多少都摊开写，不虚标 */
  discount: 0.95,
  discountLabel: '套装 95 折',
  /** 每个目标类目最多取多少件候选参与挑选，避免全库扫描 */
  perTargetScan: 40,
};

/**
 * 一级类目 → 搭配策略。
 * 服饰类搭鞋包配饰，数码类搭配件，家居类搭软装；targets 是「主商品的一级类目」，
 * 允许包含自身（数码配件本身就在 digital 下）。
 */
export const OUTFIT_STRATEGY_BY_L1 = {
  womenswear: { label: '女装', targets: ['shoes', 'bags', 'jewelry'], scene: '通勤与日常' },
  menswear: { label: '男装', targets: ['shoes', 'bags', 'watches'], scene: '通勤与出行' },
  lingerie: { label: '内衣家居服', targets: ['womenswear', 'bags', 'shoes'], scene: '居家与睡眠' },
  shoes: { label: '鞋靴', targets: ['bags', 'womenswear', 'menswear'], scene: '通勤与出行' },
  bags: { label: '箱包', targets: ['shoes', 'watches', 'jewelry'], scene: '通勤与出行' },
  jewelry: { label: '珠宝配饰', targets: ['womenswear', 'bags', 'watches'], scene: '约会与正式场合' },
  watches: { label: '钟表眼镜', targets: ['bags', 'menswear', 'jewelry'], scene: '通勤与正式场合' },
  sports: { label: '运动户外', targets: ['shoes', 'bags', 'fitness'], scene: '户外与训练' },
  digital: { label: '数码', targets: ['digital', 'mobile', 'computer'], scene: '桌面与出行' },
  mobile: { label: '手机通讯', targets: ['digital', 'computer', 'smart-home'], scene: '移动与桌面' },
  computer: { label: '电脑办公', targets: ['digital', 'stationery', 'smart-home'], scene: '办公与桌面' },
  appliance: { label: '家用电器', targets: ['smart-home', 'fragrance', 'appliance'], scene: '居家日常' },
  'smart-home': { label: '智能家居', targets: ['appliance', 'fragrance', 'digital'], scene: '居家日常' },
  fitness: { label: '健身器材', targets: ['sports', 'appliance', 'digital'], scene: '训练与恢复' },
  'auto-parts': { label: '汽车用品', targets: ['digital', 'smart-home', 'auto-parts'], scene: '车内与出行' },
  music: { label: '乐器音响', targets: ['digital', 'computer', 'stationery'], scene: '练习与演出' },
  beauty: { label: '美妆护肤', targets: ['fragrance', 'beauty', 'jewelry'], scene: '日常妆造' },
  fragrance: { label: '香水香氛', targets: ['beauty', 'jewelry', 'smart-home'], scene: '居家与外出' },
  food: { label: '食品生鲜', targets: ['wine-tea', 'food', 'appliance'], scene: '餐桌与待客' },
  'wine-tea': { label: '酒水茶饮', targets: ['food', 'appliance', 'stationery'], scene: '餐桌与待客' },
  'mother-baby': { label: '母婴用品', targets: ['kids-toys', 'beauty', 'food'], scene: '育儿日常' },
  'kids-toys': { label: '童装玩具', targets: ['mother-baby', 'books-culture', 'shoes'], scene: '居家与户外' },
  pet: { label: '宠物用品', targets: ['pet', 'smart-home', 'food'], scene: '养宠日常' },
  'books-culture': { label: '图书文创', targets: ['stationery', 'books-culture', 'digital'], scene: '阅读与书桌' },
  stationery: { label: '办公文具', targets: ['books-culture', 'computer', 'digital'], scene: '书桌与办公' },
};

/** 未收录的一级类目走这里，保证永远有结果、且结果仍来自商品库。 */
export const DEFAULT_STRATEGY = {
  label: '通用', targets: ['digital', 'smart-home', 'stationery'], scene: '日常使用',
};

/**
 * 搭配理由句式：{…} 占位符由 outfitStore.fillReason 按真实数据填充。
 * 判定逻辑在数据层（看颜色 / 价位 / 品牌 / 场景），这里只管怎么说。
 */
export const OUTFIT_REASONS = [
  { id: 'same-color', text: '同色系搭配 · 主件与配件都落在{color}' },
  { id: 'near-price', text: '同价位互补 · 两件相差 {diff}%，凑套装更划算' },
  { id: 'same-scene', text: '同场景使用 · {scene}' },
  { id: 'same-brand', text: '同品牌成套 · 都来自{brand}' },
  { id: 'category-pair', text: '{from} 搭 {to}，是这一类最常用的组合' },
  { id: 'price-ladder', text: '价位互补 · 主件 {mainPrice}，配件 {matePrice}' },
  { id: 'ready-stock', text: '现货充足 · 两件都能立刻发货' },
];

/** 主件与配件的色系归类：只按真实属性值归组，不猜。 */
export const COLOR_FAMILIES = [
  { id: 'light', name: '浅色系', values: ['雾白', '白', '浅色', '米白', '砂杏'] },
  { id: 'dark', name: '深色系', values: ['墨黑', '黑', '曜黑', '深空灰', '深色'] },
  { id: 'cool', name: '冷色系', values: ['青灰', '雾蓝', '蓝', '灰'] },
];

/** 页面文案集中管理。 */
export const OUTFIT_COPY = {
  eyebrow: 'AI STYLIST',
  title: 'AI 搭配',
  entry: 'AI 搭配这套',
  entryHint: '按品类给 2–4 件搭配建议',
  loading: 'AI 正在翻商品库找搭配…',
  empty: '这一件暂时凑不出合适的套装，换个商品看看',
  addAll: '一键加购套装',
  addedAll: '整套已加入购物袋',
  replace: '换一件',
  remove: '移出套装',
  mainLabel: '主商品',
  matesLabel: '搭配',
  subtotal: '原价合计',
  total: '套装总价',
  saving: '省',
  note: '套装折扣为演示用固定规则，结算以购物袋实际价格为准',
  inBag: '已加入',
};
