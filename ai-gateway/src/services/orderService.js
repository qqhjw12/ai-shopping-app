// 下单服务：购物车 → 订单。整个链路在一个事务里完成，任一环节失败全部回滚。
//
// 两层规则：
//   1) 商品与库存由数据库说了算（价格、SKU、库存都现查，绝不信任客户端传来的价格）；
//   2) 运费与配送方式由运营配置说了算（app_settings.shipping），
//      与结算页展示用的是同一份配置，因此「预览一个价、下单另一个价」在结构上很难发生。
//
// 券核销必须和建单在同一个事务里：分开做会出现「单建成了、券没核销」（用户白嫖一张券）
// 或「券核销了、单没建成」（用户丢一张券）。退款时同理，取消单与返券必须原子。
import { getDb } from '../db/connection.js';
import * as cartRepo from '../repositories/cartRepo.js';
import * as userRepo from '../repositories/userRepo.js';
import { listCart } from '../repositories/cartRepo.js';
import { normalizePaymentId, paymentMethods, shippingById, shippingFeeOf } from './settingsService.js';
import {
  appendEvents, dbTime, eventsOnDeliver, listEvents, newShipment,
} from './logisticsService.js';
import { listAftersales } from './aftersaleService.js';

/** 已废弃：运费改由运营配置（app_settings.shipping）决定。保留导出仅为不打断外部引用。 */
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

/* ---------------- 幂等键 ---------------- */

const IDEM_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 幂等键归一化：合法则原样返回，不合法当作「没传」。
 *
 * 为什么非法值不报错：幂等键是客户端为了自保加的东西，服务端把它当强约束会
 * 让「客户端版本旧、不传 key」直接下单失败。所以非法/缺失 = 不启用幂等，
 * 退化成原来的行为；合法才享受「同 key 只建一单」。
 */
function normalizeIdemKey(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return IDEM_KEY_RE.test(s) ? s : null;
}

/** 该 key 已经建过的订单（幂等命中） */
function findByIdemKey(db, userId, key) {
  if (!key) return null;
  return db.prepare('SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?').get(userId, key) || null;
}

