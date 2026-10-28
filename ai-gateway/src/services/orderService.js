// 下单服务：购物车 → 订单。整个链路在一个事务里完成，任一环节失败全部回滚。
// 规则与 FAQ/政策保持一致：满 99 包邮，否则 10 元运费；优惠券不可用则拒绝而非静默忽略。
import { getDb } from '../db/connection.js';
import * as cartRepo from '../repositories/cartRepo.js';
import * as userRepo from '../repositories/userRepo.js';
import { listCart } from '../repositories/cartRepo.js';

export const SHIPPING_FREE_THRESHOLD = 99;
export const SHIPPING_FEE = 10;

/** 订单号：SO + 日期 + 随机序列（冲突重试） */
function makeOrderId(db) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const exists = db.prepare('SELECT id FROM orders WHERE id = ?');
  for (let i = 0; i < 8; i++) {
    const id = `SO${day}${String(Math.floor(Math.random() * 900000) + 100000)}`;
    if (!exists.get(id)) return id;
  }
  throw new Error('生成订单号失败，请重试');
}

/**
 * 预览订单（不写库）：前端结算页用它实时算钱
 * @returns {{items, productAmount, shippingFee, discountAmount, payAmount, address, coupon}}
 */
export function previewOrder({ userId, items, addressId, couponId }) {
  const db = getDb();
  // 新用户首次结算时补齐档案（orders 外键指向 users，缺人会导致建单失败）
  userRepo.ensureUser(userId);
  // 地址簿为空且未指定地址时才补一条兜底地址（仅结算时触发，账户中心看到的空就是空）
  if (!addressId && !userRepo.listAddresses(userId).length) {
    userRepo.saveAddress(userId, {
      receiver: '演示收货人',
      phone: '13800000000',
      province: '上海市',
      city: '浦东新区',
      detail: '示例路 1 号 101 室',
      isDefault: true,
    });
  }
  const address = addressId
    ? userRepo.listAddresses(userId).find((a) => a.id === addressId)
    : userRepo.defaultAddress(userId);
  if (!address) throw Object.assign(new Error('请先设置收货地址'), { status: 400 });

  // 未指定明细时用购物车全部内容
  const source = (items && items.length ? items : listCart(userId).items).map((i) => ({
    productId: i.productId,
    skuId: i.skuId ?? null,
    qty: Number(i.qty) || 1,
  }));
  if (!source.length) throw Object.assign(new Error('购物车是空的'), { status: 400 });

  const lines = [];
  for (const it of source) {
    const p = db.prepare('SELECT id, name, price FROM products WHERE id = ?').get(it.productId);
    if (!p) throw Object.assign(new Error(`商品 ${it.productId} 不存在`), { status: 400 });
    let unit = p.price;
    let spec = '';
    let stock = null;
    if (it.skuId) {
      const s = db.prepare('SELECT id, spec, price, stock FROM product_skus WHERE id = ? AND product_id = ?')
        .get(it.skuId, it.productId);
      if (!s) throw Object.assign(new Error('商品规格不存在'), { status: 400 });
      unit = s.price;
      spec = s.spec;
      stock = s.stock;
    } else {
      const first = db.prepare('SELECT spec, price, stock FROM product_skus WHERE product_id = ? ORDER BY id LIMIT 1')
        .get(it.productId);
      if (first) {
        spec = first.spec;
        unit = first.price;
        stock = first.stock;
      }
    }
    if (stock != null && stock < it.qty) {
      throw Object.assign(new Error(`「${p.name}」库存仅剩 ${stock} 件`), { status: 409 });
    }
    lines.push({ productId: it.productId, skuId: it.skuId, name: p.name, spec, price: unit, qty: it.qty, subtotal: unit * it.qty });
  }

  const productAmount = lines.reduce((s, l) => s + l.subtotal, 0);
  let discountAmount = 0;
  let coupon = null;
  if (couponId) {
    coupon = userRepo.listCoupons(userId, productAmount).find((c) => c.couponId === couponId);
    // usable 里已经含「未使用 + 未过期 + 达到门槛」三个条件，
    // 只判断「找不到」会把过期券放过——过期的券也在卡包里，只是 state 是 expired。
    if (!coupon || !coupon.usable) throw Object.assign(new Error('优惠券不可用'), { status: 400 });
    discountAmount = Math.min(coupon.worth, productAmount);
  }
  const shippingFee = productAmount - discountAmount >= SHIPPING_FREE_THRESHOLD ? 0 : SHIPPING_FEE;
  const payAmount = productAmount - discountAmount + shippingFee;

  return { items: lines, address, coupon, productAmount, shippingFee, discountAmount, payAmount };
}

