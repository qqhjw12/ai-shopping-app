#!/usr/bin/env node
/**
 * 详情页 3D/360° + AR 入口验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 本轮只动详情页的 3D/360° 与 AR 入口（最轻方案、必须可降级），要验的是：
 *   1) 主图区有「图片 / 360° 查看」切换（等宽小字，选中态青色细线）+「AR 预览」入口；
 *   2) 360° 舞台：24 帧序列、拖拽切帧、松手惯性、首尾回绕、左右方向键、演示标注；
 *   3) AR：桌面弹层提示「请在移动设备上使用」（零脚本加载）；
 *      移动端不支持 WebXR → 降级回图片 + 一行说明；
 *      支持 WebXR（桩）→ 动态 import 演示层（请求发生在点击之后）+「演示模式」可关闭；
 *   4) 首屏网络面板零 3D 相关请求（无 three / model-viewer / glb / arPreview）；
 *   5) 帧预载失败 → 「3D 预览暂不可用」+ 切回图片按钮（window.Image 桩确定性触发）；
 *   6) reduced-motion：无惯性（拖到哪停哪）；
 *   7) 控制台零错误；移动端无横向滚动。
 *
 * 用法：node scripts/e2e-pdp-immersive.mjs [--port 4401] [--headed]
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
const PORT = Number(argOf('--port', '4401'));
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

// 3D 相关请求判定：任何 three / model-viewer / glb / arPreview 命中都算首屏越界
const HEAVY = /(three|model-viewer|\.glb|\.gltf|arPreview\.js)/i;

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
    hasTouch: mobile, // pointer: coarse 探测依赖触控仿真
  });
  for (const s of initScripts) await page.addInitScript(s);
  const consoleErrors = [];
  const requests = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource/.test(t)) return; // 网络 404 噪音（无后端演示站）
    consoleErrors.push(t.slice(0, 140));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));
  page.on('request', (r) => requests.push(r.url()));
  return { page, consoleErrors, requests };
}

const style = (page, sel, prop) =>
  page.locator(sel).first().evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop);

try {
  /* ================= 桌面端 ================= */
  const { page: d, consoleErrors: dErr, requests: dReq } = await newPage({ width: 1440, height: 1000 });
  await d.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await d.waitForTimeout(1400);
  const heavyBefore = dReq.filter((u) => HEAVY.test(u));
  check('首屏网络零 3D 相关请求（three/model-viewer/glb/arPreview）', heavyBefore.length === 0, heavyBefore.join(','));

  // 1) 视图条与入口
  check('「图片 / 360° 查看」切换可见', await d.locator('.pdp-mode-btn', { hasText: '360° 查看' }).isVisible()
    && await d.locator('.pdp-mode-btn', { hasText: '图片' }).isVisible());
  check('图片模式默认选中', await d.locator('.pdp-mode-btn', { hasText: '图片' }).first().getAttribute('aria-pressed') === 'true');
  check('切换按钮等宽 11px',
    (await style(d, '.pdp-mode-btn', 'font-family')).toLowerCase().includes('mono')
    && Math.abs(parseFloat(await style(d, '.pdp-mode-btn', 'font-size')) - 11) < 0.5);
  const activeBorder = await style(d, '.pdp-mode-btn.is-active', 'border-color');
  check('选中态青色细线', activeBorder.includes('34, 211, 238'), activeBorder);
  check('AR 预览入口可见', await d.locator('.pdp-ar-btn').isVisible());
  check('360° 舞台未提前挂载（懒初始化）', (await d.locator('.spin-stage').count()) === 0);

  // 2) 进入 360°：演示标注 + 帧计数
  await d.locator('.pdp-mode-btn', { hasText: '360° 查看' }).click();
  await d.waitForTimeout(250);
  check('360° 舞台可见，主图隐藏', await d.locator('.spin-stage').isVisible()
    && !(await d.locator('.pdp-main-image').isVisible()));
  check('无真实序列 → 演示标注', (await d.locator('.spin-stage').getAttribute('data-demo')) === 'true'
    && (await d.locator('.spin-demo-tag').textContent()).trim() === '演示');
  const counter0 = (await d.locator('.spin-counter').textContent()).trim();
  check('24 帧序列帧计数（01 / 24）', counter0 === '01 / 24', counter0);

  // 3) 拖拽切帧 + 松手惯性
  const stage = d.locator('.spin-stage');
  const box = await stage.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await d.mouse.move(cx, cy);
  await d.mouse.down();
  for (let i = 1; i <= 10; i += 1) await d.mouse.move(cx - i * 30, cy, { steps: 1 });
  const counterDuringDrag = (await d.locator('.spin-counter').textContent()).trim();
  await d.mouse.up();
  const counterAtRelease = (await d.locator('.spin-counter').textContent()).trim();
  check('拖拽映射帧索引（−300px → 帧变化）', counterDuringDrag !== counter0, `${counter0} → ${counterDuringDrag}`);
  await d.waitForTimeout(120);
  const counterInertia = (await d.locator('.spin-counter').textContent()).trim();
  await d.waitForTimeout(1100);
  const counterSettled = (await d.locator('.spin-counter').textContent()).trim();
  check('松手后惯性继续推进（阻尼到停）', counterInertia !== counterAtRelease || counterSettled !== counterAtRelease,
    `${counterAtRelease} → ${counterInertia} → ${counterSettled}`);
  await d.waitForTimeout(700);
  const counterFinal = (await d.locator('.spin-counter').textContent()).trim();
  check('惯性最终收敛（不再变化）', counterFinal === counterSettled, `${counterSettled} → ${counterFinal}`);

  // 4) 首尾回绕：大距离拖拽后帧号仍落在 01–24
  await d.mouse.move(cx, cy);
  await d.mouse.down();
  await d.mouse.move(cx - 2400, cy, { steps: 12 });
  await d.mouse.up();
  await d.waitForTimeout(900);
  const wrapped = (await d.locator('.spin-counter').textContent()).trim();
  const frameNo = Number(wrapped.slice(0, 2));
  check(`首尾无缝回绕（帧号 ${wrapped}）`, frameNo >= 1 && frameNo <= 24, wrapped);

  // 5) 键盘方向键
  await stage.focus();
  const before = (await d.locator('.spin-counter').textContent()).trim();
  await d.keyboard.press('ArrowRight');
  await d.waitForTimeout(80);
  const afterRight = (await d.locator('.spin-counter').textContent()).trim();
  await d.keyboard.press('ArrowLeft');
  await d.waitForTimeout(80);
  const afterLeft = (await d.locator('.spin-counter').textContent()).trim();
  check('左右方向键切帧（可访问性）', afterRight !== before && afterLeft === before,
    `${before} → ${afterRight} → ${afterLeft}`);

  // 6) 切回图片
  await d.locator('.pdp-mode-btn', { hasText: '图片' }).click();
  await d.waitForTimeout(150);
  check('切回图片模式（主图恢复，舞台隐藏）', await d.locator('.pdp-main-image').isVisible()
    && !(await d.locator('.spin-stage').isVisible()));

  // 7) 桌面 AR：提示弹层，零脚本加载
  const heavyBeforeAr = dReq.filter((u) => HEAVY.test(u)).length;
  await d.locator('.pdp-ar-btn').click();
  await d.waitForTimeout(300);
  check('桌面 AR：弹层提示「请在移动设备上使用」', await d.locator('.pdp-ar-prompt').isVisible()
    && (await d.locator('.pdp-ar-prompt').textContent()).includes('请在移动设备上使用 AR 预览'));
  check('桌面 AR 不加载任何演示层脚本', dReq.filter((u) => HEAVY.test(u)).length === heavyBeforeAr);
  await d.locator('.pdp-ar-prompt-ok').click();
  await d.waitForTimeout(150);
  check('AR 提示弹层可关闭', (await d.locator('.pdp-ar-prompt').count()) === 0);
  check('桌面控制台零错误', dErr.length === 0, dErr.join(' | '));
  await d.close();

  /* ================= 移动端：不支持 WebXR → 降级说明 ================= */
  const { page: m, consoleErrors: mErr, requests: mReq } = await newPage({ width: 390, height: 844 }, [], true);
  await m.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await m.waitForTimeout(1400);
  await m.locator('.pdp-ar-btn').click();
  await m.waitForTimeout(400);
  check('移动端不支持 WebXR → 一行降级说明', await m.locator('.pdp-ar-note').isVisible()
    && (await m.locator('.pdp-ar-note').textContent()).includes('当前设备不支持 AR 预览'));
  check('降级后停留在图片模式', await m.locator('.pdp-main-image').isVisible());
  check('不支持路径零演示层请求', mReq.filter((u) => /arPreview\.js/.test(u)).length === 0);
  const overflowM = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端无横向滚动', overflowM <= 1, `超出 ${overflowM}px`);
  await m.screenshot({ path: join(ROOT, '.shots', 'pdp-immersive-m.png') });
  check('移动控制台零错误', mErr.length === 0, mErr.join(' | '));
  await m.close();

  /* ================= 移动端：WebXR 桩 → 演示层按需加载 ================= */
  const xrStub = () => {
    // navigator.xr 是只读访问器，直接赋值会被静默忽略——必须 defineProperty 覆盖
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: { isSessionSupported: async (mode) => mode === 'immersive-ar' },
    });
  };
  const { page: m2, consoleErrors: m2Err, requests: m2Req } = await newPage({ width: 390, height: 844 }, [xrStub], true);
  await m2.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await m2.waitForTimeout(1400);
  const arReqBefore = m2Req.filter((u) => /arPreview\.js/.test(u)).length;
  check('演示层模块点击前零加载', arReqBefore === 0);
  await m2.locator('.pdp-ar-btn').click();
  await m2.waitForTimeout(600);
  check('支持 WebXR → 打开全屏演示层并标注「演示模式」', await m2.locator('.ar-layer').isVisible()
    && (await m2.locator('.ar-status-text').textContent()).includes('演示模式'));
  check('演示层模块在点击后才动态加载', m2Req.filter((u) => /arPreview\.js/.test(u)).length === 1);
  const closeBox = await m2.locator('.ar-close').boundingBox();
  check('演示层关闭热区 ≥44px', Boolean(closeBox) && closeBox.width >= 44 && closeBox.height >= 44);
  await m2.locator('.ar-close').click();
  await m2.waitForTimeout(200);
  check('演示层可关闭', (await m2.locator('.ar-layer').count()) === 0);
  check('演示层关闭后滚动恢复', await m2.evaluate(() => !document.body.classList.contains('no-scroll')));
  check('WebXR 桩页控制台零错误', m2Err.length === 0, m2Err.join(' | '));
  await m2.close();

  /* ================= 失败兜底：帧预载失败 → 「3D 预览暂不可用」 ================= */
  const imageFailStub = () => {
    // 只影响 pdpImmersive 的预载探针（new Image()），页面 <img> 不受影响
    window.Image = class {
      set src(v) { setTimeout(() => this.onerror && this.onerror(new Event('error')), 30); }
    };
  };
  const { page: f, consoleErrors: fErr } = await newPage({ width: 1440, height: 1000 }, [imageFailStub]);
  await f.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await f.waitForTimeout(1300);
  await f.locator('.pdp-mode-btn', { hasText: '360° 查看' }).click();
  await f.waitForTimeout(500);
  check('帧预载失败 → 「3D 预览暂不可用」+ 切回图片按钮', await f.locator('.spin-fail').isVisible()
    && (await f.locator('.spin-fail-text').textContent()).includes('3D 预览暂不可用')
    && await f.locator('.spin-fail-back').isVisible());
  await f.locator('.spin-fail-back').click();
  await f.waitForTimeout(150);
  check('失败后可切回图片模式', await f.locator('.pdp-main-image').isVisible());
  check('失败兜底页控制台零错误', fErr.length === 0, fErr.join(' | '));
  await f.close();

  /* ================= reduced-motion：无惯性 ================= */
  const rm = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const rmErr = [];
  rm.on('pageerror', (e) => rmErr.push(String(e).slice(0, 140)));
  await rm.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await rm.waitForTimeout(1300);
  await rm.locator('.pdp-mode-btn', { hasText: '360° 查看' }).click();
  await rm.waitForTimeout(250);
  const rBox = await rm.locator('.spin-stage').boundingBox();
  const rCx = rBox.x + rBox.width / 2;
  const rCy = rBox.y + rBox.height / 2;
  await rm.mouse.move(rCx, rCy);
  await rm.mouse.down();
  for (let i = 1; i <= 6; i += 1) await rm.mouse.move(rCx - i * 30, rCy, { steps: 1 });
  await rm.mouse.up();
  const rmAtRelease = (await rm.locator('.spin-counter').textContent()).trim();
  await rm.waitForTimeout(500);
  const rmAfter = (await rm.locator('.spin-counter').textContent()).trim();
  check('reduced-motion：拖到哪停哪（无惯性推进）', rmAtRelease === rmAfter, `${rmAtRelease} → ${rmAfter}`);
  check('reduced-motion 页零 JS 错', rmErr.length === 0);
  await rm.close();
} finally {
  browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 详情页 3D/360° + AR 验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
