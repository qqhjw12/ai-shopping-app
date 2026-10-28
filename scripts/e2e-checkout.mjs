#!/usr/bin/env node
/**
 * 交易闭环真实浏览器验收（playwright-core + 本机 Edge，无头）。
 *
 * 为什么必须跑真机：DOM 垫片能证明「结构存在、事件能触发」，但证明不了
 * CSS 两栏是否真的并排、disabled 是否真的挡住点击、刷新后页面是否还原。
 *
 * 用法：node scripts/e2e-checkout.mjs [--port 4319] [--headed]
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
const PORT = Number((args[args.indexOf('--port') + 1] || '').match(/^\d+$/) ? args[args.indexOf('--port') + 1] : 4319);
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;

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

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const server = spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], {
  stdio: 'ignore',
});

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitForServer(`${BASE}/index.html`))) throw new Error('静态服务器没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const hash = () => page.evaluate(() => location.hash);
  const go = async (h) => {
    await page.goto(`${BASE}/index.html${h}`, { waitUntil: 'load' });
    await page.waitForTimeout(320);
  };

  console.log('\n交易闭环 e2e（购物袋 → 结算 → 下单 → 成功页 → 订单详情）');

  /* 1) 加购两件商品 */
  await go('#/products');
  await page.waitForSelector('.thumb-add', { timeout: 8000 });
  await page.locator('.thumb-add').nth(0).click();
  await page.waitForTimeout(160);
  await page.locator('.thumb-add').nth(1).click();
  await page.waitForTimeout(260);
  const badge = await page.locator('#cart-count').textContent();
  check('加购后角标更新', Number(badge) >= 2, `角标=${badge}`);

  /* 2) 购物袋整页：清单 + 去结算 */
  await go('#/cart');
  const bagRows = await page.locator('.bag-row').count();
  const bagTotal = (await page.locator('.bag-sum-money').textContent()) || '';
  check('购物袋整页渲染商品行', bagRows >= 2, `${bagRows} 行`);
  check('购物袋金额为 tabular-nums', await page.locator('.bag-sum-money').evaluate((n) => getComputedStyle(n).fontVariantNumeric === 'tabular-nums'));
  check('购物袋显示合计金额', /¥/.test(bagTotal), bagTotal);

  /* 3) 未登录点「去结算」→ 登录页且带 redirect */
  await page.locator('.bag-checkout').click();
  await page.waitForTimeout(360);
  const guestHash = await hash();
  check('未登录去结算跳登录页', guestHash.startsWith('#/login'), guestHash);
  check('登录 redirect 指向结算页', decodeURIComponent(guestHash).includes('/checkout'), guestHash);

  /* 4) 演示账号一键登录 → 回到结算页 */
  await page.locator('.auth-demo').click();
  await page.waitForTimeout(900);
  const afterLogin = await hash();
  check('登录后回到结算页', afterLogin === '#/checkout', afterLogin);

  /* 4.5) 券中心领券：结算页只认「我的券包」，没领的券不该出现在结算页 */
  await page.evaluate(() => { location.hash = '#/coupons'; });
  await page.waitForSelector('.cp-ticket', { timeout: 6000 });
  const ticketN = await page.locator('.cp-ticket').count();
  check('券中心列出可领取优惠券', ticketN >= 3, `${ticketN} 张`);
  for (let i = 0; i < ticketN; i += 1) {
    const btn = page.locator('.cp-claim:not([disabled])').first();
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.waitForTimeout(160);
  }
  const claimedN = await page.locator('.cp-claim[disabled]').count();
  check('领券后按钮置灰为「已领取」', claimedN === ticketN, `${claimedN}/${ticketN}`);
  const walletStatText = (await page.locator('.cp-stats').textContent()) || '';
  check('券包摘要显示未使用张数', walletStatText.includes(String(ticketN)), walletStatText.trim());

  await page.evaluate(() => { location.hash = '#/checkout'; });
  await page.waitForTimeout(420);

  /* 5) 结算页结构与门禁 */
  await page.waitForSelector('.co2-grid', { timeout: 6000 });
  const cols = await page.locator('.co2-grid').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  check('桌面端为两栏布局', cols === 2, `${cols} 列`);
  const addrCards = await page.locator('.co2-addr').count();
  const submitDisabled = await page.locator('.co2-submit').isDisabled();
  check('无地址时提交按钮禁用', submitDisabled, `地址卡 ${addrCards} 张`);
  check('无地址时给出提示', await page.locator('.co2-sum-hint').isVisible());

  /* 6) 新增地址 */
  await page.locator('.co2-addr-add').click();
  await page.locator('.f-receiver').fill('张三');
  await page.locator('.f-phone').fill('13800001234');
  await page.locator('.f-region').fill('上海市 浦东新区');
  await page.locator('.f-detail').fill('世纪大道 100 号 8 楼');
  await page.locator('.co2-save').click();
  await page.waitForTimeout(520);
  const addrAfter = await page.locator('.co2-addr').count();
  const submitEnabled = !(await page.locator('.co2-submit').isDisabled());
  check('新增地址后出现地址卡', addrAfter >= 1, `${addrAfter} 张`);
  check('选中地址后提交按钮可用', submitEnabled);

  /* 7) 配送方式 / 支付方式 / 金额联动 */
  const total0 = (await page.locator('.co2-sum-money').textContent()) || '';
  await page.locator('.co2-pick').nth(1).click();
  await page.waitForTimeout(140);
  const total1 = (await page.locator('.co2-sum-money').textContent()) || '';
  check('切加急配送后运费计入应付', total0 !== total1, `${total0} → ${total1}`);
  await page.locator('.co2-pick').nth(3).click();
  await page.waitForTimeout(120);
  check('支付方式可切到货到付款', (await page.locator('.co2-pick').nth(3).getAttribute('aria-checked')) === 'true');

  /* 8) 商品清单可返回购物袋 */
  const backHref = await page.locator('.co2-item-edit').getAttribute('href');
  check('清单可返回购物袋修改', backHref === '#/cart');

  /* 8.5) 券卡：已领取券可见、自动选中一张、不可用券写明差额 */
  const cpText = (await page.locator('.co2-coupons').textContent()) || '';
  const couponOn = await page.locator('.co2-cp.is-on').count();
  const couponCount = await page.locator('.co2-cp').count();
  check('结算页显示券包里的券', couponCount >= 3, `${couponCount} 张`);
  check('自动选中最优券并显示抵扣额', couponOn === 1 && /已抵扣 ¥\d+/.test(cpText), cpText.slice(0, 40));
  // 这笔订单金额较高，所有券都达门槛；这里只保证「若有不可用券，必须写明原因」
  const offCount = await page.locator('.co2-cp.is-off').count();
  check('不可用券写明原因', offCount === 0 || /还差 ¥|已过期|已使用/.test(cpText), `不可用 ${offCount} 张`);
  check('券卡用金色细边框标示选中',
    await page.locator('.co2-cp.is-on').evaluate((n) => {
      const c = getComputedStyle(n).borderColor;
      return /200,\s*169,\s*110/.test(c);
    }));

  /* 9) 备注 + 提交 */
  await page.locator('.co2-remark').fill('工作日送达，放前台');
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(900);
  const successHash = await hash();
  check('提交后跳订单成功页', successHash.startsWith('#/order-success/'), successHash);

  const orderId = decodeURIComponent(successHash.replace('#/order-success/', ''));
  const osText = (await page.locator('.os-card').textContent()) || '';
  check('成功页显示订单号', osText.includes(orderId), orderId);
  check('成功页显示应付金额', /¥/.test(osText));
  check('成功页状态为待付款', osText.includes('待付款'));
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('maison_orders::'));
    return { key, orders: JSON.parse(localStorage.getItem(key) || '[]'), cart: JSON.parse(localStorage.getItem('shop_cart') || '[]') };
  });
  check('订单写入 localStorage（按用户分区）', stored.orders.length === 1 && /maison_orders::/.test(stored.key || ''), stored.key);
  check('提交后购物袋清空', stored.cart.length === 0, `剩 ${stored.cart.length} 件`);
  const o = stored.orders[0] || {};
  check('订单结构完整', Boolean(o.id && o.userId && o.items && o.items.length === 2 && o.address
    && o.shippingMethod && o.paymentMethod && o.amounts && o.status === 'pending' && o.createdAt));
  check('订单状态为待付款', o.status === 'pending', o.status);
  check('备注已写入订单', o.remark === '工作日送达，放前台', o.remark);
  // 优惠券自动选最优：演示券 9 折（满 199），订单应付 = 商品总额 + 运费 - 折扣
  const cpDiscount = (o.amounts || {}).couponDiscount;
  const cpTitle = (o.amounts || {}).couponTitle || '';
  check('优惠券自动选最优并计入订单',
    cpDiscount > 0 && cpDiscount === Math.floor((o.amounts.productAmount || 0) * 10 / 100)
      && o.amounts.payAmount === o.amounts.productAmount + o.amounts.shippingFee - cpDiscount,
    `券 ${cpTitle} 抵 ${cpDiscount}，应付 ${o.amounts && o.amounts.payAmount}`);

  /* 10) 刷新不丢订单 */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(420);
  const afterReload = (await page.locator('.os-card').textContent()) || '';
  check('刷新后成功页仍显示该订单', afterReload.includes(orderId));

  /* 11) 成功页 → 订单详情 */
  await page.locator('.os-btn').first().click();
  await page.waitForTimeout(560);
  const detailHash = await hash();
  const detailText = (await page.locator('.od-card').textContent()) || '';
  check('查看订单进入详情页', detailHash === `#/account/order/${orderId}`, detailHash);
  check('详情页还原订单内容', detailText.includes(orderId) && /加急配送/.test(detailText) && /货到付款/.test(detailText));

  /* 12) 个人中心订单列表能看到这笔单 */
  await go('#/account?tab=orders');
  await page.waitForTimeout(420);
  const acctText = (await page.locator('.acct-orders').textContent().catch(() => '')) || '';
  check('个人中心订单列表含新订单', acctText.includes(orderId));

  /* 13) 移动端单栏（先补一件商品，购物袋刚被清空） */
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#/products');
  await page.locator('.thumb-add').nth(0).click();
  await page.waitForTimeout(220);
  await go('#/cart');
  const mobileBags = await page.locator('.bag-grid').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  await go('#/checkout');
  await page.waitForSelector('.co2-grid', { timeout: 6000 });
  const mobileCols = await page.locator('.co2-grid').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  check('移动端购物袋单栏', mobileBags === 1, `${mobileBags} 列`);
  check('移动端结算单栏', mobileCols === 1, `${mobileCols} 列`);

  // 静态演示站没有网关，首屏会有一批 /api 探测 404（浏览器网络日志）。
  // 这里判定的是「JS 运行时错误」：TypeError / undefined 之类才算出错，
  // 网络 404 已由 api.js 的「无后端」记忆机制收敛，且单独计数如实报告。
  const jsErrors = consoleErrors.filter((t) => !/Failed to load resource/i.test(t));
  const net404 = consoleErrors.filter((t) => /Failed to load resource/i.test(t)).length;
  check('控制台无 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  console.log(`  info 静态演示站的 /api 探测 404 日志：${net404} 条（非 JS 错误）`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed}/${results.length} 项通过`);
} catch (e) {
  failed += 1;
  console.log(`\n✗ e2e 异常: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
process.exit(failed === 0 ? 0 : 1);
