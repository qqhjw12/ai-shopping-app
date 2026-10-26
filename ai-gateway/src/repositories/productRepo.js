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
  SELECT p.*, c.name AS category_name
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
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
    price: row.price,
    originalPrice: row.original_price,
    description: row.description,
    tags: safeJson(row.tags, []),
    rating: row.rating,
    reviewsCount: row.reviews_count,
    sales: row.sales,
    pic: '',
  };
}

export function listProducts({ categoryId, category } = {}) {
  const db = getDb();
  if (categoryId) {
    return db.prepare(`${BASE_SELECT} WHERE p.category_id = ? ORDER BY p.sales DESC`).all(categoryId).map(mapProduct);
  }
  if (category) {
    return db
      .prepare(`${BASE_SELECT} WHERE c.name = ? ORDER BY p.sales DESC`)
      .all(category)
      .map(mapProduct);
  }
  return db.prepare(`${BASE_SELECT} ORDER BY p.id`).all().map(mapProduct);
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
    .prepare('SELECT rating, content, created_at FROM reviews WHERE product_id = ? ORDER BY id DESC LIMIT 3')
    .all(p.id);
  p.totalStock = p.skus.reduce((s, k) => s + k.stock, 0);
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
    where.push('p.category_id = ?');
    args.push(categoryId);
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

export function listCategories() {
  const db = getDb();
  return db
    .prepare(`
      SELECT c.id, c.name, COUNT(p.id) AS count
      FROM categories c LEFT JOIN products p ON p.category_id = c.id
      GROUP BY c.id ORDER BY c.sort
    `)
    .all();
}

/** 类目名 → 类目 id（对话里说「耳机」要能映射到 audio 这类类目） */
export function resolveCategoryId(text) {
  if (!text) return null;
  const cats = listCategories();
  const hit = cats.find((c) => text.includes(c.name) || c.name.includes(text));
  return hit ? hit.id : null;
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
