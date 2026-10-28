// 数据库初始化与种子：建表（迁移）+ 写入演示数据，幂等可重复执行。
// 用法：
//   node src/db/seedDb.js           # 缺数据才写（启动时也会自动调用）
//   node src/db/seedDb.js --reset   # 清空业务表后重灌
import '../quiet.js';
import { pathToFileURL } from 'node:url';
import { getDb } from './connection.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import { backfillMissing } from '../services/logisticsService.js';
import {
  CATEGORIES,
  SUBCATEGORIES,
  buildCatalog,
  deriveReviews,
  DEMO_USERS,
  DEMO_ADDRESSES,
  DEMO_ORDERS,
  DEMO_FAQS,
  DEMO_POLICIES,
  DEMO_CART,
  DEMO_FAVORITES,
  DEMO_COUPONS,
  DEMO_USER_COUPONS,
} from '../data/catalog.js';

function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function resetTables(db) {
  // 顺序遵循外键依赖，先子后父
  for (const t of [
    'messages', 'conversations', 'track_events', 'order_logistics_events', 'aftersales',
    'order_items', 'orders',
    'reviews', 'addresses', 'product_skus', 'products', 'brands', 'users', 'categories',
    'faqs', 'policies', 'cart_items', 'favorites', 'user_coupons', 'coupons',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('order_items','reviews','messages','track_events','faqs','cart_items','favorites','user_coupons','order_logistics_events')");
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 保证库结构就绪并已种子。返回 { seeded, version, products } */
export function ensureSeeded({ reset = false } = {}) {
  const db = getDb();
  const version = migrate(db);

  if (reset) resetTables(db);
  if (!reset && countOf(db, 'products') > 0) {
    // 历史订单补物流时间线（幂等）：迁移只建表，老订单的「已发货」不该是一片空白
    try {
      backfillMissing(db);
    } catch (e) {
      // 补数据失败不该拦住启动：时间线缺失只影响展示，卖不了东西才是真事故
      console.warn(`[seed] 物流时间线回填失败: ${e.message}`);
    }
    return { seeded: false, version, products: countOf(db, 'products') };
  }

  const { products, skus } = buildCatalog();
  const byId = new Map(products.map((p) => [p.id, p]));

  db.exec('BEGIN');
  try {
    // 两级类目一起写入（一级先于二级，满足外键依赖）
    const insCat = db.prepare(
      'INSERT OR REPLACE INTO categories (id, name, sort, parent_id, icon, desc) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const c of CATEGORIES) insCat.run(c.id, c.name, c.sort, null, c.icon || '', c.desc || '');
    const insSub = db.prepare(
      'INSERT OR REPLACE INTO categories (id, name, sort, parent_id, icon, desc) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const s of SUBCATEGORIES) insSub.run(s.id, s.name, s.sort, s.parentId, '', '');

    const insProd = db.prepare(`
      INSERT OR REPLACE INTO products
        (id, name, brand, category_id, sub_category_id, price, original_price, description, tags,
         rating, reviews_count, sales, status, cover_color, highlight, highlights)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of products) {
      insProd.run(
        p.id, p.name, p.brand, p.categoryId, p.subCategoryId, p.price, p.originalPrice,
        p.description, JSON.stringify(p.tags), p.rating, p.reviewsCount, p.sales, p.status,
        p.coverColor, p.highlight, JSON.stringify(p.highlights),
      );
    }

    // 品牌：从商品派生的去重表（品牌筛选 / 「按品牌逛」用）
    const seenBrand = new Set();
    const insBrand = db.prepare(
      'INSERT OR REPLACE INTO brands (id, name, category_id, logo_color) VALUES (?, ?, ?, ?)',
    );
    for (const p of products) {
      const bname = (p.brand || '').trim();
      if (!bname || seenBrand.has(bname)) continue;
      seenBrand.add(bname);
      const hue = Math.abs([...bname].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)) % 360;
      insBrand.run(`br_${Buffer.from(bname).toString('hex').slice(0, 16)}`, bname, p.categoryId, `hsl(${hue} 62% 48%)`);
    }

    const insSku = db.prepare(
      'INSERT OR REPLACE INTO product_skus (id, product_id, spec, price, stock, status) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const s of skus) insSku.run(s.id, s.productId, s.spec, s.price, s.stock, s.status);

    const insUser = db.prepare('INSERT OR REPLACE INTO users (id, nickname, phone, level) VALUES (?, ?, ?, ?)');
    for (const u of DEMO_USERS) insUser.run(u.id, u.nickname, u.phone, u.level);

    const insAddr = db.prepare(
      'INSERT OR REPLACE INTO addresses (id, user_id, receiver, phone, region, detail, is_default) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const a of DEMO_ADDRESSES) insAddr.run(a.id, a.userId, a.receiver, a.phone, a.region, a.detail, a.isDefault);

    const insOrder = db.prepare(`
      INSERT OR REPLACE INTO orders
        (id, user_id, status, total_amount, address_id, logistics_company, tracking_no, created_at, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insItem = db.prepare(
      'INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [id, userId, status, productId, qty, days, company, tracking] of DEMO_ORDERS) {
      const p = byId.get(productId);
      const total = p.price * qty;
      const created = daysAgo(days);
      const paid = status === 'pending' ? null : created;
      insOrder.run(id, userId, status, total, DEMO_ADDRESSES[0].id, company, tracking, created, paid);
      insItem.run(id, productId, p.name, p.price, qty);
    }

    // 评价覆盖全部商品（每款 3 条，星级与商品评分匹配）
    const insReview = db.prepare(
      'INSERT INTO reviews (product_id, user_id, rating, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const r of deriveReviews(products)) {
      insReview.run(r.productId, 'u_demo', r.rating, r.content, r.author, daysAgo(r.daysAgo));
    }

    // 演示购物车（SKU 序号 0 表示取该商品的第一个规格）
    const insCart = db.prepare(
      'INSERT INTO cart_items (user_id, product_id, sku_id, qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const [pid, skuNo, qty] of DEMO_CART) {
      const p = byId.get(pid);
      if (!p) continue;
      const skuId = skuNo ? `${pid}-s${skuNo}` : `${pid}-s1`;
      const now = daysAgo(1);
      insCart.run('u_demo', pid, skuId, qty, now, now);
    }

    const insFav = db.prepare('INSERT INTO favorites (user_id, product_id, created_at) VALUES (?, ?, ?)');
    DEMO_FAVORITES.forEach((pid, i) => {
      if (byId.get(pid)) insFav.run('u_demo', pid, daysAgo(5 + i * 2));
    });

    const insCoupon = db.prepare(
      'INSERT OR REPLACE INTO coupons (id, title, kind, threshold, amount, expire_days, scope_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [id, title, kind, threshold, amount, days, scope] of DEMO_COUPONS) {
      insCoupon.run(id, title, kind, threshold, amount, days, scope || '全场通用');
    }

    // 到期时间直接落库（不是每端各算一遍 claimed_at + expire_days），
    // 否则取消订单返还时的「顺延」没有唯一真源可改。
    const insUserCoupon = db.prepare(`
      INSERT INTO user_coupons (user_id, coupon_id, status, claimed_at, expires_at)
      VALUES (?, ?, ?, ?, datetime(?, '+' || (SELECT expire_days FROM coupons WHERE id = ?) || ' days'))
    `);
    DEMO_USER_COUPONS.forEach((cid, i) => {
      const claimedAt = daysAgo(6 - i);
      insUserCoupon.run('u_demo', cid, 'unused', claimedAt, claimedAt, cid);
    });

    const insFaq = db.prepare('INSERT INTO faqs (topic, question, answer, keywords) VALUES (?, ?, ?, ?)');
    for (const [topic, q, a, kw] of DEMO_FAQS) {
      insFaq.run(topic, q, a, JSON.stringify(kw.split(',').map((s) => s.trim())));
    }

    const insPolicy = db.prepare('INSERT OR REPLACE INTO policies (id, title, content) VALUES (?, ?, ?)');
    for (const [id, title, content] of DEMO_POLICIES) insPolicy.run(id, title, content);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // 刚灌进去的演示订单里有 shipped/completed，补上时间线（放在事务外：
  // 回填失败时订单数据本身应该已经落库，不该跟着回滚）
  try {
    backfillMissing(db);
  } catch (e) {
    console.warn(`[seed] 物流时间线回填失败: ${e.message}`);
  }

  return { seeded: true, version: SCHEMA_VERSION, products: countOf(db, 'products') };
}

// 直接执行时打印统计
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const reset = process.argv.includes('--reset');
  const r = ensureSeeded({ reset });
  const db = getDb();
  const stats = {
    version: r.version,
    seededNow: r.seeded,
    products: countOf(db, 'products'),
    skus: countOf(db, 'product_skus'),
    categories: countOf(db, 'categories'),
    orders: countOf(db, 'orders'),
    orderItems: countOf(db, 'order_items'),
    reviews: countOf(db, 'reviews'),
    faqs: countOf(db, 'faqs'),
    policies: countOf(db, 'policies'),
    reviews: countOf(db, 'reviews'),
    cartItems: countOf(db, 'cart_items'),
    favorites: countOf(db, 'favorites'),
    coupons: countOf(db, 'coupons'),
  };
  console.log(JSON.stringify(stats, null, 2));
}
