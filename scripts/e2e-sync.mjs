#!/usr/bin/env node
/**
 * 跨设备同步验收（playwright-core + 本机 Edge + 真网关 + 静态站）。
 *
 * 两个独立的浏览器上下文 = 两台设备：localStorage 完全隔离，只共享
 * 「同一个手机号 → 同一个 userId → 同一个网关卡包」这一条链路。
 * 这正是跨设备同步唯一有意义的前提，也是它最容易坏的地方。
 *
 * 覆盖：
 *   1) 设备 A 领券 → 设备 B 同步后也能看到（领取即上云）
 *   2) 设备 A 下单核销 → 设备 B 看到「已使用」（服务端是核销真源）
 *   3) 设备 A 取消订单 → 设备 B 看到「未使用」且有效期顺延 7 天
 *   4) 设备 B 离线期间的操作，联网后被补推（不丢券）
 *
 * 用法：node scripts/e2e-sync.mjs [--port 4330] [--gw 8086] [--headed]
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
const PORT = Number(argOf('--port', '4330'));
const GW_PORT = Number(argOf('--gw', '8086'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;

// 两台「设备」用同一个手机号登录：同号必须映射到同一个账户，否则同步无从谈起。
// 每次跑用一个新号，避免上一轮的卡包/订单击穿本轮断言。
const PHONE = `139${String(Date.now()).slice(-8)}`;
const CODE = '123456';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok });
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
    env: { ...process.env, PORT: String(GW_PORT), CORS_ORIGINS: BASE, RATE_LIMIT_PER_MIN: '0' },
  },
);

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });

  /** 开一台「设备」：独立 context，登录同一手机号 */
  async function device(name) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.goto(`${APP}#/login`, { waitUntil: 'load' });
    await page.waitForSelector('.auth-id');
    await page.locator('.auth-id').fill(PHONE);
    await page.locator('.auth-submit').click();
    await page.waitForTimeout(300);
    await page.locator('.auth-code').fill(CODE);
    await page.locator('.auth-submit').click();
    await page.waitForTimeout(900);
    const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('current_user') || '{}').id || '');
    return { name, ctx, page, errors, uid };
  }

  /** 把钱包整份读出来（含状态推导后的 display 字段） */
  const walletOf = (dev) => dev.page.evaluate(async () => {
    const mod = await import('/js/store/couponStore.js');
    const uid = JSON.parse(localStorage.getItem('current_user') || '{}').id;
    return { stats: mod.walletStats(uid), list: mod.listWallet(uid) };
  });

  /**
   * 打开券包并等待同步完成。
   * 必须显式 reload：hash 没变时 goto 属于「同文档导航」，既不重载页面也不触发
   * hashchange，页面不重绘就不会重新同步——断言会安静地读到上一轮的旧卡包。
   */
  async function openWallet(dev) {
    await dev.page.goto(`${APP}#/account?tab=coupons`, { waitUntil: 'load' });
    await dev.page.reload({ waitUntil: 'load' });
    await dev.page.waitForSelector('.mycp-tabs');
    await dev.page.waitForTimeout(1100);
  }

  async function openCenter(dev) {
    await dev.page.goto(`${APP}#/coupons`, { waitUntil: 'load' });
    await dev.page.reload({ waitUntil: 'load' });
    await dev.page.waitForSelector('.cp-ticket');
    await dev.page.waitForTimeout(1100);
  }

  const A = await device('A');
  const B = await device('B');

  console.log('\n跨设备同步 e2e（领券上云 / 核销同步 / 返还顺延 / 离线补推）');

  /* 0) 同号登录 → 同一个 userId；开户赠券来自服务端 */
  check('两台设备同号登录得到同一账户', Boolean(A.uid) && A.uid === B.uid, A.uid);
  await openWallet(A);
  const a0 = await walletOf(A);
  check('开户赠券由服务端下发（3 张未使用）', a0.stats.unused === 3, `${a0.stats.unused} 张`);

  /* 1) A 领券 → B 同步可见 */
  await openCenter(A);
  const claimTarget = await A.page.evaluate(() => {
    const btns = [...document.querySelectorAll('.cp-claim')].filter((b) => !b.disabled);
    if (!btns.length) return '';
    const card = btns[0].closest('.cp-ticket');
    const id = card && card.getAttribute('data-coupon');
    btns[0].click();
    return id;
  });
  await A.page.waitForTimeout(1200);
  check('设备 A 领取一张新券', Boolean(claimTarget), claimTarget);
  const a1 = await walletOf(A);
  check('设备 A 券包变为 4 张未使用', a1.stats.unused === 4, `${a1.stats.unused} 张`);

  await openWallet(B);
  const b1 = await walletOf(B);
  check('设备 B 同步后也看到 4 张', b1.stats.unused === 4, `${b1.stats.unused} 张`);
  check('设备 B 看到同一张券', b1.list.some((c) => c.couponId === claimTarget));

  /* 2) A 下单核销 → B 看到已使用 */
  await A.page.evaluate(() => {
    localStorage.setItem('shop_cart', JSON.stringify([{
      id: 'p244', productId: 'p244', skuId: null, itemId: null, __key: 'p244',
      name: '墨方 自动铅笔 0.5mm', price: 128, pic: '', coverColor: '', brand: '墨方',
      spec: '黑色 / 0.5mm', categoryId: 'c_stationery', stock: 20, qty: 1,
    }]));
  });
  await A.page.goto(`${APP}#/checkout`, { waitUntil: 'load' });
  await A.page.waitForSelector('.co2-grid');
  await A.page.waitForTimeout(900);
  // 首次结算需要地址：新增一条（地址簿也在服务端，两台设备共享）
  if (await A.page.locator('.co2-addr-add').count()) {
    await A.page.locator('.co2-addr-add').click();
    await A.page.locator('.f-receiver').fill('同步测试');
    await A.page.locator('.f-phone').fill(PHONE);
    await A.page.locator('.f-region').fill('浙江省 杭州市 西湖区');
    await A.page.locator('.f-detail').fill('文三路 88 号 2 单元');
    await A.page.locator('.co2-save').click();
    await A.page.waitForTimeout(900);
  }
  const pickedCoupon = await A.page.evaluate(() => {
    const on = document.querySelector('.co2-cp.is-on');
    return on ? on.getAttribute('data-coupon') : '';
  });
  check('设备 A 结算页自动选中一张券', Boolean(pickedCoupon), pickedCoupon);
  await A.page.locator('.co2-submit').click();
  await A.page.waitForTimeout(1600);
  const successHash = await A.page.evaluate(() => location.hash);
  check('设备 A 下单成功', successHash.startsWith('#/order-success/'), successHash);

  const b2 = await (async () => {
    await openWallet(B);
    return walletOf(B);
  })();
  const bUsed = b2.list.find((c) => c.couponId === pickedCoupon);
  check('设备 B 看到该券已使用', bUsed && bUsed.state === 'used', bUsed && bUsed.state);
  check('设备 B 的核销记录带订单号', Boolean(bUsed && bUsed.orderId), (bUsed && bUsed.orderId) || '');

  /* 3) A 取消订单 → B 看到未使用 + 顺延 */
  const beforeExpiry = bUsed ? bUsed.expiresAt : 0;
  const orderId = successHash.replace('#/order-success/', '');
  await A.page.goto(`${APP}#/account/order/${encodeURIComponent(orderId)}`, { waitUntil: 'load' });
  await A.page.waitForSelector('.od-cancel');
  await A.page.locator('.od-cancel').click();
  await A.page.waitForTimeout(200);
  await A.page.locator('.od-cancel').click(); // 二次确认
  await A.page.waitForTimeout(1800);

  await openWallet(B);
  const b3 = await walletOf(B);
  const bBack = b3.list.find((c) => c.couponId === pickedCoupon);
  check('设备 B 看到券已退回未使用', bBack && bBack.state === 'unused', bBack && bBack.state);
  const graceDays = 7;
  check(
    `设备 B 看到有效期顺延 ${graceDays} 天`,
    Boolean(bBack) && bBack.expiresAt - beforeExpiry === graceDays * 86400000,
    bBack ? `${new Date(bBack.expiresAt).toISOString().slice(0, 10)}（+${(bBack.expiresAt - beforeExpiry) / 86400000} 天）` : '',
  );
  check('设备 B 看到顺延次数', Boolean(bBack) && bBack.extensionCount === 1, String(bBack && bBack.extensionCount));
  const shownGrace = await B.page.evaluate(() => document.body.textContent.includes('已顺延 1 次'));
  check('券包卡片显示「已顺延」', shownGrace);

  /* 4) 离线补推：B 断网领券 → 恢复后 A 也能看到 */
  await B.ctx.setOffline(true);
  // 断网时不能 reload（会直接 ERR_INTERNET_DISCONNECTED），就在当前页面里直接调领券动作
  const offlineClaim = await B.page.evaluate(async () => {
    const mod = await import('/js/store/couponStore.js');
    const uid = JSON.parse(localStorage.getItem('current_user') || '{}').id;
    const cat = mod.currentCatalog().find((c) => !mod.hasClaimed(uid, c.id));
    if (!cat) return '';
    const r = await mod.claimCoupon(uid, cat.id);
    return r.ok ? cat.id : '';
  });
  check('设备 B 离线也能领券（本地成功）', Boolean(offlineClaim), offlineClaim);
  await B.ctx.setOffline(false);
  await openWallet(B);
  await B.page.waitForTimeout(600);
  // 前端跑在静态站端口上，/api 相对路径打不到网关，校核要用绝对地址
  const pushedToServer = await B.page.evaluate(async ({ cid, gw }) => {
    const uid = JSON.parse(localStorage.getItem('current_user') || '{}').id;
    const r = await fetch(`${gw}/api/coupons?userId=${encodeURIComponent(uid)}&all=1`);
    const d = await r.json();
    return (d.coupons || []).some((c) => c.couponId === cid);
  }, { cid: offlineClaim, gw: GW });
  check('离线领的券联网后补推到服务端', pushedToServer);
  await openWallet(A);
  const a4 = await walletOf(A);
  check('设备 A 也能看到 B 离线领的券', a4.list.some((c) => c.couponId === offlineClaim));

  /* 5) 控制台干净 */
  const pageErrors = [...A.errors, ...B.errors];
  check('两台设备控制台均无 JS 错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${results.length - failed}/${results.length} 项通过`);
} catch (e) {
  failed += 1;
  console.log(`\n✗ 异常：${e && e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  gateway.kill();
  staticServer.kill();
}
process.exit(failed ? 1 : 0);
