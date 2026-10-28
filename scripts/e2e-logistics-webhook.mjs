#!/usr/bin/env node
/**
 * 快递 webhook 验收（真网关 + 临时库，纯 API）。
 *
 * 公开端点没签名等于谁都能把别人的订单改成已签收，所以重点验鉴权与幂等：
 *   1) HMAC-SHA256 验签：无签名 / 错密钥 / 未启用渠道 / 过期时间戳 → 全部 401；
 *   2) 重放：同一条推送再来一次，事件去重（库层唯一索引，不靠先查后插）；
 *   3) 坏数据：签收早于发货、事件时间在未来 → 收下 200 但拒绝落地，
 *      不推进订单——4xx 会让快递无限重推，重推一万次坏数据还是坏的；
 *   4) 签收推进 completed，且时间取快递给的，不是服务器收包时间；
 *   5) 时区口径：webhook 写入的时间必须和发货写入的同一口径
 *      （差整 8 小时 = 已格式化时间又被当本地时间解析了一遍）。
 *
 * 用法：node scripts/e2e-logistics-webhook.mjs [--gw 8103]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const GW_PORT = Number(argOf('--gw', '8103'));
const GW = `http://127.0.0.1:${GW_PORT}`;
const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-webhook.db');
const ADMIN_KEY = 'e2e-admin-key-4c1f';
const CARRIER_KEYS = { sf: 'sk-sf-e2e-1', yd: 'sk-yd-e2e-2' };

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: join(ROOT, 'ai-gateway'),
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      DB_FILE: DB,
      RATE_LIMIT_PER_MIN: '0',
      ADMIN_API_KEY: ADMIN_KEY,
      LOGISTICS_WEBHOOK_KEYS: Object.entries(CARRIER_KEYS).map(([k, v]) => `${k}:${v}`).join(','),
    },
  },
);
gateway.stderr.on('data', (b) => process.stdout.write(`[gw-err] ${b}`));

async function req(method, path, body = null, headers = {}) {
  const r = await fetch(`${GW}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch { /* 空 */ }
  return { status: r.status, d };
}

/** 与服务端口径一致：HMAC-SHA256(密钥, `${ts}.${原始body}`) */
function signedHeaders(carrier, bodyObj, { ts = Math.floor(Date.now() / 1000), secret = null } = {}) {
  const raw = JSON.stringify(bodyObj);
  const sig = createHmac('sha256', secret === null ? (CARRIER_KEYS[carrier] || '') : secret)
    .update(`${ts}.${raw}`).digest('hex');
  return { 'X-Carrier': carrier, 'X-Timestamp': String(ts), 'X-Signature': sig };
}
const rawPost = async (path, bodyObj, headers) => {
  const r = await fetch(`${GW}${path}`, { method: 'POST', headers, body: JSON.stringify(bodyObj) });
  let d = {};
  try { d = await r.json(); } catch { /* 空 */ }
  return { status: r.status, d };
};

