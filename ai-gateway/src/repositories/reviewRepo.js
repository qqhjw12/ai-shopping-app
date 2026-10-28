// 评价仓储：列表 / 概览 / 写评价 / 追评 / 有用投票。
// 与既有仓储保持一致：只依赖 connection.getDb()，全部参数化查询，不放任何用户输入进 SQL 字符串。
import { getDb } from '../db/connection.js';
import { resolveMediaList } from '../storage/index.js';

// 业务约束集中在此，路由层与存储层共用同一份口径
export const REVIEW_RULES = {
  contentMin: 5,
  contentMax: 500,
  imageMax: 6,
  ratingMin: 1,
  ratingMax: 5,
};

const DEFAULT_AUTHOR = '匿名用户';
// 允许的图片标识：
//   · 对象存储键 reviews/YYYY/MM/<uuid>.<ext>（新，读取时现签 URL）
//   · 旧的本地相对路径 /api/uploads/<name>（历史数据，继续可读）
//   · http(s) 绝对地址（历史数据 / 外链）
// 作用是挡掉 javascript: / data: 等可被当作 src 执行的伪协议，避免存储型 XSS。
const SAFE_IMAGE = /^(?:\/api\/uploads\/[\w.-]+|reviews\/\d{4}\/\d{2}\/[A-Za-z0-9-]{1,64}\.(?:jpg|jpeg|png|webp|gif)|https?:\/\/\S+)$/;

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 图片数组收敛：去空、限数量、过滤非法协议 */
export function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((u) => String(u || '').trim())
    .filter((u) => u && SAFE_IMAGE.test(u))
    .slice(0, REVIEW_RULES.imageMax);
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

// 单条评价查询：helpful = 投票总数，voted = 当前用户是否已投（用于前端选中态与幂等切换）
const ROW_COLS = `
  r.id, r.product_id, r.parent_id, r.user_id, r.author, r.rating, r.content,
  r.images, r.sku_spec, r.source, r.created_at,
  (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = r.id) AS helpful,
  EXISTS(SELECT 1 FROM review_votes v WHERE v.review_id = r.id AND v.user_id = ?) AS voted
`;

function mapReview(row, withFollowUps = true) {
  if (!row) return null;
  const base = {
    id: row.id,
    productId: row.product_id,
    parentId: row.parent_id ?? null,
    userId: row.user_id || 'anonymous',
    author: row.author || DEFAULT_AUTHOR,
    rating: Number(row.rating) || 0,
    content: row.content || '',
    // 库里存的是对象键；出口统一换成可直接渲染的地址（s3 驱动下是现签的短期 URL）
    images: resolveMediaList(normalizeImages(safeJson(row.images, []))),
    skuSpec: row.sku_spec || '',
    source: row.source || 'seed',
    helpful: Number(row.helpful) || 0,
    voted: Boolean(row.voted),
    createdAt: row.created_at,
    isMine: false, // 由路由层按 userId 回填：仓储不感知「当前登录态」
  };
  return withFollowUps ? { ...base, followUps: [] } : base;
}

// 排序 / 筛选白名单：外部字符串不准拼接进 SQL
const SORT_SQL = {
  helpful: 'helpful DESC, r.id DESC',
  latest: 'r.created_at DESC, r.id DESC',
};
const FILTER_SQL = {
  all: '',
  good: ' AND r.rating >= 4',
  mid: ' AND r.rating = 3',
  bad: ' AND r.rating <= 2',
};

/**
 * 评价列表：取主评价（parent_id IS NULL）并把追评嵌套到 followUps。
 * @param {string} productId
 * @param {{userId?:string, filter?:'all'|'good'|'mid'|'bad', sort?:'latest'|'helpful', limit?:number, offset?:number}} [opts]
 * @returns {{reviews:Array, summary:object, hasMore:boolean}}
 */
