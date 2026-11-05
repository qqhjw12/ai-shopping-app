// 场景 / 情绪 / 节日主题的视觉验收截图（一次性脚本，产出到 shots/）。
// 用法：node scripts/shot-scene.mjs [--port 4433]
//
// 为什么单独一个脚本：三块入口都在首页模块卡下方、三个结果页各有自己的头图，
// 用 fullPage 截会把首屏压成一条看不清的细线；这里逐个滚到目标块再截。
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'shots');
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 4433;
const APP = `http://127.0.0.1:${PORT}/index.html`;
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

mkdirSync(OUT, { recursive: true });
const srv = spawn(process.execPath, [
  join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web'),
], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const errors = [];
// 静态站没有后端，/api/* 的 404 是既有噪音（与 e2e-* 同一口径过滤），不算前端错误。
const keepErr = (t) => !/Failed to load resource|net::|ERR_|404/.test(String(t));
const shot = (page, name) => page.screenshot({ path: join(OUT, `sc-${name}.png`) });

try {
  /* ---- 桌面：首页三块入口 ---- */
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error' && keepErr(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => { if (keepErr(e)) errors.push(String(e)); });
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.sc-entry', { timeout: 10000 });
  await page.waitForTimeout(800);

  await page.locator('.sc-entry').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await shot(page, 'home-desktop');

  await page.locator('.td-banner').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await shot(page, 'home-banner');

  /* ---- 桌面：场景页 ---- */
  await page.locator('.sc-card').first().click();
  await page.waitForSelector('.sc-grid .pcard', { timeout: 10000 });
  await page.waitForTimeout(500);
  console.log('scene', page.url(), '| cards', await page.locator('.sc-grid .pcard').count(),
    '|', (await page.locator('.sc-hero-meta').innerText()).replace(/\n/g, ' '));
  await shot(page, 'scene-desktop');

  /* ---- 桌面：情绪结果页 ---- */
  await page.goto(`${APP}#/mood/focus`, { waitUntil: 'load' });
  await page.waitForSelector('.sc-grid .pcard');
  await page.waitForTimeout(400);
  console.log('mood', (await page.locator('.sc-hero-line').innerText()),
    '| cards', await page.locator('.sc-grid .pcard').count());
  await shot(page, 'mood-desktop');

  /* ---- 桌面：主题页 + 演示日期切换 ---- */
  await page.goto(`${APP}#/theme`, { waitUntil: 'load' });
  await page.waitForSelector('.td-block');
  await page.waitForTimeout(500);
  console.log('theme', await page.locator('.sc-hero-name').innerText(),
    '| coupon', await page.locator('.td-coupon-title').innerText(),
    '| products', await page.locator('.sc-grid .pcard').count(),
    '| scenes', await page.locator('.td-scene').count());
  await shot(page, 'theme-desktop');

  await page.locator('.td-mock-btn', { hasText: '12-20' }).click();
  await page.waitForTimeout(700);
  console.log('after mock →', await page.locator('.sc-hero-name').innerText());
  await shot(page, 'theme-desktop-mock');
  await page.locator('.td-mock-btn', { hasText: '恢复今天' }).click();
  await page.waitForTimeout(500);

  /* ---- 移动端 390px：首页三块入口 ---- */
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  m.on('console', (x) => { if (x.type() === 'error' && keepErr(x.text())) errors.push(x.text()); });
  m.on('pageerror', (e) => { if (keepErr(e)) errors.push(String(e)); });
  await m.goto(`${APP}#/`, { waitUntil: 'load' });
  await m.waitForSelector('.sc-entry');
  await m.waitForTimeout(700);
  await m.locator('.sc-entry').scrollIntoViewIfNeeded();
  await m.waitForTimeout(500);
  console.log('mobile overflowX',
    await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    '| card h', await m.locator('.sc-card').first().evaluate((n) => n.getBoundingClientRect().height),
    '| pill h', await m.locator('.md-pill').first().evaluate((n) => n.getBoundingClientRect().height));
  await shot(m, 'home-mobile');

  await m.locator('.td-banner').scrollIntoViewIfNeeded();
  await m.waitForTimeout(400);
  await shot(m, 'home-mobile-banner');

  console.log('console errors', errors);
  console.log(`done → ${OUT}`);
} finally {
  await browser.close();
  srv.kill();
}
