// 全站深空令牌视觉验收截图（临时脚本）。
// 用法：node scripts/shot-dark.mjs [--port 5591]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5591;
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

const PAGES = [
  ['home', '#/'],
  ['products', '#/products'],
  ['detail', null],
  ['cart', '#/cart'],
  ['checkout', '#/checkout'],
  ['account', '#/account'],
  ['sourcing', '#/merchant/sourcing'],
  ['console', '#/admin/flash'],
];

for (const [name, hash] of PAGES) {
  if (!hash) continue;
  await page.goto(`${base}${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, `dark-${name}.png`) });
  console.log(`${name} ok`);
}

// 详情页：从列表点第一张卡进去
await page.goto(`${base}#/products`, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const card = page.locator('.pcard a[href*="#/product/"]').first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, 'dark-detail.png') });
  console.log('detail ok');
}

// 焦点环实测：Tab 到第一个可聚焦元素
await page.goto(`${base}#/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.keyboard.press('Tab');
await page.waitForTimeout(300);
const ring = await page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return null;
  const s = getComputedStyle(a);
  return { tag: a.tagName, cls: a.className, outline: s.outlineColor, width: s.outlineWidth, shadow: s.boxShadow };
});
console.log('focus:', JSON.stringify(ring));
await page.screenshot({ path: join(OUT, 'dark-focus.png'), clip: { x: 0, y: 0, width: 1440, height: 260 } });

// 移动端
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
for (const [name, hash] of [['home', '#/'], ['products', '#/products']]) {
  await mpage.goto(`${base}${hash}`, { waitUntil: 'networkidle' });
  await mpage.waitForTimeout(700);
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`mobile ${name} 横向溢出: ${overflow}`);
  await mpage.screenshot({ path: join(OUT, `dark-m-${name}.png`) });
}

// 采样底色与卡片色，确认没有落回浅色
const probe = await page.evaluate(() => {
  const body = getComputedStyle(document.body);
  const card = document.querySelector('.pcard');
  return {
    bodyBg: body.backgroundColor,
    bodyColor: body.color,
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
    grid: getComputedStyle(document.documentElement, '::before').backgroundImage.slice(0, 90),
  };
});
console.log('probe:', JSON.stringify(probe, null, 1));
console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');

await browser.close();