export function listReviews(productId, opts = {}) {
  const pid = String(productId);
  const {
    userId = 'anonymous',
    filter = 'all',
    sort = 'latest',
    limit = 20,
    offset = 0,
  } = opts;
  const db = getDb();
  const orderBy = SORT_SQL[sort] || SORT_SQL.latest;
  const where = FILTER_SQL[filter] ?? '';
  const limitNum = Number(limit) || 0;
  const offsetNum = Number(offset) || 0;

  let sql = `SELECT ${ROW_COLS} FROM reviews r WHERE r.product_id = ? AND r.parent_id IS NULL${where}
             ORDER BY ${orderBy}`;
  const args = [userId, pid];
  if (limitNum > 0) {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limitNum, offsetNum);
  }
  const mains = db.prepare(sql).all(...args).map((r) => mapReview(r));

  // 追评数量有限且依附主评价展示，一次性取全部再按 parent_id 挂载，不做分页
  const followUps = db
    .prepare(`SELECT ${ROW_COLS} FROM reviews r WHERE r.product_id = ? AND r.parent_id IS NOT NULL
              ORDER BY r.created_at ASC, r.id ASC`)
    .all(userId, pid)
    .map((r) => mapReview(r, false));
  const byParent = new Map();
  for (const f of followUps) {
    if (!byParent.has(f.parentId)) byParent.set(f.parentId, []);
    byParent.get(f.parentId).push(f);
  }
  for (const m of mains) {
    m.followUps = byParent.get(m.id) || [];
    m.isMine = m.userId === userId && m.source === 'user';
  }

  const summary = reviewSummary(pid);
  const hasMore = limitNum > 0 ? offsetNum + mains.length < summary.total : false;
  return { reviews: mains, summary, hasMore };
}

/** 评价概览：总数 / 均分 / 星级分布 / 好评率（仅统计主评价，追评不重复计入） */
export function reviewSummary(productId) {
  const pid = String(productId);
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) AS total, AVG(rating) AS avg FROM reviews WHERE product_id = ? AND parent_id IS NULL')
    .get(pid);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  db.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? AND parent_id IS NULL GROUP BY rating')
    .all(pid)
    .forEach((r) => {
      if (distribution[r.rating] !== undefined) distribution[r.rating] = r.n;
    });
  const total = row.total || 0;
  const good = distribution[5] + distribution[4];
  return {
    total,
    avg: total && row.avg != null ? Number(Number(row.avg).toFixed(1)) : 0,
    distribution,
    goodRate: total ? Math.round((good / total) * 100) : 0,
  };
}

/** 写评价落库后同步商品冗余字段（列表页的评价数与星级随真实评价即时变化） */
function syncProductStats(productId) {
  const pid = String(productId);
  getDb()
    .prepare(`
      UPDATE products SET
        reviews_count = (SELECT COUNT(*) FROM reviews WHERE product_id = ? AND parent_id IS NULL),
        rating = COALESCE((SELECT ROUND(AVG(rating), 2) FROM reviews WHERE product_id = ? AND parent_id IS NULL), rating)
      WHERE id = ?
    `)
    .run(pid, pid, pid);
}

function getReview(id, userId = 'anonymous') {
  return mapReview(
    getDb().prepare(`SELECT ${ROW_COLS} FROM reviews r WHERE r.id = ?`).all(userId, Number(id))[0],
  );
}

/**
 * 发布评价（主评价）。
 * @throws 带 status 的业务错误：商品不存在 404 / 参数不合法 400
 */
