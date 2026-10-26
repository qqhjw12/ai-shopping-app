// 商品仓储：所有商品读取都走这里（SQLite），保证列表/详情/检索/对话共用同一份真实数据。
import { getDb } from '../db/connection.js';

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const BASE_SELECT = `
  SELECT p.*, c.name AS category_name, sc.name AS sub_category_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories sc ON sc.id = p.sub_category_id
`;

function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    // category 保持中文名（前端与既有接口契约沿用该字段）
    category: row.category_name || '',
    categoryId: row.category_id,
    subCategory: row.sub_category_name || '',
    subCategoryId: row.sub_category_id || '',
    price: row.price,
    originalPrice: row.original_price,
    description: row.description,
    tags: safeJson(row.tags, []),
    rating: row.rating,
    reviewsCount: row.reviews_count,
    sales: row.sales,
    // 视觉：双色渐变封面 + 一句话卖点 + 服务承诺（前端据此渲染程序化商品图）
    coverColor: row.cover_color || '',
    highlight: row.highlight || '',
    highlights: safeJson(row.highlights, []),
    pic: '',
  };
}

// 排序方式 → SQL 片段（白名单，避免拼接注入）
const SORT_SQL = {
  default: 'p.sales DESC',
  sales: 'p.sales DESC',
  price_asc: 'p.price ASC',
  price_desc: 'p.price DESC',
  rating: 'p.rating DESC, p.sales DESC',
  new: 'p.id DESC',
};

/**
 * 商品列表：支持一级/二级类目、品牌、价格区间、排序与分页。
 * @param {object} q
 * @param {string} [q.categoryId] 一级类目 id（也可传二级 id，会自动分流）
 * @param {string} [q.subCategoryId] 二级类目 id
 * @param {string} [q.brand] 品牌名
 * @param {number} [q.minPrice] 最低价（含）
 * @param {number} [q.maxPrice] 最高价（含）
 * @param {string} [q.sort] default|sales|price_asc|price_desc|rating|new
 * @param {number} [q.limit] 每页条数（0 或不传表示不限）
 * @param {number} [q.offset] 偏移量
 */
