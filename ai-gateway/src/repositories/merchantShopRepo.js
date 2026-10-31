// 商家工作台仓储：店铺资料 / 商家商品 / 商家订单。
//
// 与 merchantRepo 的分工：那边管「入驻申请」，这边管「入驻之后这家店在卖什么」。
//
// 三条口径写在这一层，页面不用重复判断：
//
//   1) **商品归属靠 products.merchant_id**。商家商品不另开表——它一旦能被下单，
//      就要和平台自营商品一起被搜索、加购、扣库存、写评价。开两张表等于把售卖链路上
//      每个 JOIN 改写成 UNION，漏掉一处就是「能加购不能下单」。
//
//   2) **库存以 SKU 为准**。下单扣减、加购上限都读 product_skus.stock，
//      所以商家商品在创建时就带一条「默认」SKU，库存编辑改的是这条 SKU。
//      商品表上不再冗余一份 stock，避免两个数字打架。
//
//   3) **审核状态只做单向门**：pending → approved / rejected。approved 之后商家可以
//      自己上下架（status 在 on_sale / off_sale 之间切），但 review_status 不变——
//      「审过一次」这个事实不该被商家的一次下架抹掉。
import { getDb } from '../db/connection.js';
import { resolveMedia } from '../storage/index.js';

const PRODUCT_STATUS = { on_sale: '在售', off_sale: '已下架' };
const REVIEW_STATUS_LABEL = { pending: '审核中', approved: '已通过', rejected: '未通过' };

const dbTime = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');

/**
 * 价格统一折算成**整数元**。
 * 平台商品表本来就是整数元（2999 = ¥2999），这里跟着平台口径走而不是自己发明「分」，
 * 否则商家商品标 ¥128 会被前端按元渲染成 ¥12800——这类错误一上线就是全店价格错乱。
 */
const toYuan = (v) => Math.round(Number(v) || 0);

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ============================================================
   店铺资料
   ============================================================ */

function mapShop(row) {
  if (!row) return null;
  return {
    name: row.name,
    intro: row.intro,
    logoText: row.logo_text,
    logoColor: Number(row.logo_color) || 0,
    // 返回对象键（key）给前端存、返回 url 给前端当下预览；URL 有时效，不该被持久化
    logoKey: row.logo_key || '',
    updatedAt: row.updated_at,
  };
}

export function getShop(applicationId) {
  const row = getDb()
    .prepare('SELECT * FROM merchant_shops WHERE application_id = ?')
    .get(String(applicationId || ''));
  return mapShop(row);
}

/**
 * 首次进入工作台时按申请资料派生一份店铺资料。
 *
 * 与页面上的本地演示种子同一套派生规则（店名取品牌名、简介说人话、字标取品牌首字），
 * 这样「本地演示」与「真后端」看到的店是同一家，不会让人以为是两个系统。
 */
export function ensureShop(application) {
  const id = String((application && application.id) || '');
  if (!id) throw Object.assign(new Error('缺少商家编号'), { status: 400 });
  const existing = getShop(id);
  if (existing) return existing;

  const brand = String(application.brand || application.company || '我的店铺').trim().slice(0, 30);
  const cats = Array.isArray(application.categories) ? application.categories : [];
  const intro = cats.length
    ? `${brand}，做${cats.length >= 2 ? '这几件' : '一件'}我们自己也天天用的小东西。`
    : `${brand} 的官方店铺。`;
  const logoText = brand.replace(/[a-zA-Z\s]/g, '').slice(0, 2) || brand.slice(0, 2) || '店';

  getDb().prepare(`
    INSERT INTO merchant_shops (application_id, name, intro, logo_text, logo_color, logo_key)
    VALUES (?, ?, ?, ?, 0, '')
  `).run(id, brand, intro.slice(0, 120), logoText);
  return getShop(id);
}