/**
 * 下单：校验 → 算钱 → 扣库存 → 建单 → 清购物车 → 销券（同一事务）
 * @returns {{orderId, status, payAmount, ... }} 完整订单
 */
export function createOrder({ userId, items, addressId, couponId, remark = '' }) {
  const db = getDb();

  db.exec('BEGIN');
  try {
    const draft = previewOrder({ userId, items, addressId, couponId });
    const orderId = makeOrderId(db);

    db.prepare(`
      INSERT INTO orders
        (id, user_id, status, total_amount, product_amount, shipping_fee, discount_amount,
         coupon_id, address_id, remark, created_at, paid_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
    `).run(
      orderId, userId, draft.payAmount, draft.productAmount,
      draft.shippingFee, draft.discountAmount, couponId || null,
      draft.address.id, String(remark).slice(0, 120),
    );

    const insItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, sku_id, name, price, qty)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const l of draft.items) {
      insItem.run(orderId, l.productId, l.skuId, l.spec ? `${l.name}（${l.spec}）` : l.name, l.price, l.qty);
      if (l.skuId) {
        const updated = db
          .prepare('UPDATE product_skus SET stock = stock - ? WHERE id = ? AND stock >= ?')
          .run(l.qty, l.skuId, l.qty).changes;
        if (!updated) throw Object.assign(new Error(`${l.name} 库存不足`), { status: 409 });
      }
    }

    // 已购商品从购物车移除（用户手选了部分明细时，只清这些）
    cartRepo.clearCart(userId, draft.items.map((l) => l.productId));
    if (couponId) {
      // 核销走仓储同一入口：直接写 SQL 会绕过「已过期不许核销」与幂等判断
      userRepo.useCoupon(userId, couponId, orderId);
    }

    db.exec('COMMIT');
    return { ...getOrder(orderId, userId), _preview: draft };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
}

/** 订单详情（含明细、物流、金额拆分） */
export function getOrder(orderId, userId) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT o.*, a.receiver, a.phone, a.region, a.detail
      FROM orders o LEFT JOIN addresses a ON a.id = o.address_id
      WHERE o.id = ? AND o.user_id = ?
    `)
    .get(orderId, userId);
  if (!row) return null;
  const items = db
    .prepare('SELECT product_id, sku_id, name, price, qty FROM order_items WHERE order_id = ?')
    .all(orderId)
    .map((i) => ({
      productId: i.product_id,
      skuId: i.sku_id,
      name: i.name,
      price: i.price,
      qty: i.qty,
      subtotal: i.price * i.qty,
    }));
  return {
    orderId: row.id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    productAmount: row.product_amount ?? row.total_amount,
    shippingFee: row.shipping_fee ?? 0,
    discountAmount: row.discount_amount ?? 0,
    payAmount: row.total_amount,
    remark: row.remark || '',
    logisticsCompany: row.logistics_company,
    trackingNo: row.tracking_no,
    receiver: row.receiver || '',
    phone: row.phone || '',
    address: row.region ? `${row.region} ${row.detail}` : '',
    items,
  };
}

export function listOrders(userId, limit = 50) {
  const rows = getDb()
    .prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
  return rows.map((r) => getOrder(r.id, userId)).filter(Boolean);
}

/** 支付（演示：pending → paid，不接真实支付网关） */
export function payOrder(orderId, userId) {
  const db = getDb();
  const row = db.prepare('SELECT status FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
  if (!row) throw Object.assign(new Error('订单不存在'), { status: 404 });
  if (row.status !== 'pending') throw Object.assign(new Error('该订单无需重复支付'), { status: 409 });
  db.prepare("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(orderId);
  return getOrder(orderId, userId);
}
