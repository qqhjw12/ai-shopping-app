// 订单簿：localStorage 按用户隔离的订单仓库（本步骤的交易闭环落点）。
//
// 为什么单独成模块：
//   1) 结算页只「组装草稿」，订单的编号规则、金额结构、状态词条、容量上限全部收敛在这里，
//      页面不再各写一份，改规则只改一处；
//   2) 按 userId 分区存储（`maison_orders::<userId>`），一个浏览器里换账号不会看到别人的订单；
//   3) 服务端订单与本地下单共用同一套展示结构（normalizeRemote），
//      个人中心的列表就不需要为「数据从哪来」写两套渲染。
//
// 存储键刻意不带用户 ID 前缀以外的语义：换账号 = 换键，天然隔离，无需额外过滤。
//
// 运费与配送方式不再是本模块的常量：它们是**运营可配参数**，真源在服务端
// （GET /api/config），本模块只通过 store/config.js 读取，
// 保证结算页展示、下单请求、订单快照三处拿到的是同一组数字。
import { findShipping, shippingFeeOf, shippingMethods } from './config.js';

const KEY_PREFIX = 'maison_orders::';

/** 每个账户最多保留的订单条数，避免 localStorage 无限膨胀 */
const MAX_ORDERS = 60;

/**
 * 配送方式：从运营配置读（服务端 app_settings.shipping，离线用内置默认）。
 * 返回的是快照数组，调用方不要缓存跨渲染使用——运营改价后要能立刻看到新值。
 */
export function getShippingMethods() {
  return shippingMethods();
}

/** 支付方式（mock）：只记录选择，不接真实支付。运营不用调价，所以留在前端常量。 */
export const PAYMENT_METHODS = [
  { id: 'online', name: '在线支付', note: '微信 / 支付宝（演示环境不产生真实扣款）' },
  { id: 'cod', name: '货到付款', note: '签收时向配送员付款' },
];

export const ORDER_STATUS_TEXT = {
  pending: '待付款',
  paid: '已付款',
  shipped: '已发货',
  completed: '已完成',
  closed: '已关闭',
};

export function statusText(status) {
  return ORDER_STATUS_TEXT[status] || status || '—';
}

export function shippingById(id) {
  return findShipping(id);
}

export function paymentById(id) {
  return PAYMENT_METHODS.find((m) => m.id === id) || PAYMENT_METHODS[0];
}

/* ---------------- 存储读写 ---------------- */

function key(userId) {
  return `${KEY_PREFIX}${userId || 'anonymous'}`;
}

function read(userId) {
  try {
    const arr = JSON.parse(localStorage.getItem(key(userId)) || '[]');
    return Array.isArray(arr) ? arr.filter((o) => o && o.id) : [];
  } catch {
    return [];
  }
}

function write(userId, list) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(list.slice(0, MAX_ORDERS)));
  } catch {
    /* 配额写满等异常不该让下单失败——内存里已经返回订单，刷新后才会丢 */
  }
  notify(userId);
}

/* ---------------- 变更订阅 ---------------- */

const listeners = new Set();

