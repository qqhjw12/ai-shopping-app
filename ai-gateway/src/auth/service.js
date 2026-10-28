// 认证服务：登录签发、刷新轮换、登出撤销、过期清理。
// 设计要点：
//   · 访问令牌短时效（JWT，内存持有），刷新令牌长时效且【服务端存哈希】。
//   · 刷新即轮换：旧令牌立刻作废并签发同族新令牌（一次性使用）。
//   · 重放检测：已作废令牌再次出现，视为泄露 → 撤销整个家族，强制重新登录。
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import * as authRepo from '../repositories/authRepo.js';
import * as userRepo from '../repositories/userRepo.js';
import { signAccessToken } from './jwt.js';
import { getSecret } from './keys.js';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newRefreshToken = () => randomBytes(32).toString('base64url');

// SQLite 存 UTC 'YYYY-MM-DD HH:MM:SS'，与 datetime('now') 对齐
const toSqliteTime = (msFromNow) =>
  new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
const parseSqliteTime = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).getTime();

function issueAccess(userId) {
  return signAccessToken(
    { sub: userId },
    { secret: getSecret(), ttlSec: config.auth.accessTtlSec, issuer: config.auth.issuer },
  );
}

/** 在指定家族内签发一对令牌；replacedId 非空时同步作废旧记录（轮换） */
function issuePair({ userId, familyId, ua, ip, replacedId = null }) {
  const refreshToken = newRefreshToken();
  const id = randomUUID();
  const expiresAt = toSqliteTime(config.auth.refreshTtlSec * 1000);
  authRepo.insertRefreshToken({
    id,
    userId,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt,
    userAgent: ua,
    ip,
  });
  if (replacedId) authRepo.revokeToken(replacedId, id);
  return {
    userId,
    accessToken: issueAccess(userId),
    accessExpiresIn: config.auth.accessTtlSec,
    refreshToken,
    refreshExpiresIn: config.auth.refreshTtlSec,
  };
}

/** 登录：确保用户存在后开启一个新家族并签发令牌（演示项目无密码，userId 即身份） */
export function login({ userId, nickname, ua = '', ip = '' }) {
  const uid = userRepo.ensureUser(userId, nickname || '游客');
  return issuePair({ userId: uid, familyId: randomUUID(), ua, ip });
}

/** 刷新：校验哈希 → 检查作废/过期 → 轮换签发（旧令牌一次性作废） */
export function rotate(refreshToken, { ua = '', ip = '' } = {}) {
  const err = (msg, code) => Object.assign(new Error(msg), { status: 401, code });
  if (!refreshToken) throw err('缺少刷新令牌', 'no_refresh');

  const row = authRepo.findByHash(hashToken(refreshToken));
  if (!row) throw err('刷新令牌无效', 'invalid_refresh');

  // 已作废的令牌被重放：视为泄露，整族撤销
  if (row.revoked_at) {
    authRepo.revokeFamily(row.family_id);
    throw err('刷新令牌已失效，请重新登录', 'token_reuse');
  }
  if (parseSqliteTime(row.expires_at) <= Date.now()) {
    authRepo.revokeToken(row.id);
    throw err('刷新令牌已过期，请重新登录', 'refresh_expired');
  }
  return issuePair({ userId: row.user_id, familyId: row.family_id, ua, ip, replacedId: row.id });
}

/** 登出：作废当前刷新令牌（幂等，令牌不存在也算成功） */
export function logout(refreshToken) {
  if (!refreshToken) return false;
  const row = authRepo.findByHash(hashToken(refreshToken));
  if (row && !row.revoked_at) {
    authRepo.revokeToken(row.id);
    return true;
  }
  return false;
}

/** 清理已过期记录，返回删除条数（启动时 + 周期任务调用） */
export function cleanupExpired() {
  return authRepo.purgeExpired(toSqliteTime(0));
}
