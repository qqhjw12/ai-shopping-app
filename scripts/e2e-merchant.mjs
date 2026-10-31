// 商家入驻入口 / 招商页真机验收：playwright-core + 系统 Edge 无头。
//
// 这一步的验收重点不是「页面好看」，而是这几条可被机器验证的承诺：
//   1) 顶栏与页脚都能找到「商家入驻」，桌面 / 移动端都可见；
//   2) 移动端触控热区 ≥44×44px（导航胶囊与吸底按钮都要达标）；
//   3) 招商页四个区块齐全，平台数据是真取来的（不是写死的占位符）；
//   4) 主 CTA → #/merchant/apply，次 CTA 走 scrollIntoView（hash 是路由，不能写锚点）；
//   5) 移动端无横向滚动，吸底条不与被抬高的 AI 浮窗重叠。
//
// 用法：node scripts/e2e-merchant.mjs [--port 4377] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 4377;
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

const srv = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  if (/Failed to load resource.*404/.test(t)) return; // 静态站 /api 探测，已知噪音
  consoleErrors.push(t.slice(0, 140));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));

const base = `http://127.0.0.1:${PORT}/index.html`;
const go = async (h, wait = 1200) => {
  await page.goto(`${base}#${h}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};

try {
  /* 1) 桌面：入口可达 */
  await go('/', 1500);
  const navEntry = page.locator('.nav a.nav-merchant');
  check('顶栏有「商家入驻」入口', (await navEntry.count()) === 1 && (await navEntry.textContent()).trim() === '商家入驻');
  check('入口指向 #/merchant/join', (await navEntry.getAttribute('href')) === '#/merchant/join');
  check('页脚也有商家入驻入口', (await page.locator('.footer-links a[href="#/merchant/join"]').count()) >= 1);

  await navEntry.click();
  await page.waitForTimeout(900);
  check('点击后 hash 变为 #/merchant/join', page.url().includes('#/merchant/join'), page.url());
  const heroTitle = (await page.locator('.mz-hero h1').innerText().catch(() => '')).replace(/\s+/g, '');
  check('招商页首屏价值主张存在', heroTitle.includes('让AI帮你找到') && heroTitle.includes('真正想买的人'), heroTitle);

  /* 2) 区块齐全 */
  check('优势区 4 张文字卡片', (await page.locator('.mz-why').count()) === 4, String(await page.locator('.mz-why').count()));
  check('流程 5 步', (await page.locator('.mz-step').count()) === 5, String(await page.locator('.mz-step').count()));
  const fitCount = await page.locator('.mz-fit-list li').count();
  check('商家类型 ≥6 条', fitCount >= 6, String(fitCount));
  const stats = await page.locator('.mz-stat-k').allInnerTexts();
  check('平台数据已填充（非占位符）', stats.length === 4 && stats.every((s) => /\d/.test(s)), stats.join('/'));

  /* 3) CTA 行为 */
  const primaryHref = await page.locator('.mz-cta-row a.mz-btn--gold').getAttribute('href');
  check('主 CTA 指向申请页', primaryHref === '#/merchant/apply', String(primaryHref));
  const beforeY = await page.evaluate(() => window.scrollY);
  await page.locator('.mz-cta-row button.mz-btn--ghost').click();
  await page.waitForTimeout(900);
  const afterY = await page.evaluate(() => window.scrollY);
  const flowInView = await page.evaluate(() => {
    const r = document.querySelector('#mz-flow').getBoundingClientRect();
    return r.top >= -40 && r.top < window.innerHeight * 0.6;
  });
  check('次 CTA 滚动到流程区（锚点不走 hash）', afterY > beforeY && flowInView, `${beforeY}→${afterY}`);

  const bar = page.locator('.mz-bar');
  check('吸底 CTA 常驻', await bar.isVisible());
  check('吸底 CTA 为 fixed 定位', (await bar.evaluate((n) => getComputedStyle(n).position)) === 'fixed');
  await page.screenshot({ path: '.shots/mz-desktop-hero.png' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: '.shots/mz-desktop-full.png', fullPage: true });

  await bar.locator('a.mz-btn').click();
  await page.waitForTimeout(800);
  const applyTitle = (await page.locator('.mz-apply-title').innerText().catch(() => '')).trim();
  check('吸底 CTA 进入申请页', applyTitle === '入驻申请', applyTitle);
  check('申请页有四步进度（表单已接入）', (await page.locator('.mzf-prog').count()) === 4, String(await page.locator('.mzf-prog').count()));
  check('默认停在第 1 步，第 2 步未展开', (await page.locator('.mzf-panel[hidden]').count()) === 3);
  // 空表单点下一步必须被拦住：真表单的第一条承诺是「不让空资料进审核队列」
  await page.locator('.mzf-nav button.mz-btn--gold:visible').click();
  await page.waitForTimeout(500);
  const alertVisible = await page.locator('.mzf-alert').isVisible().catch(() => false);
  check('空表单点下一步被拦下并给出错误', alertVisible && (await page.locator('.mzf-panel[hidden]').count()) === 3);
  check('错误挂到具体字段（主体类型标红）', (await page.locator('.mzf-field.has-error').count()) >= 1);
  check('申请页无吸底条（不自己指向自己）', (await page.locator('.mz-bar').count()) === 0);

  /* 4) 移动端 */
  const m = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const mErrors = [];
  m.on('pageerror', (e) => mErrors.push(String(e).slice(0, 120)));
  await m.goto(`${base}#/`, { waitUntil: 'load' });
  await m.waitForTimeout(1500);

  const mNav = m.locator('.nav a.nav-merchant');
  check('移动端导航可见商家入驻', await mNav.isVisible());
  const box = await mNav.boundingBox();
  check('移动端触控热区 ≥44×44', Boolean(box) && box.height >= 44 && box.width >= 44, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : 'no box');

  await mNav.click();
  await m.waitForTimeout(1000);
  const mTitle = (await m.locator('.mz-hero h1').innerText().catch(() => '')).replace(/\s+/g, '');
  check('移动端进入招商页', mTitle.includes('真正想买的人'), mTitle);

  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端无横向滚动', overflow <= 1, `scrollWidth 超出 ${overflow}px`);

  const mBarBtn = m.locator('.mz-bar a.mz-btn');
  const mBarBox = await mBarBtn.boundingBox();
  check('移动端吸底按钮 ≥44px 高', Boolean(mBarBox) && mBarBox.height >= 44, mBarBox ? `${Math.round(mBarBox.height)}` : 'no box');

  // 吸底条与 AI 浮窗不重叠：浮窗底边应高于吸底条顶边
  const noOverlap = await m.evaluate(() => {
    const fab = document.querySelector('#ai-widget');
    const bar = document.querySelector('.mz-bar');
    if (!fab || !bar) return false;
    const f = fab.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return f.bottom <= b.top + 1;
  });
  check('AI 浮窗被抬到吸底条之上（不重叠）', noOverlap);

  await m.screenshot({ path: '.shots/mz-mobile-hero.png' });
  await m.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await m.waitForTimeout(700);
  await m.screenshot({ path: '.shots/mz-mobile-bottom.png' });

  check('移动端控制台无 JS 错误', mErrors.length === 0, mErrors.join(' | '));
  check('桌面端控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
  await m.close();
} finally {
  await browser.close();
  srv.kill();
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length === 0 ? 0 : 1);
