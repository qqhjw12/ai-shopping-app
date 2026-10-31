#!/usr/bin/env node
/**
 * 商家工作台「真后端」验收（playwright-core + 本机 Edge + 独立网关 + 临时库）。
 *
 * 上一支 e2e-merchant-dashboard.mjs 验的是本机演示模式（无网关）；
 * 这一支验的是**接入平台库之后**工作台是不是真的在做生意：
 *
 *   1) 未过审的申请进不了工作台（403，而不是给个空页面）；
 *   2) 新增商品真落库，且必须经运营审核——审核中在商城搜不到、详情 404、加不进购物车；
 *   3) 运营台（#/admin/products）通过之后，商品立刻出现在商城类目与详情里，图也是真的；
 *   4) 买家下单付款后，工作台订单页出现这笔单，金额按「我的货」算；
 *   5) 工作台发货写回交易库：买家侧能看到已发货与运单号；
 *   6) 改库存同步到商城 SKU；库存低于预警线时工作台标预警；
 *   7) 店铺资料（含 Logo 真图）落库，刷新不丢；
 *   8) 移动端无横向滚动，全程无 JS 错误。
 *
 * 用法：node scripts/e2e-merchant-workspace.mjs [--port 4345] [--gw 8105] [--headed]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4345'));
const GW_PORT = Number(argOf('--gw', '8105'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_KEY = 'e2e-merchant-workspace-91c3';
const ACTOR = '周运营';

let failed = 0;
const results = [];
function check(label, ok, extra = '') {
  results.push([label, ok, extra]);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------- 进程 ---------------- */

const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-mworkspace.db');
try { rmSync(DB, { force: true }); } catch { /* 首次运行不存在 */ }
mkdirSync(join(ROOT, '.shots'), { recursive: true });

// 一张 2x2 的 PNG：够小、能过文件头嗅探，也能证明「传上去的是真图」
const IMG = join(ROOT, '.shots', '_e2e-product.png');
writeFileSync(IMG, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEIhhgEAG2gAwHq3sCqAAAAAElFTkSuQmCC',
  'base64',
));

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
      STORAGE_DRIVER: 'local',
      NOTIFY_FLUSH_INTERVAL_SEC: '0',
    },
  },
);

/* ---------------- API 助手 ---------------- */

