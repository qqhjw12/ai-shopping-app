// 工作台数据适配层：同一套页面，两种数据源。
//
//   server —— 真网关在跑：读的是平台商品表与真实交易库（products / orders / merchant_shops）
//   local  —— 没有网关（或这条记录本来就是本机演示记录）：读 store/merchantShopStore.js
//
// 为什么要这层而不是让页面自己判断：页面里每个 `if (apiMode)` 都会在下一轮变成两处漏改。
// 适配器对外只有一组方法（load / createProduct / setProductStatus / …），
// 页面按同一套契约调用，切数据源不动页面。
//
// 一条硬规矩：**数据源必须如实标注**。server 模式写「平台库」，local 模式写「本机演示」，
// 不许在 local 模式下说「已上架到商城」——那是骗人，也是演示站最容易被当成 bug 的地方。
import { api, isMissingEndpoint, mediaUrl } from './api.js';
import * as shopStore from './store/merchantShopStore.js';

/** 网关不可达 / 这条路由不存在 → 值得退回本地演示；其余（400/403/409）必须原样抛给页面 */
export function isOffline(e) {
  if (!e) return true;
  if (isMissingEndpoint(e)) return true;
  if (e.status == null) return true; // fetch 直接失败（断网、CORS、网关没起）
  return e.status >= 500;
}

/**
 * 把服务端商品折成页面认的形状。
 *
 * 服务端有两个正交的状态：review_status（能不能卖）与 status（商家开没开）。
 * 页面只需要一个「现在是什么情况」的标签，所以在这里合并：
 * 未过审的一律显示审核态，过了审的才看 on_sale / off_sale。
 */
export function normalizeProduct(p) {
  let status = 'off';
  if (p.reviewStatus === 'pending') status = 'reviewing';
  else if (p.reviewStatus === 'rejected') status = 'rejected';
  else if (p.status === 'on_sale') status = 'on';
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    price: p.price,
    stock: Number(p.stock) || 0,
    warnAt: Number(p.warnAt) || 10,
    status,
    reviewStatus: p.reviewStatus,
    reviewNote: p.reviewNote || '',
    imageKey: p.imageKey || '',
    imageUrl: p.imageUrl ? mediaUrl(p.imageUrl) : '',
    createdAt: p.createdAt,
  };
}

/** 服务端订单（交易库口径）→ 工作台口径 */
export function normalizeOrder(o) {
  return {
    id: o.id,
    productName: o.title || (o.items && o.items[0] ? o.items[0].name : '—'),
    items: o.items || [],
    qty: o.qty,
    amount: o.amount,
    status: o.status, // pending / shipped / done
    buyer: '—', // 交易库里买家信息属于买家隐私，商家侧只给发货必需的信息
    region: '',
    createdAt: o.createdAt,
    shippedAt: o.shippedAt,
    carrier: o.carrier,
    trackingNo: o.trackingNo,
    finishedAt: o.completedAt || null,
  };
}

function normalizeStats(s) {
  return {
    onSale: s.onSale,
    total: s.total,
    pendingReview: s.pendingReview || 0,
    todayOrderCount: s.todayOrderCount,
    todayAmount: s.todayAmount,
    pendingCount: s.pendingCount,
    lowStockCount: s.lowStockCount,
    lowStock: (s.lowStock || []).map(normalizeProduct),
  };
}

/* ============================================================
   local：没有网关时的演示数据源
   ============================================================ */