/** 订阅订单变化（下单 / 改状态 / 清空），返回取消订阅函数 */
export function onOrdersChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(userId) {
  // 快照遍历：订阅者回调里可能再次写入并注册新订阅者，直接遍历会无限扩散
  [...listeners].forEach((fn) => {
    try {
      fn(userId);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  });
}

/* ---------------- 订单号 ---------------- */

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * 订单号：MS + 年月日 + 4 位序号。
 * 序号按「当天已有订单数 + 1」推进，冲突时再随机补一位——
 * 纯随机虽然简单，但演示时连续下单很容易撞号（同一秒两次下单会撞）。
 */
export function nextOrderId(userId, existing = null) {
  const list = existing || read(userId);
  const day = stamp();
  const sameDay = list.filter((o) => String(o.id || '').startsWith(`MS${day}`)).length;
  let seq = sameDay + 1;
  let id = `MS${day}${String(seq).padStart(4, '0')}`;
  let guard = 0;
  const taken = new Set(list.map((o) => String(o.id)));
  while (taken.has(id) && guard < 200) {
    seq += 1;
    id = `MS${day}${String(seq).padStart(4, '0')}`;
    guard += 1;
  }
  return id;
}

/* ---------------- 金额 ---------------- */

/**
 * 金额汇总：商品总额 + 运费 − 优惠券抵扣 = 应付金额。
 * 金额唯一入口：结算页预览、下单快照、订单详情展示都走这里，
 * 保证「预览一个价、下单另一个价」在结构上不可能发生。
 * couponTitle 随金额快照进订单，详情页无需再查券；couponId 用于取消订单时把券退回券包。
 *
 * 防负数三道闸：总额/运费先夹到 ≥0；抵扣夹到 [0, 商品总额]（券再多也不能抵过商品钱，
 * 运费不参与抵扣——否则「满 99 减 100」的券会倒找钱）；应付 = 总额 + 运费 − 抵扣 ≥ 运费 ≥ 0。
 */
export function computeAmounts({
  productAmount = 0, shippingFee = 0, couponDiscount = 0, couponTitle = '', couponId = '',
} = {}) {
  const goods = Math.max(0, round(productAmount));
  const ship = Math.max(0, round(shippingFee));
  const discount = Math.min(Math.max(0, round(couponDiscount)), goods);
  return {
    productAmount: goods,
    shippingFee: ship,
    couponDiscount: discount,
    payAmount: round(goods + ship - discount),
    ...(couponTitle ? { couponTitle: String(couponTitle).slice(0, 40) } : {}),
    ...(couponId ? { couponId: String(couponId) } : {}),
  };
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/* ---------------- 创建 / 查询 ---------------- */

/**
 * 下单：把结算页的草稿固化成一条订单。
 * 只保留可展示所需字段，避免把库存、原始 SKU 对象等整份塞进 localStorage。
 */
export function createOrder(userId, draft = {}) {
  if (!userId) throw new Error('缺少用户身份，无法下单');
  const list = read(userId);
  const shipping = shippingById((draft.shippingMethod || {}).id);
  const payment = paymentById((draft.paymentMethod || {}).id);
  const items = (draft.items || []).map((i) => ({
    productId: i.productId || i.id,
    skuId: i.skuId ?? null,
    name: i.name || '商品',
    spec: i.spec || '',
    price: round(i.price),
    qty: Math.max(1, Number(i.qty) || 1),
    subtotal: round(round(i.price) * Math.max(1, Number(i.qty) || 1)),
    pic: i.pic || '',
    coverColor: i.coverColor || '',
  }));
  const goods = items.reduce((s, i) => s + i.subtotal, 0);
  const amounts = draft.amounts || computeAmounts({
    productAmount: goods,
    shippingFee: shippingFeeOf(shipping, goods),
  });

  const order = {
    id: draft.id || nextOrderId(userId, list),
    userId,
    items,
    address: draft.address ? {
      id: draft.address.id || '',
      receiver: draft.address.receiver || '',
      phone: draft.address.phone || '',
      region: draft.address.region || '',
      detail: draft.address.detail || '',
      postal: draft.address.postal || '',
    } : null,
    // 运费记「实收」而不是「配送方式标价」：券后达到包邮门槛时实收是 0，
    // 卡片上写 ¥18 而金额明细里是 ¥0 会让人以为算错了。
    shippingMethod: { id: shipping.id, name: shipping.name, fee: amounts.shippingFee, eta: shipping.eta },
    paymentMethod: { id: payment.id, name: payment.name },
    remark: String(draft.remark || '').trim(),
    amounts,
    status: draft.status || 'pending',
    createdAt: draft.createdAt || new Date().toISOString(),
    // remote=true 表示这条是服务端订单的本地镜像（核销/取消都以服务端为准）
    ...(draft.remote ? { remote: true } : {}),
  };

  write(userId, [order, ...list]);
  return order;
}

export function listOrders(userId) {
  return read(userId);
}

export function getOrder(userId, id) {
  const target = String(id || '');
  return read(userId).find((o) => String(o.id) === target) || null;
}

export function updateOrderStatus(userId, id, status) {
  const list = read(userId);
  const hit = list.find((o) => String(o.id) === String(id));
  if (!hit) return null;
  hit.status = status;
  hit.updatedAt = new Date().toISOString();
  write(userId, list);
  return hit;
}

export function clearOrders(userId) {
  write(userId, []);
}

/** 订单总数（个人中心 Bento 数据块用） */
export function countOrders(userId) {
  return read(userId).length;
}

/* ---------------- 服务端订单归一化 ---------------- */

/**
 * 网关订单 → 本地订单结构。
 * 字段名差异（orderId / payAmount 平铺 / shippingMethodId）在这一层吃掉，
 * 个人中心与订单详情就能只写一套渲染逻辑。
 */
export function normalizeRemote(raw = {}) {
  const shipping = raw.shippingMethod && raw.shippingMethod.id
    ? raw.shippingMethod
    : {
      ...shippingById(raw.shippingMethodId || raw.shippingId || 'standard'),
      ...(raw.shippingEta ? { eta: raw.shippingEta } : {}),
    };
  const payment = raw.paymentMethod && raw.paymentMethod.id
    ? raw.paymentMethod
    : paymentById(raw.paymentMethodId || raw.paymentId || 'online');
  const items = (raw.items || []).map((i) => ({
    productId: i.productId || i.id,
    skuId: i.skuId ?? null,
    name: i.name || '商品',
    spec: i.spec || '',
    price: round(i.price),
    qty: Math.max(1, Number(i.qty) || 1),
    subtotal: round(i.price) * Math.max(1, Number(i.qty) || 1),
    pic: i.pic || '',
    coverColor: i.coverColor || '',
  }));
  return {
    id: raw.id || raw.orderId,
    userId: raw.userId || '',
    items,
    address: raw.address || null,
    shippingMethod: { id: shipping.id, name: shipping.name, fee: raw.shippingFee ?? shipping.fee ?? 0, eta: shipping.eta || '' },
    paymentMethod: { id: payment.id, name: payment.name },
    remark: raw.remark || '',
    amounts: raw.amounts || computeAmounts({
      productAmount: raw.productAmount ?? items.reduce((s, i) => s + i.subtotal, 0),
      shippingFee: raw.shippingFee ?? 0,
      couponDiscount: raw.discountAmount ?? 0,
      couponTitle: raw.couponTitle || '',
      couponId: raw.couponId || '',
    }),
    status: raw.status || 'pending',
    createdAt: raw.createdAt || raw.created_at || new Date().toISOString(),
    remote: raw.remote !== false,
  };
}

/**
 * 合并两批订单：本地优先（同号时以本地为准，本地带配送/支付等更完整的信息），
 * 结果按创建时间倒序。
 */
export function mergeOrders(local = [], remote = []) {
  const seen = new Set();
  const out = [];
  [...local, ...remote].forEach((o) => {
    if (!o || !o.id || seen.has(String(o.id))) return;
    seen.add(String(o.id));
    out.push(o);
  });
  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
