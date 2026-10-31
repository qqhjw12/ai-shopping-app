import './quiet.js';
import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
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
import * as visualSearch from './services/visualSearch.js';
import * as productRepo from './repositories/productRepo.js';
import * as cartRepo from './repositories/cartRepo.js';
import * as userRepo from './repositories/userRepo.js';
import * as orderService from './services/orderService.js';
import * as settingsService from './services/settingsService.js';
import * as couponCatalogService from './services/couponCatalogService.js';
import * as aftersaleService from './services/aftersaleService.js';
import * as ledgerService from './services/ledgerService.js';
import * as merchantService from './services/merchantService.js';
import * as merchantShopService from './services/merchantShopService.js';
import * as merchantShopRepo from './repositories/merchantShopRepo.js';
import * as noticeService from './services/noticeService.js';
import * as noticeTemplateService from './services/noticeTemplateService.js';
import { toCsv, contentDisposition } from './services/csv.js';

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
  // 一次性 Buffer 编码再发送：大 payload 若让 Node 按字符串分块写 socket，
  // 分块边界可能落在 UTF-8 多字节序列中间（实测 40908 条全量响应里出现 U+FFFD），
  // 先转成完整 Buffer 后 socket 层只会按字节切，编码永远安全。
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function sendError(res, status, message, reqId, extra) {
  // extra 用于字段级错误（入驻申请表单需要知道「哪个格子错了」，否则回一句
  // 「参数有误」等于让商家从头再找一遍）。其余调用方不传，结构保持不变。
  send(res, status, { error: message, reqId, ...(extra || {}) });
}

/**
 * 常量时间字符串比较：密钥校验不能用 ===，否则响应时间会随匹配前缀长度变化，
 * 攻击者可以逐字节猜出来。长度不同直接返回 false（长度本身不是秘密）。
 */
function safeEqual(a, b) {
  const left = Buffer.from(String(a == null ? '' : a));
  const right = Buffer.from(String(b == null ? '' : b));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 管理接口鉴权（运营配置写入、券目录写入）。
 *
 * 未配置 ADMIN_API_KEY 时一律 403 而不是放行：写接口的默认姿态必须是关闭的，
 * 「忘了配环境变量」不能变成「谁都能改运费和券面额」。
 * 已配置则要求请求头 X-Admin-Key 完全一致（常量时间比较）。
 * X-Admin-Actor 只用于日志追溯，不参与鉴权——它不是身份，别把它当 RBAC。
 *
 * @returns {boolean} 通过返回 true；已写好错误响应返回 false
 */
function requireAdmin(req, res) {
  const expected = config.adminApiKey;
  const path = (req.url || '').split('?')[0];
  if (!expected) {
    sendError(res, 403, '管理写入未启用：服务端未设置 ADMIN_API_KEY', req.reqId);
    return false;
  }
  if (!safeEqual(req.headers['x-admin-key'], expected)) {
    log.warn('admin.denied', { reqId: req.reqId, ip: req.ip, path });
    sendError(res, 401, '管理员密钥不正确', req.reqId);
    return false;
  }
  return true;
}

/**
 * 管理操作的执行人（只进日志与审计字段，不参与鉴权）。
 *
 * 值是 URL 编码过的——HTTP 头只吃可打印 ASCII，中文名字直接放进去会让请求
 * 在客户端就构造失败。解码失败就用原串：一个显示成乱码的署名，
 * 也好过整个审核动作 500。
 */
function adminActor(req) {
  const raw = String(req.headers['x-admin-actor'] || '');
  if (!raw) return 'admin';
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  return name.slice(0, 40);
}

/**
 * 管理员钥匙的短指纹。
 *
 * X-Admin-Actor 是客户端自报的标签——能发请求的人就能把它写成任何名字，
 * 单靠它追责是空的。指纹由服务端从钥匙本身算出，客户端改不动。两条一起记
 * 才有意义：名字回答「是谁说自己做的」，指纹回答「用的到底是哪把钥匙」。
 * 想让名字变得可信，正确的做法是给每个运营发不同的 ADMIN_API_KEY，
 * 而不是继续在这个自报字段上加校验。
 */
function adminKeyFingerprint(req) {
  const raw = String(req.headers['x-admin-key'] || '');
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 8) : 'none';
}

// 物流推送的 body 上限：几条事件文本，64KB 绰绰有余。
// 单独设一个比复用 6MB 的图片上限合理——这个端点只该收到几 KB。
const WEBHOOK_BODY_LIMIT = 64 * 1024;

/**
 * 校验快递物流推送的签名。
 *
 * 签名内容 = `${timestamp}.${原始 body}`，HMAC-SHA256，每家快递一把密钥。
 *
 * 时间戳必须进签名：只签 body 的话，任何人截到一条合法请求就能无限重放，
 * 「把订单改成已签收」这个动作会被反复执行。带上时间戳后服务端还能按窗口直接拒。
 *
 * 验签用常量时间比较（timingSafeEqual）：用 === 比较签名会按字节逐个短路，
 * 响应时间的微小差异足以让对方逐字节猜出正确签名。
 *
 * @param {Buffer} raw 原始请求体（必须在 JSON.parse 之前拿到：
 *   解析后重新序列化的键顺序/空格会变，签名必然对不上）
 */
