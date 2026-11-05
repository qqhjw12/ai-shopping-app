/**
 * products.js —— 分类树配套的 mock 商品数据源（本步纯数据层，不接页面商品源）。
 *
 * 生成策略：**确定性运行时生成**，等价于预生成静态数据但不占仓库体积。
 *   - 每个二级分类 5 款商品 → 220 × 5 = 1100 款；每个一级 7–11 个二级 → 35–55 款；
 *   - categoryId 优先挂三级分类（在该二级的三级间轮流分配），无三级时回落到二级；
 *   - 商品名 = 品牌 + 所属分类名 + 系列词，保证内容绝不串类目
 *     （美妆里不会出现手机，猫粮里不会出现连衣裙）；
 *   - 价格由「一级价格带 + 二级/三级关键词窄化」决定，点名口径：
 *     猫粮 20–300 / 智能手机 800–8000 / 香水 100–2000；
 *   - images 统一 3:4 data-URI SVG 占位图（深空令牌：--color-surface-1 底 +
 *     --color-cyan 细线），零外部请求，绝不破图。
 *
 * 设计令牌（与全局深空指挥舱一致）：
 *   --color-void #07090C / --color-surface-1 #0F141C / --color-cyan #22D3EE
 *   --color-text-muted #8B95A3 / --color-cyan-line rgba(34,211,238,.22)
 *
 * ⚠️ 依赖方向单向：products → categoryTree；categoryTree 不反向 import 本文件。
 *    加载本模块时会用真实商品数回填 CATEGORY_TREE 的 productCount（见文件末尾）。
 */
import {
  CATEGORY_TREE,
  getCategoryPath,
  getCategoryAndDescendantIds,
  setCategoryProductCounts,
} from './categoryTree.js';

/* ---------------- 稳定哈希（同一 id 每次生成结果一致，刷新不变） ---------------- */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const pick = (arr, seed, salt = 0) => arr[(hash(String(seed) + ':' + salt) >>> 0) % arr.length];
const inRange = (seed, min, max, salt = 0) => {
  const v = hash(String(seed) + ':p:' + salt) % 1000;
  return Math.round(min + (v / 999) * (max - min));
};

