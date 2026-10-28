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
import { findPayment, findShipping, paymentMethods, shippingFeeOf, shippingMethods } from './config.js';
import { mockDeliverEvents, mockShipment } from './logistics.js';

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

/**
 * 支付方式：同样来自运营配置（app_settings.payment）。
 *
 * 它曾被留在这里当常量，理由是「支付方式不参与算钱、运营不用调价」。
 * 这个理由只对了一半：不参与算钱是对的，但它会进订单快照、会出现在结算页，
 * 大促时关掉货到付款是常规操作。留成前端常量，服务端就永远不知道
 * 「这个部署只有在线支付」，用户仍能选一个服务端不认识的方式下单。
 */
export function getPaymentMethods() {
  return paymentMethods();
}

/**
 * 订单状态词条。
 *
 * paid 显示「待发货」而不是「已付款」：用户关心的是「接下来会发生什么」。
 * 已付款是既成事实，写在状态胶囊里等于没给信息——这一格应该回答「还要等多久」。
 * 同理 closed 显示「已取消」而不是「已关闭」：关闭是系统内部说法。
 */
export const ORDER_STATUS_TEXT = {
  pending: '待付款',
  paid: '待发货',
  shipped: '已发货',
  completed: '已完成',
  refunding: '售后中',
  refunded: '已退款',
  closed: '已取消',
};

export function statusText(status) {
  return ORDER_STATUS_TEXT[status] || status || '—';
}

/**
 * 履约四步：提交 → 付款 → 发货 → 收货。
 *
 * 阶段**由时间戳推导**，不看 status：售后中（refunding）的订单仍然要知道自己走到了哪一步，
 * 而 status 此时只剩「售后中」一个词，把它当阶段用会让流转条整条消失。
 */
export const ORDER_STEPS = [
  { key: 'created', label: '待付款', field: 'createdAt' },
  { key: 'paid', label: '待发货', field: 'paidAt' },
  { key: 'shipped', label: '已发货', field: 'shippedAt' },
  { key: 'completed', label: '已完成', field: 'completedAt' },
];

/**
 * @returns {{cancelled:boolean, index:number, steps:Array<{key,label,at,done}>}}
 *   index = 已走到第几步（0 起）；cancelled 时 steps 仍返回，供页面判断要不要画
 */
export function orderStage(order = {}) {
  const steps = ORDER_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    at: order[s.field] || '',
    done: Boolean(order[s.field]),
  }));
  // 本地单可能只有 status 没有时间戳（历史数据 / 服务端没返回字段）：
  // 用状态兜底，避免「已发货的单流转条停在第 1 步」。
  // refunded 按「已完成」算：退款前货一定已经送到，流转条该是四步走满而不是退回一半
  const rank = { pending: 0, paid: 1, shipped: 2, completed: 3, refunded: 3 }[order.status];
  if (rank != null) {
    for (let i = 0; i <= rank && i < steps.length; i += 1) steps[i].done = true;
  }
  const index = steps.reduce((n, s, i) => (s.done ? i : n), 0);
  return {
    cancelled: order.status === 'closed',
    refunding: order.status === 'refunding',
    index: steps.every((s) => !s.done) ? -1 : index,
    steps,
  };
}


export function shippingById(id) {
  return findShipping(id);
}

