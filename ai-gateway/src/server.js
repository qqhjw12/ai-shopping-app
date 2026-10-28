import './quiet.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { config, useReal, startupWarnings } from './config.js';
import { log, randomUUID } from './logger.js';
import {
  attachContext,
  applyCors,
  checkRateLimit,
  checkAuth,
  authenticate,
  parseCookies,
} from './middleware.js';
import { createFixedWindow, createConcurrencyGate } from './ratelimit.js';
import * as vectorStore from './vectorStore.js';
import * as searchStore from './searchStore.js';
import { seed, hybridSearch, listAllProducts } from './search.js';
import { generateCopywriting } from './copywrite.js';
import { handleAfterSale } from './aftersale.js';
import { trackEvent, getTrackStats, ensureTrackIndex } from './trackStore.js';
import { ensureSeeded } from './db/seedDb.js';
import { getDb } from './db/connection.js';
import * as chatEngine from './services/chatEngine.js';
import * as productRepo from './repositories/productRepo.js';
import * as cartRepo from './repositories/cartRepo.js';
import * as userRepo from './repositories/userRepo.js';
import * as orderService from './services/orderService.js';
import * as reviewRepo from './repositories/reviewRepo.js';
import * as storage from './storage/index.js';
import * as authService from './auth/service.js';
import { getSecret, isEphemeralSecret } from './auth/keys.js';

/** 卡片/列表用商品视图（统一字段，避免各处各写一份 mapper 导致缺字段） */
function toSummary(p) {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    originalPrice: p.originalPrice ?? null,
    pic: p.pic || '',
    coverColor: p.coverColor || '',
    highlight: p.highlight || '',
    highlights: p.highlights || [],
    brand: p.brand || '',
    category: p.category || '',
    categoryId: p.categoryId || '',
    subCategory: p.subCategory || '',
    subCategoryId: p.subCategoryId || '',
    description: p.description || '',
    tags: p.tags || [],
    rating: p.rating ?? 4.8,
    reviewsCount: p.reviewsCount ?? 0,
    sales: p.sales ?? 0,
    stock: p.totalStock ?? null,
  };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return null;
  }
}

/** 读取原始 body（带字节上限），超过返回 null —— 防止超大上传打爆内存 */
async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res, status, message, reqId) {
  send(res, status, { error: message, reqId });
}

// ===== 买家秀上传 =====
const UPLOAD_DIR = resolve(process.cwd(), 'data/uploads');
const UPLOAD_LIMIT = config.upload.maxBytes; // 单张原始上限（默认 6MB，可由 UPLOAD_MAX_BYTES 覆盖）
// 文件名白名单：UUID/字母数字 + 白名单扩展名，禁止斜杠与点点 → 路径穿越无从谈起
const UPLOAD_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp|gif)$/;
const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 按文件头判断真实类型（不信任客户端传来的扩展名，避免「图片马」入库） */
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return '.png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return '.gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

// ===== 上传限流（进程内；多实例请上移到网关/Redis）=====
// IP 窗口放宽到用户窗口的 3 倍：同一 NAT 后的多用户共用出口 IP，避免误伤。
const uploadIpWindow = createFixedWindow({ limit: config.upload.ratePerMin * 3, windowMs: 60_000 });
const uploadUserWindow = createFixedWindow({ limit: config.upload.ratePerMin, windowMs: 60_000 });
const uploadDailyQuota = createFixedWindow({ limit: config.upload.dailyQuota, windowMs: 24 * 3600 * 1000 });
const uploadGate = createConcurrencyGate({ max: config.upload.maxConcurrent });

