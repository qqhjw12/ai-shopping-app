// 用户侧仓储：收藏夹 / 优惠券 / 收货地址。均为轻量操作，按 user_id 隔离。
import { getDb } from '../db/connection.js';
import { STARTER_COUPON_IDS } from '../data/catalog.js';
import { parseDbTime, refundExpiry, stateOf, toDbTime } from '../services/couponRules.js';
import { couponRules } from '../services/settingsService.js';

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
    // 开户只送三张体验券，其余要用户到券中心自己领。
    // 早先这里是「发放全部在售券」，结果是人人卡包一开就是满的：
    // 「领取」这个动作在服务端根本不存在，跨设备同步也就没有可同步的东西。
    const grantStarter = db.prepare(`
      INSERT INTO user_coupons (user_id, coupon_id, status, claimed_at, expires_at)
      SELECT ?, id, 'unused', datetime('now'), datetime('now', '+' || expire_days || ' days')
      FROM coupons WHERE id IN (${STARTER_COUPON_IDS.map(() => '?').join(',')})
    `);
    grantStarter.run(userId, ...STARTER_COUPON_IDS);
  }
  return userId;
}

/* ---------------- 优惠券 ---------------- */

/**
 * 券目录：券中心的列表来源。
 * 前端内置同一份目录做离线兜底，联网时用这里的返回值覆盖（运营改了文案不用发版）。
 */
export function listCouponCatalog() {
  return getDb()
    .prepare(`
      SELECT id, title, kind, threshold, amount, expire_days, scope_text
      FROM coupons ORDER BY threshold ASC, id ASC
    `)
    .all()
    .map((r) => ({
      couponId: r.id,
      title: r.title,
      kind: r.kind,
      threshold: r.threshold,
      amount: r.amount,
      validDays: r.expire_days,
      scopeText: r.scope_text || '全场通用',
    }));
}

const UC_SELECT = `
  SELECT uc.id, uc.coupon_id, uc.status, uc.claimed_at, uc.expires_at,
         uc.order_id, uc.extension_count,
         c.title, c.kind, c.threshold, c.amount, c.expire_days, c.scope_text
  FROM user_coupons uc
  JOIN coupons c ON c.id = uc.coupon_id
  WHERE uc.user_id = ?
`;

function toCouponInstance(r, amount, now) {
  const state = stateOf(r, now);
  const a = Math.max(0, Number(amount) || 0);
  const usable = state === 'unused' && a >= r.threshold && r.amount > 0;
  const worth = usable
    ? (r.kind === 'discount' ? Math.floor((a * r.amount) / 100) : r.amount)
    : 0;
  return {
    id: r.id,
    couponId: r.coupon_id,
    title: r.title,
    kind: r.kind,
    threshold: r.threshold,
    amount: r.amount,
    scopeText: r.scope_text || '全场通用',
    state,
    claimedAt: parseDbTime(r.claimed_at),
    expiresAt: parseDbTime(r.expires_at),
    orderId: r.order_id || null,
    extensionCount: r.extension_count || 0,
    validDays: r.expire_days,
    usable,
    worth,
    gap: usable ? 0 : Math.max(0, r.threshold - a),
  };
}

/**
 * 用户卡包。
 * @param {string} userId
 * @param {number} amount 当前商品总额（用于标注可用性，0 表示只看不判可用）
 * @param {{all?: boolean}} opts all=true 时返回全部状态（券包三 Tab 与跨设备同步需要），
 *        默认只返回未使用（旧调用方与结算预览的口径）
 */
export function listCoupons(userId, amount = 0, { all = false } = {}) {
  // 先建档：新访客首次进结算页时 ensureUser 才会补发体验券。
  // 少了这一步，卡包永远查不到券，结算页的「自动选最优券」形同虚设。
  const uid = ensureUser(userId, '游客');
  const now = Date.now();
  const sql = `${UC_SELECT}${all ? '' : " AND uc.status = 'unused'"}
    ORDER BY CASE uc.status WHEN 'unused' THEN 0 WHEN 'used' THEN 1 ELSE 2 END,
             uc.expires_at ASC, uc.id ASC`;
  return getDb().prepare(sql).all(uid).map((r) => toCouponInstance(r, amount, now));
}

