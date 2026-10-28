// 极简 JWT（HS256）签发与校验，零依赖，仅用 node:crypto。
// 只实现本项目需要的 HS256；不追求算法协商（反而更安全：固定 alg 可防 alg=none 类攻击）。
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');
const hmac = (data, secret) => createHmac('sha256', secret).update(data).digest();

/**
 * 签发访问令牌。
 * @param {object} payload  例如 { sub: 'u_xxx' }
 * @param {{secret:string, ttlSec:number, issuer?:string}} opts
 */
export function signAccessToken(payload, { secret, ttlSec, issuer }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSec };
  if (issuer) body.iss = issuer;
  const p1 = b64url(JSON.stringify(header));
  const p2 = b64url(JSON.stringify(body));
  const sig = b64url(hmac(`${p1}.${p2}`, secret));
  return `${p1}.${p2}.${sig}`;
}

/**
 * 校验访问令牌，成功返回 payload，失败抛错（message 不对外暴露细节）。
 * 校验项：结构 → 签名（常数时间比较）→ 过期 → 签发方。
 */
export function verifyAccessToken(token, { secret, issuer }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [p1, p2, sig] = parts;
  const expected = hmac(`${p1}.${p2}`, secret);
  const got = fromB64url(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    throw new Error('bad signature');
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(p2).toString('utf8'));
  } catch {
    throw new Error('bad payload');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) throw new Error('token expired');
  if (issuer && payload.iss !== issuer) throw new Error('bad issuer');
  return payload;
}
