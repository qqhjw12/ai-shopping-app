#!/usr/bin/env node
/**
 * 下单事务 + 运营配置验收（playwright-core + 本机 Edge + 真网关 + 静态站）。
 *
 * 这一轮改了两件结构性的事，都需要真网关才验得出来：
 *   1) 券核销从「客户端下单后再补发一条核销请求」挪进服务端 createOrder 的事务里。
 *      断言的重点因此不是「券变成了已使用」，而是**前端根本没有发过核销请求**——
 *      只要还能看到 POST /api/coupons/use，就说明又退回两条腿走路了。
 *   2) 运费与券返还规则从编译期常量改成运营配置（app_settings + GET/PUT /api/config）。
 *      断言的重点是「改了配置，页面展示与服务端实收一起变」，
 *      只改一边的那种实现（前端常量 or 后端常量）都会在这里露馅。
 *
 * 覆盖：
 *   1) 结算页运费来自服务端配置
 *   2) 提交走 POST /api/orders，订单号为服务端号（SO…）
 *   3) 全程没有客户端核销请求，服务端券已挂到该订单
 *   4) 取消订单走服务端事务：关单 + 券返还 + 顺延 7 天
 *   5) 运营改运费 → 刷新后页面与实收同步变化
 *   6) 下单失败（库存不足 / 券已被占用）不落单、不动券
 *
 * 用法：node scripts/e2e-order-tx.mjs [--port 4335] [--gw 8095] [--headed]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4335'));
const GW_PORT = Number(argOf('--gw', '8095'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;
const ADMIN_KEY = 'e2e-admin-key';

// 每次跑用新号：上一轮的订单/券会击穿「券只能核销一次」这类断言
const PHONE = `137${String(Date.now()).slice(-8)}`;
const CODE = '123456';

const DAY = 86400000;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
}

async function waitFor(url, tries = 80) {
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
const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: 'ignore',
    cwd: join(ROOT, 'ai-gateway'),
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      CORS_ORIGINS: BASE,
      RATE_LIMIT_PER_MIN: '0',
      ADMIN_API_KEY: ADMIN_KEY,
    },
  },
);

/** 服务端卡包（含已用/已过期） */
async function serverWallet(uid) {
  const r = await fetch(`${GW}/api/coupons?userId=${encodeURIComponent(uid)}&all=1`);
  const d = await r.json();
  return d.coupons || [];
}