export function updateShop(applicationId, patch = {}) {
  const db = getDb();
  const current = getShop(applicationId);
  if (!current) throw Object.assign(new Error('店铺还没建立'), { status: 404 });
  const next = {
    name: patch.name == null ? current.name : String(patch.name).trim().slice(0, 30),
    intro: patch.intro == null ? current.intro : String(patch.intro).trim().slice(0, 120),
    logoText: (patch.logoText == null ? current.logoText : String(patch.logoText).trim().slice(0, 2)) || '店',
    logoColor: patch.logoColor == null ? current.logoColor : Math.max(0, Math.min(5, Number(patch.logoColor) || 0)),
    logoKey: patch.logoKey == null ? current.logoKey : String(patch.logoKey),
  };
  db.prepare(`
    UPDATE merchant_shops
    SET name = ?, intro = ?, logo_text = ?, logo_color = ?, logo_key = ?, updated_at = ?
    WHERE application_id = ?
  `).run(next.name, next.intro, next.logoText, next.logoColor, next.logoKey, dbTime(), String(applicationId));
  return getShop(applicationId);
}

/* ============================================================
   商家商品
   ============================================================ */

/** 商品 + 库存（库存取该商品价格最低的那条 SKU，商家商品只有一条「默认」） */
const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name,
         (SELECT s.stock FROM product_skus s WHERE s.product_id = p.id ORDER BY s.id LIMIT 1) AS stock,
         (SELECT s.spec  FROM product_skus s WHERE s.product_id = p.id ORDER BY s.id LIMIT 1) AS sku_spec
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

function mapProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    category: row.category_name || '',
    price: row.price, // 平台价格口径是「整数元」，接口原样给
    imageKey: row.image_url || '',
    // 现签的可访问地址：对象键 15 分钟就过期，只能当次给，不能存
    imageUrl: resolveMedia(row.image_url || ''),
    stock: Number(row.stock) || 0,
    warnAt: Number(row.warn_at) || 10,
    // 商家视角的状态：审核结论优先，其次才是上下架
    reviewStatus: row.review_status,
    reviewLabel: REVIEW_STATUS_LABEL[row.review_status] || row.review_status,
    reviewNote: row.review_note || '',
    status: row.status,
    statusLabel: PRODUCT_STATUS[row.status] || row.status,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

export function listProducts(applicationId) {
  return getDb()
    .prepare(`${PRODUCT_SELECT} WHERE p.merchant_id = ? ORDER BY p.created_at DESC, p.id DESC`)
    .all(String(applicationId || ''))
    .map(mapProduct);
}

export function countProducts(applicationId) {
  const rows = getDb()
    .prepare('SELECT review_status, status FROM products WHERE merchant_id = ?')
    .all(String(applicationId || ''));
  const counts = { all: rows.length, onSale: 0, offSale: 0, pending: 0, rejected: 0 };
  for (const r of rows) {
    if (r.review_status === 'pending') counts.pending += 1;
    else if (r.review_status === 'rejected') counts.rejected += 1;
    else if (r.status === 'off_sale') counts.offSale += 1;
    else counts.onSale += 1;
  }
  return counts;
}

export function findProduct(productId) {
  return mapProduct(getDb().prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(String(productId || '')));
}

/** 按「我的货」口径取一件商品：别家的 id 一律返回 null，不给横向探测留口子 */
export function findProductFor(applicationId, productId) {
  return mapProduct(
    getDb()
      .prepare(`${PRODUCT_SELECT} WHERE p.id = ? AND p.merchant_id = ?`)
      .get(String(productId || ''), String(applicationId || '')),
  );
}

/** 商家商品编号：MP + 日期 + 4 位序号，与入驻编号（MA/ML）风格一致，一眼看得出是什么单 */
function nextProductId(db, now = new Date()) {
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('');
  const prefix = `MP${stamp}`;
  const { n } = db
    .prepare('SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS n FROM products WHERE id LIKE ?')
    .get(prefix.length + 1, `${prefix}%`);
  return `${prefix}${String((n || 0) + 1).padStart(4, '0')}`;
}

/**
 * 新增商品：写商品 + 写一条默认 SKU + 写轨迹，**单事务**。
 *
 * 状态固定 pending / off_sale：平台不让商家自己把新货直接挂到在售。
 * 这条规则在演示里也保留——否则商家会以为上架不用审。
 */