export function paymentById(id) {
  return findPayment(id);
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
    // 履约时间戳 / 物流 / 售后：只有「服务端订单落镜像」时才会带进来，
    // 正常下单时这些键都不存在，不会给订单塞一堆空字段。
    ...(draft.paidAt ? { paidAt: draft.paidAt } : {}),
    ...(draft.shippedAt ? { shippedAt: draft.shippedAt } : {}),
    ...(draft.completedAt ? { completedAt: draft.completedAt } : {}),
    ...(draft.logistics ? { logistics: draft.logistics } : {}),
    ...(draft.aftersales ? { aftersales: draft.aftersales } : {}),
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

/** 按 id 覆盖写入（服务端最新状态回写镜像时用；不存在则插到最前） */
export function upsertOrder(userId, order = {}) {
  if (!userId || !order.id) return null;
  const list = read(userId);
  const idx = list.findIndex((o) => String(o.id) === String(order.id));
  const merged = idx >= 0 ? { ...list[idx], ...order } : order;
  if (idx >= 0) list[idx] = merged;
  else list.unshift(merged);
  write(userId, list);
  return merged;
}

/* ---------------- 履约推进（本地单 / 离线演示） ---------------- */

/**
 * 模拟发货：paid → shipped，并生成快递公司、运单号与两条物流事件。
 *
 * 服务端订单不该走这里——它们在服务端事务里推进，前端只负责把返回结果写回镜像。
 * 这条路径是给「没有网关的纯静态站点」用的：那条路上没有任何服务端可以改状态，
 * 否则演示按钮点下去什么也不会发生。
 */
export function applyShipment(userId, id, now = Date.now()) {
  const hit = getOrder(userId, id);
  if (!hit) return null;
  if (hit.status !== 'paid') return hit;
  const shipment = mockShipment(now);
  return upsertOrder(userId, {
    ...hit,
    status: 'shipped',
    shippedAt: shipment.events[shipment.events.length - 1].at,
    logisticsCompany: shipment.company,
    trackingNo: shipment.trackingNo,
    logistics: {
      company: shipment.company,
      trackingNo: shipment.trackingNo,
      shippedAt: shipment.events[0].at,
      completedAt: null,
      events: shipment.events,
    },
  });
}

/** 模拟签收：shipped → completed，追加派送中 / 已签收两条事件 */
export function applyDelivery(userId, id, now = Date.now()) {
  const hit = getOrder(userId, id);
  if (!hit) return null;
  if (hit.status !== 'shipped') return hit;
  const prev = (hit.logistics && Array.isArray(hit.logistics.events)) ? hit.logistics.events : [];
  const events = [...prev, ...mockDeliverEvents(now)];
  return upsertOrder(userId, {
    ...hit,
    status: 'completed',
    completedAt: events[events.length - 1].at,
    logistics: {
      company: (hit.logistics && hit.logistics.company) || hit.logisticsCompany || '',
      trackingNo: (hit.logistics && hit.logistics.trackingNo) || hit.trackingNo || '',
      shippedAt: (hit.logistics && hit.logistics.shippedAt) || hit.shippedAt || null,
      completedAt: events[events.length - 1].at,
      events,
    },
  });
}

/** 售后中标记：本地单申请售后后调用（服务端单由服务端返回的状态覆盖） */
export function markRefunding(userId, id, aftersales) {
  const hit = getOrder(userId, id);
  if (!hit) return null;
  return upsertOrder(userId, {
    ...hit,
    status: 'refunding',
    ...(Array.isArray(aftersales) ? { aftersales } : {}),
  });
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
  // 地址兼容两种形态：结构化对象（当前网关）与拼接字符串（老版本 / 缓存里的镜像）。
  // 只认对象的话，老数据会把整块「收货信息」渲染成三个「—」，看起来像订单丢了地址。
  const rawAddr = raw.address;
  const address = rawAddr && typeof rawAddr === 'object'
    ? {
      receiver: rawAddr.receiver || raw.receiver || '',
      phone: rawAddr.phone || raw.phone || '',
      region: rawAddr.region || '',
      detail: rawAddr.detail || '',
      postal: rawAddr.postal || '',
    }
    : (rawAddr || raw.addressText)
      ? {
        receiver: raw.receiver || '',
        phone: raw.phone || '',
        region: String(raw.addressText || rawAddr || ''),
        detail: '',
        postal: '',
      }
      : null;
  return {
    id: raw.id || raw.orderId,
    userId: raw.userId || '',
    items,
    address,
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
    // 履约时间戳：流转条靠它们判断走到第几步（status 只负责顶部胶囊）
    paidAt: raw.paidAt || null,
    shippedAt: raw.shippedAt || null,
    completedAt: raw.completedAt || null,
    // 物流与售后只有详情接口会带；列表接口没有这两个字段，保持 undefined 而不是空对象，
    // 免得详情页把「列表数据」误当成「没有物流事件」。
    ...(raw.logistics ? {
      logistics: {
        company: raw.logistics.company || '',
        trackingNo: raw.logistics.trackingNo || '',
        shippedAt: raw.logistics.shippedAt || null,
        completedAt: raw.logistics.completedAt || null,
        events: Array.isArray(raw.logistics.events) ? raw.logistics.events : [],
      },
    } : {}),
    ...(Array.isArray(raw.aftersales) ? { aftersales: raw.aftersales } : {}),
    // 资金流水与余额：只详情接口带。列表不带的字段保持缺失，
    // 免得详情页把「没有数据」当成「余额为 0」——那是两种完全不同的意思。
    ...(Array.isArray(raw.ledger) ? { ledger: raw.ledger } : {}),
    ...(raw.balance ? { balance: raw.balance } : {}),
    ...(raw.logisticsCompany ? { logisticsCompany: raw.logisticsCompany } : {}),
    ...(raw.trackingNo ? { trackingNo: raw.trackingNo } : {}),
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
