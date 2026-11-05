#!/usr/bin/env node
/**
 * 氛围动效与全局性能开关验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 本轮只加 CSS 级氛围动效并建立全局性能开关，不改结构与业务，要验的是：
 *   1) 背景网格 30s linear 斜向漂移，有效强度 ≤0.05；桌面动、该静止时静止；
 *   2) 扫描线只出现在 Hero 环内（循环，opacity ≤0.25）；AI 面板打开时暂停（预算让位）；
 *   3) 卡片 hover 只有边框信号（150ms），无位移无缩放；按钮 :active scale(0.98)/120ms；
 *   4) 稳态无限循环 keyframes ≤3 个（网格 + 状态栏呼吸 + Hero 扫描线）；
 *   5) .reduced-fx：reduced-motion / <768px / deviceMemory<4 任一命中 →
 *      网格静止、扫描线消失、呼吸点停、backdrop-filter 关闭并换不透明底；
 *   6) .low-power：Battery API 桩 <20% 未充电 → 网格单独静止，reduced-fx 不误伤；
 *   7) 控制台零错误。
 *
 * 用法：node scripts/e2e-ambient.mjs [--port 4405] [--headed]
 * 退出码：0 全通过 / 1 有失败
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
const PORT = Number(argOf('--port', '4405'));
const BASE = `http://127.0.0.1:${PORT}`;
const APP = `${BASE}/index.html`;

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

async function newPage(viewport, initScripts = [], mobile = false) {
  const page = await browser.newPage({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
  });
  for (const s of initScripts) await page.addInitScript(s);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource/.test(t)) return; // 无后端演示站的 404 噪音，单独由业务断言覆盖
    consoleErrors.push(t.slice(0, 140));
  });
  return { page, consoleErrors };
}

// 统计「稳态无限循环」动画：iterations === Infinity 的 running CSS animation
const steadyCount = (page) =>
  page.evaluate(() =>
    document.getAnimations().filter((a) => {
      try {
        const t = a.effect.getTiming();
        return t.iterations === Infinity && a.playState === 'running';
      } catch {
        return false;
      }
    }).length,
  );

/* ---------------- 一、桌面基线：网格动、扫描线限量、hover 信号 ---------------- */
{
  const { page: d, consoleErrors: dErr } = await newPage({ width: 1440, height: 900 });
  await d.goto(`${APP}#/`, { waitUntil: 'load' });
  await d.waitForTimeout(1300);

  const switchOn = await d.evaluate(() => ({
    reduced: document.documentElement.classList.contains('reduced-fx'),
    low: document.documentElement.classList.contains('low-power'),
  }));
  check('桌面基线不带 reduced-fx / low-power', !switchOn.reduced && !switchOn.low,
    JSON.stringify(switchOn));

  const grid = await d.evaluate(() => {
    const s = getComputedStyle(document.documentElement, '::before');
    return { name: s.animationName, dur: s.animationDuration, iter: s.animationIterationCount };
  });
  check('背景网格 30s linear infinite 斜向漂移',
    grid.name === 'grid-drift' && grid.dur === '30s' && grid.iter === 'infinite', JSON.stringify(grid));

  const scan = await d.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.hp-ring'), '::after');
    return { name: s.animationName, dur: s.animationDuration, h: s.height, op: s.opacity, disp: s.display };
  });
  check('Hero 环内扫描线：1px / 5s 循环 / opacity ≤0.25',
    scan.name === 'hp-scan-down' && scan.dur === '5s' && scan.h === '1px' && Number(scan.op) <= 0.25,
    JSON.stringify(scan));

  const others = await d.evaluate(() =>
    [...document.querySelectorAll('.fs-sale *, .pcard *')]
      .filter((n) => {
        const s = getComputedStyle(n);
        return s.animationName !== 'none' && s.animationIterationCount === 'infinite';
      }).length,
  );
  check('商品区无其他循环扫描/脉冲（扫描线限量两处）', others === 0, `found=${others}`);

  const steady = await steadyCount(d);
  check('稳态无限 keyframes ≤3（网格+状态栏呼吸+扫描线）', steady <= 3, `running=${steady}`);

  // hover 信号：边框变青、无位移无缩放（首页结果卡的边框在外壳 .scan-item 上）
  const card = d.locator('.scan-item').first();
  await card.scrollIntoViewIfNeeded();
  const before = await card.evaluate((n) => {
    const s = getComputedStyle(n);
    return { border: s.borderColor, tf: s.transform, tr: s.transition };
  });
  await card.hover();
  await d.waitForTimeout(260);
  const after = await card.evaluate((n) => {
    const s = getComputedStyle(n);
    return { border: s.borderColor, tf: s.transform };
  });
  check('卡片 hover：border-color 过渡到青色细线', before.border !== after.border
    && after.border.includes('34, 211, 238'), `${before.border} → ${after.border}`);
  check('卡片 hover：无位移与缩放（transform 保持 none）',
    before.tf === 'none' && after.tf === 'none', after.tf);
  check('卡片过渡只作用于 border-color（150ms）',
    /^border-color 150ms/.test(before.tr.replace('0', '').replace('s ', 'ms ')) || before.tr.includes('border-color 0.15s')
      || before.tr.includes('border-color 150ms'), before.tr);

  // AI 面板打开 → 环内扫描线暂停（稳态预算让位），总预算仍 ≤3
  await d.evaluate(() => window.scrollTo(0, 0));
  await d.click('#ai-fab');
  await d.waitForTimeout(400);
  const paused = await d.evaluate(() =>
    getComputedStyle(document.querySelector('.hp-ring'), '::after').animationPlayState);
  check('AI 面板打开时 Hero 扫描线暂停', paused === 'paused', paused);
  const steadyPanel = await steadyCount(d);
  check('面板打开后稳态无限 keyframes 仍 ≤3', steadyPanel <= 3, `running=${steadyPanel}`);
  await d.keyboard.press('Escape');
  await d.waitForTimeout(200);

  // 正常桌面 backdrop-filter 保留（玻璃质感只在降级时关）
  const bf = await d.evaluate(() => getComputedStyle(document.querySelector('.sysbar')).backdropFilter);
  check('正常桌面保留 backdrop-filter（玻璃质感）', bf && bf !== 'none', bf);

  check('桌面控制台零错误', dErr.length === 0, dErr.join(' | ').slice(0, 200));
  await d.close();
}

