#!/usr/bin/env node
/**
 * 下单幂等 + 支付方式配置 + 券目录写入 验收（真网关 + 本机 Edge）。
 *
 * 这一轮补的是三处「结构性遗漏」，都必须真网关才验得出来：
 *
 *   1) 下单幂等键。之前没有它，网络在「服务端已建单、响应丢包」的瞬间断掉时，
 *      用户重试就是两张真实订单，库存也扣两次。断言的重点不是「第二次返回成功」，
 *      而是**服务端只有一单**——只验前者的实现可以靠客户端补发请求蒙混过关。
 *   2) 支付方式从「前端常量」搬进 app_settings。断言的重点是「改了配置，
 *      结算页选项与服务端订单记录一起变」，只改一边的实现在这里会露馅。
 *   3) 券目录开放 PUT 写入。重点不是「能写」，而是**有持券人时改面额会被拦**——
 *      券的 worth 是按目录现算的，改一个数字等于改所有已发出券的价值。
 *
 * 覆盖：
 *   接口层
 *     1) 同 key 两次提交 → 同一订单号 + replayed + 服务端只有一单
 *     2) 同 key 第二次不重复扣库存
 *     3) 不同 key → 两单
 *     4) 非法 key → 当没传，正常建单（不报错）
 *     5) 不同用户用同一个 key → 各自建单（唯一索引按用户分区）
 *     6) 券目录：无密钥 / 错密钥 → 401
 *     7) 券目录：新增 → 200 且出现在目录里
 *     8) 券目录：非法 kind / amount → 400
 *     9) 券目录：有持券人时改面额 → 409 被拦，force=true 才通过
 *    10) 券目录：有持券人时只改 title → 直接通过（不影响钱的不拦）
 *   浏览器层
 *    11) 结算页提交请求体带合法幂等键
 *    12) 首次请求网络中断 → 自动带**同一个** key 重放，最终只建一单
 *    13) 支付方式来自配置：配置新增「余额支付」→ 结算页出现 → 订单记该 id
 *
 * 用法：node scripts/e2e-idempotency.mjs [--port 4345] [--gw 8096] [--headed]
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
const PORT = Number(argOf('--port', '4345'));
const GW_PORT = Number(argOf('--gw', '8096'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;
const ADMIN_KEY = 'e2e-idem-admin-key';
const WRONG_KEY = 'not-the-key';

// 独立数据库：本脚本会往券目录里写测试券，跑完删库。
// 用开发库的话「探针券」会永久留在演示站的券中心里（券目录只做 upsert，不提供删除）。
const DB_NAME = '_e2e-idem.db';
const DB_DIR = join(ROOT, 'ai-gateway', 'data');

const PHONE = `138${String(Date.now()).slice(-8)}`;
const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

/* ---------------- 接口辅助 ---------------- */

/** @returns {Promise<{status:number, d:any}>} */
async function req(method, path, body, headers = {}) {
  const r = await fetch(`${GW}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let d = null;
  try {
    d = await r.json();
  } catch { /* 204 / 空响应 */ }
  return { status: r.status, d };
}

const items = [{ productId: 'p244', skuId: 'p244-s1', qty: 1 }];
const placeOrder = (body) => req('POST', '/api/orders', body);
const serverOrders = async (userId) => (await req('GET', `/api/orders?userId=${encodeURIComponent(userId)}`)).d.orders || [];
const catalog = async () => (await req('GET', '/api/coupons/catalog')).d.coupons || [];
const putCatalog = (body, key) => req('PUT', '/api/coupons/catalog', body, key ? { 'X-Admin-Key': key, 'X-Admin-Actor': 'e2e' } : {});
const skuStock = async (skuId) => {
  const r = await req('GET', '/api/products/p244');
  return (r.d.product.skus || []).find((s) => s.id === skuId)?.stock ?? null;
};

/* ---------------- 启动 ---------------- */

for (const f of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`]) {
  rmSync(join(DB_DIR, f), { force: true });
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
      DB_FILE: `data/${DB_NAME}`,
      CORS_ORIGINS: BASE,
      RATE_LIMIT_PER_MIN: '0',
      ADMIN_API_KEY: ADMIN_KEY,
    },
  },
);

