// 结算链路服务层：地址 / 优惠券 / 金额规则。
//
// 设计约定：
// 1) API-first —— 网关是真相源；网关不可达（Pages 静态站点、断网）时降级到 localStorage，
//    并保证「结算页能渲染、金额明细能算、下单按钮在」这条主链路不塌。
// 2) 金额规则（包邮门槛 / 运费）必须与网关 orderService 保持一致，
//    否则会出现「预览一个价、下单另一个价」——所以常量在这里集中定义，页面不再各写一份。
import { api } from '../api.js';

/* ---------------- 金额规则（与网关 orderService 对齐） ---------------- */
export const FREE_SHIPPING_THRESHOLD = 99;
export const SHIPPING_FEE = 10;

/* ---------------- 本地持久化（降级用） ---------------- */
const ADDR_KEY = 'maison_addresses_v1';

function readJSON(key, fallback) {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function writeJSON(key, val) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* 隐私模式 / 配额满：降级为纯内存，不影响交互 */
  }
}

/** 判断一次失败是否来自「网关不可达」（而非用户输入错误） */
export function isUnreachable(e) {
  if (!e) return true;
  if (e.kind === 'network' || e.kind === 'offline' || e.kind === 'server') return true;
  return !e.status; // 拿不到 HTTP 状态码 = 没连上
}

/* ---------------- 金额汇总 ---------------- */

/**
 * 商品金额 → 优惠 → 运费 → 应付。
 * @param {number} productAmount 商品小计
 * @param {number} [discountAmount] 优惠金额（会被夹逼到不超过商品金额）
 */
export function summarize(productAmount, discountAmount = 0) {
  const goods = Math.max(0, Number(productAmount) || 0);
  const discount = Math.min(Math.max(0, Number(discountAmount) || 0), goods);
  const shippingFee = goods - discount >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
  return {
    productAmount: goods,
    discountAmount: discount,
    shippingFee,
    payAmount: goods - discount + shippingFee,
    // 距包邮还差多少（已包邮为 0），用于在 UI 上给「再买 ¥X 包邮」提示
    freeShippingGap: shippingFee ? Math.max(0, FREE_SHIPPING_THRESHOLD - (goods - discount)) : 0,
  };
}

/** 把购物袋/结算清单折算成行金额 */
export function linesOf(items = []) {
  return items.map((i) => {
    const qty = Math.max(1, Number(i.qty) || 1);
    const price = Number(i.price) || 0;
    return { productId: i.productId || i.id, skuId: i.skuId ?? null, name: i.name, spec: i.spec || '', price, qty, subtotal: price * qty };
  });
}

/**
 * 离线 / 演示模式的完整预览对象：结构对齐服务端 `/api/orders/preview` 返回值，
 * 让页面渲染逻辑只有一套，不区分「服务端算的」还是「本地算的」。
 */
export function estimatePreview(items = [], coupon = null, address = null) {
  const lines = linesOf(items);
  const productAmount = lines.reduce((s, l) => s + l.subtotal, 0);
  const discount = coupon ? Math.min(couponWorth(coupon, productAmount), productAmount) : 0;
  const sum = summarize(productAmount, discount);
  return {
    items: lines,
    address,
    coupon,
    productAmount: sum.productAmount,
    discountAmount: sum.discountAmount,
    shippingFee: sum.shippingFee,
    payAmount: sum.payAmount,
    freeShippingGap: sum.freeShippingGap,
    local: true,
  };
}

/* ---------------- 优惠券 ---------------- */

/** 券在当前金额下能省多少；折扣券按比例换算，满减券为固定额 */
export function couponWorth(coupon, productAmount) {
  if (!coupon) return 0;
  const amount = Number(coupon.amount) || 0;
  const threshold = Number(coupon.threshold) || 0;
  const goods = Number(productAmount) || 0;
  if (threshold && goods < threshold) return 0;
  if (coupon.kind === 'discount') {
    // 折扣券 amount 为打折幅度百分比（10 = 减 10%）。
    // 必须与网关 userRepo.listCoupons 的取整方式一致（Math.floor），否则会出现
    // 「券卡显示可省 ¥939.8、服务端实扣 ¥939」这种差几毛钱的口径不一致。
    const off = Math.min(100, Math.max(0, amount));
    return Math.floor((goods * off) / 100);
  }
  return Math.min(amount, goods);
}

/** 距使用门槛还差多少（已达标为 0） */
export function couponGap(coupon, productAmount) {
  if (!coupon) return 0;
  const threshold = Number(coupon.threshold) || 0;
  if (!threshold) return 0;
  return Math.max(0, Math.round((threshold - (Number(productAmount) || 0)) * 100) / 100);
}

/** 自动挑最优：可用券里省得最多的那张 */
export function pickBestCoupon(coupons = []) {
  const usable = (coupons || []).filter((c) => c && c.usable);
  if (!usable.length) return null;
  return usable.slice().sort((a, b) => (Number(b.worth) || 0) - (Number(a.worth) || 0))[0];
}

