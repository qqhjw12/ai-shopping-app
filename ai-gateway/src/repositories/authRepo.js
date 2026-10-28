// 刷新令牌仓储：全部参数化查询，库里只存哈希，绝不落明文令牌。
import { getDb } from '../db/connection.js';

/** 插入一条刷新令牌记录（tokenHash 为 sha256 十六进制） */
export function insertRefreshToken({ id, userId, tokenHash, familyId, expiresAt, userAgent = '', ip = '' }) {
  getDb()
    .prepare(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, userId, tokenHash, familyId, expiresAt, userAgent, ip);
}

/** 按哈希查令牌记录（哈希索引，等值查询） */
export function findByHash(tokenHash) {
  return getDb()
    .prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?')
    .get(tokenHash) || null;
}

/** 作废单条令牌（可记录被替换成哪条，便于审计轮换链路） */
export function revokeToken(id, replacedBy = null) {
  return getDb()
    .prepare("UPDATE refresh_tokens SET revoked_at = datetime('now'), replaced_by = ? WHERE id = ? AND revoked_at IS NULL")
    .run(replacedBy, id).changes;
}

/** 撤销整个轮换家族（检测到重放时使用） */
export function revokeFamily(familyId) {
  return getDb()
    .prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE family_id = ? AND revoked_at IS NULL")
    .run(familyId).changes;
}

/** 撤销某用户全部未作废令牌（可用于「退出所有设备」） */
export function revokeAllForUser(userId) {
  return getDb()
    .prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL")
    .run(userId).changes;
}

/** 清理已过期记录，返回删除条数 */
export function purgeExpired(nowIso) {
  return getDb().prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(nowIso).changes;
}
