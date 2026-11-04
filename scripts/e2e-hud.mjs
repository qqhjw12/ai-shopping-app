// 全局 HUD 框架层验收（状态栏 / 四角角标 / 界面层分隔线，**不需要网关**）。
//
// 覆盖：
//   1) 状态栏在每个页面都在且吸顶（滚动 900px 后 top=0），顶栏在它正下方
//   2) 状态栏构造：状态点 + ONLINE 文案 + 读数带（数字青色）+ 信号条 + 等宽时钟在走
//   3) 层级与交互：整条 pointer-events: none（不挡下层的导航点击）；导航可点
//   4) 四角角标存在且 pointer-events 全关；移动端只剩上两角
//   5) 界面层分隔线：topbar::after 存在、渐变青色、透明度 ≤ 0.35
//   6) 不改业务：加购、跳详情等主流程照旧（借导航点击验证状态栏没挡交互）
//   7) 移动端 26px 档 + 无横向滚动；reduced-motion 下呼吸停止
//   8) 无 JS 报错
//
// 用法：node scripts/e2e-hud.mjs [--port 5583] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5583;
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

const openAt = async (hash) => {
  await page.goto(`${base}#${hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
};

const sysbarProbe = () => page.evaluate(() => {
  const bar = document.querySelector('.sysbar');
  const topbar = document.querySelector('.topbar');
  const cs = (n) => getComputedStyle(n);
  const r = (n) => n.getBoundingClientRect();
  return {
    h: bar ? r(bar).height : 0,
    top: bar ? r(bar).top : -1,
    pe: bar ? cs(bar).pointerEvents : null,
    bg: bar ? cs(bar).backgroundColor : null,
    border: bar ? cs(bar).borderBottomColor : null,
    topbarTop: topbar ? r(topbar).top : -1,
    seam: topbar ? getComputedStyle(topbar, '::after').backgroundImage : '',
    seamOpacity: topbar ? getComputedStyle(topbar, '::after').opacity : '',
    corners: [...document.querySelectorAll('.hud-corner')].map((c) => ({ cls: c.className, pe: cs(c).pointerEvents, w: cs(c).width })),
  };
});

/* ---------------- 1) 存在性与构造 ---------------- */
await openAt('/');
const p1 = await sysbarProbe();
check('状态栏存在且高 30px', p1.h === 30, `实际 ${p1.h}`);
check('状态栏初始贴视口顶（top=0）', p1.top === 0, `实际 ${p1.top}`);
check('顶栏吸顶让位（top = 30px）', p1.topbarTop === 30, `实际 ${p1.topbarTop}`);
check('状态栏玻璃底 rgba(7,9,12,0.82) + hairline 下边',
  p1.bg === 'rgba(7, 9, 12, 0.82)' && p1.border === 'rgba(139, 149, 163, 0.12)',
  `${p1.bg} / ${p1.border}`);
check('四角角标齐备且 pointer-events 全关',
  p1.corners.length === 4 && p1.corners.every((c) => c.pe === 'none' && c.w === '14px'),
  JSON.stringify(p1.corners));
check('界面层分隔线：青色渐变 + 透明度 0.35',
  p1.seam.includes('linear-gradient') && p1.seam.includes('34, 211, 238') && Number(p1.seamOpacity) <= 0.35,
  `${p1.seam.slice(0, 60)} / ${p1.seamOpacity}`);

/* ---------------- 2) 读数内容与时钟 ---------------- */
const state = await page.locator('.sysbar-state').innerText();
check('左侧「SYSTEM ONLINE / 系统在线」', /SYSTEM ONLINE/i.test(state), state);
const feed = await page.locator('.sysbar-feed').innerText();
check('中部 mock 读数带（延迟 / AI 模型 / 扫描 / 价格异动，· 分隔）',
  /延迟/.test(feed) && /AI 模型/.test(feed) && /今日扫描/.test(feed) && /价格异动/.test(feed) && feed.includes('·'), feed);
const cyanNums = await page.locator('.sysbar-feed b').count();
check('读数数字用信号青（≥3 处 b 标记）', cyanNums >= 3, `实际 ${cyanNums}`);
const t1 = await page.locator('#sysbar-clock').innerText();
await page.waitForTimeout(1300);
const t2 = await page.locator('#sysbar-clock').innerText();
check(`时钟每秒走（${t1} → ${t2}）`, /^\d{2}:\d{2}:\d{2}$/.test(t2) && t1 !== t2, `${t1} / ${t2}`);

/* ---------------- 3) 吸顶：滚下去不散架 ---------------- */
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(400);
const p3 = await sysbarProbe();
check('滚动 900px 后状态栏仍吸顶（top=0）', p3.top === 0, `实际 ${p3.top}`);
check('滚动后顶栏仍贴在状态栏正下方', p3.topbarTop === 30, `实际 ${p3.topbarTop}`);
await page.screenshot({ path: `${ROOT}/.shots/hud-e2e-scrolled.png` });

/* ---------------- 4) 不挡交互：状态栏 pointer-events none，导航可点 ---------------- */
check('状态栏整条 pointer-events: none', p1.pe === 'none', p1.pe);
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.locator('.nav a[data-nav="products"]').click();
await page.waitForTimeout(600);
check('状态栏不挡导航：点「甄选」正常路由', page.url().includes('#/products'), page.url());

/* ---------------- 5) 多页面都在（验收要求逐页有状态栏） ---------------- */
for (const [name, hash] of [['详情', '#/categories'], ['结算(守卫)', '#/checkout'], ['商家工作台', '#/merchant/dashboard']]) {
  await openAt(hash);
  const bar = await page.locator('.sysbar').count();
  const top = await page.evaluate(() => document.querySelector('.sysbar')?.getBoundingClientRect().top);
  check(`${name}页状态栏在位`, bar === 1 && top === 0, `count=${bar} top=${top}`);
}

/* ---------------- 6) 移动端 ---------------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
mpage.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
mpage.on('pageerror', (e) => consoleErrors.push(e.message));
await mpage.goto(`${base}#/`, { waitUntil: 'load' });
await mpage.waitForTimeout(700);
const mp = await mpage.evaluate(() => {
  const bar = document.querySelector('.sysbar');
  const cs = getComputedStyle(bar);
  return {
    h: bar.getBoundingClientRect().height,
    feed: getComputedStyle(document.querySelector('.sysbar-feed')).display,
    visibleCorners: [...document.querySelectorAll('.hud-corner')].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});
check('移动端状态栏 26px', mp.h === 26, `实际 ${mp.h}`);
check('移动端中部读数带收起', mp.feed === 'none', mp.feed);
check('移动端只留上两角（底部两角让位吸底栏）',
  mp.visibleCorners.length === 2 && mp.visibleCorners.every((c) => /hud-t[rl]/.test(c)),
  mp.visibleCorners.join(','));
check('移动端无横向滚动', mp.overflow === 0, `溢出 ${mp.overflow}px`);
await mpage.screenshot({ path: `${ROOT}/.shots/hud-e2e-mobile.png` });

/* ---------------- 7) 减少动效 ---------------- */
const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const rpage = await rctx.newPage();
await rpage.goto(`${base}#/`, { waitUntil: 'load' });
await rpage.waitForTimeout(500);
const rm = await rpage.evaluate(() => {
  const s = getComputedStyle(document.querySelector('.sysbar-dot'));
  return { anim: s.animationName, opacity: s.opacity };
});
check('减少动效下呼吸停止、圆点静态可见', rm.anim === 'none' && Number(rm.opacity) === 1, `${rm.anim} / ${rm.opacity}`);

/* ---------------- 收尾 ---------------- */
const errs = consoleErrors.filter((t) => !/net::|ERR_|404/.test(t));
check('无 JS 报错', errs.length === 0, errs.join(' | '));

await browser.close();
if (srv) srv.kill();

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\n✓ HUD 框架验收 ${results.length}/${results.length} 全部通过` : `\n✗ ${failed.length}/${results.length} 失败`);
process.exit(failed.length ? 1 : 0);
