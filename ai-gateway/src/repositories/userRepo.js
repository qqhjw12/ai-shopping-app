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

/** 读取用户公开信息（不含任何凭证） */
export function getUser(userId) {
  const row = getDb()
    .prepare('SELECT id, nickname, phone, level, created_at FROM users WHERE id = ?')
    .get(userId);
  if (!row) return null;
  return { id: row.id, nickname: row.nickname, phone: row.phone, level: row.level, createdAt: row.created_at };
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
    // 券是按会员发放的（user_coupons），新建会员时补发在售券；
    // 否则任何首次到访的用户卡包都是空的，结算页优惠券区会永远显示「暂无可用优惠券」。
    db.prepare("INSERT INTO user_coupons (user_id, coupon_id, status) SELECT ?, id, 'unused' FROM coupons").run(userId);
  }
  return userId;
}

/* ---------------- 优惠券 ---------------- */

/** 用户卡包：未使用的券，并标注当前金额下是否可用 */
export function listCoupons(userId, amount = 0) {
  // 先建档：新访客首次进结算页时 ensureUser 才会补发体验券。
  // 少了这一步，卡包永远查不到券，结算页的「自动选最优券」形同虚设。
  const uid = ensureUser(userId, '游客');
  return getDb()
    .prepare(`
      SELECT uc.id, uc.coupon_id, uc.status, uc.claimed_at,
             c.title, c.kind, c.threshold, c.amount
      FROM user_coupons uc
      JOIN coupons c ON c.id = uc.coupon_id
      WHERE uc.user_id = ? AND uc.status = 'unused'
      ORDER BY c.threshold DESC
    `)
    .all(uid)
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

const ADDR_COLS = 'id, receiver, phone, province, city, region, detail, postal, is_default, updated_at';

function toAddress(r) {
  return {
    id: r.id,
    receiver: r.receiver,
    phone: r.phone,
    province: r.province || '',
    city: r.city || '',
    region: r.region,
    detail: r.detail,
    postal: r.postal || '',
    isDefault: !!r.is_default,
    updatedAt: r.updated_at || null,
    full: `${r.region} ${r.detail}`,
  };
}

/** 把省/市拼成展示用的 region；前端已给 region 时优先用它 */
function composeRegion({ province, city, region }) {
  const p = String(province || '').trim();
  const c = String(city || '').trim();
  if (p || c) return [p, c].filter(Boolean).join(' ');
  return String(region || '').trim();
}

export function listAddresses(userId) {
  return getDb()
    .prepare(`SELECT ${ADDR_COLS} FROM addresses WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, rowid`)
    .all(userId)
    .map(toAddress);
}

export function getAddress(userId, id) {
  const row = getDb()
    .prepare(`SELECT ${ADDR_COLS} FROM addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(id, userId);
  return row ? toAddress(row) : null;
}

/** 下单时若前端未指定地址则取默认地址 */
export function defaultAddress(userId) {
  const rows = listAddresses(userId);
  return rows.find((a) => a.isDefault) || rows[0] || null;
}

/** 默认位收敛：保证有地址时恰好一条 is_default=1，preferId 优先 */
function settleDefault(userId, preferId = null) {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, is_default FROM addresses WHERE user_id = ? AND deleted_at IS NULL ORDER BY rowid')
    .all(userId);
  if (!rows.length) return;
  const exists = rows.some((r) => r.id === preferId);
  const target = exists
    ? preferId
    : (rows.find((r) => r.is_default) || rows[0]).id;
  db.prepare(`UPDATE addresses SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END
               WHERE user_id = ? AND deleted_at IS NULL`)
    .run(target, userId);
}

/**
 * 新增或更新收货地址。
 * - 带 id：更新该条（归属校验：id + user_id 双条件，越权改不到别人的）
 * - 不带 id：新增；满 20 条上限时抛 409
 * @returns {{id:string, created:boolean}}
 */
export function saveAddress(userId, payload = {}) {
  const db = getDb();
  ensureUser(userId);

  const receiver = String(payload.receiver || '').trim();
  const phone = String(payload.phone || '').trim();
  let province = String(payload.province || '').trim();
  let city = String(payload.city || '').trim();
  const region = composeRegion({ province, city, region: payload.region });
  // 只给了 region（结算页的简表只有一个地区输入框）时按空格拆一次，保证 province/city 不缺；
  // 否则个人中心编辑时省份下拉选不中，再保存一次就会把地区写丢。
  if (!province && !city && region) {
    const [head, ...rest] = region.split(/\s+/);
    province = head || '';
    city = rest.join(' ');
  }
  const detail = String(payload.detail || '').trim();
  const postal = String(payload.postal || '').trim();
  const isDefault = Boolean(payload.isDefault);

  if (!receiver) throw Object.assign(new Error('请填写收货人姓名'), { status: 400 });
  if (!region) throw Object.assign(new Error('请填写所在地区'), { status: 400 });
  if (!detail) throw Object.assign(new Error('请填写详细地址'), { status: 400 });
  if (postal && !/^\d{6}$/.test(postal)) throw Object.assign(new Error('邮编为 6 位数字'), { status: 400 });

  const id = String(payload.id || '').trim();
  if (id) {
    const hit = db.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, userId);
    if (!hit) throw Object.assign(new Error('地址不存在'), { status: 404 });
    db.prepare(`
      UPDATE addresses
         SET receiver=?, phone=?, province=?, city=?, region=?, detail=?, postal=?,
             updated_at=datetime('now')
       WHERE id=? AND user_id=?
    `).run(receiver, phone, province, city, region, detail, postal, id, userId);
    settleDefault(userId, isDefault ? id : null);
    return { id, created: false };
  }

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ? AND deleted_at IS NULL')
    .get(userId);
  if (n >= 20) throw Object.assign(new Error('最多保存 20 个地址'), { status: 409 });

  const newId = `a_${userId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO addresses (id, user_id, receiver, phone, province, city, region, detail, postal, is_default, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(newId, userId, receiver, phone, province, city, region, detail, postal, isDefault ? 1 : 0);
  settleDefault(userId, isDefault ? newId : null);
  return { id: newId, created: true };
}

/**
 * 删除地址（软删除）。
 * 为什么不物理删：orders.address_id 外键指向 addresses，硬删会被外键挡下
 * （下过单的用户永远删不掉那条地址），而历史订单还要靠这条记录追溯。
 * 打时间戳 + 列表过滤，用户视角就是「已删除」，数据侧仍可审计。
 */
export function removeAddress(userId, id) {
  const db = getDb();
  const hit = db
    .prepare('SELECT id, is_default FROM addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId);
  if (!hit) throw Object.assign(new Error('地址不存在'), { status: 404 });
  db.prepare(`UPDATE addresses SET deleted_at = datetime('now'), is_default = 0
               WHERE id = ? AND user_id = ?`).run(id, userId);
  settleDefault(userId);
  return { id, wasDefault: !!hit.is_default };
}

/** 设为默认地址（幂等） */
export function setDefaultAddress(userId, id) {
  const hit = getDb()
    .prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId);
  if (!hit) throw Object.assign(new Error('地址不存在'), { status: 404 });
  settleDefault(userId, id);
  return { id };
}