export function createProduct(applicationId, input = {}) {
  const db = getDb();
  const now = new Date();
  const id = nextProductId(db, now);
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO products
        (id, name, brand, category_id, price, description, tags, status,
         image_url, merchant_id, review_status, warn_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', 'off_sale', ?, ?, 'pending', ?)
    `).run(
      id,
      input.name,
      String(input.brand || '').slice(0, 40),
      input.categoryId,
      toYuan(input.price),
      String(input.description || '').slice(0, 200),
      String(input.imageKey || ''),
      String(applicationId),
      Math.round(Number(input.warnAt) || 10),
    );
    // 默认 SKU：下单、加购、扣库存全走 SKU，没有它就等于「上架了但买不了」
    db.prepare(`
      INSERT INTO product_skus (id, product_id, spec, price, stock, status)
      VALUES (?, ?, '默认', ?, ?, 'on_sale')
    `).run(`${id}-S1`, id, toYuan(input.price), Math.round(Number(input.stock) || 0));
    db.prepare(`
      INSERT INTO merchant_product_events (product_id, application_id, event, note, actor)
      VALUES (?, ?, 'submitted', '', 'merchant')
    `).run(id, String(applicationId));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 不掩盖原始错误 */ }
    throw e;
  }
  return findProduct(id);
}

/** 上下架：只动 status，不动 review_status（审过就是审过） */
export function setProductStatus(productId, status) {
  const db = getDb();
  db.prepare('UPDATE products SET status = ? WHERE id = ?').run(status, String(productId));
  db.prepare(`
    INSERT INTO merchant_product_events (product_id, application_id, event, actor)
    SELECT id, merchant_id, ?, 'merchant' FROM products WHERE id = ?
  `).run(status === 'on_sale' ? 'on' : 'off', String(productId));
  return findProduct(productId);
}

/** 改库存：直接改默认 SKU，与下单扣减读的是同一行 */
export function updateStock(productId, stock) {
  const db = getDb();
  const sku = db.prepare('SELECT id FROM product_skus WHERE product_id = ? ORDER BY id LIMIT 1')
    .get(String(productId));
  if (!sku) throw Object.assign(new Error('商品没有可售规格'), { status: 409 });
  db.prepare('UPDATE product_skus SET stock = ? WHERE id = ?').run(Math.round(Number(stock)), sku.id);
  db.prepare(`
    INSERT INTO merchant_product_events (product_id, application_id, event, note, actor)
    SELECT id, merchant_id, 'stock', ?, 'merchant' FROM products WHERE id = ?
  `).run(String(Math.round(Number(stock))), String(productId));
  return findProduct(productId);
}

/** 商家可在售前改价与改名（审核中也能改，运营看到的是最新一版） */
export function updateProduct(productId, patch = {}) {
  const db = getDb();
  const current = db.prepare('SELECT * FROM products WHERE id = ?').get(String(productId));
  if (!current) throw Object.assign(new Error('商品不存在'), { status: 404 });
  const price = patch.price == null ? current.price : toYuan(patch.price);
  db.prepare('UPDATE products SET name = ?, price = ?, warn_at = ? WHERE id = ?').run(
    patch.name == null ? current.name : String(patch.name),
    price,
    patch.warnAt == null ? current.warn_at : Math.round(Number(patch.warnAt)),
    String(productId),
  );
  // 价格改了，SKU 价格跟着改：否则列表标新价、下单按旧价，是最难查的一类客诉
  if (patch.price != null) {
    db.prepare('UPDATE product_skus SET price = ? WHERE product_id = ?').run(price, String(productId));
  }
  return findProduct(productId);
}

/* ---------------- 运营侧：商品审核 ---------------- */

export function listProductsForReview({ reviewStatus = '', page = 1, size = 20 } = {}) {
  const db = getDb();
  const where = ["p.merchant_id != ''"];
  const args = [];
  if (reviewStatus) {
    where.push('p.review_status = ?');
    args.push(String(reviewStatus));
  }
  const clause = ` WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p${clause}`).get(...args).n;
  const sizeNum = Math.max(1, Math.min(100, Number(size) || 20));
  const pageNum = Math.max(1, Number(page) || 1);
  const rows = db.prepare(`
    ${PRODUCT_SELECT}${clause}
    ORDER BY CASE p.review_status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...args, sizeNum, (pageNum - 1) * sizeNum);

  const counts = { all: 0, pending: 0, approved: 0, rejected: 0 };
  for (const r of db.prepare("SELECT review_status FROM products WHERE merchant_id != ''").all()) {
    counts.all += 1;
    if (counts[r.review_status] != null) counts[r.review_status] += 1;
  }
  return { items: rows.map(mapProduct), counts, total, page: pageNum, size: sizeNum };
}