export function localAdapter(app) {
  shopStore.ensureShop(app);
  const reload = () => {
    const s = shopStore.getShop(app.id) || shopStore.ensureShop(app);
    return {
      shop: { ...s.shop, logoKey: '' },
      products: s.products,
      orders: s.orders,
      stats: { ...shopStore.statsOf(s), total: s.products.length, pendingReview: s.products.filter((p) => p.status === 'reviewing').length },
      source: 'local',
    };
  };
  return {
    source: 'local',
    load: async () => reload(),
    async createProduct(input) {
      shopStore.createProduct(app.id, input);
      return reload();
    },
    async setProductStatus(productId, next) {
      shopStore.setProductStatus(app.id, productId, next);
      return reload();
    },
    async updateStock(productId, stock) {
      shopStore.updateStock(app.id, productId, stock);
      return reload();
    },
    async shipOrder(orderId, payload) {
      shopStore.shipOrder(app.id, orderId, payload);
      return reload();
    },
    async finishOrder(orderId) {
      shopStore.finishOrder(app.id, orderId);
      return reload();
    },
    async updateShop(patch) {
      shopStore.updateShop(app.id, patch);
      return reload();
    },
    async uploadImage() {
      throw Object.assign(new Error('本机演示模式不上传图片：连接网关后才会传到对象存储'), { code: 'offline' });
    },
  };
}

/* ============================================================
   server：真网关
   ============================================================ */

export function serverAdapter(app, { id, key }) {
  const qs = `id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
  const reload = async () => {
    const d = await api(`/api/merchant/workspace?${qs}`, { retries: 0 });
    return {
      shop: { ...d.shop, logoUrl: d.shop.logoKey ? mediaUrl(`/api/uploads/${String(d.shop.logoKey).split('/').pop()}`) : '' },
      products: (d.products || []).map(normalizeProduct),
      orders: (d.orders || []).map(normalizeOrder),
      stats: normalizeStats(d.stats || {}),
      counts: { products: d.productCounts, orders: d.orderCounts },
      application: d.application,
      source: 'server',
    };
  };
  return {
    source: 'server',
    load: reload,
    async createProduct(input) {
      await api(`/api/merchant/products?${qs}`, { method: 'POST', body: input, retries: 0 });
      return reload();
    },
    async setProductStatus(productId, next) {
      await api(`/api/merchant/products/${encodeURIComponent(productId)}?${qs}`, {
        method: 'PATCH', body: { action: next === 'on' ? 'on' : 'off' }, retries: 0,
      });
      return reload();
    },
    async updateStock(productId, stock) {
      await api(`/api/merchant/products/${encodeURIComponent(productId)}?${qs}`, {
        method: 'PATCH', body: { action: 'stock', stock }, retries: 0,
      });
      return reload();
    },
    async shipOrder(orderId, payload) {
      await api(`/api/merchant/orders/${encodeURIComponent(orderId)}?${qs}`, {
        method: 'PATCH', body: payload, retries: 0,
      });
      return reload();
    },
    /** 真链路的「已完成」由买家确认收货触发，商家侧不提供这个动作 */
    async finishOrder() {
      throw Object.assign(new Error('订单完成由买家确认收货触发，商家侧不能直接标记'), { code: 'forbidden' });
    },
    async updateShop(patch) {
      await api(`/api/merchant/shop?${qs}`, { method: 'PUT', body: patch, retries: 0 });
      return reload();
    },
    /**
     * 上传商品图 / Logo，返回对象键（不是 URL）。
     * URL 是现签的、会过期的，存进库里的必须是键。
     */
    async uploadImage(dataUrl, kind = 'product') {
      const d = await api(`/api/merchant/media?kind=${encodeURIComponent(kind)}&${qs}`, {
        method: 'POST',
        body: { data: dataUrl },
        retries: 0, // 大 body 不重试：重试一次就是再传一遍几百 KB
      });
      return { key: d.key, url: mediaUrl(d.url || '') };
    },
  };
}

/**
 * 选数据源。
 *
 * 本机记录（ML 前缀）永远走 local —— 它压根不在平台库里，去问网关只会得到 404。
 * 真记录先试网关：连不上（网关没起 / 静态演示站）就退回 local，
 * 由页面顶部如实标注「本机演示数据」。
 */
export async function createAdapter(app, { id, key, isLocalId }) {
  if (isLocalId) return localAdapter(app);
  const server = serverAdapter(app, { id, key });
  try {
    const data = await server.load();
    return { ...server, initial: data };
  } catch (e) {
    if (isOffline(e)) return localAdapter(app);
    throw e; // 403/404：审核没过或凭证失效，交给页面显示门禁
  }
}
