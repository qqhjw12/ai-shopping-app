// 账户状态：当前登录用户的唯一真相源，持久化在 localStorage 的 current_user。
//
// 约定（与 auth.js 严格分工）：
//   - 这里只存「用户资料」（id / 昵称 / 登录标识 / 登录时间），可安全落盘；
//   - 访问令牌与刷新令牌一律不落 localStorage（见 auth.js 顶部说明），
//     所以本模块不 import auth.js，避免把令牌语义混进账户资料。
//   - 未登录返回 null，调用方据此决定跳登录还是按匿名继续。

const USER_KEY = 'current_user';

/** 订阅者：登录 / 登出 / 资料变更时通知（顶栏与个人中心据此重绘） */
const listeners = new Set();

export function onUserChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(user) {
  // 必须遍历快照：订阅者回调里常常会「先退订再重绘」，重绘又注册一个新回调。
  // 直接遍历 Set 的话，新增的订阅者在同一轮里也会被访问，于是「退订→注册→再触发」
  // 无限循环，表现为登录/换号后页面疯狂重绘直到卡死。
  [...listeners].forEach((fn) => {
    try {
      fn(user);
    } catch {
      /* 单个订阅者出错不影响其他 */
    }
  });
}

/** 当前登录用户；未登录或数据损坏返回 null（宁可当未登录，也不要卡在半个坏状态里） */
export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || typeof u !== 'object' || !u.id) return null;
    return u;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return !!getCurrentUser();
}

/** 写入登录态（登录成功调用）。只接受已知字段，防止外部塞入任意内容。 */
export function setCurrentUser(input) {
  const user = {
    id: String(input.id || '').trim(),
    nickname: String(input.nickname || '').trim() || 'MAISON 会员',
    identifier: String(input.identifier || '').trim(),
    via: ['demo', 'sms', 'password'].includes(input.via) ? input.via : 'sms',
    loginAt: new Date().toISOString(),
  };
  if (!user.id) throw new Error('用户 ID 不能为空');
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 隐私模式 / 配额满：本次仍然生效（调用方持有内存态），只是刷新后需重登 */
  }
  emit(user);
  return user;
}

export function clearCurrentUser() {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  emit(null);
}

/** 演示账号：一键登录用，也是验收脚本里的固定身份 */
export const DEMO_ACCOUNT = {
  id: 'u_demo',
  nickname: '演示买手',
  identifier: '13800000000',
  via: 'demo',
};

/** 演示验证码（mock 登录，不接短信网关） */
export const DEMO_CODE = '123456';

/* ---------------- 展示辅助 ---------------- */

/** 昵称：优先用户设置，其次掩码标识 */
export function displayName(user) {
  if (!user) return '未登录';
  return user.nickname || maskIdentifier(user.identifier) || 'MAISON 会员';
}

/** 头像字：昵称首字（中文）或首字母（英文） */
export function initials(user) {
  if (!user) return '·';
  const name = String(user.nickname || user.identifier || 'M').trim();
  const first = name[0] || 'M';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

/** 手机号 138****0000 / 邮箱 ab***@x.com —— 个人中心展示用，不把完整标识铺在页面上 */
export function maskIdentifier(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.includes('@')) {
    const [name, domain] = s.split('@');
    const head = name.slice(0, 2);
    return `${head}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
  }
  if (/^\d{11}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-4)}`;
  return s;
}

/**
 * 登录标识 → 稳定的用户 ID。
 * 同一手机号/邮箱在任何设备上都要映射到同一个账户，否则「订单归属」会随设备漂移。
 */
export function userIdOf(identifier) {
  const s = String(identifier || '').trim().toLowerCase();
  if (!s) return '';
  // djbt2 变体哈希（无依赖、稳定、够短）——仅用于生成可读 ID，不承担安全职能
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `u_${h.toString(36)}`;
}

/** 手机号 / 邮箱识别：返回 'phone' | 'email' | '' */
export function identifierKind(value) {
  const s = String(value || '').trim();
  if (/^1[3-9]\d{9}$/.test(s)) return 'phone';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) return 'email';
  return '';
}

/** 由登录标识推导默认昵称 */
export function nicknameOf(identifier) {
  const s = String(identifier || '').trim();
  if (!s) return 'MAISON 会员';
  if (s.includes('@')) return s.split('@')[0];
  if (/^\d{11}$/.test(s)) return `用户${s.slice(-4)}`;
  return s;
}
