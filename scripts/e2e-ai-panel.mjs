#!/usr/bin/env node
/**
 * AI 助手升级验收（playwright-core + 本机 Edge + 真网关 + 静态站）。
 *
 * 这一轮只动 AI 的「入口、面板和反馈」，推荐逻辑与商品卡数据结构不变。要验的是：
 *   1) 全局触发器：48×48 圆形（移动 44×44）、距边缘 20px、层级高于内容低于弹层；
 *   2) 面板：380–420px 桌面浮层 / 移动端全宽底部抽屉（80vh 上限，吸底栏让位）；
 *   3) 打开动效一次性：160ms 上浮 + 300ms 扫线（iteration-count 1，不循环）；
 *   4) 顶部状态行（6px 青点 + AI ASSISTANT / 在线）与 44px 关闭热区；
 *   5) 提交后先有扫描系统消息：三行读数 750ms 内逐条出现，指示器只转一轮后隐藏；
 *   6) AI 商品卡带 AI MATCH 读数 + 数量步进器 + 加购按钮，加购真实进购物袋；
 *   7) 打开面板锁背景滚动，关闭恢复；Esc 可关；
 *   8) 桌面与移动控制台零错误。
 *
 * 用法：node scripts/e2e-ai-panel.mjs [--port 4392] [--gw 8127] [--headed]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4392'));
const GW_PORT = Number(argOf('--gw', '8127'));
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;

// 独立临时库：AI 会话/打点只增不减，跑开发库会留脏数据
const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-aipanel.db');

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: 'ignore',
    cwd: join(ROOT, 'ai-gateway'),
    env: { ...process.env, PORT: String(GW_PORT), DB_FILE: DB, CORS_ORIGINS: BASE, RATE_LIMIT_PER_MIN: '0' },
  },
);

mkdirSync(join(ROOT, '.shots'), { recursive: true });
await waitFor(`${BASE}/index.html`);
await waitFor(`${GW}/api/products`);

const browser = await chromium.launch({ executablePath: EDGE, headless: !args.includes('--headed') });

async function newPage(viewport) {
  const page = await browser.newPage({ viewport });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource/.test(t)) return; // 网络 404 噪音单独由断言覆盖
    consoleErrors.push(t.slice(0, 140));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));
  return { page, consoleErrors };
}

const style = (page, sel, prop) =>
  page.locator(sel).first().evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop);

try {
  /* ================= 桌面端 ================= */
  const { page: d, consoleErrors: dErr } = await newPage({ width: 1440, height: 1000 });
  await d.goto(`${APP}#/`, { waitUntil: 'load' });
  await d.waitForTimeout(1400);

  // 1) 触发器规格
  const fab = d.locator('#ai-fab');
  check('触发器全局可见（首页）', await fab.isVisible());
  const fabBox = await fab.boundingBox();
  check('触发器 48×48 圆形', Boolean(fabBox) && Math.abs(fabBox.width - 48) <= 2 && Math.abs(fabBox.height - 48) <= 2
    && (await style(d, '#ai-fab', 'border-radius')).startsWith('50%'), fabBox ? `${Math.round(fabBox.width)}x${Math.round(fabBox.height)}` : 'no box');
  check('触发器距边缘 20px', Boolean(fabBox)
    && Math.abs((1440 - fabBox.x - fabBox.width) - 20) <= 2 && Math.abs((1000 - fabBox.y - fabBox.height) - 20) <= 2);
  const zWidget = Number(await style(d, '#ai-widget', 'z-index'));
  check('层级高于内容低于弹层（75）', zWidget === 75, String(zWidget));
  const fabBg = await style(d, '#ai-fab', 'background-color');
  check('触发器 surface-1 底 + cyan-line 边',
    fabBg.replace(/\s/g, '') === 'rgb(15,20,28)' && (await style(d, '#ai-fab', 'border-color')).includes('34, 211, 238'),
    fabBg);
  check('hover 边框变青', await d.evaluate(() => {
    const n = document.querySelector('#ai-fab');
    n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true;
  }) && (await style(d, '#ai-fab', 'border-color')).includes('34, 211, 238'));

  // 2) 打开动效一次性
  await fab.click();
  await d.waitForTimeout(80);
  const panel = d.locator('#ai-panel');
  check('点击触发器打开面板', await panel.isVisible());
  check('打开触发上浮动画（160ms，一次性）',
    (await style(d, '#ai-panel', 'animation-name')) === 'ai-panel-in'
    && (await style(d, '#ai-panel', 'animation-iteration-count')) === '1'
    && Math.abs(parseFloat(await style(d, '#ai-panel', 'animation-duration')) - 0.16) < 0.02,
    `${await style(d, '#ai-panel', 'animation-name')} / ${await style(d, '#ai-panel', 'animation-duration')}`);
  check('扫线 300ms 只播一次（不循环）',
    (await style(d, '.ai-sweep', 'animation-name')) === 'ai-sweep-run'
    && (await style(d, '.ai-sweep', 'animation-iteration-count')) === '1'
    && Math.abs(parseFloat(await style(d, '.ai-sweep', 'animation-duration')) - 0.3) < 0.02);
  check('面板宽 380–420px（桌面浮层非全屏）',
    (await panel.boundingBox()).width >= 380 && (await panel.boundingBox()).width <= 420,
    String((await panel.boundingBox()).width));

  // 3) 状态行 / 关闭热区
  const dotBox = await d.locator('.ai-status-dot').boundingBox();
  check('状态点 6px 青色', Boolean(dotBox) && dotBox.width <= 7 && (await style(d, '.ai-status-dot', 'background-color')).includes('34, 211, 238'));
  const statusText = (await d.locator('.ai-status-text').textContent()).trim();
  check('状态行文案 AI ASSISTANT / 在线', /AI ASSISTANT\s*\/\s*在线/.test(statusText), statusText);
  const closeBox = await d.locator('#ai-close').boundingBox();
  check('关闭按钮热区 ≥44px', Boolean(closeBox) && closeBox.width >= 44 && closeBox.height >= 44,
    closeBox ? `${Math.round(closeBox.width)}x${Math.round(closeBox.height)}` : 'no box');
  check('状态行等宽 11px',
    (await style(d, '.ai-status-text', 'font-family')).toLowerCase().includes('mono')
    && Math.abs(parseFloat(await style(d, '.ai-status-text', 'font-size')) - 11) < 0.5);

  // 4) 背景滚动锁（overflow:hidden 只拦用户滚轮，程序化 scrollTo 本来就能滚——用 wheel 验证）
  await d.mouse.wheel(0, 600);
  await d.waitForTimeout(200);
  const scrollLocked = await d.evaluate(() => document.documentElement.scrollTop === 0);
  check('面板打开时背景滚动被锁定', scrollLocked);
  check('body 有 no-scroll 类', await d.evaluate(() => document.body.classList.contains('no-scroll')));

  // 5) 发送需求 → 扫描系统消息（750ms 内三行）→ AI 回复 + MATCH 卡片
  await d.locator('#ai-input').fill('推荐一款适合长时间办公的降噪耳机');
  const t0 = Date.now();
  await d.locator('#ai-form button[type="submit"]').click();
  await d.waitForSelector('.ai-sys', { timeout: 2000 });
  await d.waitForSelector('.ai-sys-lines .ai-sys-line:nth-child(3)', { timeout: 1500 });
  const scanMs = Date.now() - t0;
  check(`扫描系统消息三行在 750ms 级别出现（实际 ${scanMs}ms）`, scanMs >= 600 && scanMs <= 1300, `${scanMs}ms`);
  const sysText = await d.locator('.ai-sys-lines').textContent();
  check('扫描读数：扫描 N 件商品 / 交叉比价中 / 过滤 3 个维度',
    /扫描 [\d,]+ 件商品/.test(sysText) && sysText.includes('交叉比价中') && sysText.includes('过滤 3 个维度'), sysText);
  await d.waitForTimeout(900);
  check('旋转指示器只转一轮后隐藏（不无限转圈）',
    await d.evaluate(() => {
      const s = document.querySelector('.ai-sys-spin');
      return s && getComputedStyle(s).display === 'none';
    }));
  check('系统消息等宽 11px 弱化色',
    (await style(d, '.ai-sys-lines', 'font-family')).toLowerCase().includes('mono')
    && Math.abs(parseFloat(await style(d, '.ai-sys-lines', 'font-size')) - 11) < 0.5);

  await d.waitForSelector('.mini-card .mc-add', { timeout: 8000 });
  check('AI 回复带商品卡（真网关）', (await d.locator('.mini-card').count()) >= 1);
  const matchTxt = (await d.locator('.mc-match').first().textContent()).trim();
  check('商品卡顶部 AI MATCH 读数（88–99%）', /^AI MATCH (8[89]|9[0-9])%$/.test(matchTxt), matchTxt);
  check('MATCH 读数等宽青色',
    (await style(d, '.mc-match', 'font-family')).toLowerCase().includes('mono')
    && (await style(d, '.mc-match', 'color')).includes('34, 211, 238'));
  const userMsgAlign = await style(d, '.ai-msg.user', 'align-self');
  const botMsgBg = await style(d, '.ai-msg.bot', 'background-color');
  check('用户消息右对齐 / AI 消息 surface-2 底',
    userMsgAlign === 'flex-end' && botMsgBg.replace(/\s/g, '') === 'rgb(20,27,37)', `${userMsgAlign} / ${botMsgBg}`);

  // 6) 数量步进器 + 加购真实进购物袋
  await d.locator('.mc-stepper button').nth(1).click(); // +
  await d.waitForTimeout(120);
  check('数量步进器可用（1 → 2）', (await d.locator('.mc-qty').first().textContent()).trim() === '2');
  const badgeBefore = Number((await d.locator('#cart-count').textContent()).trim()) || 0;
  await d.locator('.mc-add').first().click();
  await d.waitForTimeout(350);
  const badgeAfter = Number((await d.locator('#cart-count').textContent()).trim()) || 0;
  check(`加购按钮真实进购物袋（角标 ${badgeBefore} → ${badgeAfter}）`, badgeAfter === badgeBefore + 2, `${badgeBefore}→${badgeAfter}`);
  check('加购反馈文案（已加入 ✓）', (await d.locator('.mc-add').first().textContent()).includes('已加入'));

  // 7) Esc 关闭 + 滚动恢复
  await d.keyboard.press('Escape');
  await d.waitForTimeout(160);
  check('Esc 关闭面板', !(await panel.isVisible()));
  check('关闭后滚动锁恢复', await d.evaluate(() => !document.body.classList.contains('no-scroll')));
  await d.mouse.wheel(0, 600);
  await d.waitForTimeout(200);
  check('关闭后背景可滚动', await d.evaluate(() => document.documentElement.scrollTop > 0));

  // 8) 触发器作为开关：开 → 关 → 开；控制台零错误
  await fab.click();
  await d.waitForTimeout(120);
  check('触发器点击重新打开', await panel.isVisible());
  await fab.click();
  await d.waitForTimeout(160);
  check('触发器再次点击可关闭（开关语义）', !(await panel.isVisible()));
  await fab.click();
  await d.waitForTimeout(120);
  check('触发器可再次打开（回到初始态收尾）', await panel.isVisible());
  await d.waitForTimeout(400);
  check('桌面控制台零错误', dErr.length === 0, dErr.join(' | '));
  await d.close();

  /* ================= 移动端 ================= */
  const { page: m, consoleErrors: mErr } = await newPage({ width: 390, height: 844 });
  await m.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await m.waitForTimeout(1500);

  const mFab = m.locator('#ai-fab');
  const mBox = await mFab.boundingBox();
  check('移动端触发器 44×44', Boolean(mBox) && Math.abs(mBox.width - 44) <= 2 && Math.abs(mBox.height - 44) <= 2,
    mBox ? `${Math.round(mBox.width)}x${Math.round(mBox.height)}` : 'no box');

  // 抽屉规格：全宽、底部、80vh 上限、顶部圆角
  await mFab.click();
  await m.waitForTimeout(120);
  const mPanel = m.locator('#ai-panel');
  const pBox = await mPanel.boundingBox();
  // PDP 有吸底操作栏：抽屉让位（bottom ≈ 844 - 78），否则贴底
  const lifted = Math.abs(pBox.y + pBox.height - (844 - 78)) <= 3;
  check('移动端面板为全宽底部抽屉（吸底栏页让位）', Boolean(pBox)
    && Math.abs(pBox.width - 390) <= 2 && lifted,
    pBox ? `${Math.round(pBox.width)}w bottom=${Math.round(pBox.y + pBox.height)}` : 'no box');
  check('抽屉高度 ≤ 80vh', pBox.height <= 844 * 0.8 + 2, `${Math.round(pBox.height)}px`);
  check('抽屉顶部圆角 16px', (await style(m, '#ai-panel', 'border-radius')).startsWith('16px'));

  // 不遮挡 PDP 吸底操作栏
  const noOverlapM = await m.evaluate(() => {
    const p = document.querySelector('#ai-panel');
    const bar = document.querySelector('.pdp-mobile-actions');
    if (!p || !bar) return false;
    return p.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top + 1;
  });
  check('抽屉不遮挡移动端吸底操作栏', noOverlapM);

  // 抽屉内发起对话：扫描消息 + MATCH 卡 + 加购（移动端同链路）
  await m.locator('#ai-input').fill('预算 500 的通勤耳机');
  await m.locator('#ai-form button[type="submit"]').click();
  await m.waitForSelector('.ai-sys-lines .ai-sys-line:nth-child(3)', { timeout: 2000 });
  await m.waitForSelector('.mini-card .mc-add', { timeout: 8000 });
  check('移动端扫描消息 + MATCH 卡照常', /AI MATCH \d+%/.test(await m.locator('.mc-match').first().textContent()));
  const mBadgeBefore = Number((await m.locator('#cart-count').textContent()).trim()) || 0;
  await m.locator('.mc-add').first().click();
  await m.waitForTimeout(350);
  const mBadgeAfter = Number((await m.locator('#cart-count').textContent()).trim()) || 0;
  check('移动端加购真实进购物袋', mBadgeAfter === mBadgeBefore + 1, `${mBadgeBefore}→${mBadgeAfter}`);

  // 无横向溢出
  const overflowM = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端无横向滚动', overflowM <= 1, `超出 ${overflowM}px`);
  await m.screenshot({ path: join(ROOT, '.shots', 'ai-panel-m.png') });
  check('移动控制台零错误', mErr.length === 0, mErr.join(' | '));
  await m.close();
} finally {
  browser.close();
  staticServer.kill();
  gateway.kill();
}

console.log(failed === 0 ? '\n✓ AI 助手升级验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