try {
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  const PHONE = `137${String(Date.now()).slice(-8)}`;
  const { d: lg } = await req('POST', '/api/auth/login', { phone: PHONE, code: '123456' });
  const uid = (lg.user || {}).id || '';
  const { d: od } = await req('POST', '/api/orders', {
    userId: uid, items: [{ productId: 'p244', skuId: 'p244-s1', qty: 1 }],
  });
  const oid = (od.order || {}).orderId;
  await req('POST', `/api/orders/${oid}/pay?userId=${encodeURIComponent(uid)}`);
  await req('POST', `/api/orders/${oid}/ship?userId=${encodeURIComponent(uid)}`);
  const { d: d2 } = await req('GET', `/api/orders/${oid}?userId=${encodeURIComponent(uid)}`);
  const tracking = (d2.order || {}).trackingNo || '';
  check('发货后有运单号', Boolean(tracking), tracking);
  console.log(`\n快递 webhook 验收（订单=${oid} 运单=${tracking}）`);

  /* 1) 鉴权 */
  const push = { trackingNo: tracking, events: [{ code: 'out_for_delivery', happenedAt: new Date().toISOString() }] };
  const ts = Math.floor(Date.now() / 1000);
  const noSig = await rawPost('/api/webhooks/logistics', push,
    { 'X-Carrier': 'sf', 'X-Timestamp': String(ts) });
  check('无签名被拒 401', noSig.status === 401, `HTTP ${noSig.status} ${noSig.d.error || ''}`);
  const badSig = await rawPost('/api/webhooks/logistics', push, signedHeaders('sf', push, { secret: 'wrong' }));
  check('错密钥被拒 401', badSig.status === 401, `HTTP ${badSig.status}`);
  const unknownCarrier = await rawPost('/api/webhooks/logistics', push, signedHeaders('zto', push, { secret: 'x' }));
  check('未启用渠道被拒 401', unknownCarrier.status === 401, `HTTP ${unknownCarrier.status}`);
  const stale = await rawPost('/api/webhooks/logistics', push,
    signedHeaders('sf', push, { ts: ts - 4000 }));
  check('过期时间戳被拒 401（防重放）', stale.status === 401, `HTTP ${stale.status} ${stale.d.error || ''}`);
  const noBody = await rawPost('/api/webhooks/logistics', push,
    { 'X-Carrier': 'sf', 'X-Timestamp': String(ts), 'X-Signature': createHmac('sha256', CARRIER_KEYS.sf).update(`${ts}.{}`).digest('hex') });
  check('签名与实际 body 不符被拒 401', noBody.status === 401, `HTTP ${noBody.status}`);
  const unknownNo = await rawPost('/api/webhooks/logistics', { trackingNo: 'NOPE', events: [] }, signedHeaders('sf', { trackingNo: 'NOPE', events: [] }));
  check('未知运单号 404 且不炸', unknownNo.status === 404, `HTTP ${unknownNo.status} ${unknownNo.d.error || ''}`);

  /* 2) 正确签名 + 去重 */
  const okPush = await rawPost('/api/webhooks/logistics', push, signedHeaders('sf', push));
  check('正确签名被接受 200', okPush.status === 200, `HTTP ${okPush.status} ${okPush.d.error || ''}`);
  check('插入 1 条事件', okPush.d.inserted === 1, JSON.stringify(okPush.d));
  check('派送中不推进订单', okPush.d.advanced === false);
  const replay = await rawPost('/api/webhooks/logistics', push, signedHeaders('sf', push));
  check('重放被去重 inserted=0', replay.status === 200 && replay.d.inserted === 0, JSON.stringify(replay.d));
  check('去重计数正确', replay.d.deduped === 1, String(replay.d.deduped));

  /* 3) 坏时间：收下但拒绝落地 */
  const early = new Date(Date.now() - 3 * 3600_000).toISOString();
  const earlyPush = { trackingNo: tracking, events: [{ code: 'signed', happenedAt: early }] };
  const earlyRes = await rawPost('/api/webhooks/logistics', earlyPush, signedHeaders('sf', earlyPush));
  check('签收早于发货：收下但不落地', earlyRes.status === 200 && earlyRes.d.inserted === 0,
    JSON.stringify(earlyRes.d));
  check('拒绝原因写清楚', (earlyRes.d.rejected || []).some((r) => /早于(下单|发货)/.test(r.reason)),
    JSON.stringify(earlyRes.d.rejected));
  check('非法签收不推进订单', earlyRes.d.advanced === false);
  const future = new Date(Date.now() + 3 * 3600_000).toISOString();
  const futPush = { trackingNo: tracking, events: [{ code: 'in_transit', happenedAt: future }] };
  const fut = await rawPost('/api/webhooks/logistics', futPush, signedHeaders('sf', futPush));
  check('未来时间的事件被拒绝落地', fut.status === 200 && fut.d.inserted === 0
    && (fut.d.rejected || []).some((r) => /未来/.test(r.reason)), JSON.stringify(fut.d.rejected));

  /* 4) 签收 → 推进 completed，时间取快递给的 */
  const signedAt = new Date().toISOString();
  const signPush = { trackingNo: tracking, events: [{ code: 'signed', happenedAt: signedAt, detail: '本人签收' }] };
  const signed = await rawPost('/api/webhooks/logistics', signPush, signedHeaders('sf', signPush));
  check('签收推进订单到已完成', signed.status === 200 && signed.d.advanced === true, JSON.stringify(signed.d));
  const { d: d3 } = await req('GET', `/api/orders/${oid}?userId=${encodeURIComponent(uid)}`);
  check('订单状态 completed', (d3.order || {}).status === 'completed', (d3.order || {}).status);
  const events = ((d3.order || {}).logistics || {}).events || [];
  check('事件累计 4 条', events.length === 4, String(events.length));
  check('签收时间取快递给的时间戳',
    events.some((e) => e.code === 'signed' && e.at === signedAt.slice(0, 19).replace('T', ' ')),
    JSON.stringify(events.map((e) => `${e.code}@${e.at}`)));

  /* 5) 时区口径与单调性 */
  {
    const ms = events.map((e) => Date.parse(`${e.at.slice(0, 10)}T${e.at.slice(11)}Z`));
    const spread = Math.max(...ms) - Math.min(...ms);
    check('webhook 与发货事件同一时区口径（无 8 小时偏移）',
      spread < 30 * 60_000, `spread=${Math.round(spread / 60000)}min`);
    check('时间线单调不倒流', ms.every((v, i) => i === 0 || v >= ms[i - 1]),
      JSON.stringify(events.map((e) => `${e.code}@${e.at}`)));
  }

  /* 6) 终态订单再推事件：记事不推进 */
  const afterPush = { trackingNo: tracking, events: [{ code: 'in_transit', happenedAt: new Date().toISOString() }] };
  const after = await rawPost('/api/webhooks/logistics', afterPush, signedHeaders('sf', afterPush));
  check('终态订单收事件但不推进状态', after.status === 200 && after.d.advanced === false,
    JSON.stringify(after.d));
  check('健康检查列出已启用渠道',
    ((await req('GET', '/health')).d.logisticsWebhookCarriers || []).join(',') === 'sf,yd',
    JSON.stringify((await req('GET', '/health')).d.logisticsWebhookCarriers));

  console.log(failed === 0 ? '\n✓ Webhook 验收通过' : `\n✗ 失败 ${failed} 项`);
} catch (e) {
  console.log(`FATAL ${e.message}`);
  failed += 1;
} finally {
  gateway.kill('SIGKILL');
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  process.exit(failed === 0 ? 0 : 1);
}
