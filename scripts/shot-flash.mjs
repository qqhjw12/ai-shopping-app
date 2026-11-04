// 秒杀模块视觉验收截图（临时脚本，跑完可删）。
// 用法：node scripts/shot-flash.mjs [--port 5581]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5581;
const OUT = join(ROOT, 'shots');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const serving = await fetch(`http://127.0.0.1:${PORT}/index.html`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);
const srv = serving ? null : spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], { stdio: 'ignore' });
if (!serving) await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ executablePath: EDGE, channel: 'msedge' });
const base = `http://127.0.0.1:${PORT}/index.html`;

/* 桌面：首页顶部 */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
await page.goto(`${base}#/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.fs-sale', { timeout: 20000 });
await page.waitForTimeout(600);
await page.locator('.fs-sale').screenshot({ path: join(OUT, 'flash-desktop.png') });
await page.screenshot({ path: join(OUT, 'flash-home-top.png') });
console.log('desktop ok');

/* 桌面：后台控制台 */
await page.goto(`${base}#/admin/flash`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.locator('.fs-input').first().fill('demo4321');
await page.locator('.fs-gate button[type=submit]').click();
await page.waitForSelector('.fs-readbar', { timeout: 8000 });
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, 'flash-console.png'), fullPage: true });
console.log('console ok');

/* 移动端：首页顶部 */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
mpage.on('pageerror', (e) => console.log('M PAGE ERROR:', e.message));
await mpage.goto(`${base}#/`, { waitUntil: 'networkidle' });
await mpage.waitForSelector('.fs-sale', { timeout: 20000 });
await mpage.waitForTimeout(600);
await mpage.locator('.fs-sale').screenshot({ path: join(OUT, 'flash-mobile.png') });
console.log('mobile ok');

await browser.close();
if (srv) srv.kill();