async function req(method, path, body = null, headers = {}) {
  const r = await fetch(`${GW}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, d };
}
const admin = { 'X-Admin-Key': ADMIN_KEY, 'X-Admin-Actor': encodeURIComponent(ACTOR) };

const APPLICANT = {
  entityKind: 'studio',
  company: '杭州砚白设计有限公司',
  creditCode: '91330100MA2H1XYG4K',
  contact: '周砚',
  phone: '13800138000',
  email: 'zhou@yanbai.design',
  brand: '砚白 YANBAI',
  brandSource: 'owned',
  categories: ['home'],
  skuRange: '50-200',
  priceRange: '100-500',
  bankAccount: '杭州砚白设计有限公司',
  bankNo: '6225880123456789',
  returnPolicy: '7days',
  shipWithin: '48h',
  submitKey: 'e2e-workspace-submit-001',
};

let browser;
try {
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  /* ============ 0) 准备：一份已提交、待审核的申请 ============ */
  const sub = await req('POST', '/api/merchant/applications', APPLICANT);
  const appId = (sub.d.application && sub.d.application.id) || '';
  const queryKey = sub.d.queryKey || '';
  check('入驻申请已提交（待审核）', sub.status === 201 && Boolean(appId), `${sub.status}`);
  const dashHash = `/merchant/dashboard?id=${encodeURIComponent(appId)}&key=${encodeURIComponent(queryKey)}`;
  const pageUrl = (hash) => `${BASE}/index.html?api=${encodeURIComponent(GW)}#${hash}`;
  // 同一个 hash 再 goto 不会重新加载（浏览器认为是同地址），
  // 而审核状态变了必须重新取数，所以这里显式 reload 一次。
  const openAt = async (hash, wait = 1300) => {
    await page.goto(pageUrl(hash), { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(wait);
  };

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource/.test(t)) return; // 预期内的 404（未过审商品详情）
    errors.push(t.slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));

  /* ============ 1) 未过审：工作台不给进 ============ */
  console.log('\n— 未过审时不给进工作台 —');
  await openAt(dashHash);
  const gateText = await page.locator('.mzw-title').innerText().catch(() => '');
  check('显示「工作台还没开门」', gateText.includes('工作台还没开门'), gateText);
  check('没有渲染工作台骨架', (await page.locator('.mdash-navitem').count()) === 0);

  /* ============ 2) 运营放行申请 ============ */
  const approveApp = await req('PATCH', `/api/merchant/applications/${appId}`, { action: 'approve', note: '资料齐全' }, admin);
  check('运营通过入驻申请', approveApp.status === 200, approveApp.status);

  /* ============ 3) 新店工作台：真实数据源 ============ */
  console.log('\n— 工作台读平台库 —');
  await openAt(dashHash, 1500);
  check('工作台打开', (await page.locator('.mdash-title').innerText()) === '概览');
  check('数据来源标「平台库」', (await page.locator('.mdash-note').innerText()).includes('平台库'),
    await page.locator('.mdash-note').innerText());
  check('新店商品为 0（不造假数据）', (await page.locator('.mdash-card', { hasText: '在售商品' }).locator('.mdash-card-value').innerText()).trim() === '0');
  check('设置页不给「重置演示数据」', await (async () => {
    await page.locator('.mdash-navitem', { hasText: '店铺设置' }).click();
    await page.waitForTimeout(600);
    return !(await page.locator('.mdash-block.is-danger').count());
  })());

  /* ============ 4) 新增商品（含真图上传） ============ */
  console.log('\n— 新增商品：真落库 + 真图 —');
  await page.locator('.mdash-navitem', { hasText: '商品管理' }).click();
  await page.waitForTimeout(700);
  await page.locator('.mdash-btn.is-gold', { hasText: '新增商品' }).click();
  await page.waitForTimeout(500);
  const sheet = page.locator('.modal.is-sheet');
  const field = (label) => sheet.locator('.mdash-field', { hasText: label }).first();
  await field('商品名称').locator('input').fill('手作粗陶盖碗');
  await field('价格（元）').locator('input').fill('128');
  await field('初始库存').locator('input').fill('30');
  await field('类目').locator('select').selectOption('home');
  await sheet.locator('input[type="file"]').setInputFiles(IMG);
  await page.waitForTimeout(1500);
  check('图片已上传（抽屉里出现真图）', (await sheet.locator('.mdash-thumb img').count()) === 1);
  await sheet.locator('button[type="submit"]').click();
  await page.waitForTimeout(1600);
  check('提交后抽屉关闭', (await page.locator('.modal.is-sheet').count()) === 0);
  check('商品列表出现 1 件', (await page.locator('tr[data-product]').count()) === 1);
  check('新商品状态是「审核中」', (await page.locator('tr[data-product] .mdash-pill').innerText()).includes('审核中'));
  check('审核中不给上下架（显示等运营审核）',
    (await page.locator('tr[data-product] .c-act').innerText()).includes('等运营审核'),
    await page.locator('tr[data-product] .c-act').innerText());

  const ws = await req('GET', `/api/merchant/workspace?id=${appId}&key=${queryKey}`);
  const pid = ws.d.products[0].id;
  check('商品真落库且带对象键', ws.d.products[0].reviewStatus === 'pending' && String(ws.d.products[0].imageKey).startsWith('products/'),
    JSON.stringify({ s: ws.d.products[0].reviewStatus, k: ws.d.products[0].imageKey }));

  /* ============ 5) 未过审：商城不可见、不可买 ============ */
  console.log('\n— 未过审商品在商城不可售 —');
  const catList = await req('GET', '/api/products?category=home&limit=0');
  check('类目列表里没有它', !(catList.d.products || []).some((p) => p.id === pid));
  check('详情 404', (await req('GET', `/api/products/${pid}`)).status === 404);
  check('加购 404', (await req('POST', '/api/cart', { userId: 'u1', productId: pid, qty: 1 })).status === 404);

  /* ============ 6) 运营台审商品 ============ */
  console.log('\n— 运营台商品审核 —');
  await openAt('/admin/products?reviewStatus=pending', 1000);
  check('未登录时先出钥匙门', (await page.locator('.adm-key-form').count()) === 1);
  await page.locator('.adm-key-input').nth(0).fill(ADMIN_KEY);
  await page.locator('.adm-key-input').nth(1).fill(ACTOR);
  await page.locator('.adm-key-form button[type="submit"]').click();
  await page.waitForTimeout(1400);

  check('待审列表里有这件商品', (await page.locator('.apr-card').count()) === 1,
    String(await page.locator('.apr-card').count()));
  check('卡片显示真图', (await page.locator('.apr-thumb img').count()) === 1);
  check('筛选条带待审计数', (await page.locator('.mzr-filter').first().innerText()).includes('1'),
    await page.locator('.mzr-filter').first().innerText());

  // 驳回必须写理由
  await page.locator('.apr-actions .od-line-btn', { hasText: '驳回' }).click();
  await page.waitForTimeout(400);
  await page.locator('.modal .as-submit').click();
  await page.waitForTimeout(400);
  check('驳回不写理由被拦住', (await page.locator('.modal .as-error').innerText()).includes('必须填写理由'),
    await page.locator('.modal .as-error').innerText());
  await page.locator('.modal .od-line-btn', { hasText: '取消' }).click();
  await page.waitForTimeout(300);

  await page.locator('.apr-actions .od-main-btn', { hasText: '通过' }).click();
  await page.waitForTimeout(400);
  await page.locator('.modal .as-note').fill('实拍图清晰，类目正确');
  await page.locator('.modal .as-submit').click();
  await page.waitForTimeout(1500);
  check('通过后待审清空', (await page.locator('.adm-empty').count()) === 1);

  /* ============ 7) 过审后商城可搜可买，图是真的 ============ */
  console.log('\n— 过审后在商城可售 —');
  const catList2 = await req('GET', '/api/products?category=home&limit=0');
  check('类目列表里出现了', (catList2.d.products || []).some((p) => p.id === pid));
  const detail = await req('GET', `/api/products/${pid}`);
  check('详情可访问', detail.status === 200 && detail.d.product.name === '手作粗陶盖碗', detail.status);
  check('商品图是上传的那张', String(detail.d.product.pic || '').includes('/api/uploads/'), detail.d.product.pic);
  const imgResp = await fetch(`${GW}${detail.d.product.pic}`);
  check('图片地址真的能取到（本地驱动）', imgResp.ok && Number(imgResp.headers.get('content-length') || 0) > 0,
    `${imgResp.status}`);

  /* ============ 8) 买家下单 → 工作台真实订单 ============ */
  console.log('\n— 真实订单进工作台 —');
  await req('POST', '/api/addresses', {
    userId: 'u1', receiver: '林小满', phone: '13900139000', region: '浙江杭州', detail: '西湖区 1 号', isDefault: true,
  });
  const orderResp = await req('POST', '/api/orders', {
    userId: 'u1', items: [{ productId: pid, qty: 2 }], idempotencyKey: 'e2e-ws-order-1',
  });
  const orderId = orderResp.d.order && orderResp.d.order.orderId;
  check('买家下单成功', Boolean(orderId), JSON.stringify(orderResp.d).slice(0, 120));
  await req('POST', `/api/orders/${orderId}/pay?userId=u1`);

  await openAt(dashHash);
  check('概览待发货 = 1', (await page.locator('.mdash-card', { hasText: '待发货' }).locator('.mdash-card-value').innerText()).trim() === '1');
  await page.locator('.mdash-navitem', { hasText: '订单管理' }).click();
  await page.waitForTimeout(800);
  check('订单列表出现这笔单', (await page.locator(`tr[data-order="${orderId}"]`).count()) === 1);
  check('金额按「我的货」算（128×2）',
    (await page.locator(`tr[data-order="${orderId}"] .c-price`).innerText()).replace(/[^\d.]/g, '') === '256',
    await page.locator(`tr[data-order="${orderId}"] .c-price`).innerText());

  /* ============ 9) 发货写回交易库 ============ */
  console.log('\n— 发货写回交易库 —');
  await page.locator(`tr[data-order="${orderId}"] button.mdash-link`, { hasText: '发货' }).click();
  await page.waitForTimeout(500);
  const shipSheet = page.locator('.modal.is-sheet');
  await shipSheet.locator('.mdash-field', { hasText: '运单号' }).locator('input').fill('abc');
  await shipSheet.locator('button[type="submit"]').click();
  await page.waitForTimeout(500);
  check('运单号太短被拒', (await shipSheet.locator('.mdash-error').innerText()).includes('6–32'),
    await shipSheet.locator('.mdash-error').innerText());
  await shipSheet.locator('.mdash-field', { hasText: '快递公司' }).locator('select').selectOption('顺丰速运');
  await shipSheet.locator('.mdash-field', { hasText: '运单号' }).locator('input').fill('sf139700228842');
  await shipSheet.locator('button[type="submit"]').click();
  await page.waitForTimeout(1600);
  check('发货后状态变「已发货」', (await page.locator(`tr[data-order="${orderId}"] .mdash-pill`).innerText()).includes('已发货'));

  const buyer = await req('GET', `/api/orders/${orderId}?userId=u1`);
  check('买家侧订单变已发货', buyer.d.order.status === 'shipped', buyer.d.order.status);
  check('买家侧能看到运单号', buyer.d.order.trackingNo === 'SF139700228842', buyer.d.order.trackingNo);
  const shipAgain = await req('PATCH', `/api/merchant/orders/${orderId}?id=${appId}&key=${queryKey}`, {
    carrier: '顺丰速运', trackingNo: 'SF139700228843',
  });
  check('重复发货被拒 409', shipAgain.status === 409, shipAgain.status);

  /* ============ 10) 库存同步到商城 ============ */
  console.log('\n— 库存与预警 —');
  await page.locator('.mdash-navitem', { hasText: '库存管理' }).click();
  await page.waitForTimeout(800);
  const stockIn = page.locator(`tr[data-product="${pid}"] .mdash-stock-input`);
  await stockIn.fill('5');
  await stockIn.press('Enter');
  await page.waitForTimeout(1200);
  check('低于预警线标黄', (await page.locator(`tr[data-product="${pid}"]`).innerText()).includes('库存预警'));
  const detail2 = await req('GET', `/api/products/${pid}`);
  check('商城 SKU 库存同步为 5', (detail2.d.product.skus || [])[0].stock === 5,
    JSON.stringify((detail2.d.product.skus || [])[0]));

  /* ============ 11) 店铺设置：店名 + Logo 真图 ============ */
  console.log('\n— 店铺设置落库 —');
  await page.locator('.mdash-navitem', { hasText: '店铺设置' }).click();
  await page.waitForTimeout(800);
  await page.locator('.mdash-field', { hasText: '店铺名称' }).locator('input').fill('砚白器物');
  await page.locator('.mdash-field', { hasText: '店铺简介' }).locator('textarea').fill('做几只自己天天用的碗。');
  await page.locator('.mdash-upload input[type="file"]').last().setInputFiles(IMG);
  await page.waitForTimeout(1500);
  check('Logo 上传成功', (await page.locator('.mdash-logo.is-photo').count()) >= 1);
  await page.locator('button[type="submit"]', { hasText: '保存修改' }).click();
  await page.waitForTimeout(1500);
  check('侧栏店名同步', (await page.locator('.mdash-shop-name').innerText()) === '砚白器物',
    await page.locator('.mdash-shop-name').innerText());

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1600);
  check('刷新后店名还在', (await page.locator('.mdash-shop-name').innerText()) === '砚白器物');
  const shopRow = await req('GET', `/api/merchant/shop?id=${appId}&key=${queryKey}`);
  check('店铺资料落库（含 Logo 对象键）', shopRow.d.shop.name === '砚白器物' && String(shopRow.d.shop.logoKey).startsWith('shops/'),
    JSON.stringify(shopRow.d.shop));

  /* ============ 12) 越权与门禁 ============ */
  console.log('\n— 越权与门禁 —');
  check('错凭证读不到工作台', (await req('GET', `/api/merchant/workspace?id=${appId}&key=wrong`)).status === 404);
  check('改不了平台自营商品',
    (await req('PATCH', `/api/merchant/products/p001?id=${appId}&key=${queryKey}`, { action: 'off' })).status === 404);
  check('运营接口没钥匙被挡', (await req('GET', '/api/admin/products')).status === 401);

  /* ============ 13) 移动端 ============ */
  console.log('\n— 移动端 —');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await mctx.newPage();
  const mErrors = [];
  mp.on('pageerror', (e) => mErrors.push(String(e).slice(0, 120)));
  await mp.goto(pageUrl(dashHash), { waitUntil: 'load' });
  await mp.waitForTimeout(1600);
  check('移动端底部标签栏出现', await mp.locator('.mdash-tabbar').isVisible());
  const overflow = () => mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端概览无横向滚动', (await overflow()) <= 1, String(await overflow()));
  await mp.locator('.mdash-tab', { hasText: '商品' }).click();
  await mp.waitForTimeout(800);
  check('移动端商品页无横向滚动', (await overflow()) <= 1, String(await overflow()));
  check('移动端无 JS 错误', mErrors.length === 0, mErrors.join(' | '));
  await mp.screenshot({ path: '.shots/mws-mobile.png', fullPage: true });
  await mctx.close();

  await openAt(dashHash);
  await page.screenshot({ path: '.shots/mws-overview.png', fullPage: true });
  await page.locator('.mdash-navitem', { hasText: '商品管理' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: '.shots/mws-products.png', fullPage: true });
  check('桌面端无 JS 错误', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('脚本执行未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
} finally {
  if (browser) await browser.close();
  staticServer.kill();
  gateway.kill();
  try { rmSync(DB, { force: true }); } catch { /* 忽略 */ }
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length ? '✗' : '✓'} ${results.length - bad.length}/${results.length} 项通过`);
if (bad.length) {
  bad.forEach(([label, , extra]) => console.log(`  FAIL ${label}${extra ? ` → ${extra}` : ''}`));
  process.exitCode = 1;
}