export function createReview({
  productId, userId = 'anonymous', author, rating, content, skuSpec, images,
}) {
  const pid = String(productId || '');
  if (!getDb().prepare('SELECT id FROM products WHERE id = ?').get(pid)) throw fail('商品不存在', 404);

  const r = Number(rating);
  const { contentMin, contentMax, ratingMin, ratingMax, imageMax } = REVIEW_RULES;
  if (!Number.isInteger(r) || r < ratingMin || r > ratingMax) throw fail('请先选择 1-5 星评分');
  const text = String(content || '').trim();
  if (text.length < contentMin) throw fail(`评价内容至少 ${contentMin} 个字`);
  if (text.length > contentMax) throw fail(`评价内容最多 ${contentMax} 字`);

  const pics = normalizeImages(images);
  if (Array.isArray(images) && images.length > imageMax) throw fail(`最多上传 ${imageMax} 张图片`);

  const res = getDb()
    .prepare(`
      INSERT INTO reviews (product_id, user_id, author, rating, content, images, sku_spec, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user')
    `)
    .run(
      pid,
      String(userId || 'anonymous'),
      String(author || DEFAULT_AUTHOR).slice(0, 20) || DEFAULT_AUTHOR,
      r,
      text,
      JSON.stringify(pics),
      String(skuSpec || '').slice(0, 40),
    );
  syncProductStats(pid);
  const review = getReview(Number(res.lastInsertRowid), userId);
  review.isMine = true;
  return review;
}

/** 追评：挂在已有主评价下，继承 product_id，不需要重新评分 */
export function createFollowUp({ reviewId, userId = 'anonymous', author, content, images }) {
  const db = getDb();
  const parent = db.prepare('SELECT id, product_id, parent_id, rating FROM reviews WHERE id = ?').get(Number(reviewId));
  if (!parent) throw fail('被追评的评价不存在', 404);
  if (parent.parent_id != null) throw fail('只能对主评价追加追评，追评不可再追评');

  const text = String(content || '').trim();
  if (text.length < REVIEW_RULES.contentMin) throw fail(`追评内容至少 ${REVIEW_RULES.contentMin} 个字`);
  if (text.length > REVIEW_RULES.contentMax) throw fail(`追评内容最多 ${REVIEW_RULES.contentMax} 字`);
  const pics = normalizeImages(images);
  if (Array.isArray(images) && images.length > REVIEW_RULES.imageMax) throw fail(`最多上传 ${REVIEW_RULES.imageMax} 张图片`);

  const res = db
    .prepare(`
      INSERT INTO reviews (product_id, parent_id, user_id, author, rating, content, images, sku_spec, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', 'user')
    `)
    .run(
      parent.product_id,
      parent.id,
      String(userId || 'anonymous'),
      String(author || DEFAULT_AUTHOR).slice(0, 20) || DEFAULT_AUTHOR,
      // 追评不重新打分：沿用主评价星级，保证「评分分布」统计口径不变
      Number(parent.rating) || 5,
      text,
      JSON.stringify(pics),
    );
  const review = mapReview(
    db.prepare(`SELECT ${ROW_COLS} FROM reviews r WHERE r.id = ?`).all(String(userId), Number(res.lastInsertRowid))[0],
    false,
  );
  review.isMine = true;
  return review;
}

/**
 * 有用投票：幂等切换。同一用户对同一评价只能有一条记录，
 * 因此「取消赞」就是删记录，计数天然不会漂移。
 * @returns {{voted:boolean, helpful:number}}
 */
export function toggleHelpful(reviewId, userId = 'anonymous') {
  const id = Number(reviewId);
  const uid = String(userId || 'anonymous');
  const db = getDb();
  if (!db.prepare('SELECT id FROM reviews WHERE id = ?').get(id)) throw fail('评价不存在', 404);

  const exists = db.prepare('SELECT review_id FROM review_votes WHERE review_id = ? AND user_id = ?').get(id, uid);
  if (exists) db.prepare('DELETE FROM review_votes WHERE review_id = ? AND user_id = ?').run(id, uid);
  else db.prepare('INSERT INTO review_votes (review_id, user_id) VALUES (?, ?)').run(id, uid);

  const helpful = db.prepare('SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ?').get(id).n;
  return { voted: !exists, helpful };
}
