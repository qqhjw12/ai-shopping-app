// 认证客户端：访问令牌【只存内存】，刷新令牌由服务端以 HttpOnly Cookie 下发。
// 注意：令牌绝不写入 localStorage / sessionStorage，也不放进 URL 查询参数。
// 刷新失败（未登录 / 令牌过期）返回 null，由调用方决定是否重新登录或降级匿名。

// Base URL 与 api.js 同源策略（?api= 可覆盖跨端口直连）
const API_BASE = new URLSearchParams(location.search).get('api') || location.origin;

let accessToken = '';
let accessExpiresAt = 0; // 毫秒时间戳；提前 30s 视为过期，避免边界请求恰好过期
let inflightRefresh = null;
// 当前令牌属于哪个用户：用于「页面登录用户 ≠ 令牌身份」时不把令牌发出去，
// 否则服务端按令牌取身份，会读到上一个身份（匿名/旧账号）的数据。
let tokenSubject = '';

// 「本设备是否拿到过刷新令牌」的布尔标记（不是令牌本身，只是让前端少一次必然 401 的探测）。
// 刷新令牌本体在 HttpOnly Cookie 里，JS 读不到也不需要读。
const FLAG_KEY = 'maison_has_refresh';

function hasRefreshFlag() {
  try {
    return localStorage.getItem(FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function setRefreshFlag(on) {
  try {
    if (on) localStorage.setItem(FLAG_KEY, '1');
    else localStorage.removeItem(FLAG_KEY);
  } catch {
    /* 隐私模式：降级为每次探测 */
  }
}

function setToken(token, expiresInSec) {
  accessToken = token || '';
  accessExpiresAt = token ? Date.now() + Math.max(0, expiresInSec - 30) * 1000 : 0;
}

/** 当前可用的访问令牌（过期也返回，交给 401 触发刷新） */
export function getAccessToken() {
  return accessToken;
}

/** 令牌所属的用户 ID（未建会话时为空串） */
export function tokenOwner() {
  return tokenSubject;
}

export function hasValidToken() {
  return !!accessToken && Date.now() < accessExpiresAt;
}

function authFetch(path, body) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // 关键：带上 HttpOnly 刷新令牌 Cookie
    body: JSON.stringify(body || {}),
  });
}

/** 登录（演示项目无密码，userId 即身份） */
export async function login(userId, nickname) {
  const resp = await authFetch('/api/auth/login', { userId, nickname });
  if (!resp.ok) throw new Error('登录失败');
  const d = await resp.json();
  setToken(d.accessToken, d.expiresIn);
  tokenSubject = String(userId || '');
  setRefreshFlag(true);
  return d.user || null;
}

/**
 * 用 HttpOnly Cookie 里的刷新令牌换新的访问令牌。
 * 并发调用会复用同一个进行中的请求（避免刷新风暴）。
 * @returns {Promise<string|null>} 成功返回访问令牌，失败返回 null
 */
export function refreshAccessToken() {
  if (inflightRefresh) return inflightRefresh;
  // 本设备从没拿到过刷新令牌（首次访问 / 已登出）：不做这次必然 401 的探测
  if (!hasRefreshFlag()) return Promise.resolve(null);
  inflightRefresh = (async () => {
    try {
      const resp = await authFetch('/api/auth/refresh');
      if (!resp.ok) {
        setToken('', 0);
        if (resp.status === 401) setRefreshFlag(false); // Cookie 已被服务端作废，别再来回试
        return null;
      }
      const d = await resp.json();
      setToken(d.accessToken, d.expiresIn);
      setRefreshFlag(true);
      return d.accessToken;
    } catch {
      setToken('', 0);
      return null;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/**
 * 确保有会话：已有令牌直接过；否则先试刷新（Cookie），再退化为登录。
 * 网关不可达时（GitHub Pages 纯静态演示）静默返回 false，不影响匿名浏览。
 */
export async function ensureSession(userId) {
  if (hasValidToken()) return true;
  const refreshed = await refreshAccessToken();
  if (refreshed) return true;
  try {
    await login(userId);
    return true;
  } catch {
    return false;
  }
}

/** 登出：作废服务端刷新令牌并清 Cookie，本地令牌清空 */
export async function logout() {
  try {
    await authFetch('/api/auth/logout');
  } catch {
    /* 离线也要清本地令牌 */
  }
  setToken('', 0);
  tokenSubject = '';
  setRefreshFlag(false);
}

/** 当前用户（需要有效访问令牌） */
export async function me() {
  const token = getAccessToken();
  if (!token) return null;
  const resp = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.user || null;
}
