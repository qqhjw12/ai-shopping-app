#!/usr/bin/env node
/**
 * 优惠券真实浏览器验收（playwright-core + 本机 Edge，无头）。
 *
 * 覆盖的是「券的生命周期」，这一条链最容易在页面之间断掉：
 *   券中心领取 → 我的券包 → 结算页抵扣 → 下单核销 → 取消订单返还 → 刷新仍一致。
 * 用低价商品造门槛不足的场景，验证「不可用券要说清楚还差多少钱」。
 *
 * 用法：node scripts/e2e-coupons.mjs [--port 4321] [--headed]
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
const PORT = Number((args[args.indexOf('--port') + 1] || '').match(/^\d+$/) ? args[args.indexOf('--port') + 1] : 4321);
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
    await page.waitForTimeout(340);
  };

  console.log('\n优惠券 e2e（券中心 → 券包 → 结算抵扣 → 核销 → 取消返还）');

  /* 1) 未登录也能浏览券中心，但按钮是先登录 */
  await go('#/coupons');
  await page.waitForSelector('.cp-ticket', { timeout: 8000 });
  const ticketN = await page.locator('.cp-ticket').count();
  const guestBtn = (await page.locator('.cp-claim').first().textContent()) || '';
  const heroText = (await page.locator('.cp-page').textContent()) || '';
  check('券中心列出可领取优惠券', ticketN >= 3, `${ticketN} 张`);
  check('未登录按钮为「登录后领取」', guestBtn.includes('登录后领取'), guestBtn);
  check('券卡含门槛 / 有效期 / 适用范围',
    /满 ¥\d+ 可用/.test(heroText) && /有效期：领取后 \d+ 天/.test(heroText) && /适用范围：/.test(heroText));
  check('票券面额用衬线大数字',
    await page.locator('.cp-ticket-num').first().evaluate((n) => /Playfair|serif/i.test(getComputedStyle(n).fontFamily)));

  /* 2) 未登录点领取 → 登录页（redirect 回券中心） */
  await page.locator('.cp-claim').first().click();
  await page.waitForTimeout(420);
  const loginHash = await hash();
  check('未登录点领取跳登录页', loginHash.startsWith('#/login'), loginHash);
  check('登录 redirect 回到券中心', decodeURIComponent(loginHash).includes('/coupons'), loginHash);

  await page.locator('.auth-demo').click();
  await page.waitForTimeout(900);
  check('登录后回到券中心', (await hash()) === '#/coupons', await hash());

  /* 3) 领取全部 → 按钮置灰 */
  await page.waitForSelector('.cp-ticket', { timeout: 6000 });
  for (let i = 0; i < ticketN; i += 1) {
    const btn = page.locator('.cp-claim:not([disabled])').first();
    if ((await btn.count()) === 0) break;
    await btn.click();
    await page.waitForTimeout(170);
  }
  const claimedN = await page.locator('.cp-claim[disabled]').count();
  check('领取后按钮置灰为「已领取」', claimedN === ticketN, `${claimedN}/${ticketN}`);
  const statText = (await page.locator('.cp-stats').textContent()) || '';
  check('券包摘要同步未使用张数', statText.includes(String(ticketN)), statText.trim());
  check('已领取显示到期日', /已领取 · \d{4}\.\d{2}\.\d{2} 到期/.test(
    (await page.locator('.cp-ticket-meta').first().textContent()) || ''));

  /* 4) 刷新后领取状态保持 */
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.cp-ticket', { timeout: 6000 });
  await page.waitForTimeout(250);
  check('刷新后仍为已领取', (await page.locator('.cp-claim[disabled]').count()) === ticketN);

  /* 5) 我的券包：三个 Tab 与计数 */
  await go('#/account?tab=coupons');
  await page.waitForSelector('.mycp-tabs', { timeout: 6000 });
  const myTabs = await page.locator('.mycp-tab').count();
  const myCards = await page.locator('.mycp').count();
  const unusedPanel = (await page.locator('.acct-panel').textContent()) || '';
  check('我的优惠券三个 Tab', myTabs === 3, `${myTabs} 个`);
  check('未使用 Tab 列出全部券', myCards === ticketN, `${myCards} 张`);
  check('面板统计与券包一致', unusedPanel.includes(`${ticketN} 张可用`), unusedPanel.slice(0, 40));
  await page.locator('.mycp-tab').nth(1).click();
  await page.waitForTimeout(200);
  check('已使用 Tab 空态', /还没有用过优惠券/.test((await page.locator('.acct-panel').textContent()) || ''));
  await page.locator('.mycp-tab').nth(0).click();
  await page.waitForTimeout(150);

  /* 6) 低价订单：金额不足门槛 → 券不可用并写明差额 */
  await page.evaluate(() => {
    localStorage.setItem('shop_cart', JSON.stringify([{
      id: 'p244',
      productId: 'p244',
      skuId: null,
      itemId: null,
      __key: 'p244',
      name: '墨方 自动铅笔 0.5mm',
      price: 29,
      pic: '',
      coverColor: '',
      brand: '墨方',
      spec: '黑色 / 0.5mm',
      categoryId: 'c_stationery',
      stock: 20,
      qty: 1,
    }]));
  });
  await go('#/checkout');
  await page.waitForSelector('.co2-grid', { timeout: 6000 });
  await page.locator('.co2-addr-add').click();
  await page.locator('.f-receiver').fill('券测试');
  await page.locator('.f-phone').fill('13700007777');
  await page.locator('.f-region').fill('浙江省 杭州市 西湖区');
  await page.locator('.f-detail').fill('文二西路 66 号 3 单元');
  await page.locator('.co2-save').click();
  await page.waitForTimeout(560);

  const lowText = (await page.locator('.co2-coupons').textContent()) || '';
  const lowTotal = (await page.locator('.co2-sum-money').textContent()) || '';
  check('金额不足时无可用券', (await page.locator('.co2-cp.is-on').count()) === 0);
  check('不可用券写明还差多少钱', /还差 ¥70/.test(lowText), lowText.slice(0, 60));
  check('无券时应付 = 商品总额', lowTotal === '¥29', lowTotal);

  /* 7) 加到 4 件（116 元）→ 满 99 减 30 自动生效 */
  for (let i = 0; i < 3; i += 1) {
    await page.locator('.co2-step').nth(1).click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(260);
  const qtyText = (await page.locator('.co2-qty-n').textContent()) || '';
  const upText = (await page.locator('.co2-coupons').textContent()) || '';
  const upTotal = (await page.locator('.co2-sum-money').textContent()) || '';
  check('清单可加数量到 4 件', qtyText.trim() === '4', qtyText.trim());
  check('达标后自动选中最优券', (await page.locator('.co2-cp.is-on').count()) === 1 && /已抵扣 ¥30/.test(upText));
  check('抵扣后应付 = 116 − 30', upTotal === '¥86', upTotal);

  /* 8) 下单 → 券核销为已使用 */
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(900);
  const successHash = await hash();
  check('提交后进入成功页', successHash.startsWith('#/order-success/'), successHash);
  const orderId = decodeURIComponent(successHash.replace('#/order-success/', ''));
  const order = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('maison_orders::'));
    return (JSON.parse(localStorage.getItem(k) || '[]'))[0] || {};
  });
  check('订单记录券抵扣与券 id',
    order.amounts && order.amounts.couponDiscount === 30 && order.amounts.couponId === 'demo-c30',
    `抵 ${order.amounts && order.amounts.couponDiscount}`);

  await go('#/account?tab=coupons');
  await page.locator('.mycp-tab').nth(1).click();
  await page.waitForTimeout(250);
  const usedPanel = (await page.locator('.acct-panel').textContent()) || '';
  check('券包里该券变为已使用', (await page.locator('.mycp.is-used').count()) === 1, usedPanel.slice(0, 40));
  check('已使用卡片带订单号', usedPanel.includes(orderId));

  /* 9) 取消订单 → 券退回未使用 */
  await go(`#/account/order/${encodeURIComponent(orderId)}`);
  await page.waitForSelector('.od-card', { timeout: 6000 });
  check('待付款订单可取消', (await page.locator('.od-cancel').count()) === 1);
  await page.locator('.od-cancel').click();
  await page.waitForTimeout(200);
  check('取消需二次确认', /确认取消/.test((await page.locator('.od-cancel').textContent()) || ''));
  await page.locator('.od-cancel').click();
  await page.waitForTimeout(700);
  const afterCancel = (await page.locator('.od-card').textContent()) || '';
  check('取消后订单显示已取消', /已取消/.test(afterCancel), afterCancel.slice(0, 30));

  await go('#/account?tab=coupons');
  await page.waitForTimeout(360);
  const refundText = (await page.locator('.acct-panel').textContent()) || '';
  check('取消后券退回未使用', (await page.locator('.mycp.is-unused').count()) === ticketN, `${await page.locator('.mycp').count()} 张`);
  check('返还后统计回到全部可用', refundText.includes(`${ticketN} 张可用`), refundText.slice(0, 40));

  /* 10) 过期状态由时间推导：把一张券的到期时间改到昨天 */
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith('maison_coupons::'));
    const list = JSON.parse(localStorage.getItem(k) || '[]');
    const hit = list.find((w) => w.couponId === 'cp-bag20');
    if (hit) hit.expiresAt = Date.now() - 86400000;
    localStorage.setItem(k, JSON.stringify(list));
  });
  await go('#/account?tab=coupons');
  await page.locator('.mycp-tab').nth(2).click();
  await page.waitForTimeout(250);
  const expiredPanel = (await page.locator('.acct-panel').textContent()) || '';
  check('过期券落入已过期 Tab', (await page.locator('.mycp.is-expired').count()) === 1);
  check('已过期卡片写明过期日期', /已过期/.test(expiredPanel) && /\d{4}\.\d{2}\.\d{2}/.test(expiredPanel));

  /* 11) 移动端券中心单列、无横向溢出 */
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#/coupons');
  await page.waitForSelector('.cp-ticket', { timeout: 6000 });
  const colsMobile = await page.locator('.cp-grid').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端券中心单列', colsMobile === 1, `${colsMobile} 列`);
  check('移动端无横向溢出', overflow <= 0, `溢出 ${overflow}px`);

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
