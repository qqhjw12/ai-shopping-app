// 货源市场（供应商目录）的演示数据层。
//
// 定位：这是给「有采购需求的商家 / 分销用户」看的**目录**，不是 B2B 交易系统。
// 所以这里没有报价单、没有合同、没有授信——只有「谁在供什么、起订多少、
// 在哪儿、能不能定制」。数据全部是写死的演示数据（确定性，不用随机数：
// 刷新两次看到的必须是同一批供应商，否则演示时自己都说不清哪张卡是真的）。
//
// 真要接真实货源时，替换 listSuppliers / getSupplier / findSourcing 的实现即可，
// 页面只依赖这三个函数与它们返回的字段形状。

/** 起订量档位：筛选与卡片上的「起订」都用这一套口径，避免两处各说各话 */
export const MOQ_BANDS = [
  { id: 'all', label: '不限起订', min: 0, max: Infinity },
  { id: 'm50', label: '≤ 50 件', min: 0, max: 50 },
  { id: 'm200', label: '≤ 200 件', min: 0, max: 200 },
  { id: 'm1000', label: '≤ 1000 件', min: 0, max: 1000 },
];

export const moqBandOf = (id) => MOQ_BANDS.find((b) => b.id === id) || MOQ_BANDS[0];

/** 能力标签：固定词表，卡片上按这个顺序排，不做「每个供应商一套说法」 */
export const CAPABILITIES = ['现货', '支持定制', '7天发货', '一件代发', '工厂直供', '可开专票'];

/**
 * 供应商目录。
 * - moq：整单起订量（件）
 * - lead：承诺发货天数；sample：打样天数；capacity：月产能（件）
 * - products 里的 wholesale 是**批发价（整数元）**，与商城价格口径一致
 */