/** 服务端订单列表 */
async function serverOrders(uid) {
  const r = await fetch(`${GW}/api/orders?userId=${encodeURIComponent(uid)}`);
  const d = await r.json();
  return d.orders || [];
}

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  // 只收真正的 JS 错误：本轮会**故意**打出 401（无密钥写配置）与 400（重复用券），
  // 浏览器会为每个失败响应记一条 "Failed to load resource"，那不是脚本错误。
  const errors = [];
  const httpNoise = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) httpNoise.push(t);
    else errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // 记录所有 /api 请求：断言「前端不再自己核销」靠的就是这份流水
  const calls = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/')) calls.push({ method: r.method(), path: u.slice(GW.length) });
  });

  console.log('\n下单事务 + 运营配置 e2e（服务端事务核销 / 取消返还 / 配置生效 / 失败不落单）');

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
  check('登录成功并拿到服务端账户', Boolean(uid), uid);

  /* 工具：塞购物袋 + 进结算页 + 建地址 */
  const seedCart = (qty = 4, stock = 143) => page.evaluate(({ qty: q, stock: s }) => {
    localStorage.setItem('shop_cart', JSON.stringify([{
      id: 'p244',
      productId: 'p244',
      skuId: 'p244-s1',
      itemId: null,
      __key: 'p244-s1',
      name: '墨方 自动铅笔 0.5mm',
      price: 29,
      pic: '',
      coverColor: '',
      brand: '墨方',
      spec: '0.5mm / 灰',
      categoryId: 'c_stationery',
      stock: s,
      qty: q,
    }]));
  }, { qty, stock });

  async function openCheckout() {
    await page.goto(`${APP}#/checkout`, { waitUntil: 'load' });
    await page.waitForSelector('.co2-grid');
    await page.waitForTimeout(900);
  }

  async function ensureAddress() {
    if (!(await page.locator('.co2-addr-add').count())) return;
    await page.locator('.co2-addr-add').click();
    await page.locator('.f-receiver').fill('事务测试');
    await page.locator('.f-phone').fill(PHONE);
    await page.locator('.f-region').fill('浙江省 杭州市 西湖区');
    await page.locator('.f-detail').fill('文三路 88 号 2 单元');
    await page.locator('.co2-save').click();
    await page.waitForTimeout(900);
  }

  /* 1) 结算页运费来自服务端配置（默认加急 ¥18） */
  await seedCart();
  await openCheckout();
  await ensureAddress();
  const shipFees = await page.locator('.co2-pick-fee').allTextContents();
  check('配送方式由服务端配置下发（标准免运费 / 加急 ¥18）',
    shipFees.includes('免运费') && shipFees.some((t) => t.includes('18')),
    shipFees.join(' | '));

  /* 2) 选加急 → 116 − 30（满 99 减 30）+ 18 = 104 */
  const expressBtn = page.locator('.co2-pick', { hasText: '加急配送' });
  await expressBtn.click();
  await page.waitForTimeout(200);
  const totalExpress = (await page.locator('.co2-sum-money').textContent()) || '';
  check('加急运费计入应付（116 − 30 + 18 = 104）', totalExpress.includes('104'), totalExpress.trim());

  const couponPicked = await page.locator('.co2-cp.is-on').count();
  check('自动选中最优券', couponPicked === 1);

  /* 3) 提交 → 服务端订单（SO…） */
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(2200);
  const hashAfter = await page.evaluate(() => location.hash);
  const orderId = decodeURIComponent(hashAfter.replace('#/order-success/', ''));
  check('提交后跳成功页且订单号来自服务端（SO…）', /^SO\d+/.test(orderId), orderId);

  const remoteOrders = await serverOrders(uid);
  const created = remoteOrders.find((o) => o.orderId === orderId);
  check('服务端存在该订单', Boolean(created));
  check('服务端金额与结算页一致（商品 116 / 运费 18 / 抵扣 30 / 应付 104）',
    Boolean(created) && created.productAmount === 116 && created.shippingFee === 18
      && created.discountAmount === 30 && created.payAmount === 104,
    created ? `${created.productAmount}/${created.shippingFee}/${created.discountAmount}/${created.payAmount}` : '');

  /* 4) 核销发生在服务端事务里：券已挂该订单，且前端从未发过核销请求 */
  const walletAfterOrder = await serverWallet(uid);
  const usedCoupon = walletAfterOrder.find((c) => c.state === 'used');
  check('服务端券在事务内已核销并挂上订单号',
    Boolean(usedCoupon) && usedCoupon.orderId === orderId,
    usedCoupon ? `${usedCoupon.couponId} → ${usedCoupon.orderId}` : '未找到已用券');
  const clientUseCalls = calls.filter((c) => c.method === 'POST' && c.path.includes('/api/coupons/use'));
  check('前端全程没有自行发起核销请求', clientUseCalls.length === 0,
    clientUseCalls.length ? clientUseCalls.map((c) => c.path).join(',') : '0 次');
  const createCalls = calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/orders'));
  check('下单走 POST /api/orders（不是本地建单）', createCalls.length === 1,
    `${createCalls.length} 次`);

  /* 5) 本机券包也跟着变成已使用（syncWallet 拉服务端结果） */
  await page.waitForTimeout(900);
  const localUsed = await page.evaluate(async () => {
    const mod = await import('/js/store/couponStore.js');
    const uid2 = JSON.parse(localStorage.getItem('current_user') || '{}').id;
    return mod.listWallet(uid2).filter((c) => c.state === 'used').length;
  });
  check('本机券包已同步为「已使用」', localUsed === 1, `${localUsed} 张`);

  /* 6) 取消订单：服务端事务关单 + 券返还 + 顺延 */
  const beforeCancel = walletAfterOrder.find((c) => c.state === 'used');
  const beforeExp = Number(beforeCancel.expiresAt);
  await page.goto(`${APP}#/account/order/${encodeURIComponent(orderId)}`, { waitUntil: 'load' });
  await page.waitForSelector('.od-cancel');
  await page.locator('.od-cancel').click();
  await page.waitForTimeout(200);
  await page.locator('.od-cancel').click();
  await page.waitForTimeout(2000);

  const ordersAfterCancel = await serverOrders(uid);
  const closed = ordersAfterCancel.find((o) => o.orderId === orderId);
  check('服务端订单已关闭', Boolean(closed) && closed.status === 'closed', closed ? closed.status : '');
  const refundedCoupon = (await serverWallet(uid)).find((c) => c.couponId === beforeCancel.couponId);
  check('券已返还为未使用', Boolean(refundedCoupon) && refundedCoupon.state === 'unused',
    refundedCoupon ? refundedCoupon.state : '');
  const extendedDays = refundedCoupon
    ? Math.round((Number(refundedCoupon.expiresAt) - beforeExp) / DAY)
    : 0;
  check('返还后有效期顺延 7 天（运营配置默认值）', extendedDays === 7, `${extendedDays} 天`);
  check('顺延次数记为 1 次', Boolean(refundedCoupon) && refundedCoupon.extensionCount === 1,
    refundedCoupon ? String(refundedCoupon.extensionCount) : '');

  /* 7) 运营改运费：加急 18 → 28，刷新后页面与实收同步变化 */
  const putRes = await page.evaluate(async ({ gw, key }) => {
    const cur = await (await fetch(`${gw}/api/config`)).json();
    const methods = cur.settings.shipping.methods.map((m) => (m.id === 'express' ? { ...m, fee: 28 } : m));
    const r = await fetch(`${gw}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ shipping: { methods } }),
    });
    return { ok: r.ok, status: r.status };
  }, { gw: GW, key: ADMIN_KEY });
  check('运营可写入配送配置（X-Admin-Key 校验通过）', putRes.ok, `HTTP ${putRes.status}`);

  /* 无密钥写入必须被拒 */
  const noKey = await page.evaluate(async ({ gw }) => {
    const r = await fetch(`${gw}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"coupon":{"refundGraceDays":1}}' });
    return r.status;
  }, { gw: GW });
  check('未带管理员密钥的写入被拒（401）', noKey === 401, `HTTP ${noKey}`);

  await seedCart();
  await openCheckout();
  const feesAfter = await page.locator('.co2-pick-fee').allTextContents();
  check('刷新后页面运费跟着配置变（加急 ¥28）', feesAfter.some((t) => t.includes('28')), feesAfter.join(' | '));

  await page.locator('.co2-pick', { hasText: '加急配送' }).click();
  await page.waitForTimeout(200);
  const totalAfterCfg = (await page.locator('.co2-sum-money').textContent()) || '';
  check('应付随配置变化（116 − 30 + 28 = 114）', totalAfterCfg.includes('114'), totalAfterCfg.trim());

  const pendingCoupon = (await serverWallet(uid)).find((c) => c.state === 'unused' && c.couponId === 'demo-c30');
  check('取消返还的券可再次使用', Boolean(pendingCoupon), pendingCoupon ? pendingCoupon.couponId : '无可用券');

  /* 8) 下单：服务端按新运费实收 114 */
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(2200);
  const hash2 = await page.evaluate(() => location.hash);
  const orderId2 = decodeURIComponent(hash2.replace('#/order-success/', ''));
  const remote2 = (await serverOrders(uid)).find((o) => o.orderId === orderId2);
  check('服务端按新配置实收运费（应付 114）',
    Boolean(remote2) && remote2.shippingFee === 28 && remote2.payAmount === 114,
    remote2 ? `${remote2.shippingFee}/${remote2.payAmount}` : '');

  /* 9) 券只能核销一次：同一张券再下一单必须被服务端拒绝，且不产生新订单 */
  const ordersBefore = (await serverOrders(uid)).length;
  const walletBefore = (await serverWallet(uid)).filter((c) => c.state === 'unused').length;
  const dupAttempt = await page.evaluate(async ({ gw, uid: u, oid }) => {
    const r = await fetch(`${gw}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: u,
        items: [{ productId: 'p244', skuId: 'p244-s1', qty: 4 }],
        couponId: 'demo-c30',
        shippingMethodId: 'express',
      }),
    });
    const d = await r.json();
    return { status: r.status, error: d.error || '' };
  }, { gw: GW, uid, oid: orderId2 });
  const ordersAfterDup = (await serverOrders(uid)).length;
  const walletAfterDup = (await serverWallet(uid)).filter((c) => c.state === 'unused').length;
  check('已用掉的券不能再次下单（服务端拒绝）',
    dupAttempt.status === 400 && /优惠券/.test(dupAttempt.error),
    `HTTP ${dupAttempt.status} ${dupAttempt.error}`);
  check('失败的下单没有落单、没有动券',
    ordersAfterDup === ordersBefore && walletAfterDup === walletBefore,
    `订单 ${ordersBefore}→${ordersAfterDup}，可用券 ${walletBefore}→${walletAfterDup}`);

  /* 10) 库存不足：整单被拒，不建单不核销 */
  await seedCart(999999, 999999); // 绕过前端库存夹逼，让服务端来拒
  await openCheckout();
  const ordersBeforeStock = (await serverOrders(uid)).length;
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(1800);
  const stockErr = await page.locator('.co2-sum-error').count()
    ? await page.locator('.co2-sum-error').textContent()
    : '';
  const ordersAfterStock = (await serverOrders(uid)).length;
  check('库存不足时显示服务端错误文案', /库存/.test(stockErr || ''), (stockErr || '').trim());
  check('库存不足不产生订单', ordersAfterStock === ordersBeforeStock,
    `${ordersBeforeStock}→${ordersAfterStock}`);

  /* 收尾：把加急运费改回 18，别让演示站停在测试值上 */
  await page.evaluate(async ({ gw, key }) => {
    const cur = await (await fetch(`${gw}/api/config`)).json();
    const methods = cur.settings.shipping.methods.map((m) => (m.id === 'express' ? { ...m, fee: 18 } : m));
    await fetch(`${gw}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify({ shipping: { methods } }),
    });
  }, { gw: GW, key: ADMIN_KEY });

  check('控制台无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`  info 预期内的 HTTP 错误日志：${httpNoise.length} 条（401 无密钥写配置 / 400 重复用券）`);

  console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ 失败 ${failed} 项`}`);
} catch (e) {
  failed += 1;
  console.error(`\n✗ 异常：${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  staticServer.kill();
  gateway.kill();
}
process.exit(failed === 0 ? 0 : 1);