/** 领券：写一条实例，到期时间 = 现在 + 券模板有效天数 */
export function takeCoupon(userId, couponId) {
  const db = getDb();
  const uid = ensureUser(userId || 'u_guest');
  const c = db
    .prepare('SELECT id, title, expire_days FROM coupons WHERE id = ?')
    .get(couponId);
  if (!c) throw Object.assign(new Error('优惠券不存在'), { status: 404 });
  // 判重看「未使用」而不是「存在」：用掉/过期之后可以再领，符合真实电商的复领规则
  const now = Date.now();
  const dup = db
    .prepare(
      `SELECT id, status, claimed_at, expires_at FROM user_coupons
       WHERE user_id = ? AND coupon_id = ? AND status = 'unused'`,
    )
    .get(uid, couponId);
  if (dup && stateOf(dup, now) === 'unused') {
    throw Object.assign(new Error('该券已在卡包中'), { status: 409 });
  }
  const info = db
    .prepare(`
      INSERT INTO user_coupons (user_id, coupon_id, status, claimed_at, expires_at)
      VALUES (?, ?, 'unused', datetime('now'), datetime('now', '+' || ? || ' days'))
    `)
    .run(uid, couponId, c.expire_days);
  const row = db.prepare(`${UC_SELECT} AND uc.id = ?`).get(uid, Number(info.lastInsertRowid));
  return toCouponInstance(row, 0, now);
}

/**
 * 核销：下单成功后把券标记为已使用并挂订单号。
 * 幂等——同一张券已经被同一订单核销过就直接返回，不报错，
 * 免得「下单成功但响应丢包 → 客户端重试」把用户卡在报错页面。
 */
export function useCoupon(userId, couponId, orderId) {
  const db = getDb();
  const uid = ensureUser(userId || 'u_guest');
  const now = Date.now();
  const hit = db
    .prepare(
      `SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND status = 'unused'
       ORDER BY expires_at ASC LIMIT 1`,
    )
    .get(uid, couponId);
  if (!hit) {
    const used = db
      .prepare(`SELECT * FROM user_coupons WHERE user_id = ? AND coupon_id = ? AND order_id = ?`)
      .get(uid, couponId, orderId || null);
    if (used) return { ok: true, already: true, coupon: toCouponInstance(used, 0, now) };
    throw Object.assign(new Error('优惠券不可用'), { status: 400 });
  }
  if (stateOf(hit, now) === 'expired') {
    throw Object.assign(new Error('优惠券已过期'), { status: 400 });
  }
  db.prepare(`UPDATE user_coupons SET status = 'used', order_id = ? WHERE id = ?`)
    .run(orderId || '', hit.id);
  const row = db.prepare(`${UC_SELECT} AND uc.id = ?`).get(uid, hit.id);
  return { ok: true, already: false, coupon: toCouponInstance(row, 0, now) };
}

/**
 * 取消订单返还：把该订单用掉的券退回未使用，并把有效期顺延。
 *
 * 顺延是「补偿」不是「奖励」：用户因为订单取消才晚拿到券，
 * 剩余可用时间不该比下单前更短。上限 MAX_EXTENSIONS 次防刷。
 * 超过上限的券仍然退回未使用，只是不再延长。
 */
export function refundCouponByOrder(userId, orderId) {
  const db = getDb();
  const uid = ensureUser(userId || 'u_guest');
  if (!orderId) return { restored: 0, coupons: [] };
  const rows = db
    .prepare(`SELECT * FROM user_coupons WHERE user_id = ? AND order_id = ? AND status = 'used'`)
    .all(uid, orderId);
  if (!rows.length) return { restored: 0, coupons: [] };

  const now = Date.now();
  // 规则取一次配置：同一笔订单里的券必须按同一套顺延参数处理，
  // 逐张读配置在「运营刚好在保存新配置」时会出现同单券顺延天数不一致。
  const rules = couponRules();
  const updExtend = db.prepare(
    `UPDATE user_coupons SET status = 'unused', order_id = NULL, expires_at = ?, extension_count = ?
     WHERE id = ?`,
  );
  const updPlain = db.prepare(
    `UPDATE user_coupons SET status = 'unused', order_id = NULL WHERE id = ?`,
  );
  let extendedCount = 0;
  for (const r of rows) {
    const { expiresAt, extended } = refundExpiry(parseDbTime(r.expires_at), r.extension_count, now, rules);
    if (extended) {
      updExtend.run(toDbTime(expiresAt), (Number(r.extension_count) || 0) + 1, r.id);
      extendedCount += 1;
    } else {
      updPlain.run(r.id);
    }
  }
  const coupons = db
    .prepare(`${UC_SELECT} AND uc.status = 'unused' AND uc.order_id IS NULL AND uc.id IN (${rows.map(() => '?').join(',')})`)
    .all(uid, ...rows.map((r) => r.id))
    .map((r) => toCouponInstance(r, 0, now));
  return { restored: rows.length, extended: extendedCount, graceDays: rules.refundGraceDays, coupons };
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