const SUPPLIERS = [
  {
    id: 'SU-2201',
    name: '景德镇砚山陶瓷厂',
    categoryId: 'home',
    categoryLabel: '家居家具',
    region: '江西 · 景德镇',
    moq: 50,
    lead: 7,
    sample: 3,
    capacity: 12000,
    since: 2016,
    tags: ['现货', '支持定制', '7天发货'],
    intro: '手工拉坯与釉下彩，做茶器与餐桌器物；小批量可混色，logo 可刻可印。',
    products: [
      { name: '粗陶盖碗（150ml）', wholesale: 46, stock: 3200, moq: 50, unit: '只' },
      { name: '月白釉马克杯', wholesale: 28, stock: 8600, moq: 50, unit: '只' },
      { name: '手作陶盘 8 寸', wholesale: 38, stock: 2100, moq: 30, unit: '只' },
      { name: '窑变茶叶罐', wholesale: 62, stock: 900, moq: 20, unit: '只' },
    ],
  },
  {
    id: 'SU-2202',
    name: '潮州恒益不锈钢制品',
    categoryId: 'kitchen',
    categoryLabel: '厨房餐具',
    region: '广东 · 潮州',
    moq: 200,
    lead: 10,
    sample: 5,
    capacity: 60000,
    since: 2011,
    tags: ['现货', '工厂直供', '可开专票'],
    intro: '304 不锈钢厨具代工，冲压与抛光自有产线，支持贴牌与礼盒组装。',
    products: [
      { name: '不锈钢三层蒸锅 26cm', wholesale: 78, stock: 5400, moq: 100, unit: '口' },
      { name: '硅胶手柄汤勺', wholesale: 9, stock: 42000, moq: 500, unit: '把' },
      { name: '厨房剪刀（可拆洗）', wholesale: 14, stock: 18000, moq: 300, unit: '把' },
      { name: '不锈钢沥水篮', wholesale: 22, stock: 7600, moq: 200, unit: '个' },
    ],
  },
  {
    id: 'SU-2203',
    name: '义乌小商品城·织语家纺',
    categoryId: 'home',
    categoryLabel: '家居家具',
    region: '浙江 · 义乌',
    moq: 30,
    lead: 5,
    sample: 2,
    capacity: 30000,
    since: 2014,
    tags: ['现货', '一件代发', '7天发货'],
    intro: '棉麻桌布、抱枕套与床品四件套，花色可按季度上新，支持一件代发。',
    products: [
      { name: '棉麻桌旗 33×180cm', wholesale: 26, stock: 12000, moq: 30, unit: '条' },
      { name: '水洗棉抱枕套 45cm', wholesale: 18, stock: 22000, moq: 30, unit: '个' },
      { name: '素色亚麻四件套', wholesale: 128, stock: 3600, moq: 20, unit: '套' },
      { name: '餐垫（四片装）', wholesale: 12, stock: 26000, moq: 50, unit: '套' },
    ],
  },
  {
    id: 'SU-2204',
    name: '深圳声谷电子',
    categoryId: 'audio',
    categoryLabel: '数码音频',
    region: '广东 · 深圳',
    moq: 500,
    lead: 15,
    sample: 7,
    capacity: 40000,
    since: 2013,
    tags: ['支持定制', '工厂直供', '可开专票'],
    intro: 'TWS 耳机与蓝牙音箱方案商，支持 ODM 改外观、改 EQ、改包装。',
    products: [
      { name: '半入耳蓝牙耳机 A2', wholesale: 89, stock: 15000, moq: 500, unit: '副' },
      { name: '便携蓝牙音箱 S6', wholesale: 112, stock: 6800, moq: 300, unit: '台' },
      { name: '骨传导运动耳机', wholesale: 168, stock: 3200, moq: 300, unit: '副' },
      { name: '耳机硅胶套（10 对装）', wholesale: 6, stock: 60000, moq: 1000, unit: '盒' },
    ],
  },
  {
    id: 'SU-2205',
    name: '南通棉序家纺',
    categoryId: 'home',
    categoryLabel: '家居家具',
    region: '江苏 · 南通',
    moq: 100,
    lead: 12,
    sample: 4,
    capacity: 20000,
    since: 2009,
    tags: ['支持定制', '工厂直供'],
    intro: '纯棉与天丝床品，自有织造与缝制车间，可按图打样做独立品牌。',
    products: [
      { name: '60 支长绒棉四件套', wholesale: 196, stock: 5200, moq: 50, unit: '套' },
      { name: '天丝夏凉被', wholesale: 158, stock: 2800, moq: 50, unit: '床' },
      { name: '枕芯（羽丝绒）', wholesale: 34, stock: 18000, moq: 100, unit: '只' },
      { name: '床笠（单件）', wholesale: 68, stock: 6400, moq: 100, unit: '条' },
    ],
  },
  {
    id: 'SU-2206',
    name: '泉州衣言服饰',
    categoryId: 'apparel',
    categoryLabel: '服饰鞋包',
    region: '福建 · 泉州',
    moq: 60,
    lead: 10,
    sample: 5,
    capacity: 50000,
    since: 2012,
    tags: ['支持定制', '现货', '一件代发'],
    intro: '针织与梭织基础款，30 件起可混码，支持来图定制与自有吊牌。',
    products: [
      { name: '重磅纯棉 T 恤（250g）', wholesale: 42, stock: 36000, moq: 60, unit: '件' },
      { name: '宽松亚麻衬衫', wholesale: 86, stock: 12000, moq: 50, unit: '件' },
      { name: '垂感西装裤', wholesale: 108, stock: 8600, moq: 50, unit: '条' },
      { name: '棉质睡裙', wholesale: 56, stock: 9400, moq: 60, unit: '件' },
    ],
  },
  {
    id: 'SU-2207',
    name: '广州花研日化',
    categoryId: 'beauty',
    categoryLabel: '美妆个护',
    region: '广东 · 广州',
    moq: 300,
    lead: 20,
    sample: 10,
    capacity: 80000,
    since: 2015,
    tags: ['支持定制', '工厂直供', '可开专票'],
    intro: '面膜、洁面与身体护理 OEM/ODM，备案资料齐全，支持小批量试产。',
    products: [
      { name: '氨基酸洁面慕斯', wholesale: 32, stock: 26000, moq: 300, unit: '支' },
      { name: '玻尿酸补水面膜（10 片）', wholesale: 38, stock: 42000, moq: 300, unit: '盒' },
      { name: '身体乳 300ml', wholesale: 26, stock: 18000, moq: 500, unit: '瓶' },
      { name: '护手霜礼盒（3 支）', wholesale: 29, stock: 9600, moq: 200, unit: '盒' },
    ],
  },
  {
    id: 'SU-2208',
    name: '永康简造五金',
    categoryId: 'appliance',
    categoryLabel: '家用电器',
    region: '浙江 · 永康',
    moq: 120,
    lead: 9,
    sample: 4,
    capacity: 35000,
    since: 2010,
    tags: ['现货', '7天发货', '工厂直供'],
    intro: '小家电与厨房五金，电热水壶、手冲壶与保温杯，整机与配件都供。',
    products: [
      { name: '细口手冲电水壶', wholesale: 96, stock: 6200, moq: 100, unit: '只' },
      { name: '真空保温杯 500ml', wholesale: 38, stock: 24000, moq: 200, unit: '只' },
      { name: '桌面暖风机', wholesale: 78, stock: 4800, moq: 120, unit: '台' },
      { name: '电动打蛋器', wholesale: 46, stock: 8600, moq: 200, unit: '台' },
    ],
  },
  {
    id: 'SU-2209',
    name: '上海纸间文具',
    categoryId: 'stationery',
    categoryLabel: '文具办公',
    region: '上海 · 静安',
    moq: 100,
    lead: 6,
    sample: 3,
    capacity: 60000,
    since: 2018,
    tags: ['现货', '支持定制', '7天发货'],
    intro: '笔记本、手账与桌面收纳，封面可烫金压印，支持企业定制。',
    products: [
      { name: '布面精装笔记本 A5', wholesale: 22, stock: 32000, moq: 100, unit: '本' },
      { name: '可替换内芯手账本', wholesale: 34, stock: 14000, moq: 50, unit: '本' },
      { name: '黄铜书签（三枚）', wholesale: 16, stock: 26000, moq: 100, unit: '套' },
      { name: '桌面收纳笔筒', wholesale: 21, stock: 8800, moq: 100, unit: '个' },
    ],
  },
  {
    id: 'SU-2210',
    name: '青岛毛孩宠物用品',
    categoryId: 'pet',
    categoryLabel: '宠物生活',
    region: '山东 · 青岛',
    moq: 80,
    lead: 8,
    sample: 4,
    capacity: 28000,
    since: 2017,
    tags: ['现货', '支持定制', '一件代发'],
    intro: '宠物窝垫、牵引与餐具，可绣名字，支持礼盒与跨境包装。',
    products: [
      { name: '可拆洗宠物窝（中号）', wholesale: 84, stock: 6200, moq: 40, unit: '个' },
      { name: '尼龙牵引绳', wholesale: 18, stock: 24000, moq: 80, unit: '条' },
      { name: '陶瓷宠物碗（双碗）', wholesale: 32, stock: 9600, moq: 60, unit: '套' },
      { name: '猫抓板（瓦楞）', wholesale: 14, stock: 18000, moq: 100, unit: '个' },
    ],
  },
];