/** 离线演示券：让静态站点也能看到「选券省钱」的完整链路 */
export function demoCoupons(productAmount = 0) {
  const defs = [
    { couponId: 'c_demo_20', title: '新人立减券', kind: 'amount', amount: 20, threshold: 199 },
    { couponId: 'c_demo_10', title: '会员 9 折券', kind: 'discount', amount: 10, threshold: 0 },
  ];
  return defs.map((d) => {
    const worth = couponWorth(d, productAmount);
    const threshold = Number(d.threshold) || 0;
    return {
      ...d,
      worth,
      usable: !threshold || productAmount >= threshold,
      expired: false,
      demo: true,
    };
  });
}

export async function loadCoupons(userId, productAmount = 0) {
  try {
    const d = await api(`/api/coupons?userId=${encodeURIComponent(userId)}&amount=${encodeURIComponent(String(productAmount))}`, { retries: 0 });
    const list = Array.isArray(d && d.coupons) ? d.coupons : [];
    return { coupons: list, online: true };
  } catch (e) {
    if (!isUnreachable(e)) return { coupons: [], online: false };
    return { coupons: demoCoupons(productAmount), online: false };
  }
}

/* ---------------- 收货地址 ---------------- */

/** 离线默认地址，保证「结算需要的四段信息」在无后端时依然可见可交付 */
export const DEMO_ADDRESS = {
  id: 'a_demo',
  receiver: '演示用户',
  phone: '138****0000',
  region: '上海市 浦东新区',
  detail: '示例路 1 号 101 室',
  isDefault: true,
  demo: true,
};

function localAddresses(userId) {
  const all = readJSON(ADDR_KEY, {});
  return Array.isArray(all && all[userId]) ? all[userId] : [];
}

function writeLocalAddresses(userId, list) {
  const all = readJSON(ADDR_KEY, {}) || {};
  all[userId] = list;
  writeJSON(ADDR_KEY, all);
}

/** 服务端列表与本地离线新增合并（按 id 去重，服务端优先） */
function mergeAddresses(server = [], local = []) {
  const out = server.slice();
  const seen = new Set(out.map((a) => String(a && a.id)));
  local.forEach((a) => {
    if (a && !seen.has(String(a.id))) { out.push(a); seen.add(String(a.id)); }
  });
  return out.length ? out : [DEMO_ADDRESS];
}

export async function loadAddresses(userId) {
  const local = localAddresses(userId);
  try {
    const d = await api(`/api/addresses?userId=${encodeURIComponent(userId)}`, { retries: 0 });
    const server = Array.isArray(d && d.addresses) ? d.addresses : [];
    return { addresses: mergeAddresses(server, local), online: true };
  } catch (e) {
    // 离线首次进入：把演示地址落进本地清单。
    // 否则后续「新增地址」是在一份空列表上追加，返回时会把刚展示过的演示地址覆盖掉，
    // 表现为「明明新增成功，地址数量却没变」。
    if (isUnreachable(e) && !local.length) writeLocalAddresses(userId, [DEMO_ADDRESS]);
    return { addresses: mergeAddresses([], localAddresses(userId)), online: false };
  }
}

/** 校验并在缺少必填项时抛错（网关侧同样要求 receiver + region） */
export function validateAddress({ receiver, phone, region } = {}) {
  if (!String(receiver || '').trim()) return '请填写收货人姓名';
  if (!String(region || '').trim()) return '请填写所在地区';
  // 手机号非必填，但填了就做基本格式校验，避免把明显无效的地址存下来
  const p = String(phone || '').trim();
  if (p && !/^1[3-9]\d{9}$/.test(p)) return '手机号格式有误，请填写 11 位手机号';
  return '';
}

export async function saveAddress(userId, payload = {}) {
  const addr = {
    receiver: String(payload.receiver || '').trim(),
    phone: String(payload.phone || '').trim(),
    region: String(payload.region || '').trim(),
    detail: String(payload.detail || '').trim(),
    isDefault: !!payload.isDefault,
  };
  try {
    const d = await api('/api/addresses', { method: 'POST', body: { userId, ...addr } });
    const server = Array.isArray(d && d.addresses) ? d.addresses : [];
    return { addresses: mergeAddresses(server, localAddresses(userId)), id: d && d.id, online: true };
  } catch (e) {
    if (!isUnreachable(e)) throw e;
    // 离线：落到本地并在下次连通时不丢
    const list = localAddresses(userId).filter((a) => String(a.id) !== String(payload.id));
    const id = payload.id || `a_local_${Date.now()}`;
    const next = [{ id, ...addr, local: true }, ...list];
    if (addr.isDefault) next.forEach((a) => { a.isDefault = String(a.id) === String(id); });
    writeLocalAddresses(userId, next);
    return { addresses: mergeAddresses([], next), id, online: false };
  }
}
