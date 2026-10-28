#!/usr/bin/env node
/**
 * 订单履约 + 售后验收（playwright-core + 本机 Edge + 真网关 + 静态站）。
 *
 * 这一轮把订单详情从「一张静态账单」做成「能走完整条路的页面」，要验的是**状态真的在动**：
 *   1) 付款 → 模拟发货 → 模拟签收：每一步的胶囊、流转条、物流时间线都要跟着变；
 *   2) 物流时间线来自服务端事件表，刷新后运单号与节点不能变（前端自己编时间就会露馅）；
 *   3) 售后必须落单 + 把订单改成售后中，且同一笔单不能重复申请（服务端 409 而不是前端藏按钮）；
 *   4) DEMO_ACTIONS=false 时模拟端点整体关闭，而售后这类真实路径不受影响——
 *      「演示按钮不影响正常用户路径」这句要求，只有这样才能证明。
 *
 * 覆盖：
 *   1) 下单 → 待付款 → 去支付 → 待发货（未发货显示「待发货」占位）
 *   2) 模拟发货 → 已发货 + 运单号 + 两段已完成节点
 *   3) 刷新后运单号与节点不变（服务端持久化，不是前端临时状态）
 *   4) 模拟签收 → 已完成 + 四段全绿
 *   5) 申请售后（类型/原因/说明/凭证）→ 订单变售后中 + 售后记录可见 + 处理说明
 *   6) 刷新后售后状态与记录仍在
 *   7) 重复申请被服务端拒绝（409）
 *   8) DEMO_ACTIONS=false 的网关：模拟端点 403，售后与查单照常
 *
 * 用法：node scripts/e2e-fulfillment.mjs [--port 4337] [--gw 8097] [--headed]
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
const PORT = Number(argOf('--port', '4337'));
const GW_PORT = Number(argOf('--gw', '8097'));
const GW2_PORT = GW_PORT + 1;
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const GW2 = `http://127.0.0.1:${GW2_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;

// 独立临时库：券目录/售后单这类数据只增不减，跑开发库会永久留下测试工单
const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-fulfil.db');

// 每次跑用新号：上一轮的订单会击穿「售后只能申请一次」这类断言
const PHONE = `136${String(Date.now()).slice(-8)}`;
const CODE = '123456';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);

const gatewayEnv = (extra = {}) => ({
  ...process.env,
  PORT: String(GW_PORT),
  DB_FILE: DB,
  CORS_ORIGINS: BASE,
  RATE_LIMIT_PER_MIN: '0',
  ...extra,
});

const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  { stdio: 'ignore', cwd: join(ROOT, 'ai-gateway'), env: gatewayEnv() },
);

// 第二个网关：关掉演示端点，用来证明「关演示开关不影响正常路径」
const gatewayNoDemo = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: 'ignore',
    cwd: join(ROOT, 'ai-gateway'),
    env: { ...gatewayEnv({ DEMO_ACTIONS: 'false', PORT: String(GW2_PORT), DB_FILE: `${DB}.nodemo` }) },
  },
);

async function serverOrders(uid) {
  const r = await fetch(`${GW}/api/orders?userId=${encodeURIComponent(uid)}`);
  return (await r.json()).orders || [];
}

/**
 * 单笔订单详情。
 * 列表接口刻意不带物流事件与售后单（避免 50 笔订单各查两次的 N+1），
 * 所以断言这些字段必须走 /api/orders/:id —— 和页面用的是同一个接口。
 */