function cleanup() {
  try { browser?.close(); } catch { /* 已关闭 */ }
  try { gateway.kill(); } catch { /* 已退出 */ }
  try { staticServer.kill(); } catch { /* 已退出 */ }
  // kill 之后文件可能还被占用片刻，删不掉也不影响结果（下次启动前会再删一次）
  for (const f of [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`]) {
    try { rmSync(join(DB_DIR, f), { force: true }); } catch { /* 忽略 */ }
  }
}

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  console.log('\n下单幂等 + 支付方式配置 + 券目录写入 e2e\n');

  /* ================= 接口层 ================= */
  console.log('接口层：下单幂等键');

  const uA = `u_idem_${Date.now()}`;
  const keyA = `kA${Date.now()}`;
  const stockBefore = await skuStock('p244-s1');

  const first = await placeOrder({ userId: uA, items, idempotencyKey: keyA });
  const second = await placeOrder({ userId: uA, items, idempotencyKey: keyA });
  const orderA = first.d?.order || {};
  const orderA2 = second.d?.order || {};
  const stockAfter = await skuStock('p244-s1');
  const listA = await serverOrders(uA);

  check('首次提交建单成功', first.status === 201 && Boolean(orderA.orderId), orderA.orderId);
  check('同 key 第二次返回同一订单号', Boolean(orderA2.orderId) && orderA2.orderId === orderA.orderId, orderA2.orderId);
  check('重放被明确标记（replayed）', orderA2.replayed === true);
  check('服务端只有一单（不是两单）', listA.length === 1, `${listA.length} 单`);
  check(
    '同 key 不重复扣库存',
    stockBefore !== null && stockAfter === stockBefore - 1,
    `${stockBefore} → ${stockAfter}`,
  );

  const keyB = `kB${Date.now()}`;
  const third = await placeOrder({ userId: uA, items, idempotencyKey: keyB });
  const listA2 = await serverOrders(uA);
  check(
    '不同 key 正常建第二单（幂等不是「一人只能一单」）',
    third.status === 201 && listA2.length === 2,
    `${listA2.length} 单`,
  );

  const uBad = `u_badkey_${Date.now()}`;
  const badKey = await placeOrder({ userId: uBad, items, idempotencyKey: 'x' }); // 太短，服务端当没传
  check('非法幂等键不报错（退化为无幂等）', badKey.status === 201 && Boolean(badKey.d?.order?.orderId));

  const sharedKey = `shared${Date.now()}`;
  const uC = `u_share_a_${Date.now()}`;
  const uD = `u_share_b_${Date.now()}`;
  const rC = await placeOrder({ userId: uC, items, idempotencyKey: sharedKey });
  const rD = await placeOrder({ userId: uD, items, idempotencyKey: sharedKey });
  check(
    '同一 key 在不同用户下互不影响（唯一索引按用户分区）',
    rC.status === 201 && rD.status === 201
      && rC.d?.order?.orderId !== rD.d?.order?.orderId,
  );

  /* ---- 券目录写入 ---- */
  console.log('\n接口层：券目录运营写入');

  const testCoupon = {
    id: 'cp-e2e-probe',
    title: '探针券 · 满 100 减 10',
    kind: 'cash',
    threshold: 100,
    amount: 10,
    expireDays: 10,
  };

  const noKey = await putCatalog({ coupon: testCoupon });
  check('无密钥写入被拒（403/401）', noKey.status === 403 || noKey.status === 401, String(noKey.status));
  const wrongKey = await putCatalog({ coupon: testCoupon }, WRONG_KEY);
  check('错误密钥写入被拒（401）', wrongKey.status === 401, String(wrongKey.status));

  const created = await putCatalog({ coupon: testCoupon }, ADMIN_KEY);
  const catAfterCreate = await catalog();
  check(
    '正确密钥可新增券，且立刻出现在目录里',
    created.status === 200 && catAfterCreate.some((c) => c.couponId === 'cp-e2e-probe'),
  );

  const badKind = await putCatalog({ coupon: { ...testCoupon, kind: 'magic' } }, ADMIN_KEY);
  const badAmount = await putCatalog({ coupon: { ...testCoupon, kind: 'discount', amount: 300 } }, ADMIN_KEY);
  check('非法 kind 被拒（400）', badKind.status === 400);
  check('折扣券面额越界被拒（400）', badAmount.status === 400);

  // 让这张券真的落到某个用户卡包里，制造「有持券人」的场景
  const holder = `u_holder_${Date.now()}`;
  await req('POST', '/api/coupons', { userId: holder, couponId: 'cp-e2e-probe' });

  const raiseAmount = await putCatalog({ coupon: { ...testCoupon, amount: 200 } }, ADMIN_KEY);
  const catAfterBlock = await catalog();
  check(
    '有持券人时改面额被拦（409），目录未被改动',
    raiseAmount.status === 409
      && catAfterBlock.find((c) => c.couponId === 'cp-e2e-probe').amount === 10,
    String(raiseAmount.status),
  );
  check('拦截信息说明了影响面', /force/i.test(String(raiseAmount.d?.error || '')));

  const forced = await putCatalog({ coupon: { ...testCoupon, amount: 200 }, force: true }, ADMIN_KEY);
  check('带 force 才允许改（200）', forced.status === 200);

  const titleOnly = await putCatalog({ coupon: { ...testCoupon, amount: 200, title: '探针券 · 换个文案' } }, ADMIN_KEY);
  check('只改文案不拦（200）', titleOnly.status === 200);

  const catFinal = await catalog();
  check(
    '目录条目数不因写入而减少（只做 upsert，不删）',
    catFinal.length >= catAfterCreate.length,
    `${catAfterCreate.length} → ${catFinal.length}`,
  );

  /* ================= 浏览器层 ================= */
  console.log('\n浏览器层：结算页提交 / 幂等重放 / 支付方式配置');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 本轮会故意打 401（错密钥）、409（改面额被拦）与一次被 abort 的请求，
    // 浏览器会为每个失败响应记一条 "Failed to load resource"，那不是脚本错误。
    if (/Failed to load resource/i.test(m.text()) || /ERR_FAILED/i.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${APP}#/login`, { waitUntil: 'load' });
  await page.waitForSelector('.auth-id');
  await page.locator('.auth-id').fill(PHONE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(300);
  await page.locator('.auth-code').fill('123456');
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(900);
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('current_user') || '{}').id || '');
  check('登录成功并拿到服务端账户', Boolean(uid), uid);

  const seedCart = (qty = 4) => page.evaluate((q) => {
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
      stock: 200,
      qty: q,
    }]));
  }, qty);

  async function openCheckout() {
    await page.goto(`${APP}#/checkout`, { waitUntil: 'load' });
    await page.waitForSelector('.co2-grid');
    await page.waitForTimeout(900);
  }

  async function ensureAddress() {
    if (!(await page.locator('.co2-addr-add').count())) return;
    await page.locator('.co2-addr-add').click();
    await page.locator('.f-receiver').fill('幂等测试');
    await page.locator('.f-phone').fill(PHONE);
    await page.locator('.f-region').fill('浙江省 杭州市 西湖区');
    await page.locator('.f-detail').fill('文三路 88 号 2 单元');
    await page.locator('.co2-save').click();
    await page.waitForTimeout(900);
  }

  /* ---- 支付方式配置：新增一个方式，结算页应立刻出现 ---- */
  const cfgPut = await req('PUT', '/api/config', {
    settings: {
      payment: {
        methods: [
          { id: 'online', name: '在线支付', note: '微信 / 支付宝' },
          { id: 'wallet', name: '余额支付', note: 'e2e 注入的支付方式' },
        ],
        fallbackId: 'online',
      },
    },
  }, { 'X-Admin-Key': ADMIN_KEY });
  check('运营改支付方式配置成功（200）', cfgPut.status === 200);

  await seedCart(4);
  await openCheckout();
  await ensureAddress();

  const payTitles = await page.locator('.co2-pick-title').allTextContents();
  check(
    '结算页支付方式来自配置（出现「余额支付」）',
    payTitles.includes('余额支付') && payTitles.includes('在线支付'),
    payTitles.join(' / '),
  );
  check('下线的方式不再出现（货到付款已移除）', !payTitles.includes('货到付款'));

  /* ---- 幂等键：请求体带 key，且网络中断后带同一个 key 重放 ---- */
  const sentKeys = [];
  let orderHits = 0;
  await page.route('**/api/orders', async (route) => {
    const r = route.request();
    if (r.method() !== 'POST') return route.continue();
    orderHits += 1;
    let body = {};
    try { body = JSON.parse(r.postData() || '{}'); } catch { /* 非 JSON */ }
    sentKeys.push(body.idempotencyKey || '');
    // 第一次直接掐断：模拟「请求发出去了，响应没回来」
    if (orderHits === 1) return route.abort('failed');
    return route.continue();
  });

  // 选中「余额支付」：它由配置注入，服务端必须能原样记账
  const walletIdx = payTitles.indexOf('余额支付');
  await page.locator('.co2-pick').nth(walletIdx).click();
  await page.waitForTimeout(200);
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(2500);

  check('首次请求被中断后自动重放（共 2 次提交）', orderHits === 2, `${orderHits} 次`);
  check('两次请求携带同一个幂等键', sentKeys.length === 2 && sentKeys[0] === sentKeys[1], sentKeys[0]);
  check('幂等键格式合法', IDEM_RE.test(String(sentKeys[0] || '')), sentKeys[0]);

  const hash = await page.evaluate(() => location.hash);
  check('重放成功后跳到订单成功页', hash.startsWith('#/order-success/'), hash);

  const listB = await serverOrders(uid);
  check('重放没有产生第二单（服务端仅 1 单）', listB.length === 1, `${listB.length} 单`);
  check('订单记录了配置注入的支付方式', listB[0] && listB[0].paymentMethodId === 'wallet', listB[0] && listB[0].paymentMethodId);

  /* ---- 券目录写入 → 券中心可见 ---- */
  // 这才是「开放 PUT /api/coupons/catalog」的目的：运营改完券不用发版。
  // 只验接口返回只能证明写进了库，验页面才能证明整条链路真的通了。
  await putCatalog({
    coupon: {
      id: 'cp-e2e-center',
      title: 'E2E 运营新券',
      kind: 'cash',
      threshold: 150,
      amount: 15,
      expireDays: 20,
      scopeText: '全场通用',
    },
  }, ADMIN_KEY);
  await page.goto(`${APP}#/coupons`, { waitUntil: 'load' });
  await page.waitForTimeout(1600);
  const centerTitles = await page.locator('.cp-ticket-title').allTextContents();
  check(
    '运营新增的券出现在券中心（改完即生效，不用发版）',
    centerTitles.some((t) => t.includes('E2E 运营新券')),
    `${centerTitles.length} 张券`,
  );

  /* ---- 恢复配置，避免影响后续手工调试 ---- */
  await req('PUT', '/api/config', {
    settings: {
      payment: {
        methods: [
          { id: 'online', name: '在线支付', note: '微信 / 支付宝（演示环境不产生真实扣款）' },
          { id: 'cod', name: '货到付款', note: '签收时向配送员付款' },
        ],
        fallbackId: 'online',
      },
    },
  }, { 'X-Admin-Key': ADMIN_KEY });

  check('控制台无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  failed += 1;
  console.log(`  FAIL 运行异常: ${e.message}`);
} finally {
  cleanup();
}

console.log(failed === 0 ? '\n✓ 全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