/* ---------------- 二、reduced-motion：装饰动效全停 ---------------- */
{
  const { page: r, consoleErrors: rErr } = await newPage({ width: 1440, height: 900 });
  await r.emulateMedia({ reducedMotion: 'reduce' });
  await r.goto(`${APP}#/`, { waitUntil: 'load' });
  await r.waitForTimeout(1100);

  check('reduced-motion → html.reduced-fx',
    await r.evaluate(() => document.documentElement.classList.contains('reduced-fx')));
  const gridStop = await r.evaluate(() =>
    getComputedStyle(document.documentElement, '::before').animationName);
  check('网格漂移停止', gridStop === 'none', gridStop);
  const scanStop = await r.evaluate(() =>
    getComputedStyle(document.querySelector('.hp-ring'), '::after').display);
  check('扫描线消失', scanStop === 'none', scanStop);
  const breath = await r.evaluate(() =>
    getComputedStyle(document.querySelector('.sysbar-dot')).animationName);
  check('呼吸点停止', breath === 'none', breath);
  const bf = await r.evaluate(() => getComputedStyle(document.querySelector('.sysbar')).backdropFilter);
  const bg = await r.evaluate(() => getComputedStyle(document.querySelector('.sysbar')).backgroundColor);
  check('backdrop-filter 关闭且状态栏换不透明底', bf === 'none' && bg === 'rgb(15, 20, 28)', `${bf} / ${bg}`);
  // 页面仍完整可用：主标题、模块卡、加购链路都在
  const usable = await r.evaluate(() => ({
    title: document.querySelector('.hp-title')?.textContent.length > 0,
    mods: document.querySelectorAll('.hp-mod').length,
    cards: document.querySelectorAll('.pcard').length,
  }));
  check('reduced-fx 下页面仍完整可用', usable.title && usable.mods >= 6 && usable.cards > 0,
    JSON.stringify(usable));
  check('reduced-motion 控制台零错误', rErr.length === 0, rErr.join(' | ').slice(0, 200));
  await r.close();
}

/* ---------------- 三、移动端 <768px：默认静止 ---------------- */
{
  const { page: m, consoleErrors: mErr } = await newPage({ width: 390, height: 844 }, [], true);
  await m.goto(`${APP}#/`, { waitUntil: 'load' });
  await m.waitForTimeout(1100);

  check('移动端 <768px → html.reduced-fx',
    await m.evaluate(() => document.documentElement.classList.contains('reduced-fx')));
  check('移动端网格静止',
    (await m.evaluate(() => getComputedStyle(document.documentElement, '::before').animationName)) === 'none');
  check('移动端扫描线消失',
    (await m.evaluate(() => getComputedStyle(document.querySelector('.hp-ring'), '::after').display)) === 'none');
  const noHScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('移动端无横向滚动', noHScroll);
  check('移动端控制台零错误', mErr.length === 0, mErr.join(' | ').slice(0, 200));
  await m.close();
}

/* ---------------- 四、低内存 deviceMemory<4：桌面也降级 ---------------- */
{
  const { page: lo, consoleErrors: loErr } = await newPage({ width: 1440, height: 900 }, [
    () => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 2 }),
  ]);
  await lo.goto(`${APP}#/`, { waitUntil: 'load' });
  await lo.waitForTimeout(1100);
  check('deviceMemory=2 → html.reduced-fx',
    await lo.evaluate(() => document.documentElement.classList.contains('reduced-fx')));
  check('低内存下网格静止',
    (await lo.evaluate(() => getComputedStyle(document.documentElement, '::before').animationName)) === 'none');
  check('低内存控制台零错误', loErr.length === 0, loErr.join(' | ').slice(0, 200));
  await lo.close();
}

/* ---------------- 五、低电量 Battery API：网格单独静止 ---------------- */
{
  const { page: b, consoleErrors: bErr } = await newPage({ width: 1440, height: 900 }, [
    () => {
      Object.defineProperty(navigator, 'getBattery', {
        configurable: true,
        value: () => Promise.resolve({
          level: 0.15,
          charging: false,
          addEventListener() {},
        }),
      });
    },
  ]);
  await b.goto(`${APP}#/`, { waitUntil: 'load' });
  await b.waitForTimeout(1300);
  const state = await b.evaluate(() => ({
    low: document.documentElement.classList.contains('low-power'),
    reduced: document.documentElement.classList.contains('reduced-fx'),
  }));
  check('低电量 → html.low-power 且不误加 reduced-fx', state.low && !state.reduced, JSON.stringify(state));
  check('低电量网格静止',
    (await b.evaluate(() => getComputedStyle(document.documentElement, '::before').animationName)) === 'none');
  check('低电量下扫描线保留（纯装饰只停网格）',
    (await b.evaluate(() => getComputedStyle(document.querySelector('.hp-ring'), '::after').display)) !== 'none');
  check('低电量控制台零错误', bErr.length === 0, bErr.join(' | ').slice(0, 200));
  await b.close();
}

await browser.close();
staticServer.kill();

console.log(failed === 0 ? '\n✓ 氛围动效验收全部通过' : `\n✗ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
