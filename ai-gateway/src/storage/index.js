// 对象存储门面：上层只认识「存一个对象、拿一个可访问 URL、删一个对象」，
// 具体落到 S3 兼容存储还是本地磁盘由 STORAGE_DRIVER 决定。
//
// 关键设计：**数据库里只存对象键（key），不存 URL**。
// 预签名 URL 是有时效的（默认 15 分钟），存下来第二天就是一堆死链；
// 读取时用 key 现签一次，才是正确姿势。旧的 `/api/uploads/xxx.png` 记录
// 继续按原样透传（由本地静态路由兜底），不破坏历史数据。
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { config } from '../config.js';
import * as s3 from './s3Client.js';

const LOCAL_DIR = resolvePath(process.cwd(), 'data/uploads');
const LEGACY_PREFIX = '/api/uploads/';
/**
 * 对象键命名空间：reviews 是买家秀，evidence 是售后凭证。
 * 两者必须分开——孤儿清理按「评价引用了哪些键」来判定，凭证图不在那个集合里，
 * 共用前缀会被当成没人引用的孤儿直接删掉（凭证提交后过半小时图片就没了）。
 */
export const KEY_NAMESPACES = ['reviews', 'evidence'];
// 对象键格式：<ns>/2026/10/<uuid>.jpg（按年月分目录，便于后续生命周期策略）
const KEY_RE = /^(?:reviews|evidence)\/\d{4}\/\d{2}\/[A-Za-z0-9-]{1,64}\.(?:jpg|jpeg|png|webp|gif)$/;

export const isObjectKey = (value) => typeof value === 'string' && KEY_RE.test(value);
export const isLegacyUpload = (value) => typeof value === 'string' && value.startsWith(LEGACY_PREFIX);
const isAbsolute = (value) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(String(value)) || String(value).startsWith('data:');

/**
 * 启动期校验：选 s3 就必须把连接信息配全，缺一个就在启动时炸掉，
 * 而不是等用户上传时才发现 500。
 */
function assertS3Config() {
  const s = config.storage;
  const missing = [
    ['S3_ENDPOINT', s.endpoint],
    ['S3_BUCKET', s.bucket],
    ['S3_ACCESS_KEY_ID', s.accessKeyId],
    ['S3_SECRET_ACCESS_KEY', s.secretAccessKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `STORAGE_DRIVER=s3 但缺少配置：${missing.join(', ')}。`
      + '本地可用 `bash scripts/dev-storage.sh` 起一个 S3 替身并按其输出设置环境变量；'
      + '不想接对象存储就把 STORAGE_DRIVER 设为 local。',
    );
  }
}

if (config.storage.driver === 's3') assertS3Config();

export function storageInfo() {
  const s = config.storage;
  return {
    driver: s.driver,
    // 不打印密钥，只暴露能定位问题的最小信息
    bucket: s.driver === 's3' ? s.bucket : 'local:data/uploads',
    endpoint: s.driver === 's3' ? s.endpoint : '',
    signedUrlTtlSec: s.mediaUrlTtl,
  };
}

