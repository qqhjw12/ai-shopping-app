// 首页「全息任务面板」验收（#/，**不需要网关**）。
//
// 覆盖：
//   1) 信息架构顺序：任务简报 → 读数胶囊 → 模块卡 → 任务条带 → 扫描结果
//   2) 首屏第一眼是「系统在运行」：扫描状态 + 两条 CTA + 扫描环
//   3) 读数胶囊数字现算（已匹配 = 商品总数，隐藏选项 = 折扣狠且未卖爆）
//   4) 七张编号模块卡可点：分类/甄选/洞察/货源/订单/AI 盲盒真的路由，AI 导购开面板
//   5) 扫描结果流：7 条、首条跨两列、每条带 MATCH / PRICE INDEX、卡片可进详情
//   6) MATCH 读数确定性（刷新后同一商品同一分数）
//   7) 入场级联只播一次（二次进首页不再有动画类）
//   8) 移动端：无横向滚动、读数带可横滚、单列时重点卡不撑出第二列
//   9) 无 JS 报错
//
// 用法：node scripts/e2e-home.mjs [--port 5584] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5584;
const HEADED = args.includes('--headed');

const results = [];
const check = (label, ok, extra = '') => {
  results.push([label, ok]);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const serving = await fetch(`http://127.0.0.1:${PORT}/index.html`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);
const srv = serving ? null : spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], { stdio: 'ignore' });
if (!serving) await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

const base = `http://127.0.0.1:${PORT}/index.html`;
const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(e.message));

const openHome = async (ms = 1200) => {
  await page.goto(`${base}#/`, { waitUntil: 'load' });
  await page.waitForTimeout(ms);
};

const panelInfo = () => page.evaluate(() => {
  const panel = document.querySelector('.home-panel');
  const q = (s) => panel?.querySelector(s) || null;
  const kids = panel ? [...panel.children].map((n) => n.className.split(' ')[0]) : [];
  return {
    kids,
    hero: Boolean(q('.hp-hero')),
    state: q('.hp-state')?.textContent || '',
    ctas: panel ? panel.querySelectorAll('.hp-cta .hp-btn').length : 0,
    ring: Boolean(q('.hp-ring svg')),
    ringArcs: panel ? panel.querySelectorAll('.hp-ring circle').length : 0,
    reads: [...(panel?.querySelectorAll('.hp-read') || [])].map((n) => n.textContent.trim()),
    modules: [...(panel?.querySelectorAll('.hp-mod') || [])].map((n) => ({
      n: n.querySelector('.hp-mod-n')?.textContent,
      t: n.querySelector('.hp-mod-t')?.textContent,
      href: n.getAttribute('href') || '(button)',
    })),
    task: q('.hp-task') ? (q('.hp-task-text')?.textContent || '').trim() : null,
    resultsCount: panel ? panel.querySelectorAll('.scan-item').length : 0,
    keySpan: panel?.querySelector('.scan-item.is-key') ? getComputedStyle(panel.querySelector('.scan-item.is-key')).gridColumnStart : null,
    reads2: [...(panel?.querySelectorAll('.scan-read') || [])].map((n) => n.textContent.trim()),
  };
});

/* ---------------- 1) 信息架构顺序 ---------------- */
await openHome();
let info = await panelInfo();
check('首块是任务简报（Hero 在面板最前）', info.kids[0] === 'hp-hero', info.kids.join(','));
check('顺序：简报 → 读数 → 模块 → 任务带 → 结果',
  info.kids.indexOf('hp-readslot') === 1 && info.kids.indexOf('hp-modules') === 2
  && info.kids.indexOf('hp-task') === 3 && info.kids.indexOf('hp-results') === 4,
  info.kids.join(','));

/* ---------------- 2) 首屏气质 ---------------- */
check('扫描状态行（AI SCAN ACTIVE / 扫描中）', /AI SCAN ACTIVE/.test(info.state), info.state);
check('两条 CTA（主 + 次）', info.ctas === 2, `实际 ${info.ctas}`);
check('扫描环在（同心圆 ≥3 圈 + 弧线）', info.ring && info.ringArcs >= 3, `circles=${info.ringArcs}`);
const btnH = await page.locator('.hp-btn--primary').evaluate((n) => n.getBoundingClientRect().height);
check('主按钮高度 ≥48px', btnH >= 48, `实际 ${btnH}`);

/* ---------------- 3) 读数胶囊现算 ---------------- */
const matched = info.reads.find((t) => t.includes('已匹配'));
check('读数胶囊：已匹配 = 商品总数（>0）', Boolean(matched) && /已匹配[\d,]+件/.test(matched.replace(/\s+/g, '')), info.reads.join(' | '));
check('读数胶囊：隐藏选项 >0（折扣狠且未卖爆）', /隐藏选项\s*[1-9]/.test(info.reads.find((t) => t.includes('隐藏选项')) || ''), info.reads.join(' | '));