/** 地区清单由数据自己派生：新增供应商不必再回来维护一份下拉选项 */
export const REGIONS = [...new Set(SUPPLIERS.map((s) => s.region))].sort((a, b) => a.localeCompare(b, 'zh'));

/** 类目清单同理，附带每家供应商的可选类目 id（筛选 chips 用） */
export const SOURCE_CATEGORIES = (() => {
  const map = new Map();
  for (const s of SUPPLIERS) {
    if (!map.has(s.categoryId)) map.set(s.categoryId, { id: s.categoryId, label: s.categoryLabel, count: 0 });
    map.get(s.categoryId).count += 1;
  }
  return [...map.values()];
})();

const clone = (s) => ({ ...s, products: s.products.map((p) => ({ ...p })) });

/**
 * 按条件筛供应商。
 * @param {{category?: string, moq?: string, region?: string}} filters
 */
export function listSuppliers(filters = {}) {
  const band = moqBandOf(filters.moq || 'all');
  const category = String(filters.category || '').trim();
  const region = String(filters.region || '').trim();
  return SUPPLIERS
    .filter((s) => (!category || s.categoryId === category))
    .filter((s) => (!region || s.region === region))
    .filter((s) => s.moq >= band.min && s.moq <= band.max)
    .map(clone);
}