function buildKey(ext, ns = 'reviews') {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${ns}/${yyyy}/${mm}/${randomUUID()}${ext}`;
}

/**
 * 存一个对象。
 * @param {{buffer: Buffer, ext: string, contentType: string, ns?: string}} input
 * @returns {Promise<{key: string, url: string, driver: string}>} url 是可直接渲染的地址
 */
export async function saveObject({ buffer, ext, contentType, ns = 'reviews' }) {
  const key = buildKey(ext, KEY_NAMESPACES.includes(ns) ? ns : 'reviews');
  if (config.storage.driver === 's3') {
    await s3.putObject(config.storage, key, buffer, contentType);
    return { key, url: resolveMedia(key), driver: 's3' };
  }
  // 本地驱动：键仍是逻辑路径，落盘拍平到 data/uploads/<uuid>.<ext>
  await mkdir(LOCAL_DIR, { recursive: true });
  await writeFile(join(LOCAL_DIR, basename(key)), buffer);
  return { key, url: resolveMedia(key), driver: 'local' };
}

/**
 * 把「键 / 旧相对路径 / 绝对 URL」统一解析成可直接放进 <img src> 的地址。
 * - 对象键 → 现签的预签名 URL（s3 驱动）或本地静态路由（local 驱动）
 * - 旧的 /api/uploads/… → 原样返回（前端 mediaUrl() 会补 API 前缀）
 * - 已是绝对 URL / data: → 原样返回
 */
export function resolveMedia(value) {
  if (!value) return '';
  if (isObjectKey(value)) {
    if (config.storage.driver === 's3') {
      return s3.presignGet(config.storage, value, { expires: config.storage.mediaUrlTtl });
    }
    return `${LEGACY_PREFIX}${basename(value)}`;
  }
  if (isLegacyUpload(value) || isAbsolute(value)) return value;
  return value;
}

export function resolveMediaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(resolveMedia);
}

/** 删除对象（失败只记日志，不阻断主流程：图删不掉比评价删不掉轻得多） */
export async function removeObject(key) {
  if (!isObjectKey(key)) return false;
  try {
    if (config.storage.driver === 's3') await s3.deleteObject(config.storage, key);
    else await unlink(join(LOCAL_DIR, basename(key)));
    return true;
  } catch {
    return false;
  }
}

/**
 * 孤儿对象清理：删除「存储中存在、但没有任何评价引用」的对象。
 * 覆盖两类泄漏：① 上传了但没发布（或编辑时去掉了）的图片；② 评价被删后图片对象残留。
 *
 * @param {Set<string>|string[]} referencedKeys 所有被评价引用的对象键集合
 * @param {{logger?: object}} [opts]
 * @returns {Promise<number>} 实际删除的对象数
 */
export async function sweepOrphans(referencedKeys, { logger } = {}) {
  const referenced = new Set([...(Array.isArray(referencedKeys) ? referencedKeys : referencedKeys.keys?.() || [])]);
  let removed = 0;
  if (config.storage.driver === 's3') {
    // 两个命名空间都要扫：只扫 reviews 的话，凭证图永远扫不到，
    // 用户删掉工单后就变成没人付钱的死对象（账单上是真金白银）。
    for (const ns of KEY_NAMESPACES) {
      let keys = [];
      try {
        keys = await s3.listObjects(config.storage, `${ns}/`);
      } catch (err) {
        logger?.warn?.({ event: 'storage.sweep_list_failed', ns, err: err.message });
        continue;
      }
      for (const k of keys) {
        if (!referenced.has(k)) {
          if (await removeObject(k)) removed += 1;
        }
      }
    }
  } else {
    // 本地驱动：磁盘文件名是键的 basename（年月被拍平），所以按 basename 比对引用集
    const referencedBases = new Set([...referenced].map((k) => basename(k)));
    let files = [];
    try {
      files = await readdir(LOCAL_DIR);
    } catch {
      return 0; // 目录还没建（从未上传过）→ 没东西可清
    }
    for (const name of files) {
      if (!referencedBases.has(name)) {
        if (await removeObject(`reviews/0000/00/${name}`)) removed += 1;
      }
    }
  }
  if (removed) logger?.info?.({ event: 'storage.sweep', removed });
  return removed;
}

/** 启动自检：bucket 不存在就建一个；连不上只告警（本地驱动不用管） */
export async function ensureReady(logger) {
  if (config.storage.driver !== 's3') return { ok: true, driver: 'local' };
  try {
    await s3.headBucket(config.storage);
    return { ok: true, driver: 's3' };
  } catch (err) {
    if (err.status === 404) {
      try {
        await s3.createBucket(config.storage);
        logger?.info?.({ event: 'storage.bucket_created', bucket: config.storage.bucket });
        return { ok: true, driver: 's3', created: true };
      } catch (createErr) {
        logger?.warn?.({ event: 'storage.bucket_create_failed', err: createErr.message });
        return { ok: false, driver: 's3', error: createErr.message };
      }
    }
    logger?.warn?.({ event: 'storage.unreachable', endpoint: config.storage.endpoint, err: err.message });
    return { ok: false, driver: 's3', error: err.message };
  }
}

export const IMAGE_EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