/* ---------------- 4) 模块卡路由 ---------------- */
check('七张编号模块卡（01–07，含 AI 盲盒入口）',
  info.modules.length === 7 && info.modules[0].n === '01' && info.modules[5].n === '06'
  && info.modules[6].n === '07' && info.modules[6].t === 'AI 盲盒', JSON.stringify(info.modules));
const expect = ['(button)', '#/categories', '#/products', '#/analytics', '#/merchant/sourcing', '#/account?tab=orders', '#/blindbox'];
check('模块指向：导购(按钮)/分类/甄选/洞察/货源/订单/AI 盲盒',
  info.modules.map((m) => m.href).join('|') === expect.join('|'), info.modules.map((m) => m.href).join('|'));

await page.locator('.hp-mod[href="#/categories"]').click();
await page.waitForTimeout(700);
check('点「分类」模块真的路由', page.url().includes('#/categories'), page.url());
await openHome(1000);
info = await panelInfo();
check('二次进首页：入场动画类已不再播放', !(await page.locator('.home-panel.is-enter').count()));

/* ---------------- 5) 扫描结果流 ---------------- */
check('结果流 8 条（1 跨两列 + 7 单列，3×3 铺满不留洞）', info.resultsCount === 8, `实际 ${info.resultsCount}`);
check('首条跨两列（重点结果）', info.keySpan === 'span 2', `实际 ${info.keySpan}`);
check('每条带 MATCH / PRICE INDEX 读数', info.reads2.length === 8 && info.reads2.every((t) => /MATCH \d+%/.test(t) && /PRICE INDEX [−+-]?\d+%/.test(t)), info.reads2.slice(0, 2).join(' | '));
check('MATCH 全部落在 88–99（不留 100%）', info.reads2.every((t) => { const m = t.match(/MATCH (\d+)%/); return m && +m[1] >= 88 && +m[1] <= 99; }), info.reads2.join(' | '));

const firstRead = info.reads2[0];
await page.locator('.scan-item .pcard .name').first().click();
await page.waitForTimeout(800);
check('点结果卡进详情页', page.url().includes('#/product/'), page.url());

await openHome(1000);
info = await panelInfo();
check('MATCH 读数确定性：刷新后首条分数不变', info.reads2[0] === firstRead, `${firstRead} → ${info.reads2[0]}`);

/* ---------------- 6) 任务条带 ---------------- */
check('任务带文案（比价 3 渠道 / 预计节省 ¥）',
  /比价 3 个渠道/.test(info.task || '') && /预计节省 ¥[\d,]+/.test(info.task || ''), info.task || '(missing)');
const fill = await page.locator('.hp-task-fill').evaluate((n) => getComputedStyle(n).transform);
check('进度条已走到 68%（一次性，不循环）', fill.includes('0.68'), fill);

/* ---------------- 7) 移动端 ---------------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
mpage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
mpage.on('pageerror', (e) => consoleErrors.push(e.message));
await mpage.goto(`${base}#/`, { waitUntil: 'load' });
await mpage.waitForTimeout(1200);
const mp = await mpage.evaluate(() => {
  const rb = document.querySelector('.hp-readbar');
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    cols: getComputedStyle(document.querySelector('.hp-modules')).gridTemplateColumns.split(' ').length,
    resultCols: getComputedStyle(document.querySelector('.hp-results-grid')).gridTemplateColumns.split(' ').length,
    keySpan: getComputedStyle(document.querySelector('.scan-item.is-key')).gridColumnStart,
    readScroll: rb ? rb.scrollWidth > rb.clientWidth : false,
    titleSize: getComputedStyle(document.querySelector('.hp-title')).fontSize,
  };
});
check('移动端无横向滚动', mp.overflow === 0, `溢出 ${mp.overflow}px`);
check('移动端模块卡 2 列', mp.cols === 2, `实际 ${mp.cols}`);
check('移动端结果单列且重点卡不撑出第二列', mp.resultCols === 1 && mp.keySpan === 'auto', `${mp.resultCols} 列 / span=${mp.keySpan}`);
check('移动端读数带可横向滚动（内容超出可视区）', mp.readScroll, 'readbar 未超出');
check('移动端标题 30–34px', /3[0-4](\.\d+)?px/.test(mp.titleSize), mp.titleSize);
await mpage.screenshot({ path: `${ROOT}/.shots/home-e2e-mobile.png` });

/* ---------------- 收尾 ---------------- */
const errs = consoleErrors.filter((t) => !/net::|ERR_|404/.test(t));
check('无 JS 报错', errs.length === 0, errs.join(' | '));

await browser.close();
if (srv) srv.kill();

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\n✓ 首页任务面板验收 ${results.length}/${results.length} 全部通过` : `\n✗ ${failed.length}/${results.length} 失败`);
process.exit(failed.length ? 1 : 0);
