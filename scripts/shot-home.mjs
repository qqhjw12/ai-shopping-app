// 首页「全息任务面板」视觉验收（临时脚本）。
// 用法：node scripts/shot-home.mjs [--port 5595]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5595;
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

await page.goto(`${base}#/`, { waitUntil: 'load' });
await page.waitForTimeout(1400); // 等入场级联 + 数据填充
await page.screenshot({ path: join(OUT, 'home2a-hero.png'), clip: { x: 0, y: 0, width: 1440, height: 1000 } });

const probe = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const cs = (s) => { const n = q(s); return n ? getComputedStyle(n) : null; };
  const r = (s) => { const n = q(s); return n ? n.getBoundingClientRect() : null; };
  return {
    title: cs('.hp-title')?.fontSize + ' / ' + cs('.hp-title')?.fontWeight + ' / ' + cs('.hp-title')?.lineHeight,
    titleColor: cs('.hp-title')?.color,
    btnH: r('.hp-btn--primary')?.height,
    ring: r('.hp-ring') ? { w: Math.round(r('.hp-ring').width), opacity: cs('.hp-ring').opacity } : null,
    readout: [...document.querySelectorAll('.hp-read')].map((n) => n.textContent.trim()),
    modules: [...document.querySelectorAll('.hp-mod')].map((n) => n.textContent.trim()),
    modCols: cs('.hp-modules').gridTemplateColumns,
    resultCols: cs('.hp-results-grid').gridTemplateColumns,
    keySpan: cs('.scan-item.is-key')?.gridColumn,
    scanReads: [...document.querySelectorAll('.scan-read')].map((n) => n.textContent.trim()),
    taskBar: r('.hp-task-bar') ? { w: Math.round(r('.hp-task-bar').width), h: r('.hp-task-bar').height } : null,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    firstChild: q('.home-panel')?.firstElementChild?.className,
  };
});
console.log('probe:', JSON.stringify(probe, null, 1));

// 整页（分屏截，避免超长图）
await page.screenshot({ path: join(OUT, 'home2a-full.png'), fullPage: true });

// 两个锚点区特写
await page.locator('.hp-modules').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'home2a-modules.png') });
await page.locator('.hp-results').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'home2a-results.png') });

// 移动端
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
await mpage.goto(`${base}#/`, { waitUntil: 'load' });
await mpage.waitForTimeout(1400);
await mpage.screenshot({ path: join(OUT, 'home2a-m-hero.png') });
await mpage.screenshot({ path: join(OUT, 'home2a-m-full.png'), fullPage: true });
const mprobe = await mpage.evaluate(() => ({
  overflow: document.documentElement.scrollWidth - window.innerWidth,
  titleSize: getComputedStyle(document.querySelector('.hp-title')).fontSize,
  modCols: getComputedStyle(document.querySelector('.hp-modules')).gridTemplateColumns,
  resultCols: getComputedStyle(document.querySelector('.hp-results-grid')).gridTemplateColumns,
  keySpan: getComputedStyle(document.querySelector('.scan-item.is-key')).gridColumn,
  readbarScroll: (() => { const n = document.querySelector('.hp-readbar'); return n.scrollWidth + '/' + n.clientWidth; })(),
  ringPos: getComputedStyle(document.querySelector('.hp-ring')).position,
}));
console.log('mobile:', JSON.stringify(mprobe));

// 减少动效
const rctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
const rpage = await rctx.newPage();
await rpage.goto(`${base}#/`, { waitUntil: 'load' });
await rpage.waitForTimeout(600);
console.log('reduced:', JSON.stringify(await rpage.evaluate(() => ({
  dot: getComputedStyle(document.querySelector('.hp-dot')).animationName,
  arc: getComputedStyle(document.querySelector('.hp-ring-arc')).animationName,
  hero: getComputedStyle(document.querySelector('.hp-hero')).animationName,
  heroOpacity: getComputedStyle(document.querySelector('.hp-hero')).opacity,
  fill: getComputedStyle(document.querySelector('.hp-task-fill')).transform,
}))));

console.log('errors:', errors.filter((t) => !/404|net::/.test(t)).slice(0, 6));
await browser.close();
