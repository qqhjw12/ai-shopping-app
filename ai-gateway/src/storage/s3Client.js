// 最小可用的 S3 客户端：只做本项目需要的几个动作 —— PutObject、预签名 GET、
// DeleteObject、以及启动时的 bucket 探测/创建。
//
// 为什么手写 SigV4 而不引 AWS SDK：网关至今零运行时依赖（只靠 Node 22 内置能力），
// 为一个上传接口拉进几十个包不划算；SigV4 是稳定的公开规范，这里实现的是
// S3 兼容存储的公共子集（SeaweedFS / MinIO / OSS / R2 / AWS 都认）。
//
// 寻址方式：默认 path-style（`{endpoint}/{bucket}/{key}`），本地 S3 替身都吃这套；
// 真 AWS 需要 vhost 时设 S3_FORCE_PATH_STYLE=0，并把 endpoint 写成
// `https://s3.<region>.amazonaws.com`（此时 key 直接拼在 host 后面）。
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 百分号编码。
 * encodeURIComponent 不转 `! ' ( ) *`，SigV4 要求这些也编码；
 * 漏转会导致签名与服务端算出的不一致（403 SignatureDoesNotMatch）。
 */
function uriEncode(input, encodeSlash = true) {
  let out = '';
  for (const byte of Buffer.from(String(input), 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

const amzStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function endpointOf(cfg) {
  const url = new URL(cfg.endpoint);
  return { host: url.host, protocol: url.protocol, prefix: url.pathname.replace(/\/+$/, '') };
}

/** 对象路径（path-style 带 bucket，vhost 模式不带） */
function objectPath(cfg, key) {
  const { prefix } = endpointOf(cfg);
  const encoded = uriEncode(key, false);
  return cfg.forcePathStyle ? `${prefix}/${cfg.bucket}/${encoded}` : `${prefix}/${encoded}`;
}

/** bucket 级路径（建桶、探桶用） */
function bucketPath(cfg) {
  const { prefix } = endpointOf(cfg);
  return cfg.forcePathStyle ? `${prefix}/${cfg.bucket}` : `${prefix}/`;
}

function signingKey(cfg, dateStamp) {
  return hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), cfg.region), SERVICE), 'aws4_request');
}

function credentialScope(cfg, dateStamp) {
  return `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;
}

function sign(cfg, stringToSign, dateStamp) {
  return createHmac('sha256', signingKey(cfg, dateStamp)).update(stringToSign, 'utf8').digest('hex');
}

/**
 * 生成预签名 GET URL（查询串签名）。
 * @param {object} cfg 存储配置
 * @param {string} key 对象键
 * @param {{expires?: number, now?: Date}} [opts] expires 单位秒
 * @returns {string} 绝对 URL，过期后 S3 直接返回 403
 */
export function presignGet(cfg, key, { expires = 900, now = new Date() } = {}) {
  const { host } = endpointOf(cfg);
  const stamp = amzStamp(now);
  const dateStamp = stamp.slice(0, 8);
  const path = objectPath(cfg, key);

  const params = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${credentialScope(cfg, dateStamp)}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  // 查询串按键名排序后再签名，URL 里的顺序必须和签名时逐字节一致
  const canonicalQuery = params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = ['GET', path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = [ALGORITHM, stamp, credentialScope(cfg, dateStamp), sha256Hex(canonicalRequest)].join('\n');
  const signature = sign(cfg, stringToSign, dateStamp);

  return `${cfg.endpoint}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * 发一个 SigV4 签名的请求。path 由调用方给（对象级或 bucket 级）。
 * 不签 content-length：它是 Node 自动注入的，签了容易与服务端看到的值不一致。
 */
function signedRequest(cfg, { method, path, body, headers: extraHeaders = {} }) {
  const { host, protocol } = endpointOf(cfg);
  const payload = body || null;
  const payloadHash = payload ? sha256Hex(payload) : EMPTY_SHA256;
  const stamp = amzStamp(new Date());

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp, ...extraHeaders };
  if (payload) headers['content-length'] = String(payload.length);

  const signedHeaders = Object.keys(headers).filter((h) => h !== 'content-length').sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');

  const dateStamp = stamp.slice(0, 8);
  const stringToSign = [ALGORITHM, stamp, credentialScope(cfg, dateStamp), sha256Hex(canonicalRequest)].join('\n');
  headers.authorization = `${ALGORITHM} Credential=${cfg.accessKeyId}/${credentialScope(cfg, dateStamp)}, `
    + `SignedHeaders=${signedHeaders.join(';')}, Signature=${sign(cfg, stringToSign, dateStamp)}`;

  const client = protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(`${cfg.endpoint}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, body: text });
        // S3 错误体是 XML，把 Code/Message 抽出来，日志里能直接区分签名错还是权限错
        const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || '';
        const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] || text.slice(0, 200);
        const err = new Error(`S3 ${method} ${path} → ${res.statusCode} ${code} ${message}`.trim());
        err.status = res.statusCode;
        err.code = code;
        reject(err);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function putObject(cfg, key, body, contentType) {
  return signedRequest(cfg, {
    method: 'PUT',
    path: objectPath(cfg, key),
    body,
    headers: { 'content-type': contentType || 'application/octet-stream' },
  });
}

export async function deleteObject(cfg, key) {
  return signedRequest(cfg, { method: 'DELETE', path: objectPath(cfg, key) });
}

/** 建桶（幂等：已存在时 S3 返回 409 BucketAlreadyOwnedByYou，按成功处理） */
export async function createBucket(cfg) {
  try {
    return await signedRequest(cfg, { method: 'PUT', path: bucketPath(cfg) });
  } catch (err) {
    if (err.status === 409) return { status: 409, body: '' };
    throw err;
  }
}

export async function headBucket(cfg) {
  return signedRequest(cfg, { method: 'HEAD', path: bucketPath(cfg) });
}
