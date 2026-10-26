// 数据库初始化与种子：建表（迁移）+ 写入演示数据，幂等可重复执行。
// 用法：
//   node src/db/seedDb.js           # 缺数据才写（启动时也会自动调用）
//   node src/db/seedDb.js --reset   # 清空业务表后重灌
import '../quiet.js';
import { pathToFileURL } from 'node:url';
import { getDb } from './connection.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import {
  CATEGORIES,
  buildCatalog,
  DEMO_USERS,
  DEMO_ADDRESSES,
  DEMO_ORDERS,
  DEMO_REVIEWS,
  DEMO_FAQS,
  DEMO_POLICIES,
} from '../data/catalog.js';

function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

function resetTables(db) {
  // 顺序遵循外键依赖，先子后父
  for (const t of [
    'messages', 'conversations', 'track_events', 'order_items', 'orders',
    'reviews', 'addresses', 'product_skus', 'products', 'users', 'categories',
    'faqs', 'policies',
  ]) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('order_items','reviews','messages','track_events','faqs')");
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
    return { seeded: false, version, products: countOf(db, 'products') };
  }

  const { products, skus } = buildCatalog();
  const byId = new Map(products.map((p) => [p.id, p]));

  db.exec('BEGIN');
  try {
    const insCat = db.prepare('INSERT OR REPLACE INTO categories (id, name, sort) VALUES (?, ?, ?)');
    for (const c of CATEGORIES) insCat.run(c.id, c.name, c.sort);

    const insProd = db.prepare(`
      INSERT OR REPLACE INTO products
        (id, name, brand, category_id, price, original_price, description, tags, rating, reviews_count, sales, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of products) {
      insProd.run(
        p.id, p.name, p.brand, p.categoryId, p.price, p.originalPrice,
        p.description, JSON.stringify(p.tags), p.rating, p.reviewsCount, p.sales, p.status,
      );
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

    const insReview = db.prepare(
      'INSERT INTO reviews (product_id, user_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const [pid, rating, content] of DEMO_REVIEWS) {
      insReview.run(pid, 'u_demo', rating, content, daysAgo(3 + (pid.charCodeAt(3) % 20)));
    }

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
  };
  console.log(JSON.stringify(stats, null, 2));
}