/** 唯一索引冲突 = 并发下另一个请求刚插进去（同一个 key 抢跑），去重查即可 */
function isUniqueViolation(e) {
  const msg = String((e && e.message) || '');
  return msg.includes('UNIQUE constraint failed') || (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE');
}

/**
 * 预览订单（不写库）：前端结算页用它实时算钱。
 * 服务端是金额的唯一真源——商品价、库存、券可用性、运费全部现算，
 * 前端传什么价都不作数，只传「买哪个 SKU 几件、用哪张券、走哪种配送」。
 * @returns {{items, productAmount, shippingFee, discountAmount, payAmount, address, coupon, shipping, paymentMethodId}}
 */
export function previewOrder({ userId, items, addressId, couponId, shippingMethodId, paymentMethodId }) {
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
  // 运费按运营配置的配送方式算，包邮门槛按「券后商品金额」判断：
  // 先看商品总额再判包邮，会让「用券把总额压到门槛以下」的订单仍然免运费，等于券抵了两次。
  const shipping = shippingById(shippingMethodId);
  const goodsAfterDiscount = Math.max(0, productAmount - discountAmount);
  const shippingFee = shippingFeeOf(shipping, goodsAfterDiscount);
  const payAmount = Math.max(0, Math.round((goodsAfterDiscount + shippingFee) * 100) / 100);

  return {
    items: lines,
    address,
    coupon,
    productAmount,
    shippingFee,
    discountAmount,
    payAmount,
    shipping,
    paymentMethodId: normalizePaymentId(paymentMethodId),
  };
}

/**
 * 支付方式：**不再是本模块的常量**，改由运营配置（app_settings.payment）决定，
 * 与结算页展示同一份。本模块只负责把传入 id 归一化到配置里存在的某一项。
 * @deprecated 用 settingsService.paymentMethods() —— 保留导出仅为不打断外部引用
 */
export function paymentMethodIds() {
  return paymentMethods().map((m) => m.id);
}

/**
 * 下单：校验 → 算钱 → 扣库存 → 建单 → 清购物车 → 销券（同一事务）
 *
 * 券核销是事务里的最后一步，与建单同生共死：
 * 建单失败不会白扣一张券，核销失败（券过期/已被别处用掉）则整单回滚，
 * 用户看到的是「优惠券不可用」而不是「下单成功但券没了」。
 *
 * 幂等：带 idempotencyKey 时，同一个 key 在同一个用户下只会建一单。
 *   - 命中已有订单 → 直接返回那一单（replayed: true），不再扣库存、不再清购物车、不再销券；
 *   - 并发抢跑撞唯一索引 → 回滚后重查，返回先插进去的那一单；
 *   - 没带 key（老客户端 / 直接调接口）→ 行为与以前完全一致。
 * 这一层挡的是「服务端已建单、响应在网络上丢了，用户以为失败又点一次」——
 * 没有它，用户会真的被收两次钱，而且两单的库存也扣了两次。
 *
 * @returns {{orderId, status, payAmount, ... }} 完整订单，幂等命中时附带 replayed: true
 */
export function createOrder({ userId, items, addressId, couponId, remark = '', shippingMethodId, paymentMethodId, idempotencyKey }) {
  const db = getDb();
  const idemKey = normalizeIdemKey(idempotencyKey);

  db.exec('BEGIN');
  try {
    // 幂等查询必须在事务内、在建单之前：并发请求会串行拿到写锁，
    // 第一个提交后第二个才读到，读到就返回，不会走到建单。
    const hit = findByIdemKey(db, userId, idemKey);
    if (hit) {
      const existing = getOrder(hit.id, userId);
      db.exec('COMMIT');
      return { ...existing, replayed: true };
    }

    const draft = previewOrder({ userId, items, addressId, couponId, shippingMethodId, paymentMethodId });
    const orderId = makeOrderId(db);

    db.prepare(`
      INSERT INTO orders
        (id, user_id, status, total_amount, product_amount, shipping_fee, discount_amount,
         coupon_id, address_id, remark, shipping_method_id, payment_method_id, shipping_eta,
         idempotency_key, created_at, paid_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
    `).run(
      orderId, userId, draft.payAmount, draft.productAmount,
      draft.shippingFee, draft.discountAmount, couponId || null,
      draft.address.id, String(remark).slice(0, 120),
      draft.shipping.id, draft.paymentMethodId, draft.shipping.eta, idemKey,
    );

    const insItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, sku_id, name, spec, price, qty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of draft.items) {
      // name 存纯商品名，规格单独存 spec：两处都塞规格会让订单详情显示
      // 「墨方 自动铅笔 0.5mm（0.5mm / 灰） / SKU：0.5mm / 灰」这种重复。
      // 历史订单的 name 里已经拼过规格，前端在 spec 为空时只显示名称，不做猜测解析。
      insItem.run(orderId, l.productId, l.skuId, l.name, l.spec || '', l.price, l.qty);
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
    // 并发抢跑：另一个请求刚用同一个 key 建完单（它先拿到写锁并提交），
    // 本请求的查询发生在它提交之前、插入时撞唯一索引。回滚后重查并返回那一单——
    // 用户视角这就是「同一次提交」，拿到订单才是对的，抛冲突反而让他以为没下成。
    if (idemKey && isUniqueViolation(e)) {
      const raced = findByIdemKey(db, userId, idemKey);
      if (raced) return { ...getOrder(raced.id, userId), replayed: true };
    }
    throw e;
  }
}

/**
 * 订单详情（含明细、物流、金额拆分、售后记录）。
 *
 * withDetail=false 用于列表接口：物流事件与售后单各是一次额外查询，
 * 列表只显示「订单号 / 状态 / 金额」，为 50 笔订单各查两次属于典型的 N+1。
 */
export function getOrder(orderId, userId, { withDetail = true } = {}) {
  const db = getDb();
  const row = db
    .prepare(`
      SELECT o.*, a.receiver, a.phone, a.region, a.detail, c.title AS coupon_title
      FROM orders o
      LEFT JOIN addresses a ON a.id = o.address_id
      LEFT JOIN coupons c ON c.id = o.coupon_id
      WHERE o.id = ? AND o.user_id = ?
    `)
    .get(orderId, userId);
  if (!row) return null;
  const items = db
    .prepare('SELECT product_id, sku_id, name, spec, price, qty FROM order_items WHERE order_id = ?')
    .all(orderId)
    .map((i) => ({
      productId: i.product_id,
      skuId: i.sku_id,
      name: i.name,
      spec: i.spec || '',
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
    shippedAt: row.shipped_at || null,
    completedAt: row.completed_at || null,
    productAmount: row.product_amount ?? row.total_amount,
    shippingFee: row.shipping_fee ?? 0,
    discountAmount: row.discount_amount ?? 0,
    payAmount: row.total_amount,
    couponId: row.coupon_id || '',
    couponTitle: row.coupon_title || '',
    shippingMethodId: row.shipping_method_id || '',
    paymentMethodId: row.payment_method_id || '',
    shippingEta: row.shipping_eta || '',
    remark: row.remark || '',
    logisticsCompany: row.logistics_company,
    trackingNo: row.tracking_no,
    // 物流与售后只在详情里带：没发货时 events 为空数组，前端据此显示「待发货」
    ...(withDetail ? {
      logistics: {
        company: row.logistics_company || '',
        trackingNo: row.tracking_no || '',
        shippedAt: row.shipped_at || null,
        completedAt: row.completed_at || null,
        events: listEvents(db, orderId),
      },
      aftersales: listAftersales(orderId, db),
    } : {}),
    receiver: row.receiver || '',
    phone: row.phone || '',
    // 结构化地址：前端的订单页要分「收货人 / 电话 / 地区 / 详细地址」三行显示，
    // 只给一个拼接字符串的话，页面只能整行倒出来（或者干脆显示成「—」）。
    // addressText 保留给「一行式」消费方（日志、AI 客服话术）。
    address: (row.region || row.detail) ? {
      receiver: row.receiver || '',
      phone: row.phone || '',
      region: row.region || '',
      detail: row.detail || '',
      postal: '',
    } : null,
    addressText: row.region ? `${row.region} ${row.detail}` : '',
    items,
  };
}

export function listOrders(userId, limit = 50) {
  const rows = getDb()
    .prepare('SELECT id FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
  return rows
    .map((r) => getOrder(r.id, userId, { withDetail: false }))
    .filter(Boolean);
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

/* ---------------- 履约推进（模拟发货 / 模拟签收） ---------------- */

/** 允许演示推进的前置状态 */
const SHIPPABLE = 'paid';
const DELIVERABLE = 'shipped';

/**
 * 模拟发货（演示用）：paid → shipped，写物流公司与运单号 + 揽收/运输两条事件。
 *
 * 为什么状态检查这么死：发货不是「改个标签」，它决定了用户能不能申请售后
 * （只有已发货/已完成可申请）。如果允许从 pending 直接发货，
 * 就会出现「没付款也能退款」这种账算不平的路径。
 *
 * 幂等：已经发过货再点一次直接返回现状，不重新生成运单号——
 * 同一笔订单两次发货会得到两个运单号，用户不知道该看哪个。
 */
export function shipOrder(orderId, userId) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT status FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!row) throw Object.assign(new Error('订单不存在'), { status: 404 });
    if (row.status === 'shipped' || row.status === 'completed') {
      db.exec('COMMIT');
      return getOrder(orderId, userId);
    }
    if (row.status !== SHIPPABLE) {
      throw Object.assign(
        new Error(row.status === 'pending' ? '订单还未付款，无法发货' : '当前状态不支持发货'),
        { status: 409 },
      );
    }
    const now = new Date();
    const shipment = newShipment(now);
    db.prepare(`
      UPDATE orders
      SET status = 'shipped', shipped_at = ?, logistics_company = ?, tracking_no = ?
      WHERE id = ?
    `).run(dbTime(now), shipment.company, shipment.trackingNo, orderId);
    appendEvents(db, orderId, shipment.events);
    db.exec('COMMIT');
    return getOrder(orderId, userId);
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
}

/**
 * 模拟签收（演示用）：shipped → completed，追加派送中 / 已签收两条事件。
 *
 * 没有它就没有「已完成」的订单可申请售后，售后入口等于永远点不到。
 * 同样是幂等的：已完成再点一次返回现状，不会补出第二组签收事件。
 */
export function completeOrder(orderId, userId) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT status FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!row) throw Object.assign(new Error('订单不存在'), { status: 404 });
    if (row.status === 'completed') {
      db.exec('COMMIT');
      return getOrder(orderId, userId);
    }
    if (row.status !== DELIVERABLE) {
      throw Object.assign(
        new Error(row.status === 'shipped' ? '当前状态不支持签收' : '订单尚未发货，无法签收'),
        { status: 409 },
      );
    }
    const now = new Date();
    db.prepare("UPDATE orders SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(dbTime(now), orderId);
    appendEvents(db, orderId, eventsOnDeliver(now));
    db.exec('COMMIT');
    return getOrder(orderId, userId);
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
}

/** 可取消的状态：已发货/已完成的订单必须先走售后，不能直接取消 */
const CANCELABLE = new Set(['pending', 'paid']);

/**
 * 取消订单（事务）：置 closed + 把该单用掉的券退回并顺延，两步同生共死。
 *
 * 为什么不能拆开：「订单关了但券没退」用户直接损失一张券；
 * 「券退了但订单没关」用户可以拿同一张券再下一单，等于无限用。
 * 券的顺延规则取自运营配置，与前端展示同一份。
 *
 * 幂等：已关闭的订单再取消一次直接返回成功，不重复顺延（否则「取消两次」就能把有效期刷长）。
 *
 * @returns {{order:object, coupon:{restored:number, extended:number, graceDays:number}}}
 */
export function cancelOrder(orderId, userId) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT id, status FROM orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!row) throw Object.assign(new Error('订单不存在'), { status: 404 });
    if (row.status === 'closed') {
      db.exec('COMMIT');
      return { order: getOrder(orderId, userId), coupon: { restored: 0, extended: 0, graceDays: 0 } };
    }
    if (!CANCELABLE.has(row.status)) {
      throw Object.assign(new Error('该订单已发货，请通过售后流程处理'), { status: 409 });
    }
    db.prepare("UPDATE orders SET status = 'closed' WHERE id = ?").run(orderId);
    const coupon = userRepo.refundCouponByOrder(userId, orderId);
    db.exec('COMMIT');
    return { order: getOrder(orderId, userId), coupon };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
}
