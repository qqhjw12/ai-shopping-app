#!/usr/bin/env node
/**
 * 资金流水账本 + 售后凭证上传验收（真网关 + 临时库 + 浏览器）。
 *
 * 遗留三条里的两条在这里闭环：
 *   1) 无资金流 → 订单收款、退款都落账本（order_ledger），退款分「待打款 / 已打款」
 *      两段：审核同意只是承诺该退，运营点「确认已打款」才代表钱真出去了；
 *   2) 凭证只存文件名 → 真上传进对象存储，返回对象键，工单与详情页都能看到图。
 *
 * 可退额度守卫单独验：退款上限从「实付」改成「实付 − 已退合计」，
 * 开放二次退款时不会累计超退。
 *
 * 用法：node scripts/e2e-ledger.mjs [--port 4342] [--gw 8102]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4342'));
const GW_PORT = Number(argOf('--gw', '8102'));
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;
const ADMIN_KEY = 'e2e-admin-key-4c1f';
const adminH = { 'X-Admin-Key': ADMIN_KEY, 'X-Admin-Actor': encodeURIComponent('李账房') };

const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-ledger.db');
const PHONE = `137${String(Date.now()).slice(-8)}`;
const CODE = '123456';
// 1×1 透明 PNG，真实可解析（服务端会 sniff 魔数，假数据过不去）
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
}

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

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: 'ignore',
    cwd: join(ROOT, 'ai-gateway'),
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      DB_FILE: DB,
      CORS_ORIGINS: BASE,
      RATE_LIMIT_PER_MIN: '0',
      ADMIN_API_KEY: ADMIN_KEY,
    },
  },
);

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
const detail = async (oid, uid) => (await req('GET', `/api/orders/${oid}?userId=${encodeURIComponent(uid)}`)).d.order || {};

try {
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  /* 0) 浏览器先登录拿 uid：API 与页面必须用同一个用户，
     否则详情页读不到这单（先 API 后 UI 会造出两个用户） */
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 404) console.log('    [404]', r.url()); });

  await page.goto(`${APP}#/login`, { waitUntil: 'load' });
  await page.waitForSelector('.auth-id');
  await page.locator('.auth-id').fill(PHONE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(300);
  await page.locator('.auth-code').fill(CODE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(900);
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('current_user') || '{}').id || '');
  check('浏览器登录成功', Boolean(uid), uid);

  const { d: od } = await req('POST', '/api/orders', {
    userId: uid, items: [{ productId: 'p244', skuId: 'p244-s1', qty: 1 }],
  });
  const oid = (od.order || {}).orderId;
  console.log(`\n账本 + 凭证验收（uid=${uid} 订单=${oid}）`);

  /* 1) 收款落账本 */
  await req('POST', `/api/orders/${oid}/pay?userId=${encodeURIComponent(uid)}`);
  let bal = (await detail(oid, uid)).balance || {};
  const paid = bal.paid;
  check('支付后账本记了收款', paid > 0, `paid=${paid}`);
  check('可退额度 = 实付', bal.refundable === bal.paid);
  check('收款不缺流水（幂等回填比对）', bal.ledgerMissing === false);

  /* 2) 凭证上传：真对象、真键、能取回 */
  const up = await req('POST', '/api/aftersale/evidence', { data: `data:image/png;base64,${PNG_1PX}` });
  check('凭证上传成功 201', up.status === 201, `HTTP ${up.status} ${up.d.error || ''}`);
  check('返回 evidence/ 前缀的对象键', /^evidence\/\d{4}\/\d{2}\/[A-Za-z0-9-]+\.png$/.test(up.d.key || ''),
    up.d.key);
  const media = await fetch(`${GW}${up.d.url}`);
  check('上传的图能通过媒体地址取回', media.ok && (media.headers.get('content-type') || '').startsWith('image/'),
    `HTTP ${media.status} ${media.headers.get('content-type')}`);
  const badUp = await req('POST', '/api/aftersale/evidence', { data: 'data:image/png;base64,SGVsbG8=' });
  check('非图片内容被拒 415', badUp.status === 415, `HTTP ${badUp.status} ${badUp.d.error || ''}`);
  // 上传端点与买家秀同一套频控：不强制登录（who = 令牌身份 || IP），恶意刷会先撞 429。
  // 工单归属校验在提交售后时做（userId 必须是订单主人），这里只管图能不能进存储。

  /* 3) 发货 + 售后 + 同意退款 → 账本 pending，可退额度守卫 */
  await req('POST', `/api/orders/${oid}/ship?userId=${encodeURIComponent(uid)}`);
  const { d: ad } = await req('POST', `/api/orders/${oid}/aftersale`, {
    userId: uid, type: 'refund', reason: 'damaged', note: '外箱破损',
    evidence: [{ name: '箱损.png', size: 95, key: up.d.key }],
  });
  const asId = (ad.aftersale || {}).id;
  check('带对象键申请售后成功', Boolean(asId), JSON.stringify(ad).slice(0, 120));

  // 超退守卫：可退额度只有实付，报 99999 必须被夹回
  const { d: rv } = await req('PATCH', `/api/aftersales/${asId}`,
    { action: 'approve', note: '同意退款', refundAmount: 99999 }, adminH);
  check('退款金额被夹到剩余可退额度',
    (rv.aftersale || {}).refundAmount === paid, `${(rv.aftersale || {}).refundAmount} vs ${paid}`);

  bal = (await detail(oid, uid)).balance || {};
  check('同意后账本有 1 笔待打款', bal.refundPending === paid, `pending=${bal.refundPending}`);
  check('可退额度归零（防二次超退）', bal.refundable === 0, String(bal.refundable));
  check('订单入终态 refunded', (await detail(oid, uid)).status === 'refunded');

  /* 4) 待打款清单 + 确认打款 */
  const { d: pend } = await req('GET', '/api/ledger/pending', null, adminH);
  const entry = (pend.items || []).find((i) => i.orderId === oid);
  check('待打款清单包含这笔退款', Boolean(entry), JSON.stringify((pend.items || []).map((i) => i.orderId)));
  check('清单合计等于待打款总额', pend.totalAmount === paid, `${pend.totalAmount} vs ${paid}`);

  const dup = await req('POST', `/api/ledger/refunds/${(entry || {}).id}/settle`, {}, {});
  check('打款确认需要管理员钥匙', dup.status === 401, `HTTP ${dup.status}`);
  const st = await req('POST', `/api/ledger/refunds/${(entry || {}).id}/settle`, {}, adminH);
  check('确认打款转 settled', (st.d.entry || {}).status === 'settled', (st.d.entry || {}).status);
  check('打款人已记录', (st.d.entry || {}).settledBy === '李账房', (st.d.entry || {}).settledBy);
  const again = await req('POST', `/api/ledger/refunds/${(entry || {}).id}/settle`, {}, adminH);
  check('重复确认被拒 409', again.status === 409, `HTTP ${again.status}`);

  bal = (await detail(oid, uid)).balance || {};
  check('打款后待打款归零、已退入账', bal.refundPending === 0 && bal.refundSettled === paid,
    `pending=${bal.refundPending} settled=${bal.refundSettled}`);
  const ledgerRows = (await detail(oid, uid)).ledger || [];
  check('流水两条：收款 + 退款', ledgerRows.length === 2, JSON.stringify(ledgerRows.map((l) => l.kind)));
  check('退款流水带确认时间', (ledgerRows.find((l) => l.kind === 'refund') || {}).settledAt,
    JSON.stringify(ledgerRows.find((l) => l.kind === 'refund')));

  /* 5) 浏览器：详情页退款进度 + 审核台打款确认按钮（沿用开头那个登录页） */

  // 用户详情页：退款进度区 + 已打款流水
  await page.goto(`${APP}#/account/order/${encodeURIComponent(oid)}`, { waitUntil: 'load' });
  await page.waitForSelector('.od-card', { timeout: 10000 });
  const hasLedger = (await page.locator('.od-ledger').count()) === 1;
  check('详情页出现退款进度区', hasLedger);
  if (hasLedger) {
    const text = (await page.locator('.od-ledger').textContent()) || '';
    check('退款进度含实付/已退/可退三格', /订单实付/.test(text) && /已退/.test(text) && /可退额度/.test(text),
      text.slice(0, 80));
    check('流水显示已打款', /已打款|已转出/.test(text), text.slice(0, 120));
  }
  // 凭证缩略图：工单里有对象键，详情页要渲染成图而不是文件名
  const thumb = page.locator('.od-as-ev-img').first();
  check('详情页凭证渲染成缩略图', (await thumb.count()) === 1);
  if ((await thumb.count()) === 1) {
    const natural = await thumb.evaluate((n) => n.naturalWidth);
    check('缩略图真的加载出了图片', natural > 0, `naturalWidth=${natural}`);
  }

  // 审核台：同意的卡片显示待打款（本例已 settle，接口侧确认过）→ 页面应显示已确认
  await page.goto(`${APP}#/admin/aftersales`, { waitUntil: 'load' });
  await page.waitForSelector('.adm-key-form');
  await page.getByLabel('管理员密钥').fill(ADMIN_KEY);
  await page.getByLabel('操作人').fill('张账房');
  await page.locator('.adm-btn', { hasText: '进入' }).click();
  // 默认停在「待处理」，而本例唯一的工单已经接口侧同意了 → 先切到「已同意」
  await page.waitForSelector('.adm-filters', { timeout: 8000 });
  await page.locator('.adm-filter', { hasText: '已同意' }).click();
  await page.waitForSelector('.adm-card.is-approved', { timeout: 8000 });
  const card = page.locator('.adm-card.is-approved').first();
  check('审核台凭证渲染成可点缩略图', (await card.locator('.adm-ev-thumb').count()) >= 1);
  const payoutText = ((await card.locator('.adm-payout').textContent()) || '').trim();
  check('打款状态与接口侧一致（已确认）', /已确认/.test(payoutText), payoutText);

  // 缩略图点开能放大
  await card.locator('.adm-ev-thumb').first().click();
  await page.waitForSelector('.adm-ev-view img', { timeout: 5000 });
  check('凭证点开放大', true);
  await page.locator('.adm-line-btn', { hasText: '关闭' }).click();

  // 待打款场景的按钮在下一单验证：再走一单完整流程，页面侧点确认
  const { d: od2 } = await req('POST', '/api/orders', {
    userId: uid, items: [{ productId: 'p244', skuId: 'p244-s1', qty: 1 }],
  });
  const oid2 = (od2.order || {}).orderId;
  await req('POST', `/api/orders/${oid2}/pay?userId=${encodeURIComponent(uid)}`);
  await req('POST', `/api/orders/${oid2}/ship?userId=${encodeURIComponent(uid)}`);
  const { d: ad2 } = await req('POST', `/api/orders/${oid2}/aftersale`, {
    userId: uid, type: 'refund', reason: 'other', note: '不想要了',
  });
  await req('PATCH', `/api/aftersales/${(ad2.aftersale || {}).id}`,
    { action: 'approve', note: '同意' }, adminH);

  // 已经停在「已同意」筛选上，再点同一个标签不会触发路由重渲染 → 刷新重取
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.adm-card.is-approved', { timeout: 8000 });
  const cards = page.locator('.adm-card.is-approved');
  const n = await cards.count();
  check('两张已同意卡片都在', n === 2, String(n));
  const pendingBtn = cards.locator('.adm-payout .adm-line-btn', { hasText: '确认已打款' }).first();
  check('新工单显示「确认已打款」按钮', (await pendingBtn.count()) === 1);
  await pendingBtn.click();
  await page.waitForSelector('.adm-payout.is-settled', { timeout: 8000 });
  check('页面点击后卡片转为已确认', true);
  const bal2 = (await detail(oid2, uid)).balance || {};
  check('页面操作真的改了服务端账本', bal2.refundPending === 0 && bal2.refundSettled > 0,
    `pending=${bal2.refundPending} settled=${bal2.refundSettled}`);
  check('页面侧打款人记录为张账房',
    ((await detail(oid2, uid)).ledger || []).some((l) => l.kind === 'refund' && l.settledBy === '张账房'),
    JSON.stringify(((await detail(oid2, uid)).ledger || []).filter((l) => l.kind === 'refund')));

  check('控制台无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();

  console.log(failed === 0 ? '\n✓ 账本验收通过' : `\n✗ 失败 ${failed} 项`);
} catch (e) {
  console.log(`FATAL ${e.message}`);
  failed += 1;
} finally {
  gateway.kill('SIGKILL');
  staticServer.kill('SIGKILL');
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
  process.exit(failed === 0 ? 0 : 1);
}