function verifyLogisticsSignature(req, res, raw) {
  const carrier = String(req.headers['x-carrier'] || '').trim().toLowerCase();
  const secret = carrier ? config.logisticsWebhook.keys.get(carrier) : '';
  if (!carrier) {
    sendError(res, 401, '缺少物流渠道标识', req.reqId);
    return false;
  }
  if (!secret) {
    // 没配这家 = 这家没开通。刻意不说「签名错误」——那会让对接的人
    // 反复去检查签名算法，而真问题是这家的密钥还没配置。
    log.warn('logistics.webhook_unconfigured', { reqId: req.reqId, carrier, ip: req.ip });
    sendError(res, 401, `${carrier} 渠道的物流推送未启用`, req.reqId);
    return false;
  }

  const sig = String(req.headers['x-signature'] || '').trim().toLowerCase();
  const ts = Number(req.headers['x-timestamp'] || 0);
  if (!sig || !ts) {
    sendError(res, 401, '缺少签名或时间戳', req.reqId);
    return false;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (!Number.isFinite(skew) || skew > config.logisticsWebhook.toleranceSec) {
    log.warn('logistics.webhook_stale', { reqId: req.reqId, carrier, skewSec: skew });
    sendError(res, 401, '推送时间戳超出容差，可能已被重放', req.reqId);
    return false;
  }

  const expect = createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
  if (!safeEqualHex(expect, sig)) {
    log.warn('logistics.webhook_bad_signature', { reqId: req.reqId, carrier, ip: req.ip });
    sendError(res, 401, '签名校验失败', req.reqId);
    return false;
  }
  return true;
}

/** 常量时间比较十六进制串（长度不等时先按长度比，否则 timingSafeEqual 会直接抛） */
function safeEqualHex(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  try {
    return timingSafeEqual(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
  } catch {
    return false;
  }
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

/**
 * 读取并校验一张 base64 提交的图片（买家秀与售后凭证共用）。
 *
 * 校验顺序刻意从外到内：声明长度 → 实际字节 → 文件头嗅探。
 * 先做嗅探的话，对方只要发个 100MB 的垃圾就能让服务器先读满内存再说「格式不对」。
 *
 * @returns {Promise<{buf: Buffer, ext: string}|null>} null = 已发出错误响应，调用方直接 return
 */
async function decodeImageBody(req, res, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  const maxBody = Math.ceil(limit * 1.4); // base64 比原始大 ~1.33，留 40% 余量
  if (declared && declared > maxBody) {
    sendError(res, 413, `图片过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`, req.reqId);
    return null;
  }
  const raw = await readRawBody(req, limit);
  if (raw === null) {
    sendError(res, 413, `图片过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`, req.reqId);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    sendError(res, 400, '请求格式有误', req.reqId);
    return null;
  }
  const dataUrl = String((parsed && parsed.data) || '');
  const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  if (!base64) {
    sendError(res, 400, '缺少图片数据', req.reqId);
    return null;
  }
  let buf;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    sendError(res, 400, '图片编码有误', req.reqId);
    return null;
  }
  // 拒绝浏览器被绕过时传来的空壳（base64 非法字符会让还原长度远小于预期）
  if (!buf.length) {
    sendError(res, 400, '图片内容为空', req.reqId);
    return null;
  }
  if (buf.length > limit) {
    sendError(res, 413, `图片过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`, req.reqId);
    return null;
  }
  const ext = sniffImage(buf);
  if (!ext) {
    sendError(res, 415, '仅支持 JPG / PNG / WebP / GIF 图片', req.reqId);
    return null;
  }
  return { buf, ext };
}

/**
 * 落对象存储并返回给客户端的描述。
 * 键进库、URL 只用于当次响应——URL 可能是会过期的预签名地址，存下来就是死链。
 */
async function storeImage(buf, ext, ns = 'reviews') {
  const saved = await storage.saveObject({
    buffer: buf,
    ext,
    contentType: IMAGE_MIME[ext] || 'application/octet-stream',
    ns,
  });
  return {
    key: saved.key,
    url: saved.url,
    size: buf.length,
    contentType: IMAGE_MIME[ext],
    driver: saved.driver,
    // 客户端据此知道预览地址的有效期，避免缓存过久后变死链
    expiresIn: config.storage.driver === 's3' ? config.storage.mediaUrlTtl : null,
  };
}

// ===== 上传限流（进程内；多实例请上移到网关/Redis）=====
// IP 窗口放宽到用户窗口的 3 倍：同一 NAT 后的多用户共用出口 IP，避免误伤。
const uploadIpWindow = createFixedWindow({ limit: config.upload.ratePerMin * 3, windowMs: 60_000 });
const uploadUserWindow = createFixedWindow({ limit: config.upload.ratePerMin, windowMs: 60_000 });
const uploadDailyQuota = createFixedWindow({ limit: config.upload.dailyQuota, windowMs: 24 * 3600 * 1000 });
const uploadGate = createConcurrencyGate({ max: config.upload.maxConcurrent });

// 入驻申请提交限流：这是唯一一个「匿名也能写、写进去就是一条运营待办」的端点，
// 不设闸门等于给刷单机器人开了个免费的表。按 IP 与用户各一层，窗口按小时算。
// 数值不往死里压：一个办公室/园区共用出口 IP 时，几家商户同时提交是正常现象，
// 真正的异常是「一分钟几十条」——那种量级靠下面的每用户窗口和内容校验一起拦。
const merchantApplyIpWindow = createFixedWindow({ limit: 30, windowMs: 3600 * 1000 });
const merchantApplyUserWindow = createFixedWindow({ limit: 6, windowMs: 3600 * 1000 });

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

// 强制鉴权（AUTH_REQUIRED=true）时仍放行的路径：登录与刷新本身，
// 外加 /api/config —— 运费与配送方式是公开信息（未登录的结算页也要显示），
// 写入另有 X-Admin-Key 独立校验，不靠用户登录态。
const AUTH_PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/config']);
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

  // ===== 运营配置：运费/配送方式 + 支付方式 + 券返还顺延规则 =====
  // 读：公开（未登录的结算页也要显示运费）；写：需 X-Admin-Key（env ADMIN_API_KEY，未设置则只读）。
  // 做成运行时配置而不是编译期常量：这类参数按大促节奏调整，改一个数字不该发一次版，
  // 更不该出现「服务端改了、前端没改」的错位（同一张券在两台设备上算出不同到期日）。
  if (url.pathname === '/api/config') {
    if (req.method === 'GET') {
      return guarded(() => ({ settings: settingsService.getSettings() }));
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      // 允许 { settings: {...} } 或直接 {...}，两种写法都常见，少一次踩坑
      const patch = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
      const actor = adminActor(req);
      return guarded(() => {
        const next = settingsService.updateSettings(patch, { by: actor });
        log.info('config.updated', { reqId: req.reqId, actor, sections: Object.keys(patch).join(',') });
        return { settings: next };
      });
    }
  }

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
          shippingMethodId: parsed.shippingMethodId || null,
          paymentMethodId: parsed.paymentMethodId || null,
          // 幂等键：客户端一次结算会话一个，重试复用同一个 → 服务端只建一单。
          // 也接受标准头 Idempotency-Key，方便非浏览器客户端按惯例接入。
          idempotencyKey: parsed.idempotencyKey || req.headers['idempotency-key'] || null,
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
      shippingMethodId: parsed.shippingMethodId || null,
      paymentMethodId: parsed.paymentMethodId || null,
    }));
  }

  // 取消订单：服务端事务里「关单 + 返券顺延」一起完成。
  // 前端本地单（无网关时的降级路径）不走这里，仍用本地返还 + 发件箱补推。
  const cancelMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    const orderId = decodeURIComponent(cancelMatch[1]);
    return guarded(() => orderService.cancelOrder(orderId, userId));
  }

  const payMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/pay$/);
  if (payMatch && req.method === 'POST') {
    const userId = userIdOf(req, url.searchParams.get('userId'));
    return guarded(() => ({ order: orderService.payOrder(decodeURIComponent(payMatch[1]), userId) }));
  }

  // 演示端点：模拟发货 / 模拟签收。
  // 这两颗按钮只为了让「待发货 → 已发货 → 已完成 → 申请售后」这条路走得通，
  // 真实系统里状态由仓储系统与快递回传推进，不该由买家点。
  // DEMO_ACTIONS=false 时整组关掉（403），而不是靠前端把按钮藏起来——
  // 前端藏起来只防手滑，防不了直接调接口的人。
  const fulfillMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/(ship|complete)$/);
  if (fulfillMatch && req.method === 'POST') {
    if (!config.demoActions) {
      return sendError(res, 403, '演示接口已关闭（DEMO_ACTIONS=false）', req.reqId);
    }
    const userId = userIdOf(req, url.searchParams.get('userId'));
    const orderId = decodeURIComponent(fulfillMatch[1]);
    return guarded(() => ({
      order: fulfillMatch[2] === 'ship'
        ? orderService.shipOrder(orderId, userId)
        : orderService.completeOrder(orderId, userId),
    }));
  }

  // 售后申请：真实业务路径，不受 DEMO_ACTIONS 影响。
  // 返回售后单 + 刷新后的订单（状态已变售后中），前端一次请求就能整页重绘。
  const asMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/aftersale$/);
  if (asMatch && req.method === 'POST') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const userId = userIdOf(req, parsed.userId || url.searchParams.get('userId'));
    const orderId = decodeURIComponent(asMatch[1]);
    return guarded(() => {
      const aftersale = aftersaleService.createAftersale({
        orderId,
        userId,
        type: parsed.type,
        reason: parsed.reason,
        note: parsed.note || '',
        evidence: parsed.evidence || [],
      });
      return { aftersale, order: orderService.getOrder(orderId, userId) };
    }, 201);
  }

  // ===== 售后工单（运营侧） =====
  // 读写都要 X-Admin-Key：工单里是收货地址、电话和用户的原话，
  // 匿名可读等于把隐私和投诉内容挂在公网上。ADMIN_API_KEY 未配置时 requireAdmin 直接 403。
  if (url.pathname === '/api/aftersales' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    // reviewed=1 只看已处理、=0 只看待处理；省略则不做这层过滤（与 status 各管一层）
    const rawReviewed = url.searchParams.get('reviewed');
    const reviewed = rawReviewed === '1' || rawReviewed === 'true'
      ? true
      : (rawReviewed === '0' || rawReviewed === 'false' ? false : null);
    return guarded(() => aftersaleService.listForAdmin({
      status: url.searchParams.get('status') || '',
      reviewed,
      page: url.searchParams.get('page'),
      size: url.searchParams.get('size'),
    }));
  }

  /**
   * 审核工单：approve / reject。
   * 用 PATCH 而不是 POST /review——动作是对既有资源的部分更新，
   * 且 PATCH 不会被中间层当成「创建」而缓存。
   * 返回结果直接是工单对象：审核台据此把这张卡片从待处理挪到已处理。
   */
  const asReviewMatch = url.pathname.match(/^\/api\/aftersales\/([^/]+)$/);
  if (asReviewMatch && req.method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const id = decodeURIComponent(asReviewMatch[1]);
    const actor = adminActor(req);
    return guarded(() => {
      const aftersale = aftersaleService.reviewAftersale({
        id,
        action: parsed.action,
        note: parsed.note || '',
        refundAmount: parsed.refundAmount,
        by: actor,
      });
      log.info('aftersale.reviewed', {
        reqId: req.reqId, actor, id,
        keyFp: adminKeyFingerprint(req),
        action: aftersale.status,
        refund: aftersale.refundAmount,
      });
      return { aftersale };
    });
  }

  /**
   * 资金流水：待打款清单与全库概览（运营侧）。
   * 待打款是运营每天开工要看的第一份清单——同意了但还没转出去的钱。
   */
  if (url.pathname === '/api/ledger/pending' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    return guarded(() => ({
      ...ledgerService.listPending({
        page: url.searchParams.get('page'),
        size: url.searchParams.get('size'),
      }),
      summary: ledgerService.summary(),
    }));
  }

  /**
   * 确认已打款：pending → settled。
   *
   * 这一步让账本从「客服说要退」变成「钱真的出去了」。持钥匙的人点这一下
   * 等于声明款项已转出，所以操作人会一起记账（自报，能追责的是钥匙指纹）。
   */
  const settleMatch = url.pathname.match(/^\/api\/ledger\/refunds\/([^/]+)\/settle$/);
  if (settleMatch && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const id = decodeURIComponent(settleMatch[1]);
    const actor = adminActor(req);
    return guarded(() => {
      const entry = ledgerService.settleRefund({ id, by: actor });
      log.info('ledger.settled', {
        reqId: req.reqId, actor, id, keyFp: adminKeyFingerprint(req),
        amount: entry.amount, orderId: entry.orderId,
      });
      return { entry };
    });
  }

  /**
   * 售后凭证上传：图片落对象存储（local 或 s3），只把对象键交给工单。
   *
   * 与买家秀共用四道闸（频率 + 全局并发 + 字节上限 + 文件头嗅探），
   * 但**不共用每日配额**：凭证与买家秀是两件事，今天发了 20 张买家秀
   * 就不让用户提交破损照片是没有道理的。上限由「每单最多 5 份」约束。
   */
  if (url.pathname === '/api/aftersale/evidence' && req.method === 'POST') {
    const who = userIdOf(req, null) || `ip:${req.ip}`;
    const uGate = uploadUserWindow.hit(who);
    if (!uGate.allowed) {
      res.setHeader('Retry-After', String(uGate.retryAfterSec));
      log.warn('upload.rate_limited', { reqId: req.reqId, scope: 'evidence', who });
      return sendError(res, 429, '上传过于频繁，请稍后再试', req.reqId);
    }
    const release = uploadGate.acquire();
    if (!release) {
      res.setHeader('Retry-After', '2');
      return sendError(res, 503, '上传繁忙，请稍后再试', req.reqId);
    }
    try {
      const decoded = await decodeImageBody(req, res, UPLOAD_LIMIT);
      if (!decoded) return;
      const saved = await storeImage(decoded.buf, decoded.ext, 'evidence');
      log.info({
        reqId: req.reqId, event: 'evidence.upload', driver: saved.driver,
        key: saved.key, bytes: saved.size, who,
      });
      return send(res, 201, saved);
    } catch (e) {
      log.error({ reqId: req.reqId, err: e.message, event: 'evidence.upload_failed' });
      return sendError(res, 502, '凭证存储失败，请稍后重试', req.reqId);
    } finally {
      release();
    }
  }

  /**
   * 快递物流推送（webhook）。
   *
   * 公开端点，所以鉴权不是可选项：验 HMAC-SHA256 签名，每家快递一把密钥。
   * 少了它，任何人都能 POST 一条 signed 把别人的订单改成已签收——
   * 而签收会释放「可申请售后」的入口，等于能随意开启退款流程。
   *
   * 三道闸：签名（对不对）→ 时间戳窗口（是不是旧的）→ 事件去重（是不是重推）。
   */
  if (url.pathname === '/api/webhooks/logistics' && req.method === 'POST') {
    // 必须先拿原始字节再验签：JSON.parse 之后再序列化，键顺序与空格都变了，
    // 签名必然对不上。这是 webhook 实现里最常见的踩坑点。
    const raw = await readRawBody(req, WEBHOOK_BODY_LIMIT);
    if (raw === null) return sendError(res, 413, '推送内容过大', req.reqId);
    if (!verifyLogisticsSignature(req, res, raw)) return;
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendError(res, 400, '请求格式有误', req.reqId);
    }
    return guarded(() => {
      const r = orderService.ingestLogisticsWebhook({
        trackingNo: parsed.trackingNo,
        events: parsed.events,
      });
      log.info('logistics.webhook', {
        reqId: req.reqId, carrier: String(req.headers['x-carrier'] || '').toLowerCase(),
        orderId: r.orderId, inserted: r.inserted, deduped: r.deduped, advanced: r.advanced,
      });
      return r;
    }, 200);
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
      // action 语义（add/remove）是给前端「本地优先 + 离线队列重放」用的：
      // 旧版只有 toggle，本地删除一条服务端本来就没有的收藏时，toggle 会把它**加回去**。
      // 缺省仍为 toggle，保持对旧调用方的兼容。
      const action = parsed.action === 'add' || parsed.action === 'remove' ? parsed.action : 'toggle';
      return guarded(() => {
        if (action === 'add') {
          const added = userRepo.addFavorite(userId, parsed.productId);
          return { favorited: true, added, ids: userRepo.favoriteIds(userId) };
        }
        if (action === 'remove') {
          const removed = userRepo.removeFavorite(userId, parsed.productId) > 0;
          return { favorited: false, removed, ids: userRepo.favoriteIds(userId) };
        }
        return { favorited: userRepo.toggleFavorite(userId, parsed.productId), ids: userRepo.favoriteIds(userId) };
      });
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
  // 读公开；写需 X-Admin-Key（与 /api/config 同一把钥匙）。
  if (url.pathname === '/api/coupons/catalog') {
    if (req.method === 'GET') {
      return guarded(() => ({ coupons: userRepo.listCouponCatalog() }));
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!requireAdmin(req, res)) return;
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      // 支持单张 { coupon: {...} } 与批量 { coupons: [...] }；force 允许改动已发出的券
      const input = parsed.coupon !== undefined
        ? parsed.coupon
        : (parsed.coupons !== undefined ? parsed.coupons : parsed);
      const force = parsed.force === true;
      const actor = adminActor(req);
      return guarded(() => {
        const result = couponCatalogService.upsertCouponCatalog(input, { force, by: actor });
        log.info('coupon.catalog_updated', {
          reqId: req.reqId,
          actor,
          force,
          changes: result.changes.map((c) => `${c.id}:${c.action}`).join(','),
        });
        return result;
      });
    }
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
      const decoded = await decodeImageBody(req, res, UPLOAD_LIMIT);
      if (!decoded) return; // 响应已在 decodeImageBody 里发出
      const { buf, ext } = decoded;

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
        const saved = await storeImage(req, buf, ext);
        log.info({
          reqId: req.reqId, event: 'review.upload', driver: saved.driver, key: saved.key, bytes: buf.length, uploader,
        });
        return send(res, 201, saved);
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

  // ===== 商家入驻申请 =====
  // 写：匿名可提交（商家注册前就要能交资料），所以限流按 IP + 用户各一层。
  // 读：单条要「编号 + 查询凭证」双要素；列表要 X-Admin-Key（审核工作台用）。
  if (url.pathname === '/api/merchant/applications') {
    if (req.method === 'POST') {
      const ipHit = merchantApplyIpWindow.hit(req.ip || 'unknown');
      if (!ipHit.allowed) {
        res.setHeader('Retry-After', String(ipHit.retryAfterSec));
        return sendError(res, 429, '提交过于频繁，请稍后再试', req.reqId);
      }
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      const userId = userIdOf(req, parsed.userId);
      // 每用户窗口只在「有真实身份」时生效：未登录时 userId 都是 'anonymous'，
      // 全站匿名商家会挤进同一个桶——第 7 家就被 429 挡住，等于给自然流量关了门。
      // 匿名提交由上面的 IP 窗口兜底。
      if (req.authUserId) {
        const userHit = merchantApplyUserWindow.hit(req.authUserId);
        if (!userHit.allowed) {
          res.setHeader('Retry-After', String(userHit.retryAfterSec));
          return sendError(res, 429, '提交过于频繁，请稍后再试', req.reqId);
        }
      }
      // 幂等键优先取请求头（与订单同一套习惯），其次取 body
      const submitKey = req.headers['x-idempotency-key'] || parsed.submitKey;
      try {
        const r = merchantService.submit(parsed, { userId, submitKey });
        // 日志只记编号与幂等命中，不记主体名称/手机号/银行账号
        log.info('merchant.application_submitted', {
          reqId: req.reqId,
          id: r.application.id,
          existed: r.existed,
          userId,
        });
        return send(res, r.existed ? 200 : 201, {
          application: r.application,
          queryKey: r.queryKey,
          existed: r.existed,
        });
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId, e.fields ? { fields: e.fields } : undefined);
      }
    }
    if (req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return guarded(() => merchantService.listForAdmin(Object.fromEntries(url.searchParams)));
    }
  }

  /**
   * 批量导出 CSV（运营侧）。
   *
   * 路径必须排在下面那条 `/applications/:id` 正则之前——否则 "export" 会被当成
   * 一个申请编号去查，运营点导出只会得到 404「申请不存在」。
   * 导出不按当前页取数，而是按筛选条件取全量（有上限，见 listForExport）。
   */
  if (req.method === 'GET' && url.pathname === '/api/merchant/applications/export') {
    if (!requireAdmin(req, res)) return;
    const data = merchantService.exportCsv(Object.fromEntries(url.searchParams));
    const payload = Buffer.from(toCsv(data.columns, data.rows), 'utf8');
    const stamp = new Date().toISOString().slice(0, 10);
    // 导出是一次「把客户资料带出系统」的动作，必须留痕：谁导的、导了多少
    log.info('merchant.exported', {
      reqId: req.reqId,
      status: data.status || 'all',
      exported: data.exported,
      total: data.total,
      actor: adminActor(req),
      keyFp: adminKeyFingerprint(req),
    });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': payload.length,
      'Content-Disposition': contentDisposition(`merchant-applications-${data.status || 'all'}-${stamp}.csv`),
      // 撞到上限时前端要能说清「只导了前 N 条」，而不是让运营以为拿到了全部
      'X-Export-Total': String(data.total),
      'X-Export-Count': String(data.exported),
      'X-Export-Truncated': data.truncated ? '1' : '0',
    });
    return res.end(payload);
  }

  const merchantAppMatch = url.pathname.match(/^\/api\/merchant\/applications\/([^/]+)$/);
  if (merchantAppMatch && req.method === 'GET') {
    const id = decodeURIComponent(merchantAppMatch[1]);
    // 带了管理密钥就按运营口径读：含审核轨迹与通知队列。
    // 不带就只认「编号 + 查询凭证」，两个口径的可见范围差很多，绝不共用一条路径。
    if (req.headers['x-admin-key']) {
      if (!requireAdmin(req, res)) return;
      return guarded(() => {
        const d = merchantService.detailForAdmin(id);
        if (!d) return null; // guarded 统一转成 404
        return d;
      });
    }
    const app = merchantService.getByCredential(id, url.searchParams.get('key'));
    if (!app) return sendError(res, 404, '申请不存在，或查询凭证已失效', req.reqId);
    return send(res, 200, { application: app });
  }

  /**
   * 审核：approve / reject。
   *
   * 改状态、写轨迹、排通知三件事在服务层一个事务里完成；通知只排队不发送
   * （发送交给后台 worker，见 services/noticeService.js 开头的理由）。
   * 终态不可再审：重复点通过会 409，而不是静默覆盖第一份结论。
   */
  if (merchantAppMatch && req.method === 'PATCH') {
    if (!requireAdmin(req, res)) return;
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const id = decodeURIComponent(merchantAppMatch[1]);
    const actor = adminActor(req);
    try {
      const r = merchantService.review(id, parsed, {
        by: actor,
        keyFp: adminKeyFingerprint(req),
      });
      // 日志只记编号、结论与操作人，不记主体名称与联系方式
      log.info('merchant.reviewed', {
        reqId: req.reqId,
        id,
        status: r.application.status,
        actor,
        keyFp: adminKeyFingerprint(req),
        notices: r.notices.length,
      });
      return send(res, 200, r);
    } catch (e) {
      return sendError(res, e.status || 400, e.message, req.reqId);
    }
  }

  /**
   * 商家自助：审核前改资料 / 撤回。
   *
   * 鉴权是「编号 + 查询凭证」（?key=），**不是**管理密钥——这是商家自己的动作。
   * 凭证错与编号不存在都回 404，理由同公开查询：两者可区分就等于给了枚举口子。
   * 只有 reviewing 状态可改（服务层守），改完写轨迹，运营在审核台能看到「改过什么」。
   */
  const merchantSelfMatch = url.pathname.match(/^\/api\/merchant\/applications\/([^/]+)\/(revise|withdraw)$/);
  if (merchantSelfMatch && req.method === 'POST') {
    const ipHit = merchantApplyIpWindow.hit(req.ip || 'unknown');
    if (!ipHit.allowed) {
      res.setHeader('Retry-After', String(ipHit.retryAfterSec));
      return sendError(res, 429, '操作过于频繁，请稍后再试', req.reqId);
    }
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const id = decodeURIComponent(merchantSelfMatch[1]);
    const action = merchantSelfMatch[2];
    const key = url.searchParams.get('key');
    try {
      const r = action === 'revise'
        ? merchantService.revise(id, key, parsed)
        : merchantService.withdraw(id, key, parsed);
      log.info('merchant.self_service', {
        reqId: req.reqId,
        id,
        action,
        changes: action === 'revise' ? (r.changesLabel || []).join('、') : undefined,
      });
      return send(res, 200, r);
    } catch (e) {
      return sendError(res, e.status || 400, e.message, req.reqId, e.fields ? { fields: e.fields } : undefined);
    }
  }

  /**
   * 通知模板：列表 / 保存 / 恢复默认 / 预览。
   * 模板是外发文案的源头，全部要管理密钥；预览不写库（改之前先看效果）。
   */
  if (req.method === 'GET' && url.pathname === '/api/merchant/notice-templates') {
    if (!requireAdmin(req, res)) return;
    return guarded(() => noticeTemplateService.list());
  }

  const tplMatch = url.pathname.match(/^\/api\/merchant\/notice-templates\/([^/]+?)(?:\/(reset|preview))?$/);
  if (tplMatch) {
    if (!requireAdmin(req, res)) return;
    const tplId = decodeURIComponent(tplMatch[1]);
    const sub = tplMatch[2] || '';
    if (!sub && req.method === 'PUT') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      try {
        const r = noticeTemplateService.save(tplId, parsed, adminActor(req));
        log.info('merchant.template_saved', {
          reqId: req.reqId,
          id: tplId,
          actor: adminActor(req),
          enabled: r.template.enabled,
          chars: r.template.body.length,
        });
        return send(res, 200, r);
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId, e.fields ? { fields: e.fields } : undefined);
      }
    }
    if (sub === 'reset' && req.method === 'POST') {
      try {
        const r = noticeTemplateService.reset(tplId);
        log.info('merchant.template_reset', { reqId: req.reqId, id: tplId, actor: adminActor(req) });
        return send(res, 200, r);
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId);
      }
    }
    if (sub === 'preview' && req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      // 传了 applicationId 就用真实申请试渲染（变量缺了能当场看出来），不传就用内置样例
      let app = null;
      if (parsed.applicationId) {
        const found = merchantService.detailForAdmin(String(parsed.applicationId));
        app = found ? found.application : null;
      }
      try {
        return send(res, 200, noticeTemplateService.preview(tplId, {
          app,
          note: parsed.note,
          body: parsed.body,
          subject: parsed.subject,
        }));
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId);
      }
    }
  }

  /**
   * 手动触发一轮通知投递。
   * 平时由后台 worker 每 45 秒扫一次；这个端点给两种场景用：
   * 刚配好 NOTIFY_WEBHOOK_URL 想立刻验证，以及运维排障时不想等下一轮。
   */
  if (req.method === 'POST' && url.pathname === '/api/merchant/notices/flush') {
    if (!requireAdmin(req, res)) return;
    try {
      const counts = await noticeService.flush({ limit: 50 });
      return send(res, 200, { ...counts, channel: noticeService.channelState() });
    } catch (e) {
      return sendError(res, 500, e.message, req.reqId);
    }
  }

  // 通知队列概览：运营台头部用它显示「通道是否就绪 / 几条没发出去」
  if (req.method === 'GET' && url.pathname === '/api/merchant/notices/stats') {
    if (!requireAdmin(req, res)) return;
    return guarded(() => noticeService.queueStats());
  }

  /* ============================================================
     商家工作台（#/merchant/dashboard 的数据源）
     ============================================================
     鉴权一律是「入驻编号 + 查询凭证」双要素：凭证不对与编号不存在统一 404，
     不给枚举留口子；申请没通过则 403（工作台对未开业的店不开放）。
     这些端点读写的是**真实交易库**：商品进 products 表，订单读 orders。 */

  /** 从 query 里取一份已通过审核的申请；取不到就直接回错误响应，返回 null */
  const merchantOf = (req, res, url) => {
    try {
      return merchantShopService.requireApprovedMerchant(url.searchParams.get('id'), url.searchParams.get('key'));
    } catch (e) {
      sendError(res, e.status || 404, e.message, req.reqId);
      return null;
    }
  };

  // 一次拉全工作台：店铺 + 商品 + 订单 + 概览数字。
  // 分成四个请求也做得到，但工作台是「打开就要看见全貌」的页面，
  // 四个并发请求只会让首屏出现「店铺名有了、商品还在转」的半截状态。
  if (req.method === 'GET' && url.pathname === '/api/merchant/workspace') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    return guarded(() => {
      const shop = merchantShopService.getShop(app);
      const products = merchantShopService.listProducts(app);
      const orders = merchantShopService.listOrders(app);
      return {
        application: {
          id: app.id,
          brand: app.brand,
          company: app.company,
          status: app.status,
          categories: app.categories || [],
          materials: (app.materials || []).map((m) => ({ kind: m.kind, name: m.name })),
          bankNoMasked: app.bankNoMasked || '',
        },
        shop,
        products: products.items,
        productCounts: products.counts,
        orders: orders.items,
        orderCounts: orders.counts,
        stats: merchantShopRepo.statsOf(app.id),
        source: 'server',
      };
    });
  }

  // 商品图 / 店铺 Logo 上传：与买家秀同一套闸门（长度预检 → IP 频率 → 并发 → 配额），
  // 只是配额按「商家编号」计——同一家店不该因为是两个人操作就翻倍。
  if (req.method === 'POST' && url.pathname === '/api/merchant/media') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    const declared = Number(req.headers['content-length'] || 0);
    const maxBody = Math.ceil(UPLOAD_LIMIT * 1.4);
    if (declared && declared > maxBody) {
      return sendError(res, 413, `image too large (max ${Math.round(UPLOAD_LIMIT / 1024 / 1024)}MB)`, req.reqId);
    }
    const ipGate = uploadIpWindow.hit(req.ip);
    if (!ipGate.allowed) {
      res.setHeader('Retry-After', String(ipGate.retryAfterSec));
      return sendError(res, 429, '上传过于频繁，请稍后再试', req.reqId);
    }
    const release = uploadGate.acquire();
    if (!release) {
      res.setHeader('Retry-After', '2');
      return sendError(res, 503, '上传繁忙，请稍后再试', req.reqId);
    }
    try {
      const decoded = await decodeImageBody(req, res, UPLOAD_LIMIT);
      if (!decoded) return;
      const { buf, ext } = decoded;
      const quota = uploadDailyQuota.hit(`merchant:${app.id}`);
      if (!quota.allowed) {
        res.setHeader('Retry-After', String(quota.retryAfterSec));
        return sendError(res, 429, '今日上传已达上限，请明天再试', req.reqId);
      }
      // kind 决定命名空间：商品图与 Logo 必须分开，否则孤儿清理会互相误删
      const kind = String(url.searchParams.get('kind') || 'product');
      const ns = kind === 'logo' ? 'shops' : 'products';
      try {
        const saved = await storeImage(buf, ext, ns);
        log.info({
          reqId: req.reqId, event: 'merchant.upload', merchantId: app.id, ns, key: saved.key, bytes: buf.length,
        });
        return send(res, 201, saved);
      } catch (e) {
        log.error({ reqId: req.reqId, err: e.message, event: 'merchant.upload_failed' });
        return sendError(res, 502, '图片存储失败，请稍后重试', req.reqId);
      }
    } finally {
      release();
    }
  }

  if (url.pathname === '/api/merchant/shop') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    if (req.method === 'GET') return guarded(() => ({ shop: merchantShopService.getShop(app) }));
    if (req.method === 'PUT') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      try {
        const shop = merchantShopService.updateShop(app, parsed);
        log.info('merchant.shop_updated', { reqId: req.reqId, merchantId: app.id });
        return send(res, 200, { shop });
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId);
      }
    }
  }

  if (url.pathname === '/api/merchant/products') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    if (req.method === 'GET') return guarded(() => merchantShopService.listProducts(app));
    if (req.method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      try {
        const r = merchantShopService.createProduct(app, parsed);
        // 日志只记编号与状态，不记商品名（商家还没公开的选品不该进日志）
        log.info('merchant.product_submitted', { reqId: req.reqId, merchantId: app.id, productId: r.product.id });
        return send(res, 201, r);
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId);
      }
    }
  }

  const merchantProductMatch = url.pathname.match(/^\/api\/merchant\/products\/([^/]+)$/);
  if (merchantProductMatch && req.method === 'PATCH') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const pid = decodeURIComponent(merchantProductMatch[1]);
    try {
      if (parsed.action === 'stock') {
        return send(res, 200, merchantShopService.updateStock(app, pid, parsed.stock));
      }
      if (parsed.action === 'on' || parsed.action === 'off') {
        const r = merchantShopService.setProductStatus(app, pid, parsed.action === 'on' ? 'on_sale' : 'off_sale');
        log.info('merchant.product_status', { reqId: req.reqId, merchantId: app.id, productId: pid, status: parsed.action });
        return send(res, 200, r);
      }
      return sendError(res, 400, 'action 只能是 stock / on / off', req.reqId);
    } catch (e) {
      return sendError(res, e.status || 400, e.message, req.reqId);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/merchant/orders') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    return guarded(() => merchantShopService.listOrders(app, Object.fromEntries(url.searchParams)));
  }

  const merchantOrderMatch = url.pathname.match(/^\/api\/merchant\/orders\/([^/]+)$/);
  if (merchantOrderMatch && req.method === 'PATCH') {
    const app = merchantOf(req, res, url);
    if (!app) return;
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const r = merchantShopService.shipOrder(app, decodeURIComponent(merchantOrderMatch[1]), parsed);
      log.info('merchant.order_shipped', {
        reqId: req.reqId, merchantId: app.id, orderId: decodeURIComponent(merchantOrderMatch[1]),
      });
      return send(res, 200, r);
    } catch (e) {
      return sendError(res, e.status || 400, e.message, req.reqId);
    }
  }

  /* ---------------- 运营侧：商家商品审核 ---------------- */

  if (req.method === 'GET' && url.pathname === '/api/admin/products') {
    if (!requireAdmin(req, res)) return;
    return guarded(() => merchantShopService.listForReview(Object.fromEntries(url.searchParams)));
  }

  const adminProductMatch = url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (adminProductMatch) {
    const id = decodeURIComponent(adminProductMatch[1]);
    if (req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      return guarded(() => ({
        product: merchantShopRepo.findProduct(id),
        events: merchantShopService.productEvents(id),
      }));
    }
    if (req.method === 'PATCH') {
      if (!requireAdmin(req, res)) return;
      const parsed = await readJson(req);
      if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
      try {
        const r = await merchantShopService.reviewProduct(id, parsed, {
          by: adminActor(req),
        });
        log.info('merchant.product_reviewed', {
          reqId: req.reqId, productId: id, action: parsed.action, actor: adminActor(req),
        });
        return send(res, 200, r);
      } catch (e) {
        return sendError(res, e.status || 400, e.message, req.reqId);
      }
    }
  }

  // 导购推荐（AI 抽屉）：检索 + 可选 LLM 导购语。不落会话，永远带商品卡。
  // 前端拿到失败 / 超时会回落本地规则，所以这里 5xx 也可以放心抛。
  // 图片搜索（色彩特征）：前端只传主色签名，原图不上传。检索失败 / 无近色时前端回落本地模拟。
  if (req.method === 'POST' && url.pathname === '/api/ai/image-search') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const r = visualSearch.searchByColor(parsed.colors, { limit: 4 });
      return send(res, 200, r);
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/recommend') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const r = await chatEngine.shopRecommend({
        query: parsed.query,
        limit: Math.min(Number(parsed.limit) || 3, 5),
      });
      return send(res, 200, r);
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
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
        'GET|PUT /api/config (运营配置：配送/运费 + 支付方式 + 券返还顺延；写入需 X-Admin-Key)',
        'POST /api/orders/preview {userId, items?, addressId?, couponId?, shippingMethodId?, paymentMethodId?} (结算预览)',
        'GET /api/orders?userId= · POST /api/orders {userId, items, addressId?, couponId?, shippingMethodId?, paymentMethodId?, idempotencyKey?}',
        'GET /api/orders/:id?userId= (含物流事件与售后记录) · POST /api/orders/:id/pay?userId=',
        'POST /api/orders/:id/cancel?userId= (取消订单事务：关单 + 券返还顺延)',
        'POST /api/orders/:id/ship?userId= · /complete?userId= (演示：发货 / 签收，DEMO_ACTIONS=false 时 403)',
        'POST /api/orders/:id/aftersale {userId, type, reason, note?, evidence?} (申请售后，订单转售后中)',
        'POST /api/aftersale/evidence {data(base64)} (售后凭证上传，落对象存储，返回对象键)',
        'GET /api/aftersales?status=&reviewed=&page=&size= (运营工单列表，需 X-Admin-Key)',
        'PATCH /api/aftersales/:id {action, note?, refundAmount?} (审核：同意/驳回，需 X-Admin-Key)',
        'GET /api/ledger/pending?page=&size= (待打款退款清单，需 X-Admin-Key)',
        'POST /api/ledger/refunds/:id/settle (确认已打款，需 X-Admin-Key)',
        'POST /api/webhooks/logistics {trackingNo, events[]} (快递推送；X-Carrier + X-Timestamp + X-Signature 验签)',
        'GET|POST|DELETE /api/favorites?userId= (收藏夹：POST action=add|remove 显式增删，缺省 toggle)',
        'GET /api/coupons/catalog (券目录，前端离线兜底同构)',
        'PUT /api/coupons/catalog {coupon|coupons, force?} (券目录 upsert，需 X-Admin-Key)',
        'GET /api/coupons?userId=&amount=&all=1 (卡包；all=1 含已用/已过期)',
        'POST /api/coupons {userId, couponId} (领券，重复领取 409)',
        'POST /api/coupons/use {userId, couponId, orderId} (核销，幂等)',
        'POST /api/coupons/refund {userId, orderId} (取消订单返还 + 有效期顺延)',
        'GET|POST /api/addresses?userId= (地址簿：POST 带 id 即更新，返回最新清单)',
        'POST /api/addresses/:id/default?userId= (设为默认，幂等)',
        'DELETE /api/addresses/:id?userId= (删除；删默认则由剩余第一条接任)',
        'POST /api/merchant/applications {entityKind, company, creditCode, contact, phone, brand, brandSource, categories, skuRange, priceRange, bankAccount, bankNo, returnPolicy, shipWithin, submitKey} (入驻申请；幂等；银行账号只存前4后4)',
        'GET /api/merchant/applications/:id?key= (凭编号 + 查询凭证自查状态，双要素缺一为 404)',
        'GET /api/merchant/applications?status=&page=&size= (运营审核列表 + 状态计数，需 X-Admin-Key)',
        'GET /api/merchant/applications/:id (带 X-Admin-Key 时返回申请 + 审核轨迹 + 通知队列)',
        'PATCH /api/merchant/applications/:id {action:approve|reject, note?} (审核：驳回必填理由；终态再审核 409；需 X-Admin-Key)',
        'POST /api/merchant/notices/flush (手动投递一轮通知队列，需 X-Admin-Key)',
        'GET /api/merchant/notices/stats (通知队列计数 + 通道状态，需 X-Admin-Key)',
        'POST /api/merchant/applications/:id/revise?key= (商家审核前改资料：只传要改的字段；非 reviewing 409)',
        'POST /api/merchant/applications/:id/withdraw?key= {reason?} (商家撤回申请：不删除，状态置 withdrawn 并留轨迹)',
        'GET /api/merchant/applications/export?status= (导出 CSV，UTF-8 BOM + 公式注入防护，需 X-Admin-Key)',
        'GET /api/merchant/notice-templates (通知模板：默认值 + 覆盖项 + 可用变量，需 X-Admin-Key)',
        'PUT /api/merchant/notice-templates/:id {subject?, body?, enabled?} (保存模板，变量白名单校验)',
        'POST /api/merchant/notice-templates/:id/reset (恢复默认：删除覆盖行，需 X-Admin-Key)',
        'POST /api/merchant/notice-templates/:id/preview {applicationId?, note?} (预览渲染结果，不写库)',
        'POST /api/ai/recommend {query, limit?} (导购推荐：检索+可选LLM导购语，不落会话、永远带卡)',
        'POST /api/ai/image-search {colors:[{h,s,l,weight}]} (色彩特征最近邻检索，不上传原图)',
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
        // 演示端点开关：上线后一眼确认「模拟发货/签收」是否已关（关演示不该去翻环境变量）
        demo: config.demoActions ? 'on' : 'off',
        // 已开通的物流推送渠道（只列渠道名，不列密钥）。一家都没配时是个空数组，
        // 对接的人一眼就知道推送没生效是因为没配密钥，而不是签名算法写错了
        logisticsWebhookCarriers: [...config.logisticsWebhook.keys.keys()],
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
/**
 * 收集所有仍被引用的对象键。
 * 评价图与售后凭证一起收：凭证不在评价的引用集里，漏掉它就会被当成孤儿删掉——
 * 用户刚提交的破损照片，半小时后运营点开是一片空白。
 */