export function getSupplier(id) {
  const hit = SUPPLIERS.find((s) => s.id === String(id || '').trim());
  return hit ? clone(hit) : null;
}

export const totalSuppliers = () => SUPPLIERS.length;

/* ============================================================
   AI 找货（演示）
   ------------------------------------------------------------
   真做会走大模型把自然语言拆成结构化的品类/工艺/起订约束，
   这里用一张关键词表 + 打分，保证离线可用、结果确定可复现。
   任何返回都必须由页面标「演示数据」——不假装是真询价。
   ============================================================ */

/** 需求里的词 → 类目。命中类目比命中字面更可靠（「茶具」不一定会写到「家居」） */
const CATEGORY_HINTS = [
  { words: ['茶具', '茶器', '陶瓷', '盖碗', '杯子', '马克杯', '餐具', '四件套', '床品', '抱枕', '桌布', '家纺', '家居'], categoryId: 'home' },
  { words: ['锅', '厨具', '刀具', '厨房', '不锈钢', '沥水', '蒸锅'], categoryId: 'kitchen' },
  { words: ['耳机', '音箱', '蓝牙', '骨传导', '音频'], categoryId: 'audio' },
  { words: ['衣服', '服饰', 'T恤', 't恤', '衬衫', '裤', '裙', '针织'], categoryId: 'apparel' },
  { words: ['面膜', '护肤', '洁面', '身体乳', '护手霜', '美妆', '日化'], categoryId: 'beauty' },
  { words: ['电水壶', '小家电', '保温杯', '暖风', '打蛋器', '电器'], categoryId: 'appliance' },
  { words: ['笔记本', '文具', '手账', '书签', '笔筒', '办公'], categoryId: 'stationery' },
  { words: ['宠物', '猫', '狗', '牵引', '宠物窝'], categoryId: 'pet' },
];

/** 需求里的词 → 能力标签，用来在同类供应商里再排个先后 */
const TAG_HINTS = [
  { words: ['现货', '有货', '急'], tag: '现货' },
  { words: ['定制', 'logo', 'LOGO', '贴牌', '改款', '自有品牌'], tag: '支持定制' },
  { words: ['代发', '一件代发', '不压货'], tag: '一件代发' },
  { words: ['工厂', '源头', '直供'], tag: '工厂直供' },
  { words: ['发票', '专票', '开票'], tag: '可开专票' },
];

const norm = (s) => String(s || '').toLowerCase();

/** 已经由类目/能力两条规则吃掉的词，不再参与字面打分——否则「定制」这种通用词
    会把所有支持定制的供应商都拉进来，AI 找货的结果就成了「随机三家」 */
const HINT_WORDS = new Set([
  ...CATEGORY_HINTS.flatMap((h) => h.words),
  ...TAG_HINTS.flatMap((h) => h.words),
].map(norm));

/**
 * 把一句需求变成结构化条件（纯函数，导出是为了可被断言/复用于埋点）。
 * @returns {{categoryIds: string[], tags: string[], maxMoq: number|null, terms: string[]}}
 */