/* ---------------- 统一占位图（3:4，data-URI SVG，零网络请求） ---------------- */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" width="300" height="400">
<rect width="300" height="400" fill="#0F141C"/>
<rect x="0.5" y="0.5" width="299" height="399" fill="none" stroke="rgba(34,211,238,0.22)" stroke-width="1"/>
<path d="M24 40 H84 M24 360 H84 M216 40 H276 M216 360 H276" fill="none" stroke="rgba(34,211,238,0.38)" stroke-width="1"/>
<path d="M150 168 l24 24 -24 24 -24 -24 z" fill="none" stroke="rgba(34,211,238,0.42)" stroke-width="1"/>
<text x="150" y="236" fill="#8B95A3" font-family="monospace" font-size="12" letter-spacing="3" text-anchor="middle">OBJECT / 3:4</text>
<text x="150" y="256" fill="#22D3EE" font-family="monospace" font-size="9" letter-spacing="2" text-anchor="middle">CATALOG PLACEHOLDER</text>
</svg>`;
export const PLACEHOLDER_IMAGE = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

/* ---------------- 一级价格带（元） ---------------- */
const L1_BANDS = {
  womenswear: [59, 899], menswear: [69, 1299], lingerie: [29, 399], shoes: [99, 1599],
  bags: [129, 2999], jewelry: [99, 5999], watches: [199, 8999], beauty: [39, 1299],
  fragrance: [100, 2000], digital: [199, 8999], mobile: [800, 8000], computer: [999, 12999],
  appliance: [299, 9999], 'smart-home': [99, 3999], food: [9, 299], 'wine-tea': [49, 2999],
  'mother-baby': [29, 899], 'kids-toys': [29, 599], sports: [59, 2999], fitness: [99, 5999],
  'auto-parts': [39, 2999], pet: [20, 300], 'books-culture': [19, 399],
  stationery: [5, 299], music: [199, 9999],
};
/* 二级/三级名关键词窄化：点名口径锚到具体类目词，不再整级锁定；
 * 并补齐配件/耗材低价带，避免「手机配件 6000 元」「笔记本电脑 57 元」这类失真。 */
const NARROW_BANDS = [
  [/钻戒|翡翠|足银|机械表|名表/, [999, 29999]],
  // 规格点名口径：智能手机 800–8000 / 香水 100–2000 / 猫粮 20–300
  [/智能手机|旗舰手机|中端手机|电竞手机|折叠屏|手机通讯|5G手机/, [800, 8000]],
  [/女士香水|男士香水|香水|香氛|香薰/, [100, 2000]],
  [/猫粮|狗粮|宠物零食|猫砂|冻干|湿粮|处方粮/, [20, 300]],
  // 配件 / 耗材 / 小样：一律低价带（置于点名规则之后，不误伤整机与正装）
  [/手机配件|手机壳膜|数据线|充电器|充电宝|存储卡|数码配件|电脑配件|乐器配件|琴弦|拨片|谱架|调音器|琴包|箱包配件|行李牌|防尘袋|内胆包|鞋靴配件|鞋垫|鞋带|鞋油|撑鞋器|运动配件|护膝护腕|运动手套|空顶帽|配件|耗材|小样|Q版|旅行装/, [19, 599]],
  // 图书 / 文具：禁用单字「笔」——否则「笔记本（电脑）」会被压到 9–199 元
  [/图书|读物|小说|期刊|字帖|画册|本册|纸品|文具|布书|黑胶唱片/, [9, 199]],
];
const PC_LABEL = /笔记本|轻薄本|游戏本|商务本|创作者本|一体机|台式机|工作站|笔记本电脑/;
function bandFor(l1Id, label) {
  // 电脑一级的「笔记本」是整机不是文具：先按一级 + 完整词锁定，避免窄化规则互相误伤。
  if (l1Id === 'computer' && PC_LABEL.test(label)) return [2999, 12999];
  const hit = NARROW_BANDS.find(([re]) => re.test(label));
  return hit ? hit[1] : (L1_BANDS[l1Id] || [29, 999]);
}

/* ---------------- 虚构品牌池（按一级，避免真实商标） ---------------- */
const BRANDS = {
  womenswear: ['素白', '南枝', '云汐', '青序'], menswear: ['北屿', '岩序', '砺行', '墨山'],
  lingerie: ['柔序', '绵里', '栖月', '轻棉'], shoes: ['踏云', '履序', '步屿', '轻足'],
  bags: ['载物', '行囊', '简匣', '隅白'], jewelry: ['琢光', '银屿', '珠序', '珀里'],
  watches: ['时刻', '铨度', '辰屿', '摆序'], beauty: ['澄肌', '花漾', '白序', '肌研所'],
  fragrance: ['闻序', '香屿', '雾里', '一息'], digital: ['星曜', '极光', '曜石', 'NEXA'],
  mobile: ['星曜', '极光', 'NEXA', '讯屿'], computer: ['算力', '砺芯', '比特屿', '文序'],
  appliance: ['适屋', '净屿', '温序', '家隅'], 'smart-home': ['栖家', '智隅', '联序', '感应里'],
  food: ['食序', '田野', '谷屿', '鲜里'], 'wine-tea': ['酿序', '茶屿', '酌里', '春醅'],
  'mother-baby': ['小屿', '柔护', '初序', '抱里'], 'kids-toys': ['童屿', '玩序', '积木里', '小星球'],
  sports: ['越屿', '风序', '野行', '劲里'], fitness: ['炼序', '力屿', '核芯', '衡里'],
  'auto-parts': ['行驭', '车屿', '途序', '轮里'], pet: ['喵栈', '汪野', '毛球研究所', '宠序'],
  'books-culture': ['纸屿', '墨序', '页里', '文隅'], stationery: ['笔序', '纸里', '案屿', '简具'],
  music: ['弦屿', '音序', '共鸣里', '律隅'],
};
const DEFAULT_BRANDS = ['云枢', '北屿', '青序', '白序'];

/* ---------------- 属性模板（按类目语义选组，不串类目） ---------------- */
const ATTR_GROUPS = {
  apparel: { 颜色: ['雾白', '墨黑', '青灰', '砂杏', '雾蓝'], 尺码: ['S', 'M', 'L', 'XL', '均码'] },
  beauty: { 规格: ['30ml', '50ml', '100ml', '正装', '补充装'], 香型: ['花香调', '木质调', '柑橘调', '无香', '清新调'] },
  food: { 规格: ['200g', '500g', '1kg', '家庭装', '尝鲜装'], 口味: ['原味', '经典', '清淡', '浓香', '混合'] },
  digital: { 规格: ['标准版', 'Pro', 'Max', '套装', '单件'], 颜色: ['深空灰', '雾白', '青灰', '曜黑'] },
  book: { 装帧: ['平装', '精装', '函套', '活页'], 开本: ['32开', '16开', '大32开', '特规'] },
};
/** 一级类目 → 主属性组（默认语义；正则只用于少数明确跨组的例外）。 */
export const ATTR_GROUP_BY_L1 = {
  womenswear: 'apparel', menswear: 'apparel', lingerie: 'apparel', shoes: 'apparel',
  bags: 'apparel', jewelry: 'digital', watches: 'digital',
  beauty: 'beauty', fragrance: 'beauty',
  digital: 'digital', mobile: 'digital', computer: 'digital',
  appliance: 'digital', 'smart-home': 'digital', fitness: 'digital', 'auto-parts': 'digital',
  food: 'food', 'wine-tea': 'food', 'mother-baby': 'food', pet: 'food',
  'books-culture': 'book', stationery: 'book',
  'kids-toys': 'digital', sports: 'apparel', music: 'digital',
};
/** 仅当类目语义明确跨主组时才覆盖；正则一律用完整词，禁用单字。
 *  历史缺陷：「项链」命中单字「线」→ 数码组，「乳品饮料」命中「乳」→ 美妆组，
 *  music 全级命中「乐器」→ 装帧/开本，服饰无兜底一律打到数码组。 */
const GROUP_OVERRIDES = [
  [/数码配件|电脑配件|手机配件|数据线|充电器|充电宝|存储卡|乐器配件|琴弦|拨片|谱架|调音器|琴包|箱包配件|行李牌|防尘袋|内胆包|鞋靴配件|鞋垫|鞋带|鞋油|撑鞋器|运动配件|护膝护腕|运动手套|空顶帽|标签机|点钞机|计算器|吸奶器|安全座椅|婴儿推车|配件|耗材/, 'digital'],
  [/香水|香氛|香薰|面膜|口红|粉底|眼影|精华|防晒|护肤|彩妆|洗护|美容|精油|蜡烛|香波|护臀膏|面霜/, 'beauty'],
  [/猫粮|狗粮|宠物零食|猫砂|冻干|湿粮|处方粮|奶粉|辅食|零食|乳品饮料|鲜牛奶|酸奶|奶酪|水果|糕点|糖果|坚果|营养补剂|左旋肉碱/, 'food'],
  [/图书|读物|小说|期刊|字帖|画册|本册|纸品|文具|布书|黑胶唱片/, 'book'],
  [/童装|连衣裙|衬衫|外套|内衣|文胸|套装|运动服饰|瑜伽服|骑行服|尿裤|拉拉裤|成长裤|湿巾|猫包|牵引|胸背|围巾/, 'apparel'],
];
function attrGroup(l1Id, label) {
  const hit = GROUP_OVERRIDES.find(([re]) => re.test(label));
  return hit ? hit[1] : (ATTR_GROUP_BY_L1[l1Id] || 'digital');
}
function buildAttributes(seed, l1Id, label) {
  const tpl = ATTR_GROUPS[attrGroup(l1Id, label)];
  const keys = Object.keys(tpl);
  const out = {};
  keys.forEach((k, i) => { out[k] = pick(tpl[k], seed, 40 + i); });
  return out;
}

const SERIES = ['轻享系列', '经典款', '限定版', '日常系列', 'Pro 系列', '甄选款', '基础款', '进阶款'];
const TAGS = ['AI推荐', '新品', '热卖', '限量', '口碑', '编辑之选'];
const BASE_DATE = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const NEW_FROM = Date.UTC(2026, 8, 15);

/** 每个二级分类固定 5 款（规格 4–8），全站 1100 款（≥600）。 */
const PER_L2 = 5;

function buildProducts() {
  const out = [];
  for (const l1 of CATEGORY_TREE) {
    for (const l2 of l1.children) {
      const anchors = l2.children.length ? l2.children : [l2];
      for (let i = 0; i < PER_L2; i++) {
        const anchor = anchors[i % anchors.length];
        const id = `mp-${l1.id}-${l2.id.slice(l1.id.length + 1)}-${i + 1}`;
        const seed = `${l1.id}/${l2.id}/${anchor.id}/${i}`;
        const label = `${l2.name} ${anchor.name}`;
        const [min, max] = bandFor(l1.id, label);
        const price = inRange(seed, min, max, 1);
        const originalPrice = Math.round(price * (1.12 + (hash(seed + ':o') % 28) / 100));
        const ageDays = hash(seed + ':d') % 330;
        const createdMs = BASE_DATE + ageDays * DAY;
        const isNew = createdMs >= NEW_FROM;
        const brand = pick(BRANDS[l1.id] || DEFAULT_BRANDS, seed, 2);
        const tagA = pick(TAGS, seed, 5);
        const tagB = pick(TAGS.filter((t) => t !== tagA), seed, 6);
        const tags = isNew && !tagsHas(tagA, tagB, '新品') ? [tagA, '新品'] : [tagA, tagB];
        out.push({
          id,
          name: `${brand} ${anchor.name} ${pick(SERIES, seed, 3)}`,
          price,
          originalPrice,
          images: [PLACEHOLDER_IMAGE],
          categoryId: anchor.id,
          brand,
          attributes: buildAttributes(seed, l1.id, label),
          stock: 20 + (hash(seed + ':st') % 480),
          sales: hash(seed + ':sa') % 2400,
          rating: Number((3.8 + (hash(seed + ':rt') % 13) / 10).toFixed(1)),
          reviewCount: hash(seed + ':rv') % 3200,
          createdAt: new Date(createdMs).toISOString(),
          isNew,
          tags,
        });
      }
    }
  }
  return out;
}
function tagsHas(a, b, tag) { return a === tag || b === tag; }

/** 全站 mock 商品（确定性，刷新不变）。 */
export const products = buildProducts();

/* ---------------- 用真实商品数回填分类树（不再使用哈希假数字） ----------------
 * 叶子节点 productCount = 直接挂在该节点的商品数，
 * 父级 = 自身直接商品数 + 全部子节点计数（与 includeDescendants 查询口径一致）。 */
const DIRECT_COUNTS = new Map();
for (const p of products) {
  DIRECT_COUNTS.set(p.categoryId, (DIRECT_COUNTS.get(p.categoryId) || 0) + 1);
}
setCategoryProductCounts(DIRECT_COUNTS);

/* ---------------- 查询函数（页面唯一的消费入口） ---------------- */

/** 按分类查商品；includeDescendants 默认 true（查一级自动含全部子孙商品）。 */
export function getProductsByCategory(categoryId, opts = {}) {
  const includeDescendants = opts.includeDescendants !== false;
  const ids = includeDescendants ? getCategoryAndDescendantIds(categoryId) : [categoryId];
  const set = new Set(ids);
  return products.filter((p) => set.has(p.categoryId));
}

/** 按 id 取单个商品，未命中返回 null。 */
export function getProductById(id) {
  return products.find((p) => p.id === id) || null;
}

/** 关键词搜索：商品名 / 品牌 / 标签 / 所属分类及祖先链名称（搜「猫粮」可命中全部三级）。 */
export function searchProducts(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  return products.filter((p) => {
    if (p.name.toLowerCase().includes(kw) || p.brand.toLowerCase().includes(kw)) return true;
    if (p.tags.some((t) => t.toLowerCase().includes(kw))) return true;
    return getCategoryPath(p.categoryId)
      .some((n) => n.name.toLowerCase().includes(kw));
  });
}

/** 分类真实商品数（includeDescendants 默认 true）；categoryId 省略时返回全站总数。
 *  总览/菜单计数一律走这里，禁止再写死数字。 */
export function getCategoryProductCount(categoryId, opts = {}) {
  if (!categoryId) return products.length;
  return getProductsByCategory(categoryId, opts).length;
}