function collectReferencedKeys() {
  const referenced = new Set();
  const add = (raw, pick) => {
    try {
      for (const item of JSON.parse(raw || '[]')) {
        const k = pick(item);
        if (storage.isObjectKey(k)) referenced.add(k);
      }
    } catch { /* 坏数据跳过，不因此中断整个清理 */ }
  };
  for (const row of getDb().prepare('SELECT images FROM reviews').all()) {
    add(row.images, (v) => (typeof v === 'string' ? v : ''));
  }
  for (const row of getDb().prepare('SELECT evidence FROM aftersales').all()) {
    add(row.evidence, (v) => (v && typeof v === 'object' ? v.key : ''));
  }
  // 商家商品图与店铺 Logo 也要收进来：孤儿清理是按命名空间逐个比对的，
  // 引用集里没有它们，就等于把整店商品图判成孤儿——上线第二天店铺全白。
  for (const key of merchantShopRepo.listMerchantMediaKeys()) {
    if (storage.isObjectKey(key)) referenced.add(key);
  }
  return referenced;
}

async function runOrphanSweep() {
  try {
    const removed = await storage.sweepOrphans(collectReferencedKeys(), { logger: log });
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
  // 入驻审核结果通知的出站队列：后台静默投递，不阻塞请求。
  // 通道没配置时这里每天就是几条 skipped，不会空转打服务商。
  if (config.notify.flushIntervalSec > 0) {
    const noticeWorker = setInterval(() => {
      noticeService.flushSafely();
    }, config.notify.flushIntervalSec * 1000);
    if (noticeWorker.unref) noticeWorker.unref();
    const state = noticeService.channelState();
    log.info('notice.worker', {
      mode: state.mode,
      intervalSec: config.notify.flushIntervalSec,
      hint: state.ready ? undefined : '未配置 NOTIFY_WEBHOOK_URL：审核结果只在页面可见，通知标为「未配置通道」',
    });
    // 启动即扫一次：重启前积压的 queued 不该再等一个周期
    noticeService.flushSafely();
  }
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
