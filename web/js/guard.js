// 路由守卫规则：哪些页面必须登录 + 登录后往哪回。
//
// 单独成模块的原因：规则要能被 app.js（拦截）、login.js（回流）、自检脚本（断言）三处共用，
// 各写一份迟早会漂移成「拦截到 /checkout，登录后回到 /account」这种错位。

/** 受保护路径（前缀匹配，含子路由如 /account/order/xxx） */
const PROTECTED = ['/account', '/checkout', '/orders', '/favorites'];

export function isProtectedPath(path) {
  const p = String(path || '/').split('?')[0];
  return PROTECTED.some((base) => p === base || p.startsWith(`${base}/`));
}

/**
 * 归一化回流地址：只接受站内 hash 路径，杜绝开放重定向
 * （`//evil.com` 这类协议相对 URL 会被浏览器当成外站）。
 * @returns {string} 带 # 的完整 hash，如 '#/checkout'
 */
export function sanitizeRedirect(raw, fallback = '#/account') {
  const s = String(raw || '');
  if (!s.startsWith('/') || s.startsWith('//')) return fallback;
  // 回到登录页自己没有意义，会形成「登录成功 → 又回登录页」的死循环
  if (s.split('?')[0] === '/login') return fallback;
  return `#${s}`;
}

/** 未登录时的跳转目标：带上原始 hash（含查询串），登录后可原路返回 */
export function loginTarget(raw) {
  const s = String(raw || '/');
  return `#/login?redirect=${encodeURIComponent(s)}`;
}