export function listProductEvents(productId) {
  return getDb()
    .prepare('SELECT * FROM merchant_product_events WHERE product_id = ? ORDER BY id ASC')
    .all(String(productId || ''))
    .map((r) => ({ event: r.event, note: r.note, actor: r.actor, at: r.created_at }));
}

/**
 * 审核结论落库（单事务：改状态 + 写轨迹）。
 *
 * 通过时同时把 status 置 on_sale —— 运营点「通过」的意思是「这件可以卖了」，
 * 如果通过之后还要商家自己再点一次上架，那审核台就少做了一半的事。
 * 驳回时 status 保持 off_sale，且必须带理由（三个字「未通过」对商家没有信息量）。
 */
export function reviewProduct(productId, { reviewStatus, note = '', by = 'admin' }) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(String(productId || ''));
  if (!row) throw Object.assign(new Error('商品不存在'), { status: 404 });
  if (row.review_status !== 'pending') {
    throw Object.assign(new Error(`这件商品已经${REVIEW_STATUS_LABEL[row.review_status] || row.review_status}，不能重复审核`), { status: 409 });
  }
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE products
      SET review_status = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?, status = ?
      WHERE id = ?
    `).run(
      reviewStatus,
      String(note || '').slice(0, 200),
      dbTime(),
      String(by || 'admin').slice(0, 40),
      reviewStatus === 'approved' ? 'on_sale' : 'off_sale',
      String(productId),
    );
    db.prepare(`
      INSERT INTO merchant_product_events (product_id, application_id, event, note, actor)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(productId), row.merchant_id, reviewStatus === 'approved' ? 'approved' : 'rejected', String(note || '').slice(0, 200), String(by || 'admin'));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 同上 */ }
    throw e;
  }
  return findProduct(productId);
}

/* ============================================================
   商家订单（真实交易库）
   ============================================================ */

/**
 * 商家视角的订单：一笔商城订单只要含这位商家的商品就出现在他的列表里。
 *
 * 一笔订单可能同时含两家店的货（购物车混单），所以这里按
 * order_items → products.merchant_id 过滤出「属于我的那几行」，
 * 金额用这几行的小计，而不是整单金额——否则商家会以为自己也该发那件别家的货。
 */
