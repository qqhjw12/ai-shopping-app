import { config } from './config.js';
import { randomUUID } from './logger.js';
import { verifyAccessToken } from './auth/jwt.js';
import { getSecret } from './auth/keys.js';

// 每 IP 的固定窗口限流桶：ip -> { count, resetAt }
const buckets = new Map();

// 取出真实客户端 IP（前置反代时优先 X-Forwarded-For）
export function getClientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// 为每个请求附加请求 ID、IP、开始时间
export function attachContext(req, res) {
  req.reqId = randomUUID();
  req.ip = getClientIp(req);
  req.startedAt = Date.now();
  res.setHeader('X-Request-Id', req.reqId);
}

// CORS：仅允许显式来源列表中匹配的来源；通配符 '*' 仅当显式配置时生效
export function applyCors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins;
  let allow = '';
  if (allowed.includes('*')) {
    allow = '*';
  } else if (origin && allowed.includes(origin)) {
    allow = origin;
  }
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    // PATCH / DELETE 是购物车改量、删条目、删地址在用的方法，漏掉会被预检直接拦死。
    // X-Admin-Key / X-Admin-Actor 是运营后台改配置用的自定义头：自定义头必须显式允许，
    // 否则浏览器预检直接失败（表现为「Failed to fetch」，且看服务端日志一条请求都没有）。
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Admin-Key, X-Admin-Actor');
    if (allow !== '*') {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  return allow;
}

// 限流：返回 { allowed, retryAfterSec }
// allowed=false 时调用方应返回 429 并写入 Retry-After
export function checkRateLimit(req) {
  const limit = config.rateLimitPerMin;
  if (!limit || limit <= 0) return { allowed: true, retryAfterSec: 0 };
  const ip = getClientIp(req);
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

// 鉴权：未配置 key 则开放；配置后必须携带 X-API-Key 或 Authorization: Bearer
export function checkAuth(req) {
  const key = config.aiGatewayApiKey;
  if (!key) return true;
  const provided =
    req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    '';
  return provided === key;
}

/** 解析 Cookie 头为对象（值做 decodeURIComponent，解析失败则保留原串） */
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 解析访问令牌（可选认证）：成功则把身份挂到 req.authUserId / req.auth。
 * 失败不抛错也不拦截——是否需要强制鉴权由调用方按 config.auth.required 决定。
 * @returns {object|null} 令牌载荷
 */
export function authenticate(req) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return null;
  try {
    const payload = verifyAccessToken(raw, { secret: getSecret(), issuer: config.auth.issuer });
    req.auth = payload;
    req.authUserId = payload.sub;
    return payload;
  } catch {
    return null;
  }
}
