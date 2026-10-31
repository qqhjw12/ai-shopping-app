// 商家工作台服务层：校验 + 经营规则。
//
// 规则集中在这里，页面与仓储都不自己判断，避免「页面拦一次、接口不拦」的老问题——
// 演示站可以直接改前端，真正拦得住人的只有服务端。
//
// 三条必须守住的：
//   1) 凭证不对 / 申请没通过 → 一律 404/403，不泄露「这个编号存在但被驳回了」；
//   2) 审核中的商品不能上下架、不能出现在商城（review_status 是单向门）；
//   3) 发货只对「已付款待发货」的订单开放，且只能发自己的货（按 merchant_id 校验）。
import { createHash } from 'node:crypto';
import { CATEGORIES } from '../data/catalog.js';
import { config } from '../config.js';
import { isObjectKey } from '../storage/index.js';
import * as merchantRepo from '../repositories/merchantRepo.js';
import * as shopRepo from '../repositories/merchantShopRepo.js';
import * as productRepo from '../repositories/productRepo.js';
import * as searchStore from '../searchStore.js';

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

export const CARRIERS = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '邮政 EMS'];
/** 运单号：各家规则不同，只做形状校验（6–32 位字母数字，允许连字符） */
const TRACKING_RE = /^[A-Z0-9-]{6,32}$/;
export const MAX_STOCK = 99999;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * 凭「编号 + 查询凭证」取一份**已通过**的申请。
 *
 * 没通过就当 404：工作台是给已开业的店用的，未通过的申请在这里不该有任何入口。
 * 与状态页不同——状态页要让人看得见「审核中」，这里要让人进不去。
 */
export function requireApprovedMerchant(id, queryKey) {
  const key = String(queryKey || '').trim();
  if (!key) throw Object.assign(new Error('缺少查询凭证'), { status: 404 });
  const app = merchantRepo.findForMerchant(String(id || ''), sha256(key));
  if (!app) throw Object.assign(new Error('店铺不存在，或查询凭证已失效'), { status: 404 });
  if (app.status !== 'approved') {
    throw Object.assign(new Error('入驻申请还没通过审核，工作台尚未开放'), { status: 403 });
  }
  return app;
}

/* ---------------- 店铺资料 ---------------- */

export function getShop(app) {
  return shopRepo.ensureShop(app);
}

export function updateShop(app, patch = {}) {
  const name = String(patch.name == null ? '' : patch.name).trim();
  if (name && name.length < 2) throw bad('店铺名至少 2 个字');
  if (patch.logoKey && !isObjectKey(patch.logoKey)) throw bad('Logo 引用不合法');
  if (patch.logoKey && !String(patch.logoKey).startsWith('shops/')) throw bad('Logo 引用不合法');
  return shopRepo.updateShop(app.id, patch);
}

/* ---------------- 商品 ---------------- */

function normalizeImageKey(key) {
  const v = String(key || '').trim();
  if (!v) return '';
  if (!isObjectKey(v) || !v.startsWith('products/')) throw bad('商品图引用不合法，请重新上传');
  return v;
}

/**
 * 新增商品。
 *
 * 状态固定 pending，且**不允许**调用方传 status / review_status ——
 * 开放这两个字段等于让商家自己给自己发上架许可，审核台就变成了装饰。
 */
export function createProduct(app, input = {}) {
  const name = String(input.name || '').trim().slice(0, 40);
  if (name.length < 2) throw bad('商品名至少 2 个字');

  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) throw bad('请填写大于 0 的价格');
  if (price > 999999) throw bad('价格超出平台上限');
  if (!Number.isInteger(price)) throw bad('价格按整数元填写');

  const stock = Number(input.stock == null ? 0 : input.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > MAX_STOCK) throw bad(`库存要填 0–${MAX_STOCK} 之间的整数`);

  const warnAt = Number(input.warnAt == null ? 10 : input.warnAt);
  if (!Number.isInteger(warnAt) || warnAt < 1 || warnAt > 999) throw bad('预警阈值要填 1–999 之间的整数');

  const categoryId = String(input.categoryId || '').trim();
  if (!CATEGORY_IDS.has(categoryId)) throw bad('类目不在可选范围内');

  const imageKey = normalizeImageKey(input.imageKey);

  const product = shopRepo.createProduct(app.id, {
    name, price, stock, warnAt, categoryId, imageKey,
    brand: String(app.brand || '').slice(0, 40),
    description: String(input.description || '').slice(0, 200),
  });
  return withCounts(app.id, product);
}

