#!/usr/bin/env node
/**
 * 场景化 / 情绪化 / 节日化购物入口验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖规格「七、验收」：
 *   1) 首页有「今天想逛什么」（8 卡横滚）、「按心情挑」（6 胶囊）、节日主题横幅；
 *   2) 场景页 / 情绪结果页 / 主题页可访问，商品全部来自真实商品池（抽查 id 归属）；
 *   3) 场景商品卡可加购、收藏、加入对比；
 *   4) 情绪页说明行是数据推导（命中标签来自筛出的商品），页内可切换心情；
 *   5) 主题页有主题券（与券中心同一张）+ 场景入口 + 演示日期切换，恢复今天后一致；
 *   6) 移动端横向滚动不溢出、热区 ≥ 44px；控制台无 JS 错误。
 *
 * 用法：node scripts/e2e-scene-mood-theme.mjs [--port 4435] [--headed]
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
const PORT = Number(argOf('--port', '4435'));
const APP = `http://127.0.0.1:${PORT}/index.html`;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: EDGE, headless: !args.includes('--headed') });
const consoleErrors = [];
async function newPage({ viewport, mobile = false } = {}) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    // /api 404、外部演示图断连是已知网络噪音（无后端演示站的常态）
    if (/Failed to load resource|net::|ERR_|404/.test(t)) return;
    consoleErrors.push(t.slice(0, 160));
  });
  return page;
}

const bagCount = (p) => p.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('shop_cart') || '[]').length; } catch { return 0; }
});

try {
  /* ================= 0) 准备：登录演示账号 ================= */
  const page = await newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('current_user', JSON.stringify({
      id: 'u_demo', nickname: '演示买手', identifier: '13800000000', via: 'demo',
    }));
  });

  /* ================= 1) 首页三块入口 ================= */
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.sc-entry', { timeout: 10000 });
  await page.waitForTimeout(600);

  check('首页有「今天想逛什么」区块', await page.locator('.sc-entry-head h2').innerText() === '今天想逛什么');
  const cardN = await page.locator('.sc-card').count();
  check('场景卡默认 6–8 张（不一次铺满）', cardN >= 6 && cardN <= 8, `${cardN} 张`);
  const railScroll = await page.evaluate(() => {
    const r = document.querySelector('.sc-rail');
    return r ? { sw: r.scrollWidth, cw: r.clientWidth } : null;
  });
  check('场景轨道可横向滑动', Boolean(railScroll && railScroll.sw > railScroll.cw), JSON.stringify(railScroll));
  check('页面本身无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0);
  const pillN = await page.locator('.md-pill').count();
  check('情绪标签 4–6 个', pillN >= 4 && pillN <= 6, `${pillN} 个`);
  check('情绪胶囊热区 ≥ 44px', await page.locator('.md-pill').first().evaluate((n) => n.getBoundingClientRect().height) >= 43.5);
  check('首页有主题横幅', await page.locator('.td-banner').count() === 1);
  const bannerTitle = await page.locator('.td-banner-title').innerText();
  check('横幅带衬线标题与主题券标记', bannerTitle.length > 0 && (await page.locator('.td-banner-coupon').count()) === 1, bannerTitle);

  /* ================= 2) 场景页：跨分类组合 + 三动作 ================= */
  await page.locator('.sc-card').first().click();
  await page.waitForSelector('.sc-grid .pcard', { timeout: 10000 });
  check('场景卡进入 #/scene/:id', /#\/scene\/commute$/.test(new URL(page.url()).hash), page.url());
  check('场景页头图带场景名与场景文案',
    (await page.locator('.sc-hero-name').innerText()) === '通勤穿搭'
    && (await page.locator('.sc-hero-line').innerText()).length > 8);

  const sceneN = await page.locator('.sc-grid .pcard').count();
  check('场景页商品不少于 12 件', sceneN >= 12, `${sceneN} 件`);

  // 商品必须真的来自商品池：把 DOM 上的对比开关 data-compare-id 拿去对池子
  const sceneIds = await page.evaluate(() => [...document.querySelectorAll('.cmp-toggle')]
    .map((n) => n.getAttribute('data-compare-id')));
  const inPool = await page.evaluate(async (ids) => {
    const V = await import('/js/views.js');
    const pool = await V.getProducts();
    const known = new Set(pool.map((p) => String(p.id)));
    const cats = new Set();
    pool.forEach((p) => { if (ids.includes(String(p.id))) cats.add(p.categoryId); });
    return { allKnown: ids.every((id) => known.has(id)), cats: cats.size, n: ids.length };
  }, sceneIds);
  check('场景商品全部来自真实商品池（无假商品）', inPool.allKnown && inPool.n > 0, JSON.stringify(inPool));
  check('场景结果真的跨分类（≥3 个类目）', inPool.cats >= 3, `${inPool.cats} 类`);

  const bagBefore = await bagCount(page);
  await page.locator('.sc-grid .pcard .thumb-add').first().click();
  await page.waitForTimeout(500);
  check('场景商品可加入购物袋', (await bagCount(page)) === bagBefore + 1, `${bagBefore} → ${await bagCount(page)}`);

  const fav = page.locator('.sc-grid .pcard .card-fav').first();
  await fav.click();
  await page.waitForTimeout(300);
  check('场景商品可收藏', (await fav.getAttribute('class')).includes('is-active'));

  const cmp = page.locator('.sc-grid .pcard .cmp-toggle').first();
  await cmp.click();
  await page.waitForTimeout(300);
  check('场景商品可加入对比', (await cmp.getAttribute('aria-pressed')) === 'true');

  /* ================= 3) 情绪结果页 ================= */
  await page.goto(`${APP}#/mood/heal`, { waitUntil: 'load' });
  await page.waitForSelector('.sc-grid .pcard', { timeout: 10000 });
  check('情绪页可访问且标题为所选心情', (await page.locator('.sc-hero-name').innerText()) === '治愈');
  const line = await page.locator('.sc-hero-line').innerText();
  check('「为这种心情挑的」一行是数据推导（带实际命中标签）',
    line.startsWith('为这种心情挑的：') && line.length > '为这种心情挑的：'.length, line);

  const moodN = await page.locator('.sc-grid .pcard').count();
  check('情绪结果不少于 6 件', moodN >= 6, `${moodN} 件`);
  check('当前心情在胶囊上呈选中态',
    (await page.locator('.md-pill.is-active .md-pill-name').innerText()) === '治愈');

  const firstBefore = await page.locator('.sc-grid .pcard .name').first().innerText();
  await page.locator('.md-pill', { hasText: '专注' }).click();
  await page.waitForSelector('.sc-grid .pcard', { timeout: 10000 });
  await page.waitForTimeout(400);
  check('页内切换心情（不回首页）', /#\/mood\/focus$/.test(new URL(page.url()).hash));
  check('切换后结果随之变化',
    (await page.locator('.sc-hero-name').innerText()) === '专注'
    && (await page.locator('.sc-grid .pcard .name').first().innerText()) !== firstBefore);
  check('切换后选中态跟着走',
    (await page.locator('.md-pill.is-active .md-pill-name').innerText()) === '专注');

  /* ================= 4) 主题页：券 + 场景 + 演示日期 ================= */
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.td-banner');
  const bannerHref = await page.locator('.td-banner').getAttribute('href');
  await page.locator('.td-banner').click();
  await page.waitForSelector('.td-block', { timeout: 10000 });
  check('横幅进入当期主题页', new URL(page.url()).hash === bannerHref, `${page.url()} vs ${bannerHref}`);
  const themeName = await page.locator('.sc-hero-name').innerText();
  check('主题页带名称、窗口与文案', themeName.length > 0 && (await page.locator('.td-banner-window, .sc-hero-meta').count()) >= 1, themeName);

  const themeN = await page.locator('.sc-grid .pcard').count();
  check('主题商品池不少于 12 件', themeN >= 12, `${themeN} 件`);
  const couponId = await page.locator('.td-coupon').getAttribute('data-coupon');
  const couponInCatalog = await page.evaluate(async (id) => {
    const C = await import('/js/store/couponStore.js');
    return C.currentCatalog().some((c) => c.id === id);
  }, couponId);
  check('主题券与券中心是同一张券', Boolean(couponId) && couponInCatalog, couponId);
  check('主题页有场景入口（≥2 个）', (await page.locator('.td-scene').count()) >= 2);

  await page.locator('.td-coupon-btn').click();
  await page.waitForTimeout(900);
  check('主题券可领取且领取后变为已领取',
    (await page.locator('.td-coupon-btn').innerText()) === '已领取');

  // 演示日期切换：换一个日期，主题必须变；恢复今天，主题必须回来
  await page.locator('.td-mock-btn', { hasText: '12-20' }).click();
  await page.waitForSelector('.td-block', { timeout: 10000 });
  await page.waitForTimeout(500);
  const mockedName = await page.locator('.sc-hero-name').innerText();
  const mockedNow = await page.locator('.td-mock-now').innerText();
  check('切换演示日期后主题跟着变', mockedName !== themeName && mockedNow.includes('2026-12-20'), `${themeName} → ${mockedName} | ${mockedNow}`);
  // 首页横幅与主题页必须同源
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.td-banner-title');
  check('演示日期下首页横幅同步切换', (await page.locator('.td-banner-title').innerText()) === mockedName);
  check('横幅上标注了演示日期', (await page.locator('.td-banner-mock').count()) === 1);
  await page.locator('.td-banner').click();
  await page.waitForSelector('.td-mock-row');
  await page.locator('.td-mock-btn', { hasText: '恢复今天' }).click();
  await page.waitForSelector('.td-block');
  await page.waitForTimeout(500);
  check('恢复今天后主题回到当期', (await page.locator('.sc-hero-name').innerText()) === themeName);

  /* ================= 5) 移动端 ================= */
  const m = await newPage({ viewport: { width: 390, height: 844 }, mobile: true });
  await m.goto(`${APP}#/`, { waitUntil: 'load' });
  await m.waitForSelector('.sc-entry');
  await m.waitForTimeout(600);
  check('移动端首页无横向溢出', await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0);
  const mRail = await m.evaluate(() => {
    const r = document.querySelector('.sc-rail');
    return r ? { sw: r.scrollWidth, cw: r.clientWidth } : null;
  });
  check('移动端场景轨道可横向滑动（单列大卡）', Boolean(mRail && mRail.sw > mRail.cw), JSON.stringify(mRail));
  check('移动端胶囊热区 ≥ 44px', await m.locator('.md-pill').first().evaluate((n) => n.getBoundingClientRect().height) >= 43.5);
  await m.goto(`${APP}#/theme`, { waitUntil: 'load' });
  await m.waitForSelector('.td-mock-row');
  check('移动端演示日期按钮热区 ≥ 44px', await m.locator('.td-mock-btn').first().evaluate((n) => n.getBoundingClientRect().height) >= 43.5);
  await m.locator('.td-scene').first().scrollIntoViewIfNeeded();
  check('移动端主题场景入口热区达标（可点）', await m.locator('.td-scene').first().evaluate((n) => n.getBoundingClientRect().height) >= 100);
  await m.close();

  /* ================= 6) 控制台纪律 ================= */
  check('控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  await page.close();
} catch (e) {
  failed += 1;
  console.log(`  FAIL 脚本异常 → ${String(e && e.message).slice(0, 300)}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 场景 / 情绪 / 主题验收全部通过' : `\n✗ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