export function parseNeed(need) {
  const text = String(need || '');
  const lower = norm(text);
  const categoryIds = CATEGORY_HINTS.filter((h) => h.words.some((w) => lower.includes(norm(w)))).map((h) => h.categoryId);
  const tags = TAG_HINTS.filter((h) => h.words.some((w) => lower.includes(norm(w)))).map((h) => h.tag);
  // 「50 件以内 / 小批量」这类起订约束
  let maxMoq = null;
  const num = lower.match(/(\d{2,5})\s*(件|个|支|条|只|套|台|副)/);
  if (num) maxMoq = Number(num[1]);
  else if (/小批量|少量|试单|试产/.test(lower)) maxMoq = 100;
  const terms = lower
    .split(/[\s,，。、；;：:！!？?/]+/)
    .filter((t) => t.length >= 2 && !HINT_WORDS.has(t) && !/^\d+$/.test(t));
  return { categoryIds, tags, maxMoq, terms };
}

/**
 * AI 找货（演示）：返回供应商与商品两个维度。
 *
 * 入选门槛只有两条：**主营类目对得上**，或**字面命中**（名称 / 简介 / 商品名）。
 * 只命中「支持定制」「现货」这类能力标签不足以入选——那是加分项，不是资格项。
 * 一条都没匹配上时**如实返回空**，由页面提示换说法——比硬凑三条"推荐"诚实。
 */
export function findSourcing(need) {
  const q = parseNeed(need);
  const hasSignal = q.categoryIds.length > 0 || q.tags.length > 0 || q.terms.length > 0;

  const scored = SUPPLIERS.map((s) => {
    const hay = norm([
      s.name, s.categoryLabel, s.region, s.intro,
      s.products.map((p) => p.name).join(' '),
    ].join(' '));
    const catHit = q.categoryIds.includes(s.categoryId);
    const termHit = q.terms.some((term) => hay.includes(term));
    let score = 0;
    if (catHit) score += 6;
    for (const term of q.terms) if (hay.includes(term)) score += 1.5;
    for (const t of q.tags) if (s.tags.includes(t)) score += 2;
    if (q.maxMoq != null && s.moq <= q.maxMoq) score += 3;
    // 说了品类就只在这个品类里挑：字面命中「OEM/ODM」的化妆品厂
    // 不该出现在「找耳机 ODM」的结果里——那是字面巧合，不是货源
    const qualified = q.categoryIds.length ? catHit : termHit;
    return { supplier: clone(s), score, qualified };
  })
    .filter((r) => r.qualified && r.score > 0)
    .sort((a, b) => b.score - a.score || a.supplier.moq - b.supplier.moq);

  const top = scored.slice(0, 3);
  // 商品维度：按供应商的相关度顺序各取两件最便宜的，避免结果全被某一家包场
  const products = top
    .flatMap((r) => r.supplier.products
      .slice()
      .sort((a, b) => a.wholesale - b.wholesale)
      .slice(0, 2)
      .map((p) => ({
        ...p,
        supplierId: r.supplier.id,
        supplierName: r.supplier.name,
        region: r.supplier.region,
      })))
    .slice(0, 4);

  return {
    need: String(need || '').trim(),
    matched: hasSignal && top.length > 0,
    parsed: q,
    suppliers: top.map((r) => r.supplier),
    products,
    // 给页面用的一句话结论：说清「凭什么是这几个」，不吹成智能洞察
    hint: describeHint(q, top.length),
  };
}

function describeHint(q, n) {
  if (!n) return '这批演示数据里没有对得上的供应商，换个说法试试（比如「陶瓷茶具 小批量 现货」）。';
  const bits = [];
  if (q.categoryIds.length) bits.push('主营类目');
  if (q.tags.length) bits.push('供应能力');
  if (q.maxMoq != null) bits.push(`起订量 ≤ ${q.maxMoq} 件`);
  return `按${bits.join(' · ') || '关键词'}匹配到 ${n} 家供应商，以下为演示数据，不代表真实报价与库存。`;
}