export function listProducts(q = {}) {
  const {
    categoryId, category, subCategoryId, brand,
    minPrice, maxPrice, sort = 'default', limit = 0, offset = 0, keyword,
  } = q;
  const db = getDb();
  const where = [];
  const args = [];

  // 一级类目：既可能是 p.category_id，也可能是 parent_id 查询得到的二级集合
  if (categoryId) {
    const subs = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(categoryId).map((r) => r.id);
    if (subs.length) {
      where.push(`(p.category_id = ? OR p.sub_category_id IN (${subs.map(() => '?').join(',')}))`);
      args.push(categoryId, ...subs);
    } else {
      // 传进来的其实是二级类目 id —— 按二级筛
      where.push('(p.category_id = ? OR p.sub_category_id = ?)');
      args.push(categoryId, categoryId);
    }
  }
  if (subCategoryId) {
    where.push('p.sub_category_id = ?');
    args.push(subCategoryId);
  }
  if (category) {
    where.push('c.name = ?');
    args.push(category);
  }
  if (brand) {
    where.push('p.brand = ?');
    args.push(brand);
  }
  if (Number.isFinite(minPrice)) {
    where.push('p.price >= ?');
    args.push(minPrice);
  }
  if (Number.isFinite(maxPrice)) {
    where.push('p.price <= ?');
    args.push(maxPrice);
  }
  if (keyword) {
    where.push('(p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ? OR p.brand LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }

  const orderBy = SORT_SQL[sort] || SORT_SQL.default;
  let sql = `${BASE_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${orderBy}`;
  const limitNum = Number(limit) || 0;
  const offsetNum = Number(offset) || 0;
  if (limitNum > 0) {
    sql += ` LIMIT ?${offsetNum > 0 ? ' OFFSET ?' : ''}`;
    args.push(limitNum);
    if (offsetNum > 0) args.push(offsetNum);
  }
  return db.prepare(sql).all(...args).map(mapProduct);
}

/** 与上面筛选条件一致的总数（分页时用） */
export function countProductsFiltered(q = {}) {
  const { categoryId, category, subCategoryId, brand, minPrice, maxPrice, keyword } = q;
  const db = getDb();
  const where = [];
  const args = [];
  if (categoryId) {
    const subs = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(categoryId).map((r) => r.id);
    if (subs.length) {
      where.push(`(p.category_id = ? OR p.sub_category_id IN (${subs.map(() => '?').join(',')}))`);
      args.push(categoryId, ...subs);
    } else {
      where.push('(p.category_id = ? OR p.sub_category_id = ?)');
      args.push(categoryId, categoryId);
    }
  }
  if (subCategoryId) {
    where.push('p.sub_category_id = ?');
    args.push(subCategoryId);
  }
  if (category) {
    where.push('c.name = ?');
    args.push(category);
  }
  if (brand) {
    where.push('p.brand = ?');
    args.push(brand);
  }
  if (Number.isFinite(minPrice)) {
    where.push('p.price >= ?');
    args.push(minPrice);
  }
  if (Number.isFinite(maxPrice)) {
    where.push('p.price <= ?');
    args.push(maxPrice);
  }
  if (keyword) {
    where.push('(p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ? OR p.brand LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }
  const join = category || keyword ? ' LEFT JOIN categories c ON c.id = p.category_id' : '';
  return db
    .prepare(`SELECT COUNT(*) AS n FROM products p${join}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`)
    .get(...args).n;
}

export function countProducts() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM products').get().n;
}

export function getProductById(id) {
  if (id == null) return null;
  const db = getDb();
  const row = db.prepare(`${BASE_SELECT} WHERE p.id = ?`).get(String(id));
  return mapProduct(row);
}

/** 商品详情：附带 SKU 与最近评价（详情页 / 问答都可用） */
export function getProductDetail(id) {
  const p = getProductById(id);
  if (!p) return null;
  const db = getDb();
  p.skus = db
    .prepare('SELECT id, spec, price, stock, status FROM product_skus WHERE product_id = ? ORDER BY price')
    .all(p.id);
  p.reviews = db
    .prepare('SELECT rating, content, author, created_at FROM reviews WHERE product_id = ? ORDER BY id DESC LIMIT 6')
    .all(p.id);
  p.totalStock = p.skus.reduce((s, k) => s + k.stock, 0);
  // 价格区间：多 SKU 定价不同时，列表展示「¥x 起」
  const prices = p.skus.map((s) => s.price);
  p.priceRange = prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
    ? [Math.min(...prices), Math.max(...prices)]
    : null;
  return p;
}

/** 按价格 / 类目 / 关键词做结构化筛选（对话引擎的推荐用地基） */
export function filterProducts({ maxPrice, minPrice, categoryId, category, keyword, limit = 8 } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (Number.isFinite(maxPrice)) {
    where.push('p.price <= ?');
    args.push(maxPrice);
  }
  if (Number.isFinite(minPrice)) {
    where.push('p.price >= ?');
    args.push(minPrice);
  }
  if (categoryId) {
    // 一级类目（含其下二级）：先查二级，拼 IN；若传的是二级 id 也能直接筛中
    const subs = categoryId === 'all' ? [] : getDb()
      .prepare('SELECT id FROM categories WHERE parent_id = ?')
      .all(categoryId)
      .map((r) => r.id);
    if (subs.length) {
      where.push(`(p.category_id = ? OR p.sub_category_id IN (${subs.map(() => '?').join(',')}))`);
      args.push(categoryId, ...subs);
    } else {
      where.push('(p.category_id = ? OR p.sub_category_id = ?)');
      args.push(categoryId, categoryId);
    }
  }
  if (category) {
    where.push('c.name = ?');
    args.push(category);
  }
  if (keyword) {
    where.push('(p.name LIKE ? OR p.description LIKE ? OR p.tags LIKE ? OR p.brand LIKE ?)');
    const like = `%${keyword}%`;
    args.push(like, like, like, like);
  }
  const sql = `${BASE_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.sales DESC LIMIT ?`;
  args.push(limit);
  return db.prepare(sql).all(...args).map(mapProduct);
}

/** 一级类目列表（带商品数 / icon / 描述），对话引擎resolve用 */
export function listCategories() {
  const db = getDb();
  return db
    .prepare(`
      SELECT c.id, c.name, c.icon, c.desc, COUNT(p.id) AS count
      FROM categories c LEFT JOIN products p ON p.category_id = c.id
      WHERE c.parent_id IS NULL
      GROUP BY c.id ORDER BY c.sort
    `)
    .all();
}

/**
 * 两级分类树：每个一级类目带商品数、son。
 * @param {boolean} [withCount] 是否附带商品数（首页卡片用）
 */
export function categoryTree() {
  const db = getDb();
  const tops = db
    .prepare(`
      SELECT c.id, c.name, c.icon, c.desc, c.sort, COUNT(p.id) AS count
      FROM categories c LEFT JOIN products p ON p.category_id = c.id
      WHERE c.parent_id IS NULL
      GROUP BY c.id ORDER BY c.sort
    `)
    .all();
  const subs = db
    .prepare(`
      SELECT c.id, c.name, c.parent_id, c.sort, COUNT(p.id) AS count
      FROM categories c LEFT JOIN products p ON p.sub_category_id = c.id
      WHERE c.parent_id IS NOT NULL
      GROUP BY c.id ORDER BY c.sort
    `)
    .all();
  return tops.map((t) => ({
    id: t.id,
    name: t.name,
    icon: t.icon,
    desc: t.desc,
    sort: t.sort,
    count: t.count,
    children: subs
      .filter((s) => s.parent_id === t.id)
      .map((s) => ({ id: s.id, name: s.name, parentId: s.parent_id, count: s.count })),
  }));
}

/** 品牌列表（带商品数与主营类目），支持按一级类目过滤 */
export function listBrands({ categoryId } = {}) {
  const db = getDb();
  if (categoryId) {
    return db
      .prepare(`
        SELECT b.id, b.name, b.logo_color AS logoColor, b.category_id AS categoryId, COUNT(p.id) AS count
        FROM brands b JOIN products p ON p.brand = b.name AND p.category_id = ?
        GROUP BY b.id ORDER BY count DESC
      `)
      .all(categoryId);
  }
  return db
    .prepare(`
      SELECT b.id, b.name, b.logo_color AS logoColor, b.category_id AS categoryId,
             (SELECT COUNT(*) FROM products p WHERE p.brand = b.name) AS count
      FROM brands b ORDER BY count DESC
    `)
    .all();
}

/** 全站概览：商品数 / SKU 数 / 类目数 / 品牌数（首页与状态展示用） */
export function stats() {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get().n;
  return {
    products: one('SELECT COUNT(*) AS n FROM products'),
    skus: one('SELECT COUNT(*) AS n FROM product_skus'),
    categories: one('SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NULL'),
    subCategories: one('SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NOT NULL'),
    brands: one('SELECT COUNT(*) AS n FROM brands'),
    reviews: one('SELECT COUNT(*) AS n FROM reviews'),
  };
}

// 类目同义词：用户不会照着类目名说话——说「猫」其实要找宠物用品，
// 说「母婴用品」而类目叫「母婴玩具」。这里做口语到类目的映射（顺序即优先级）。
const CATEGORY_SYNONYMS = [
  ['pet', ['宠物', '猫粮', '狗粮', '猫', '狗', '主子', '猫砂', '罐头', '毛孩子']],
  ['baby', ['母婴', '婴儿', '宝宝', '奶粉', '尿裤', '辅食', '幼儿', '小孩', '娃']],
  ['beauty', ['美妆', '护肤', '化妆品', '口红', '面膜', '精华', '防晒', '洗面奶', '香水']],
  ['health', ['保健', '健康', '血压', '血糖', '按摩', '营养', '维生素', '养生']],
  ['stationery', ['文具', '笔记本子', '中性笔', '钢笔', '便利贴', '手账']],
  ['kitchen', ['厨具', '餐具', '锅', '厨房', '保温杯', '保鲜盒']],
  ['book', ['图书', '买本书', '绘本', '看书', '乐器', '尤克里里', '吉他', '电子琴']],
  ['auto', ['车载', '汽车', '骑行', '自行车', '电动车', '头盔', '行车记录仪']],
  ['audio', ['耳机', '音箱', '音响', '降噪', '蓝牙耳机', '麦克风']],
  ['phone', ['手机', '平板', '手表', '充电宝', '智能机', '数码']],
  ['computer', ['电脑', '笔记本', '显示器', '键盘', '鼠标', '办公设备', '主机']],
  ['appliance', ['家电', '电器', '空调', '净化器', '洗衣机', '扫地机', '净水器']],
  ['apparel', ['衣服', '服装', '外套', '裤子', '鞋', '箱包', '背包', '穿搭']],
  ['food', ['零食', '吃的', '食品', '大米', '咖啡豆', '冲调', '杂粮']],
  ['home', ['家居', '家具', '床品', '床垫', '沙发', '收纳']],
  ['sports', ['运动', '户外', '露营', '健身', '瑜伽', '徒步', '帐篷']],
];

/** 类目名 / 二级类目名 / 口语同义词 → 一级类目 id */
export function resolveCategoryId(text) {
  if (!text) return null;
  const t = String(text);
  const db = getDb();
  // 1) 完整类目名优先（一级与二级都认，命中二级时返回其一级）
  const all = db.prepare('SELECT id, name, parent_id FROM categories').all();
  const named = all.filter((c) => c.name && t.includes(c.name));
  if (named.length) {
    const hit = named.sort((a, b) => b.name.length - a.name.length)[0];
    return hit.parent_id || hit.id;
  }
  // 2) 口语同义词
  for (const [cid, words] of CATEGORY_SYNONYMS) {
    if (words.some((w) => t.includes(w))) return cid;
  }
  return null;
}

/** 全量商品（供检索索引构建，字段与旧 sampleProducts 对齐） */
export function allForIndex() {
  return listProducts();
}

/** 同类热销（详情页「相关推荐」兜底 / 对话补推荐） */
export function similarProducts(productId, limit = 4) {
  const p = getProductById(productId);
  if (!p) return [];
  return getDb()
    .prepare(`${BASE_SELECT} WHERE p.category_id = ? AND p.id <> ? ORDER BY p.sales DESC LIMIT ?`)
    .all(p.categoryId, p.id, limit)
    .map(mapProduct);
}

// 中文没有分词器，用「商品标签 + 品牌 + 类目 + 常见名词」组一个词表，
// 在用户句子里做最长匹配——比整句 LIKE 准得多（「预算1500的降噪耳机」能命中「降噪」「耳机」）。
let vocabCache = null;

export function searchVocabulary() {
  if (vocabCache) return vocabCache;
  const db = getDb();
  const rows = db.prepare('SELECT brand, tags FROM products').all();
  const set = new Set();
  for (const r of rows) {
    if (r.brand) set.add(r.brand);
    for (const t of safeJson(r.tags, [])) set.add(t);
  }
  for (const c of listCategories()) set.add(c.name);
  [
    '耳机', '手机', '平板', '手表', '笔记本', '电脑', '键盘', '鼠标', '显示器', '音箱', '充电器',
    '空调', '净化器', '净水器', '咖啡机', '料理机', '除湿机', '电水壶', '取暖器',
    '羽绒服', '冲锋衣', '牛仔裤', '针织衫', '背包', '鞋', '大米', '咖啡豆', '坚果', '橄榄油',
    '椅子', '书桌', '床垫', '沙发', '枕头', '扫地机器人', '灯',
    '帐篷', '登山杖', '露营', '水壶', '运动', '徒步',
    '降噪', '蓝牙', '无线', '有线', '办公', '游戏', '学生', '通勤', '送礼', '轻量', '静音',
  ].forEach((w) => set.add(w));
  vocabCache = [...set].filter((w) => w && w.length >= 2).sort((a, b) => b.length - a.length);
  return vocabCache;
}
