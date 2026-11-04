// HUD 框架层视觉验收（临时脚本）。
// 用法：node scripts/shot-hud.mjs [--port 5592]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5592;
const OUT = join(ROOT, 'shots');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const serving = await fetch(`http://127.0.0.1:${PORT}/index.html`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);
if (!serving) {
  spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
}

const base = `http://127.0.0.1:${PORT}/index.html`;
const browser = await chromium.launch({ executablePath: EDGE, channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const probeOn = (p) => p.evaluate(() => {
  const sysbar = document.querySelector('.sysbar');
  const topbar = document.querySelector('.topbar');
  const dot = document.querySelector('.sysbar-dot');
  const tl = document.querySelector('.hud-tl');
  const clock = document.getElementById('sysbar-clock');
  const cs = (n) => (n ? getComputedStyle(n) : null);
  const S = cs(sysbar), T = cs(topbar), D = cs(dot), TL = cs(tl);
  const rect = (n) => (n ? n.getBoundingClientRect() : null);
  return {
    sysbarH: rect(sysbar)?.height,
    sysbarTop: rect(sysbar)?.top,
    sysbarBg: S.backgroundColor,
    sysbarBlur: S.backdropFilter || S.webkitBackdropFilter,
    sysbarBorder: S.borderBottomColor,
    sysbarEvent: S.pointerEvents,
    topbarTop: rect(topbar)?.top,
    topbarStickyTop: T.top,
    dotAnim: D.animationName + ' ' + D.animationDuration + ' ' + D.animationTimingFunction,
    dotColor: D.backgroundColor,
    corner: TL ? { w: TL.width, h: TL.height, left: TL.left, top: TL.top, border: TL.borderTopColor } : null,
    seam: getComputedStyle(topbar, '::after').backgroundImage.slice(0, 80),
    seamOpacity: getComputedStyle(topbar, '::after').opacity,
    clock: clock?.textContent,
    clockFont: cs(clock)?.fontFamily.slice(0, 30),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});

const PAGES = [
  ['home', '#/'],
  ['products', '#/products'],
  ['categories', '#/categories'],
  ['cart', '#/cart'],
  ['checkout', '#/checkout'],
  ['mdash', '#/merchant/dashboard'],
  ['sourcing', '#/merchant/sourcing'],
];

for (const [name, hash] of PAGES) {
  await page.goto(`${base}${hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `hud-${name}.png`) });
  console.log(name, 'ok');
}

// 吸顶实测：滚下去以后状态栏与顶栏是否还各自在原位、有没有互相盖住
await page.goto(`${base}#/products`, { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'hud-scrolled.png') });
console.log('scrolled probe:', JSON.stringify(await probeOn(page)));
console.log('scrollY:', await page.evaluate(() => window.scrollY));

// 详情页
await page.goto(`${base}#/products`, { waitUntil: 'load' });
await page.waitForTimeout(500);
const card = page.locator('.pcard a[href*="#/product/"]').first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'hud-detail.png') });
}

// 桌面：只截顶部条，方便看清角标与分隔线
await page.goto(`${base}#/`, { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.screenshot({ path: join(OUT, 'hud-strip.png'), clip: { x: 0, y: 0, width: 1440, height: 200 } });
console.log('home probe:', JSON.stringify(await probeOn(page), null, 1));

// 移动端
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
for (const [name, hash] of [['home', '#/'], ['mdash', '#/merchant/dashboard'], ['checkout', '#/checkout']]) {
  await mpage.goto(`${base}${hash}`, { waitUntil: 'load' });
  await mpage.waitForTimeout(700);
  await mpage.screenshot({ path: join(OUT, `hud-m-${name}.png`) });
  console.log(`mobile ${name}`, JSON.stringify(await probeOn(mpage)));
}

// 减少动效：呼吸应停
const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const rpage = await rctx.newPage();
await rpage.goto(`${base}#/`, { waitUntil: 'load' });
await rpage.waitForTimeout(500);
console.log('reduced-motion dot:', JSON.stringify(await rpage.evaluate(() => {
  const d = document.querySelector('.sysbar-dot');
  const s = getComputedStyle(d);
  return { anim: s.animationName, opacity: s.opacity };
})));

console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
await browser.close();
