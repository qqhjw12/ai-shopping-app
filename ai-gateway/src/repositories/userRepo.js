// 用户侧仓储：收藏夹 / 优惠券 / 收货地址。均为轻量操作，按 user_id 隔离。
import { getDb } from '../db/connection.js';

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ---------------- 收藏 ---------------- */

const FAV_SELECT = `
  SELECT f.id, f.product_id, f.created_at,
         p.name, p.brand, p.price, p.original_price, p.rating, p.sales,
         p.cover_color, p.highlight, p.tags, c.name AS category_name
  FROM favorites f
  JOIN products p ON p.id = f.product_id
  LEFT JOIN categories c ON c.id = p.category_id
`;

export function listFavorites(userId) {
  return getDb()
    .prepare(`${FAV_SELECT} WHERE f.user_id = ? ORDER BY f.id DESC`)
    .all(userId)
    .map((r) => ({
      id: r.id,
      productId: r.product_id,
      name: r.name,
      brand: r.brand,
      category: r.category_name || '',
      price: r.price,
      originalPrice: r.original_price,
      rating: r.rating,
      sales: r.sales,
      coverColor: r.cover_color || '',
      highlight: r.highlight || '',
      tags: safeJson(r.tags, []),
      favoritedAt: r.created_at,
    }));
}

/** 收藏状态切换，返回当前是否收藏 */
export function toggleFavorite(userId, productId) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) {
    throw Object.assign(new Error('商品不存在'), { status: 404 });
  }
  const exist = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND product_id = ?').get(userId, productId);
  if (exist) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(exist.id);
    return false;
  }
  db.prepare('INSERT INTO favorites (user_id, product_id) VALUES (?, ?)').run(userId, productId);
  return true;
}

export function removeFavorite(userId, productId) {
  return getDb().prepare('DELETE FROM favorites WHERE user_id = ? AND product_id = ?').run(userId, productId).changes;
}

export function favoriteIds(userId) {
  return getDb()
    .prepare('SELECT product_id FROM favorites WHERE user_id = ?')
    .all(userId)
    .map((r) => r.product_id);
}

/**
 * 保证用户存在且有收货地址。
 * 前端用的是会话级 userId（首次访问即生成），不一定已在 users 表中；
 * 而 orders 外键指向 users，缺人会导致下单直接失败，故在此兜底建档。
 */
export function ensureUser(userId, nickname = '游客') {
  const db = getDb();
  if (!userId || userId === 'anonymous') userId = 'u_guest';
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO users (id, nickname, level) VALUES (?, ?, ?)').run(userId, nickname, 'normal');
  }
  if (!defaultAddress(userId)) {
    db.prepare(`
      INSERT INTO addresses (id, user_id, receiver, phone, region, detail, is_default)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(`a_${userId}`, userId, nickname, '138****0000', '上海市 浦东新区', '示例路 1 号 101 室');
  }
  return userId;
}

/** 新增或更新收货地址（更新则与非默认项互斥） */
export function saveAddress(userId, { id, receiver, phone, region, detail, isDefault = false }) {
  const db = getDb();
  ensureUser(userId);
  if (id) {
    db.prepare('UPDATE addresses SET receiver=?, phone=?, region=?, detail=? WHERE id=? AND user_id=?')
      .run(receiver, phone, region, detail, id, userId);
    return { id };
  }
  if (isDefault) db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId);
  const newId = `a_${userId}_${Date.now()}`;
  db.prepare(`
    INSERT INTO addresses (id, user_id, receiver, phone, region, detail, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newId, userId, receiver, phone, region, detail, isDefault ? 1 : 0);
  return { id: newId };
}

/* ---------------- 优惠券 ---------------- */

/** 用户卡包：未使用的券，并标注当前金额下是否可用 */
export function listCoupons(userId, amount = 0) {
  return getDb()
    .prepare(`
      SELECT uc.id, uc.coupon_id, uc.status, uc.claimed_at,
             c.title, c.kind, c.threshold, c.amount
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_id = ? AND uc.status = 'unused'
      ORDER BY c.threshold DESC
    `)
    .all(userId)
    .map((r) => {
      const usable = amount >= r.threshold;
      return {
        id: r.id,
        couponId: r.coupon_id,
        title: r.title,
        kind: r.kind,
        threshold: r.threshold,
        amount: r.amount,
        // 折扣券 amount 为打折幅度百分比（如 10 表示减 10%，即 9 折）
        usable,
        worth: usable ? (r.kind === 'discount' ? Math.floor(amount * r.amount / 100) : r.amount) : 0,
      };
    });
}

export function takeCoupon(userId, couponId) {
  const db = getDb();
  const c = db.prepare('SELECT id, title FROM coupons WHERE id = ?').get(couponId);
  if (!c) throw Object.assign(new Error('优惠券不存在'), { status: 404 });
  const dup = db
    .prepare("SELECT id FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND status = 'unused'")
    .get(userId, couponId);
  if (dup) throw Object.assign(new Error('该券已在卡包中'), { status: 409 });
  const info = db.prepare('INSERT INTO user_coupons (user_id, coupon_id) VALUES (?, ?)').run(userId, couponId);
  return { id: Number(info.lastInsertRowid), title: c.title };
}

/* ---------------- 收货地址 ---------------- */

export function listAddresses(userId) {
  return getDb()
    .prepare('SELECT id, receiver, phone, region, detail, is_default FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id')
    .all(userId)
    .map((r) => ({
      id: r.id,
      receiver: r.receiver,
      phone: r.phone,
      region: r.region,
      detail: r.detail,
      isDefault: !!r.is_default,
      full: `${r.region} ${r.detail}`,
    }));
}

/** 下单时若前端未指定地址则取默认地址 */
export function defaultAddress(userId) {
  const rows = listAddresses(userId);
  return rows.find((a) => a.isDefault) || rows[0] || null;
}