/** 上下架：审核结论是前置条件。审核中 / 被驳回的商品不进入这个动作 */
export function setProductStatus(app, productId, status) {
  if (!['on_sale', 'off_sale'].includes(status)) throw bad('状态不合法');
  const p = shopRepo.findProductFor(app.id, productId);
  if (!p) throw Object.assign(new Error('商品不存在'), { status: 404 });
  if (p.reviewStatus !== 'approved') {
    throw Object.assign(
      new Error(p.reviewStatus === 'pending' ? '审核中的商品不能上下架' : '未通过审核的商品不能上架'),
      { status: 409 },
    );
  }
  shopRepo.setProductStatus(productId, status);
  return withCounts(app.id, shopRepo.findProduct(productId));
}

export function updateStock(app, productId, stock) {
  const p = shopRepo.findProductFor(app.id, productId);
  if (!p) throw Object.assign(new Error('商品不存在'), { status: 404 });
  const n = Number(stock);
  if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK) throw bad(`库存要填 0–${MAX_STOCK} 之间的整数`);
  shopRepo.updateStock(productId, n);
  return withCounts(app.id, shopRepo.findProduct(productId));
}

function withCounts(applicationId, product) {
  return { product, counts: shopRepo.countProducts(applicationId) };
}

export function listProducts(app) {
  const items = shopRepo.listProducts(app.id);
  return { items, counts: shopRepo.countProducts(app.id) };
}

/* ---------------- 订单 ---------------- */

export function listOrders(app, query = {}) {
  const status = ['pending', 'shipped', 'done'].includes(query.status) ? query.status : '';
  const { items, counts } = shopRepo.listOrders(app.id, { status });
  return { items, counts };
}

/** 发货：只能发自己那份货，且订单必须处于「已付款待发货」 */
export function shipOrder(app, orderId, { carrier, trackingNo } = {}) {
  const order = shopRepo.findOrderForMerchant(orderId, app.id);
  if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
  if (order.status !== 'pending') {
    throw Object.assign(
      new Error(order.status === 'shipped' ? '这单已经发过货了' : '当前订单状态不支持发货'),
      { status: 409 },
    );
  }
  const c = String(carrier || '').trim();
  if (!CARRIERS.includes(c)) throw bad('请选择快递公司');
  const t = String(trackingNo || '').trim().toUpperCase();
  if (!TRACKING_RE.test(t)) throw bad('运单号为 6–32 位字母或数字');

  const shipped = shopRepo.markShipped(orderId, { carrier: c, trackingNo: t, applicationId: app.id });
  return { order: shipped, counts: shopRepo.listOrders(app.id).counts };
}

/* ---------------- 运营侧：商品审核 ---------------- */

export const REVIEW_ACTIONS = ['approve', 'reject'];
const MAX_REVIEW_NOTE = 200;

export function listForReview(query = {}) {
  const reviewStatus = ['pending', 'approved', 'rejected'].includes(query.reviewStatus) ? query.reviewStatus : '';
  return shopRepo.listProductsForReview({
    reviewStatus,
    page: Number(query.page) || 1,
    size: Number(query.size) || 20,
  });
}

/**
 * 审核一件商品。
 *
 * 通过后立即写检索索引：商城的搜索走的是内存/ES 索引，不写这一下，
 * 商家商品会出现「列表里有、搜索搜不到」的诡异状态，而运营会以为没通过。
 */
export async function reviewProduct(productId, { action, note } = {}, { by = 'admin' } = {}) {
  if (!REVIEW_ACTIONS.includes(action)) throw bad('审核动作只能是 approve / reject');
  const text = String(note || '').trim();
  if (text.length > MAX_REVIEW_NOTE) throw bad(`审核意见不能超过 ${MAX_REVIEW_NOTE} 字`);
  if (action === 'reject' && !text) throw bad('驳回必须填写理由');

  const product = shopRepo.reviewProduct(productId, {
    reviewStatus: action === 'approve' ? 'approved' : 'rejected',
    note: text,
    by: String(by || 'admin').slice(0, 40),
  });

  if (action === 'approve') {
    try {
      const full = productRepo.getProductById(productId);
      if (full) await searchStore.index([full]);
    } catch (e) {
      // 索引失败不该把审核结论回滚：库里已经是 approved，只是暂时搜不到。
      // 记日志即可，下一次重建索引会自动补上（不静默失败，但也不误伤已生效的审核）。
      console.warn(`[merchantShop] 审核通过但索引失败 id=${productId}: ${e.message}`);
    }
  }
  return { product, events: shopRepo.listProductEvents(productId) };
}

export function productEvents(productId) {
  return shopRepo.listProductEvents(productId);
}

export const mediaConfig = () => ({
  maxBytes: config.upload.maxBytes,
  namespaces: ['products', 'shops'],
});