export function listOrders(applicationId, { status = '' } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.id, o.status, o.created_at, o.paid_at, o.shipped_at,
           o.logistics_company, o.tracking_no,
           SUM(i.price * i.qty) AS my_amount,
           SUM(i.qty) AS my_qty
    FROM orders o
    JOIN order_items i ON i.order_id = o.id
    JOIN products p    ON p.id = i.product_id
    WHERE p.merchant_id = ?
      -- 未付款 / 已关闭的单不进商家列表：商家看到「待发货」就会去打包，
      -- 而买家其实还没付钱。待发货 = 已付款且未发货。
      AND o.status IN ('paid', 'shipped', 'completed')
    GROUP BY o.id
    ORDER BY o.created_at DESC, o.id DESC
  `).all(String(applicationId || ''));

  const itemsOf = db.prepare(`
    SELECT i.product_id, i.name, i.spec, i.price, i.qty, i.sku_id
    FROM order_items i
    JOIN products p ON p.id = i.product_id
    WHERE i.order_id = ? AND p.merchant_id = ?
  `);

  const list = rows.map((o) => {
    const items = itemsOf.all(o.id, String(applicationId || ''));
    return {
      id: o.id,
      status: mapOrderStatus(o.status),
      statusRaw: o.status,
      amount: Number(o.my_amount) || 0,
      qty: Number(o.my_qty) || 0,
      items: items.map((i) => ({
        productId: i.product_id,
        name: i.name,
        spec: i.spec || '',
        price: i.price,
        qty: i.qty,
      })),
      // 一件商品的小标题给列表用；混单时标「等 N 件」
      title: items.length > 1 ? `${items[0].name} 等 ${items.length} 件` : (items[0] ? items[0].name : '—'),
      createdAt: o.created_at,
      paidAt: o.paid_at,
      shippedAt: o.shipped_at,
      carrier: o.logistics_company || '',
      trackingNo: o.tracking_no || '',
    };
  });
  const filtered = status ? list.filter((o) => o.status === status) : list;
  const counts = { all: list.length, pending: 0, shipped: 0, done: 0 };
  for (const o of list) if (counts[o.status] != null) counts[o.status] += 1;
  return { items: filtered, counts };
}

/**
 * 订单状态映射：交易库用的是支付/履约口径（paid/shipped/completed/closed…），
 * 工作台要的是商家心智（待发货/已发货/已完成）。两套词表在这里对齐，
 * 页面不再各写一份 if。
 */
export function mapOrderStatus(raw) {
  if (raw === 'paid') return 'pending';
  if (raw === 'shipped') return 'shipped';
  if (raw === 'completed') return 'done';
  return 'other';
}

export function findOrderForMerchant(orderId, applicationId) {
  const db = getDb();
  const row = db.prepare(`
    SELECT o.*, SUM(i.price * i.qty) AS my_amount
    FROM orders o
    JOIN order_items i ON i.order_id = o.id
    JOIN products p    ON p.id = i.product_id
    WHERE o.id = ? AND p.merchant_id = ?
      AND o.status IN ('paid', 'shipped', 'completed')
    GROUP BY o.id
  `).get(String(orderId || ''), String(applicationId || ''));
  if (!row) return null;
  return {
    id: row.id,
    statusRaw: row.status,
    status: mapOrderStatus(row.status),
    amount: Number(row.my_amount) || 0,
    carrier: row.logistics_company || '',
    trackingNo: row.tracking_no || '',
    paidAt: row.paid_at,
    shippedAt: row.shipped_at,
  };
}

/** 发货落库：改订单物流字段 + 写揽收事件，单事务 */
export function markShipped(orderId, { carrier, trackingNo, applicationId }) {
  const db = getDb();
  const now = dbTime();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE orders SET logistics_company = ?, tracking_no = ?, status = 'shipped', shipped_at = ?
      WHERE id = ?
    `).run(carrier, trackingNo, now, String(orderId));
    db.prepare(`
      INSERT INTO order_logistics_events (order_id, code, title, detail, happened_at, seq)
      VALUES (?, 'picked_up', '商家已发货', ?, ?, 1)
    `).run(String(orderId), `${carrier} ${trackingNo}`, now);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 同上 */ }
    throw e;
  }
  return findOrderForMerchant(orderId, applicationId);
}

/** 工作台概览数字（全部按「我的货」口径算，不掺别家的销量） */
export function statsOf(applicationId) {
  const products = listProducts(applicationId);
  const { items: orders } = listOrders(applicationId);
  const today = new Date();
  const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const onSale = products.filter((p) => p.reviewStatus === 'approved' && p.status === 'on_sale').length;
  const lowStock = products.filter((p) => p.reviewStatus === 'approved' && p.status === 'on_sale' && p.stock <= p.warnAt);
  const todayOrders = orders.filter((o) => String(o.createdAt || '').startsWith(stamp));
  return {
    onSale,
    total: products.length,
    pendingReview: products.filter((p) => p.reviewStatus === 'pending').length,
    todayOrderCount: todayOrders.length,
    todayAmount: Math.round(todayOrders.reduce((s, o) => s + o.amount, 0) * 100) / 100,
    pendingCount: orders.filter((o) => o.status === 'pending').length,
    lowStockCount: lowStock.length,
    lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 5),
  };
}

/* ============================================================
   媒体引用（孤儿清理用）
   ============================================================ */

export function listMerchantMediaKeys() {
  const keys = [];
  for (const r of getDb().prepare("SELECT image_url FROM products WHERE image_url != ''").all()) {
    keys.push(r.image_url);
  }
  for (const r of getDb().prepare("SELECT logo_key FROM merchant_shops WHERE logo_key != ''").all()) {
    keys.push(r.logo_key);
  }
  return keys;
}

export { dbTime, safeJson };