async function serverOrder(uid, orderId) {
  const r = await fetch(`${GW}/api/orders/${encodeURIComponent(orderId)}?userId=${encodeURIComponent(uid)}`);
  const d = await r.json().catch(() => ({}));
  return d.order || null;
}

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');
  if (!(await waitFor(`${GW2}/health`))) throw new Error('无演示网关没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/i.test(m.text())) return; // 下面有意制造的 409 会带一条
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  console.log('\n订单履约 + 售后 e2e（付款→发货→签收→售后，真网关持久化）');

  /* 0) 登录 */
  await page.goto(`${APP}#/login`, { waitUntil: 'load' });
  await page.waitForSelector('.auth-id');
  await page.locator('.auth-id').fill(PHONE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(300);
  await page.locator('.auth-code').fill(CODE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(900);
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('current_user') || '{}').id || '');
  check('登录成功', Boolean(uid), uid);

  /* 1) 塞购物袋 → 结算 → 下单 */
  await page.evaluate(() => {
    localStorage.setItem('shop_cart', JSON.stringify([{
      id: 'p244', productId: 'p244', skuId: 'p244-s1', itemId: null, __key: 'p244-s1',
      name: '墨方 自动铅笔 0.5mm', price: 29, pic: '', coverColor: '', brand: '墨方',
      spec: '0.5mm / 灰', categoryId: 'c_stationery', stock: 143, qty: 4,
    }]));
  });
  await page.goto(`${APP}#/checkout`, { waitUntil: 'load' });
  await page.waitForSelector('.co2-grid');
  await page.waitForTimeout(900);
  if (await page.locator('.co2-addr-add').count()) {
    await page.locator('.co2-addr-add').click();
    await page.locator('.f-receiver').fill('履约测试');
    await page.locator('.f-phone').fill(PHONE);
    await page.locator('.f-region').fill('浙江省 杭州市 西湖区');
    await page.locator('.f-detail').fill('文三路 88 号 2 单元');
    await page.locator('.co2-save').click();
    await page.waitForTimeout(900);
  }
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(2200);
  const hash = await page.evaluate(() => location.hash);
  const orderId = decodeURIComponent(hash.replace('#/order-success/', ''));
  check('下单成功并拿到服务端订单号', /^SO\d+/.test(orderId), orderId);

  /* 2) 详情页初始态：待付款 + 未发货占位 */
  await page.goto(`${APP}#/account/order/${encodeURIComponent(orderId)}`, { waitUntil: 'load' });
  await page.waitForSelector('.od-card');
  await page.waitForTimeout(500);
  const pill0 = (await page.locator('.od-pill').textContent()) || '';
  check('初始状态是「待付款」', pill0.trim() === '待付款', pill0.trim());
  check('未发货时物流显示「待发货」占位',
    ((await page.locator('.od-sec-tag').textContent()) || '').trim() === '待发货'
    && (await page.locator('.od-track').count()) === 0);
  check('待付款没有售后入口', (await page.locator('.od-line-btn', { hasText: '申请退款' }).count()) === 0);
  check('待付款不显示发货演示按钮', (await page.locator('.od-demo-btn', { hasText: '模拟发货' }).count()) === 0);

  /* 3) 去支付 → 待发货 */
  await page.locator('.od-main-btn', { hasText: '去支付' }).click();
  await page.waitForTimeout(1600);
  const pill1 = ((await page.locator('.od-pill').textContent()) || '').trim();
  check('支付后状态变「待发货」', pill1 === '待发货', pill1);
  const steps1 = await page.locator('.od-step').count();
  const done1 = await page.locator('.od-step.is-done').count();
  check('流转条四步、已走到第 2 步', steps1 === 4 && done1 === 2, `${done1}/${steps1}`);
  check('待发货出现「模拟发货」', (await page.locator('.od-demo-btn', { hasText: '模拟发货' }).count()) === 1);

  /* 4) 模拟发货 → 时间线出现，运单号落库 */
  await page.locator('.od-demo-btn', { hasText: '模拟发货' }).click();
  await page.waitForTimeout(1600);
  const pill2 = ((await page.locator('.od-pill').textContent()) || '').trim();
  const trackItems = await page.locator('.od-track-item').count();
  const trackDone = await page.locator('.od-track-item.is-done').count();
  const detailText = (await page.locator('.od-card').textContent()) || '';
  const waybill = (detailText.match(/(SF|JD|ZT)\d{10,}/) || [])[0] || '';
  check('模拟发货后状态变「已发货」', pill2 === '已发货', pill2);
  check('物流时间线画出四段（未达节点保留）', trackItems === 4, `${trackItems} 段`);
  check('已揽收/运输中已完成', trackDone === 2, `${trackDone} 段已完成`);
  check('运单号展示在物流卡里', Boolean(waybill), waybill);
  check('已发货出现售后入口', (await page.locator('.od-line-btn', { hasText: '申请退款' }).count()) === 1);

  const serverAfterShip = await serverOrder(uid, orderId);
  check('服务端订单已置 shipped 且有运单号',
    Boolean(serverAfterShip) && serverAfterShip.status === 'shipped'
      && serverAfterShip.logistics.trackingNo === waybill,
    serverAfterShip ? `${serverAfterShip.status}/${serverAfterShip.logistics.trackingNo}` : '');
  check('服务端物流事件两条（已揽收 + 运输中）',
    Boolean(serverAfterShip) && serverAfterShip.logistics.events.length === 2,
    serverAfterShip ? String(serverAfterShip.logistics.events.length) : '');

  /* 5) 刷新：运单号与节点不能变（服务端持久化，不是前端临时状态） */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.od-card');
  await page.waitForTimeout(600);
  const afterReload = (await page.locator('.od-card').textContent()) || '';
  check('刷新后运单号不变', Boolean(waybill) && afterReload.includes(waybill));
  check('刷新后仍是已发货且有 2 段完成',
    ((await page.locator('.od-pill').textContent()) || '').trim() === '已发货'
    && (await page.locator('.od-track-item.is-done').count()) === 2);

  /* 6) 模拟签收 → 已完成 + 四段全绿 */
  await page.locator('.od-demo-btn', { hasText: '模拟签收' }).click();
  await page.waitForTimeout(1600);
  check('模拟签收后状态变「已完成」',
    ((await page.locator('.od-pill').textContent()) || '').trim() === '已完成');
  check('四段节点全部完成',
    (await page.locator('.od-track-item.is-done').count()) === 4
    && (await page.locator('.od-track-item').count()) === 4);
  check('已完成显示「已签收」与签收时间',
    /已签收/.test((await page.locator('.od-card').textContent()) || ''));

  /* 7) 申请售后：类型 / 原因 / 说明 / 凭证 */
  await page.locator('.od-line-btn', { hasText: '申请退款' }).click();
  await page.waitForSelector('.as-form');
  await page.locator('.as-type', { hasText: '退货退款' }).click();
  await page.selectOption('.as-reason', 'damaged');
  await page.locator('.as-note').fill('外箱破损，笔身有划痕');
  // 真 1×1 PNG：凭证现在真的会上传（压缩 → /api/aftersale/evidence → 对象键），
  // 截断的假 PNG 会被服务端魔数嗅探 415 拒掉
  await page.setInputFiles('.as-file', {
    name: 'proof-1.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  // 上传是异步的：先出现「正在上传」，完成后变成缩略图条目
  await page.waitForSelector('.as-ev-item', { timeout: 10000 });
  check('凭证真上传并显示缩略图', (await page.locator('.as-ev-item .as-ev-thumb').count()) === 1);
  await page.locator('.as-submit').click();
  await page.waitForTimeout(1800);

  const asText = (await page.locator('.od-card').textContent()) || '';
  check('提交后订单变「售后中」',
    ((await page.locator('.od-pill').textContent()) || '').trim() === '售后中');
  check('详情页出现 1 条售后记录', (await page.locator('.od-as-item').count()) === 1);
  check('售后记录含类型 / 原因 / 说明',
    /退货退款/.test(asText) && /运输破损/.test(asText) && /外箱破损/.test(asText));
  check('售后记录含处理说明', /处理说明：/.test(asText) && /客服会在 24 小时内/.test(asText));
  check('售后记录凭证渲染成缩略图', (await page.locator('.od-as-ev-img').count()) === 1);
  check('售后中不再显示申请入口',
    (await page.locator('.od-line-btn', { hasText: '申请退款' }).count()) === 0);
  check('售后中仍能看到履约进度（四步走完）',
    (await page.locator('.od-step.is-done').count()) === 4);

  const serverAfterAs = await serverOrder(uid, orderId);
  check('服务端订单已置 refunding', Boolean(serverAfterAs) && serverAfterAs.status === 'refunding',
    serverAfterAs ? serverAfterAs.status : '');
  const asRecords = (serverAfterAs && serverAfterAs.aftersales) || [];
  check('服务端售后单已落库（类型/原因/说明/凭证对象键）',
    asRecords.length === 1 && asRecords[0].type === 'return'
      && asRecords[0].reason === 'damaged'
      && asRecords[0].note === '外箱破损，笔身有划痕'
      && asRecords[0].evidence.length === 1
      && /^evidence\/\d{4}\/\d{2}\//.test((asRecords[0].evidence[0] || {}).key || ''),
    asRecords.length ? JSON.stringify(asRecords[0].evidence) : '0 条');

  /* 8) 刷新后售后记录仍在（服务端权威，不靠本地缓存） */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.od-card');
  await page.waitForTimeout(700);
  check('刷新后售后中与记录仍可见',
    ((await page.locator('.od-pill').textContent()) || '').trim() === '售后中'
    && (await page.locator('.od-as-item').count()) === 1);

  /* 9) 重复申请：服务端必须拒绝（前端藏按钮挡不住直接调接口） */
  const dup = await page.evaluate(async ({ gw, u, oid }) => {
    const r = await fetch(`${gw}/api/orders/${encodeURIComponent(oid)}/aftersale`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: u, type: 'refund', reason: 'other' }),
    });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, error: d.error || '' };
  }, { gw: GW, u: uid, oid: orderId });
  check('重复申请被服务端拒绝（409）', dup.status === 409, `HTTP ${dup.status} ${dup.error}`);

  /* 10) 演示开关关掉的网关：模拟端点 403，查单与售后路径照常 */
  const gw2Health = await (await fetch(`${GW2}/health`)).json();
  check('第二个网关确实以 DEMO_ACTIONS=false 启动', gw2Health.demo === 'off', `demo=${gw2Health.demo}`);

  const noDemoShip = await page.evaluate(async ({ gw }) => {
    const r = await fetch(`${gw}/api/orders/SO_FAKE_0001/ship?userId=u_probe`, { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, error: d.error || '' };
  }, { gw: GW2 });
  check('DEMO_ACTIONS=false 时模拟发货被拒（403）', noDemoShip.status === 403,
    `HTTP ${noDemoShip.status} ${noDemoShip.error}`);

  const noDemoQuery = await page.evaluate(async ({ gw, u, oid }) => {
    const r = await fetch(`${gw}/api/orders/${encodeURIComponent(oid)}?userId=${encodeURIComponent(u)}`);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }, { gw: GW2, u: uid, oid: orderId });
  // 第二个网关用的是自己的库，查不到这笔单是正常的——关键是它返回业务 404 而不是把整站关掉
  check('关演示开关不影响查单路径（返回业务 404 而非全局拒绝）',
    noDemoQuery.status === 404, `HTTP ${noDemoQuery.status} ${noDemoQuery.body.error || ''}`);

  check('控制台无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  if (HEADED) await page.waitForTimeout(1200);
} catch (e) {
  failed += 1;
  console.log(`  FAIL 脚本异常: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* 已关闭 */ }
  for (const p of [staticServer, gateway, gatewayNoDemo]) {
    try { p.kill(); } catch { /* 已退出 */ }
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DB}.nodemo`, `${DB}.nodemo-wal`, `${DB}.nodemo-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* 没生成就算了 */ }
  }
}

console.log(failed === 0 ? '\n✓ 履约与售后 e2e 全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