// ===== 认证 Cookie（刷新令牌只走 HttpOnly Cookie，JS 读不到，也不进 localStorage）=====
function refreshCookie(value, { maxAgeSec = 0, clear = false } = {}) {
  const parts = [
    `${config.auth.cookieName}=${clear ? '' : encodeURIComponent(value)}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (config.auth.cookieSecure) parts.push('Secure');
  parts.push(`Max-Age=${clear ? 0 : Math.max(0, maxAgeSec)}`);
  return parts.join('; ');
}

/** 统一取用户身份：有效令牌优先，其次显式参数，最后匿名 */
function userIdOf(req, explicit) {
  return req.authUserId || explicit || 'anonymous';
}

// 强制鉴权（AUTH_REQUIRED=true）时仍放行的路径：登录与刷新本身
const AUTH_PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/refresh']);
const isAuthPublicPath = (p) => AUTH_PUBLIC_PATHS.has(p);

// ===== SSE（流式）辅助 =====
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 通知 nginx 不要缓冲（流式透传）
  });
}
function sseWrite(res, obj) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function sseDone(res) {
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 探测外部依赖（docker 模式用于 /ready）
function probeDeps() {
  const deps = {
    vectorStore: vectorStore.count() > 0,
    searchStore: searchStore.count() > 0,
  };
  if (useReal()) {
    // 真实模式下，至少要求 Dify 关键 App Key 已配置（否则仍走降级，但标注未就绪）
    deps.difyConfigured = !!(
      config.dify.customerServiceApiKey && config.dify.productQaApiKey
    );
    deps.qdrant = true; // 连接由适配器内部保证，启动期已校验
    deps.elasticsearch = true;
  } else {
    deps.difyConfigured = config.runMode === 'local'; // local 用内置兜底
  }
  deps.ready = Object.values(deps).every(Boolean);
  return deps;
}

// 业务路由（不含中间件/探针）
async function route(req, res, url) {
  // ===== 认证：登录 / 刷新 / 登出 / 当前用户 =====
  // 访问令牌短时效走内存；刷新令牌由服务端存哈希 + HttpOnly Cookie 下发（不进 localStorage）。
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const parsed = (await readJson(req)) || {};
    // 演示项目无密码：userId 即身份；缺省则签发一个匿名稳定 ID
    const uid = String(parsed.userId || `u_${randomUUID().slice(0, 8)}`);
    try {
      const t = authService.login({
        userId: uid,
        nickname: parsed.nickname,
        ua: req.headers['user-agent'] || '',
        ip: req.ip,
      });
      res.setHeader('Set-Cookie', refreshCookie(t.refreshToken, { maxAgeSec: t.refreshExpiresIn }));
      const user = userRepo.getUser(t.userId);
      log.info('auth.login', { reqId: req.reqId, userId: t.userId });
      return send(res, 200, {
        accessToken: t.accessToken,
        tokenType: 'Bearer',
        expiresIn: t.accessExpiresIn,
        refreshExpiresIn: t.refreshExpiresIn,
        user,
      });
    } catch (e) {
      log.error('auth.login_failed', { reqId: req.reqId, err: e.message });
      return sendError(res, 500, '登录失败，请稍后重试', req.reqId);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
    const cookies = parseCookies(req);
    let rt = cookies[config.auth.cookieName];
    if (!rt) {
      const parsed = (await readJson(req)) || {};
      rt = parsed.refreshToken; // 兼容非浏览器客户端把刷新令牌放 body
    }
    try {
      const t = authService.rotate(rt, { ua: req.headers['user-agent'] || '', ip: req.ip });
      res.setHeader('Set-Cookie', refreshCookie(t.refreshToken, { maxAgeSec: t.refreshExpiresIn }));
      log.info('auth.refresh', { reqId: req.reqId, userId: t.userId });
      return send(res, 200, {
        accessToken: t.accessToken,
        tokenType: 'Bearer',
        expiresIn: t.accessExpiresIn,
        refreshExpiresIn: t.refreshExpiresIn,
      });
    } catch (e) {
      // 刷新失败一律清 Cookie，让客户端回到登录态
      res.setHeader('Set-Cookie', refreshCookie('', { clear: true }));
      log.warn('auth.refresh_failed', { reqId: req.reqId, code: e.code, err: e.message });
      return sendError(res, e.status || 401, e.message, req.reqId);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const cookies = parseCookies(req);
    authService.logout(cookies[config.auth.cookieName]);
    res.setHeader('Set-Cookie', refreshCookie('', { clear: true }));
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!req.authUserId) return sendError(res, 401, '未登录或令牌已过期', req.reqId);
    const user = userRepo.getUser(req.authUserId);
    if (!user) return sendError(res, 404, '用户不存在', req.reqId);
    return send(res, 200, { user });
  }

  if (req.method === 'POST' && url.pathname === '/api/seed') {
    const dbInfo = ensureSeeded();
    const n = await seed();
    return send(res, 200, { seeded: n, db: dbInfo });
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.query || '';
    const topK = Number(parsed.topK || 5);
    if (!query) return sendError(res, 400, 'query required', req.reqId);
    const results = await hybridSearch(query, topK);
    return send(res, 200, { query, count: results.length, results });
  }

  // 商品列表：支持 category / sub / brand / minPrice / maxPrice / sort / limit / offset
  if (req.method === 'GET' && url.pathname === '/api/products') {
    const q = url.searchParams;
    const num = (k) => (q.get(k) === null ? undefined : Number(q.get(k)));
    const filter = {
      categoryId: q.get('category') || q.get('cat') || undefined,
      subCategoryId: q.get('sub') || undefined,
      brand: q.get('brand') || undefined,
      minPrice: num('minPrice'),
      maxPrice: num('maxPrice'),
      sort: q.get('sort') || 'default',
      limit: Number(q.get('limit')) || 0,
      offset: Number(q.get('offset')) || 0,
    };
    const total = productRepo.countProductsFiltered(filter);
    const products = productRepo.listProducts(filter).map(toSummary);
    return send(res, 200, {
      count: products.length,
      total,
      limit: filter.limit,
      offset: filter.offset,
      filter,
      products,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/categories') {
    // tree=1 返回两级树（含二级商品数），否则返回扁平一级列表（兼容旧调用）
    if (url.searchParams.get('tree') === '1') {
      return send(res, 200, {
        categories: productRepo.categoryTree(),
        total: productRepo.countProducts(),
      });
    }
    return send(res, 200, { categories: productRepo.listCategories() });
  }

  if (req.method === 'GET' && url.pathname === '/api/brands') {
    return send(res, 200, { brands: productRepo.listBrands({ categoryId: url.searchParams.get('category') || undefined }) });
  }

  // 站点概览：商品 / SKU / 类目 / 品牌 / 评价规模（首页头部展示）
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return send(res, 200, { stats: productRepo.stats() });
  }

  // 统一错误出口：业务异常自带 status（如库存不足 409），其余按 400 处理
  // 定义在商品详情之前，是因为评价列表路由要抢在 /api/products/:id 的 startsWith 匹配之前注册
  const guarded = (fn, status = 200) => {
    try {
      const data = fn();
      if (data === null || data === undefined) return sendError(res, 404, 'not found', req.reqId);
      return send(res, status, data);
    } catch (e) {
      return sendError(res, e.status || 400, e.message, req.reqId);
    }
  };

  // 评价列表：主评价 + 嵌套追评 + 概览（分布/好评率），支持筛选、排序与分页
  // 必须放在 /api/products/:id 之前注册（后者是 startsWith 前缀匹配）
  const reviewListMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/reviews$/);
  if (reviewListMatch && req.method === 'GET') {
    const productId = decodeURIComponent(reviewListMatch[1]);
    if (!productRepo.getProductById(productId)) return sendError(res, 404, 'product not found', req.reqId);
    const q = url.searchParams;
    return guarded(() => reviewRepo.listReviews(productId, {
      userId: q.get('userId') || 'anonymous',
      filter: q.get('filter') || 'all',
      sort: q.get('sort') || 'latest',
      limit: Number(q.get('limit')) || 20,
      offset: Number(q.get('offset')) || 0,
    }));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/products/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/products/'.length));
    const p = productRepo.getProductDetail(id);
    if (!p) return sendError(res, 404, 'product not found', req.reqId);
    return send(res, 200, {
      product: {
        ...toSummary(p),
        skus: p.skus || [],
        reviews: p.reviews || [],
        priceRange: p.priceRange || null,
      },
      related: productRepo.similarProducts(id, 4).map(toSummary),
    });
  }

  // ===== 交易链路：购物车 / 订单 / 收藏 / 优惠券 =====
  if (url.pathname === '/api/cart') {
    if (req.method === 'GET') {
      const userId = userIdOf(req, url.searchParams.get('userId'));
      return guarded(() => cartRepo.listCart(userId));
    }
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      if (!parsed.productId) return sendError(res, 400, 'productId required', req.reqId);
      return guarded(() => ({
        ...cartRepo.addToCart({
          userId: userIdOf(req, parsed.userId),
          productId: parsed.productId,
          skuId: parsed.skuId || null,
          qty: Number(parsed.qty || 1),
        }),
        ...cartRepo.listCart(userIdOf(req, parsed.userId)),
      }), 201);
    }
    if (req.method === 'PATCH') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      if (!parsed.itemId) return sendError(res, 400, 'itemId required', req.reqId);
      const userId = userIdOf(req, parsed.userId);
      return guarded(() => {
        cartRepo.updateQty(userId, parsed.itemId, Number(parsed.qty));
        return cartRepo.listCart(userId);
      });
    }
    if (req.method === 'DELETE') {
      // 带 itemId 删单项，否则清空
      const userId = userIdOf(req, url.searchParams.get('userId'));
      const itemId = url.searchParams.get('itemId');
      return guarded(() => {
        if (itemId) cartRepo.removeItem(userId, Number(itemId));
        else cartRepo.clearCart(userId);
        return cartRepo.listCart(userId);
      });
    }
  }

  if (url.pathname === '/api/orders') {
    if (req.method === 'GET') {
      const userId = userIdOf(req, url.searchParams.get('userId'));
      return guarded(() => ({ orders: orderService.listOrders(userId) }));
    }
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      return guarded(() => {
        const order = orderService.createOrder({
          userId: userIdOf(req, parsed.userId),
          items: parsed.items,
          addressId: parsed.addressId || null,
          couponId: parsed.couponId || null,
          remark: parsed.remark || '',
        });
        return { order: { ...order, _preview: undefined } };
      }, 201);
    }
  }

  if (url.pathname === '/api/orders/preview' && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    return guarded(() => orderService.previewOrder({
      userId: userIdOf(req, parsed.userId),
      items: parsed.items,
      addressId: parsed.addressId || null,
      couponId: parsed.couponId || null,
    }));
  }

  const payMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    return guarded(() => ({ order: orderService.payOrder(decodeURIComponent(payMatch[1]), userId) }));
  }

  if (url.pathname.startsWith('/api/orders/') && req.method === 'GET') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    const orderId = decodeURIComponent(url.pathname.slice('/api/orders/'.length));
    return guarded(() => {
      const order = orderService.getOrder(orderId, userId);
      if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
      return { order };
    });
  }

  if (url.pathname === '/api/favorites') {
    if (req.method === 'GET') {
      const userId = userIdOf(req, url.searchParams.get('userId'));
      return guarded(() => ({ favorites: userRepo.listFavorites(userId), ids: userRepo.favoriteIds(userId) }));
    }
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      if (!parsed.productId) return sendError(res, 400, 'productId required', req.reqId);
      const userId = userIdOf(req, parsed.userId);
      return guarded(() => ({ favorited: userRepo.toggleFavorite(userId, parsed.productId), ids: userRepo.favoriteIds(userId) }));
    }
    if (req.method === 'DELETE') {
      const userId = userIdOf(req, url.searchParams.get('userId'));
      const productId = url.searchParams.get('productId');
      return guarded(() => {
        if (productId) userRepo.removeFavorite(userId, productId);
        return { ids: userRepo.favoriteIds(userId) };
      });
    }
  }

  // 券目录：券中心渲染用。前端内置同一份做离线兜底，联网时以这里为准。
  if (url.pathname === '/api/coupons/catalog' && req.method === 'GET') {
    return guarded(() => ({ coupons: userRepo.listCouponCatalog() }));
  }

  if (url.pathname === '/api/coupons') {
    if (req.method === 'GET') {
      const userId = userIdOf(req, url.searchParams.get('userId'));
      const amount = Number(url.searchParams.get('amount') || 0);
      // all=1：券包三 Tab 与跨设备同步都要拿到已用/已过期的券，
      // 只返回未使用的话，另一台设备永远看不到「这张券已经被用掉了」。
      const all = ['1', 'true', 'yes'].includes(String(url.searchParams.get('all') || '').toLowerCase());
      return guarded(() => ({ coupons: userRepo.listCoupons(userId, amount, { all }) }));
    }
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      if (!parsed.couponId) return sendError(res, 400, 'couponId required', req.reqId);
      const userId = userIdOf(req, parsed.userId);
      return guarded(() => ({
        coupon: userRepo.takeCoupon(userId, parsed.couponId),
        coupons: userRepo.listCoupons(userId, 0, { all: true }),
      }), 201);
    }
  }

  // 核销：下单成功后由客户端回调（演示站订单落本地，服务端拿不到订单事务）
  if (url.pathname === '/api/coupons/use' && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    if (!parsed.couponId) return sendError(res, 400, 'couponId required', req.reqId);
    const userId = userIdOf(req, parsed.userId);
    return guarded(() => ({
      ...userRepo.useCoupon(userId, parsed.couponId, parsed.orderId),
      coupons: userRepo.listCoupons(userId, 0, { all: true }),
    }));
  }

  // 取消订单返还：退回未使用 + 有效期顺延（规则在 services/couponRules.js）
  if (url.pathname === '/api/coupons/refund' && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    if (!parsed.orderId) return sendError(res, 400, 'orderId required', req.reqId);
    const userId = userIdOf(req, parsed.userId);
    return guarded(() => ({
      ...userRepo.refundCouponByOrder(userId, parsed.orderId),
      coupons: userRepo.listCoupons(userId, 0, { all: true }),
    }));
  }

  // ===== 评价静态资源 / 发布 / 追评 / 有用投票 / 买家秀上传 =====
  // 买家秀读取：文件名受白名单约束，且二次确认解析后路径仍在上传目录内（纵深防御）
  if (req.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/uploads/'.length));
    if (!UPLOAD_NAME_RE.test(name)) return sendError(res, 400, 'invalid file name', req.reqId);
    const file = resolve(join(UPLOAD_DIR, name));
    if (!file.startsWith(UPLOAD_DIR + sep) || !existsSync(file)) return sendError(res, 404, 'file not found', req.reqId);
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': IMAGE_MIME[extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      // 文件名含 UUID 且内容不可变，可安全长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(buf);
  }

  // POST /api/reviews：带 parentId 即追评，否则为新评价（校验规则集中在 reviewRepo.REVIEW_RULES）
  if (url.pathname === '/api/reviews' && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    if (!parsed.parentId && !parsed.productId) return sendError(res, 400, 'productId required', req.reqId);
    const userId = userIdOf(req, parsed.userId);
    return guarded(() => (parsed.parentId
      ? reviewRepo.createFollowUp({
        reviewId: parsed.parentId, userId, author: parsed.author, content: parsed.content, images: parsed.images,
      })
      : reviewRepo.createReview({
        productId: parsed.productId, userId, author: parsed.author,
        rating: parsed.rating, content: parsed.content, skuSpec: parsed.skuSpec, images: parsed.images,
      })), 201);
  }

  // DELETE /api/reviews/:id：删除本人发布的评价（级联删追评/投票），并回收图片对象
  const delMatch = url.pathname.match(/^\/api\/reviews\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    return guarded(() => {
      const { keys, followUpsDeleted } = reviewRepo.deleteReview(Number(delMatch[1]), userId);
      // 图片对象 best-effort 回收：删不掉（如过期键/旧外链）也不阻断删除本身
      const imagesRemoved = reviewRepo.purgeImages(keys);
      return { deleted: true, followUpsDeleted, imagesRemoved };
    });
  }

  const helpfulMatch = url.pathname.match(/^\/api\/reviews\/(\d+)\/helpful$/);
  if (helpfulMatch && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    // 幂等：同一用户重复请求会在「有/无」之间切换，返回切换后的状态
    return guarded(() => reviewRepo.toggleHelpful(Number(helpfulMatch[1]), userIdOf(req, parsed.userId)));
  }

  // 买家秀上传：前端 canvas 压缩后以 base64 提交（免去手写 multipart 解析）
  // 加固四道闸：content-length 预检 → 每 IP 频率 → 全局并发 → 每用户频率 + 每日配额。
  // 校验：字节上限 → 文件头嗅探 → 扩展名白名单；文件名由服务端 UUID 生成。
  if (url.pathname === '/api/reviews/upload' && req.method === 'POST') {
    // 1) 声明长度预检：base64 比原始大 ~1.33，留 40% 余量，超了直接拒，不读 body
    const declared = Number(req.headers['content-length'] || 0);
    const maxBody = Math.ceil(UPLOAD_LIMIT * 1.4);
    if (declared && declared > maxBody) {
      return sendError(res, 413, `image too large (max ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB)`, req.reqId);
    }

    // 2) 每 IP 频率（读 body 前先挡，成本最低）
    const ipGate = uploadIpWindow.hit(req.ip);
    if (!ipGate.allowed) {
      res.setHeader('Retry-After', String(ipGate.retryAfterSec));
      log.warn('upload.rate_limited', { reqId: req.reqId, scope: 'ip', ip: req.ip });
      return sendError(res, 429, '上传过于频繁，请稍后再试', req.reqId);
    }

    // 3) 全局并发闸门：限制同时在读大 body 的请求数，防内存打爆
    const release = uploadGate.acquire();
    if (!release) {
      res.setHeader('Retry-After', '2');
      log.warn('upload.busy', { reqId: req.reqId, active: uploadGate.active() });
      return sendError(res, 503, '上传繁忙，请稍后再试', req.reqId);
    }

    try {
      const raw = await readRawBody(req, UPLOAD_LIMIT);
      if (raw === null) {
        return sendError(res, 413, `image too large (max ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB)`, req.reqId);
      }
      let parsed = null;
      try {
        parsed = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return sendError(res, 400, 'invalid json', req.reqId);
      }
      const dataUrl = String(parsed.data || '');
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      if (!base64) return sendError(res, 400, 'image data required', req.reqId);
      let buf;
      try {
        buf = Buffer.from(base64, 'base64');
      } catch {
        return sendError(res, 400, 'invalid image encoding', req.reqId);
      }
      // 拒绝浏览器被绕过时传来的空壳（base64 非法字符会让还原长度远小于预期）
      if (!buf.length) return sendError(res, 400, 'invalid image data', req.reqId);
      if (buf.length > UPLOAD_LIMIT) {
        return sendError(res, 413, `image too large (max ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB)`, req.reqId);
      }
      const ext = sniffImage(buf);
      if (!ext) return sendError(res, 415, '仅支持 JPG / PNG / WebP / GIF 图片', req.reqId);

      // 4) 每用户频率 + 每日配额（令牌身份优先，其次 body.userId，最后回退到 IP）
      const uploader = userIdOf(req, parsed.userId || `ip:${req.ip}`);
      const uGate = uploadUserWindow.hit(uploader);
      if (!uGate.allowed) {
        res.setHeader('Retry-After', String(uGate.retryAfterSec));
        log.warn('upload.rate_limited', { reqId: req.reqId, scope: 'user', uploader });
        return sendError(res, 429, '上传过于频繁，请稍后再试', req.reqId);
      }
      const quota = uploadDailyQuota.hit(uploader);
      if (!quota.allowed) {
        res.setHeader('Retry-After', String(quota.retryAfterSec));
        log.warn('upload.quota_exceeded', { reqId: req.reqId, uploader, quota: config.upload.dailyQuota });
        return sendError(res, 429, '今日上传已达上限，请明天再试', req.reqId);
      }

      try {
        // 落对象存储（s3）或本地（local），返回对象键 + 可直接渲染的地址。
        // 键进库、URL 只用于当次响应：预签名 URL 会过期，绝不能存。
        const saved = await storage.saveObject({
          buffer: buf,
          ext,
          contentType: IMAGE_MIME[ext] || 'application/octet-stream',
        });
        log.info({
          reqId: req.reqId, event: 'review.upload', driver: saved.driver, key: saved.key, bytes: buf.length, uploader,
        });
        return send(res, 201, {
          key: saved.key,
          url: saved.url,
          size: buf.length,
          contentType: IMAGE_MIME[ext],
          driver: saved.driver,
          // 客户端可据此提前知道预览地址的有效期，避免缓存过久后变死链
          expiresIn: config.storage.driver === 's3' ? config.storage.mediaUrlTtl : null,
        });
      } catch (e) {
        log.error({ reqId: req.reqId, err: e.message, event: 'review.upload_failed' });
        return sendError(res, 502, '图片存储失败，请稍后重试', req.reqId);
      }
    } finally {
      release();
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/addresses') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    return guarded(() => ({ addresses: userRepo.listAddresses(userId) }));
  }

  if (req.method === 'POST' && url.pathname === '/api/addresses') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    // region 可由 province/city 拼出（前端两个入口字段口径不同），这里只卡真正缺不了的字段，
    // 其余校验与文案交给仓储层，避免两处规则各说一套。
    if (!parsed.receiver) return sendError(res, 400, 'receiver required', req.reqId);
    const userId = userIdOf(req, parsed.userId);
    return guarded(
      () => {
        const r = userRepo.saveAddress(userId, parsed);
        return { ...r, addresses: userRepo.listAddresses(userId) };
      },
      201,
    );
  }

  // 设为默认地址：幂等，重复调用结果一致
  const addrDefaultMatch = url.pathname.match(/^\/api\/addresses\/([^/]+)\/default$/);
  if (req.method === 'POST' && addrDefaultMatch) {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    const id = decodeURIComponent(addrDefaultMatch[1]);
    return guarded(() => {
      userRepo.setDefaultAddress(userId, id);
      return { ok: true, addresses: userRepo.listAddresses(userId) };
    });
  }

  // 删除地址：删掉默认地址后由剩余第一条接任，返回最新清单
  const addrIdMatch = url.pathname.match(/^\/api\/addresses\/([^/]+)$/);
  if (req.method === 'DELETE' && addrIdMatch) {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    const id = decodeURIComponent(addrIdMatch[1]);
    return guarded(() => {
      const r = userRepo.removeAddress(userId, id);
      return { ...r, addresses: userRepo.listAddresses(userId) };
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.message || parsed.query || '';
    if (!query) return sendError(res, 400, 'message required', req.reqId);
    try {
      if (parsed.stream) {
        await handleChatStream(res, { ...parsed, query });
        return;
      }
      const r = await chatEngine.chatReply({
        mode: 'chat',
        query,
        userId: userIdOf(req, parsed.userId),
        conversationId: parsed.conversationId,
      });
      return send(res, 200, {
        type: 'customer-service',
        answer: r.answer,
        conversationId: r.conversationId,
        mode: r.mode,
        intent: r.intent,
      });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 客服流式（SSE）：对话引擎逐字回传（配了 LLM 走真实流式，否则本地打字机）
  async function handleChatStream(res, parsed) {
    sseInit(res);
    try {
      const r = await chatEngine.chatReplyStream(
        {
          mode: 'chat',
          query: parsed.query,
          userId: userIdOf(req, parsed.userId),
          conversationId: parsed.conversationId,
        },
        (t) => sseWrite(res, { text: t }),
      );
      sseWrite(res, {
        products: r.cards,
        conversationId: r.conversationId,
        mode: r.mode,
        intent: r.intent,
      });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/qa') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.query || '';
    if (!query) return sendError(res, 400, 'query required', req.reqId);
    try {
      if (parsed.stream) {
        await handleQaStream(res, { ...parsed, query });
        return;
      }
      const r = await chatEngine.chatReply({
        mode: 'product-qa',
        query,
        userId: userIdOf(req, parsed.userId),
        conversationId: parsed.conversationId,
        productId: parsed.productId,
      });
      return send(res, 200, {
        type: 'product-qa',
        answer: r.answer,
        results: r.cards,
        conversationId: r.conversationId,
        mode: r.mode,
        intent: r.intent,
      });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/guide') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const message = parsed.message || parsed.query || '';
    if (!message) return sendError(res, 400, 'message required', req.reqId);
    try {
      if (parsed.stream) {
        await handleGuideStream(res, { ...parsed, message });
        return;
      }
      const r = await chatEngine.chatReply({
        mode: 'guide',
        query: message,
        userId: userIdOf(req, parsed.userId),
        conversationId: parsed.conversationId,
      });
      return send(res, 200, {
        type: 'shopping-guide',
        intro: r.answer,
        answer: r.answer,
        products: r.cards,
        conversationId: r.conversationId,
        mode: r.mode,
        intent: r.intent,
      });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 导购流式（SSE）：先逐段回传导购话术，最后回传商品卡片
  async function handleGuideStream(res, parsed) {
    sseInit(res);
    try {
      const r = await chatEngine.chatReplyStream(
        {
          mode: 'guide',
          query: parsed.message,
          userId: userIdOf(req, parsed.userId),
          conversationId: parsed.conversationId,
        },
        (t) => sseWrite(res, { text: t }),
      );
      sseWrite(res, {
        products: r.cards,
        mode: r.mode,
        conversationId: r.conversationId,
        intent: r.intent,
      });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  // 商品问答流式（SSE）：逐字回传答案，最后回传关联商品卡片
  async function handleQaStream(res, parsed) {
    sseInit(res);
    try {
      const r = await chatEngine.chatReplyStream(
        {
          mode: 'product-qa',
          query: parsed.query,
          userId: userIdOf(req, parsed.userId),
          conversationId: parsed.conversationId,
          productId: parsed.productId,
        },
        (t) => sseWrite(res, { text: t }),
      );
      sseWrite(res, {
        productId: parsed.productId || null,
        results: r.cards,
        conversationId: r.conversationId,
        mode: r.mode,
        intent: r.intent,
      });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/copywrite') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const product = parsed.product || {};
      const r = await generateCopywriting({
        product,
        sellingPoints: parsed.sellingPoints || product.tags || [],
        tone: parsed.tone || '专业',
        platform: parsed.platform || '通用',
        count: parsed.count || 3,
      });
      return send(res, 200, { type: 'copywrite', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 推荐来源埋点 + 渠道分析（来源闭环数据）
  if (req.method === 'POST' && url.pathname === '/api/track') {
    const parsed = await readJson(req);
    if (!parsed || !parsed.event) return sendError(res, 400, 'event required', req.reqId);
    // 发送即忘：先回 202，异步落 ES / 内存，不阻塞主流程
    trackEvent({
      event: parsed.event,
      source: parsed.source,
      productId: parsed.productId,
      userId: userIdOf(req, parsed.userId),
      meta: parsed.meta,
    }).catch(() => {});
    return send(res, 202, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/track/stats') {
    const productId = url.searchParams.get('productId') || undefined;
    const source = url.searchParams.get('source') || undefined;
    const stats = await getTrackStats({ productId, source });
    return send(res, 200, { stats });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/aftersale') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const r = await handleAfterSale({
        userId: userIdOf(req, parsed.userId),
        orderId: parsed.orderId,
        query: parsed.query || '',
      });
      return send(res, 200, { type: 'aftersale', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      service: 'ai-gateway',
      endpoints: [
        'GET /health',
        'GET /ready',
        'POST /api/auth/login {userId?, nickname?} (签发访问令牌 + HttpOnly 刷新令牌 Cookie)',
        'POST /api/auth/refresh (轮换刷新令牌，返回新访问令牌；重放则整族撤销)',
        'POST /api/auth/logout (作废当前刷新令牌并清 Cookie)',
        'GET /api/auth/me (Bearer 访问令牌 → 当前用户)',
        'POST /api/seed',
        'POST /api/search {query, topK}',
        'GET /api/products (筛选: category/sub/brand/minPrice/maxPrice/sort/limit/offset)',
        'GET /api/products/:id (含 SKU / 评价 / 相关推荐)',
        'GET /api/products/:id/reviews?userId=&filter=&sort=&limit=&offset= (评价列表 + 追评 + 星级分布)',
        'POST /api/reviews {productId|parentId, userId?, author?, rating?, content, skuSpec?, images?} (parentId 为追评)',
        'POST /api/reviews/:id/helpful {userId?} (有用投票，幂等可取消)',
        'DELETE /api/reviews/:id?userId= (删除本人评价，级联删追评/投票并回收图片对象)',
        'POST /api/reviews/upload {data: base64} (买家秀，≤UPLOAD_MAX_BYTES；限流/并发/每日配额保护)',
        'GET /api/categories (tree=1 两级树 + 商品数)',
        'GET /api/brands (可按 category 过滤)',
        'GET /api/stats (商品/SKU/类目/品牌规模)',
        'GET|POST|PATCH|DELETE /api/cart?userId= (购物车：增删改查，服务端持久化)',
        'POST /api/orders/preview {userId, items?, addressId?, couponId?} (结算预览)',
        'GET /api/orders?userId= · POST /api/orders {userId, items, addressId?, couponId?}',
        'GET /api/orders/:id?userId= · POST /api/orders/:id/pay?userId=',
        'GET|POST|DELETE /api/favorites?userId= (收藏夹：POST 为切换)',
        'GET /api/coupons/catalog (券目录，前端离线兜底同构)',
        'GET /api/coupons?userId=&amount=&all=1 (卡包；all=1 含已用/已过期)',
        'POST /api/coupons {userId, couponId} (领券，重复领取 409)',
        'POST /api/coupons/use {userId, couponId, orderId} (核销，幂等)',
        'POST /api/coupons/refund {userId, orderId} (取消订单返还 + 有效期顺延)',
        'GET|POST /api/addresses?userId= (地址簿：POST 带 id 即更新，返回最新清单)',
        'POST /api/addresses/:id/default?userId= (设为默认，幂等)',
        'DELETE /api/addresses/:id?userId= (删除；删默认则由剩余第一条接任)',
        'POST /api/ai/chat {message, userId?, conversationId?}',
        'POST /api/ai/qa {query, userId?, conversationId?, productId?} (stream:true 时 SSE 逐字，末尾回传 results)',
        'POST /api/ai/guide {message, userId?, budget?, category?, topK?}',
        'POST /api/ai/copywrite {product, sellingPoints?, tone?, platform?, count?}',
        'POST /api/ai/aftersale {userId?, orderId?, query?}',
        'POST /api/track {event, source?, productId?, userId?, meta?} (推荐来源埋点，202 异步落 ES/内存)',
        'GET /api/track/stats?productId=&source= (渠道分析聚合)',
      ],
    });
  }

  return sendError(res, 404, 'not found', req.reqId);
}

const server = http.createServer(async (req, res) => {
  attachContext(req, res);
  applyCors(req, res);

  // 预检请求直接放行
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const url = new URL(req.url, `http://localhost:${config.port}`);
  const isProbe = url.pathname === '/health' || url.pathname === '/ready';

  // 探针接口不鉴权、不限流（供编排器/负载均衡探活）
  if (isProbe) {
    if (url.pathname === '/health') {
      return send(res, 200, {
        status: 'ok',
        runMode: config.runMode,
        embedding: config.embeddingProvider,
        vectorStore: vectorStore.count(),
        searchStore: searchStore.count(),
        // 探针里带上存储驱动：部署后一眼能看出买家秀落在本地还是对象存储
        storage: config.storage.driver,
        // 认证模式：required=强制令牌，optional=可选；便于上线后核对鉴权策略
        auth: config.auth.required ? 'required' : 'optional',
      });
    }
    const deps = probeDeps();
    return send(res, deps.ready ? 200 : 503, {
      status: deps.ready ? 'ready' : 'not ready',
      runMode: config.runMode,
      deps,
    });
  }

  // 业务接口：限流 + 鉴权
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    log.warn('rate_limited', { reqId: req.reqId, ip: req.ip });
    return sendError(res, 429, 'too many requests', req.reqId);
  }
  if (!checkAuth(req)) {
    log.warn('auth_failed', { reqId: req.reqId, ip: req.ip, path: url.pathname });
    return sendError(res, 401, 'unauthorized', req.reqId);
  }

  // 可选认证：解析访问令牌（失败不拦，由 AUTH_REQUIRED 决定是否强制）
  authenticate(req);

  // 强制鉴权模式：除登录/刷新外，业务接口必须携带有效访问令牌
  if (config.auth.required && !req.authUserId && !isAuthPublicPath(url.pathname)) {
    log.warn('auth_token_required', { reqId: req.reqId, ip: req.ip, path: url.pathname });
    return sendError(res, 401, '需要登录后访问', req.reqId);
  }

  const startedAt = req.startedAt;
  try {
    await route(req, res, url);
  } catch (e) {
    log.error('unhandled', { reqId: req.reqId, ip: req.ip, err: e.message, stack: e.stack });
    return sendError(res, 500, 'internal error', req.reqId);
  } finally {
    log.info('access', {
      reqId: req.reqId,
      ip: req.ip,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
});

// 孤儿对象清理：回收「已上传但没发布 / 评价删除后残留」的图片对象。
// 读取所有评价引用的对象键，交给 storage 层比对并删除未引用的（best-effort）。
async function runOrphanSweep() {
  try {
    const referenced = new Set();
    for (const row of getDb().prepare('SELECT images FROM reviews').all()) {
      try {
        const arr = JSON.parse(row.images || '[]');
        for (const img of arr) if (storage.isObjectKey(img)) referenced.add(img);
      } catch { /* 坏数据跳过 */ }
    }
    const removed = await storage.sweepOrphans(referenced, { logger: log });
    if (removed) log.info('storage.sweep_done', { removed });
  } catch (e) {
    log.warn('storage.sweep_failed', { err: e.message });
  }
}

// ===== 优雅停机 =====
let isClosing = false;
const connections = new Set();

server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

function shutdown(signal) {
  if (isClosing) return;
  isClosing = true;
  log.warn('shutdown', { signal, msg: 'received, draining connections' });
  // 停止接收新连接；已建立的连接自然结束
  server.close((err) => {
    if (err) log.error('shutdown', { err: err.message });
    for (const s of connections) s.destroy();
    log.info('shutdown', { msg: 'closed, bye' });
    process.exit(0);
  });
  // 兜底：超时强制退出，避免僵尸进程
  const forced = setTimeout(() => {
    log.warn('shutdown', { msg: 'force exit after timeout' });
    process.exit(0);
  }, 10000);
  forced.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 启动前先确保 SQLite 结构与种子就绪（同步执行、几十毫秒），避免请求早于建表
try {
  const dbInfo = ensureSeeded();
  log.info('db', { file: config.dbFile, ...dbInfo });
} catch (e) {
  log.error('db_init', { err: e.message });
}

// 认证密钥校验：强制鉴权但未配置密钥时快速失败（避免上线后才在第一个请求炸）
try {
  getSecret();
  if (isEphemeralSecret()) {
    log.warn('auth', { msg: 'AUTH_JWT_SECRET 未配置，已生成临时密钥（重启后令牌失效）' });
  }
} catch (e) {
  log.error('auth_init', { err: e.message });
  process.exit(1);
}

server.listen(config.port, async () => {
  const store = storage.storageInfo();
  log.info('listen', {
    port: config.port,
    runMode: config.runMode,
    embedding: config.embeddingProvider,
    llm: config.llm.apiKey ? `${config.llm.model} @ ${config.llm.baseUrl}` : 'disabled(本地引擎)',
    storage: store.driver === 's3' ? `s3 ${store.bucket} @ ${store.endpoint}` : 'local(data/uploads)',
  });
  const warns = startupWarnings();
  for (const w of warns) log.warn('config', { msg: w });
  // 对象存储自检：桶不存在就建，连不上只告警（不阻断启动，上传时才报错）
  storage.ensureReady(log).then((r) => {
    if (r.ok) {
      log.info('storage', { driver: r.driver, created: !!r.created, ttl: store.signedUrlTtlSec });
      // 启动后顺手清一次孤儿对象（上传未发布 / 删除后残留），失败不影响主流程
      runOrphanSweep();
    } else {
      log.warn('storage', { driver: r.driver, err: r.error });
    }
  });
  // 周期回收孤儿对象：后台静默运行，不阻塞请求
  if (config.storage.sweepIntervalSec > 0) {
    const timer = setInterval(runOrphanSweep, config.storage.sweepIntervalSec * 1000);
    if (timer.unref) timer.unref();
  }
  // 认证与限流转储的周期清理：过期刷新令牌出库 + 过期限流桶回收（每小时）
  try {
    const purged = authService.cleanupExpired();
    if (purged) log.info('auth.cleanup', { removed: purged });
  } catch (e) {
    log.warn('auth.cleanup_failed', { err: e.message });
  }
  const housekeeping = setInterval(() => {
    try {
      const removed = authService.cleanupExpired();
      if (removed) log.info('auth.cleanup', { removed });
    } catch (e) {
      log.warn('auth.cleanup_failed', { err: e.message });
    }
    uploadIpWindow.sweep();
    uploadUserWindow.sweep();
    uploadDailyQuota.sweep();
  }, 3600 * 1000);
  if (housekeeping.unref) housekeeping.unref();
  // 埋点索引模板：docker 模式 best-effort 建（ES 不可用时静默跳过）
  ensureTrackIndex().catch(() => {});
  try {
    // 把商品写进检索索引（向量 + 关键词）
    const n = await seed();
    log.info('seed', { count: n });
  } catch (e) {
    log.error('seed', { err: e.message });
  }
});
