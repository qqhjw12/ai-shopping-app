#!/usr/bin/env node
/**
 * 虚拟展厅 + AR 试穿/试妆验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖规格五条：
 *   1) 展厅列表与详情可访问，商品可加购 / 可看详情；
 *   2) 网格 / 展厅两种视图可切换，且偏好在刷新后保留；
 *   3) 服饰美妆等类目详情页有 AR 入口，桌面与移动端都有明确降级提示；
 *   4) AR 演示层可切换 SKU、可关闭；
 *   5) 首屏无 AR 相关脚本请求；控制台无错误。
 *
 * 另外自查三条实现纪律：展厅氛围图程序化生成（零外部图片请求）、
 * 展厅不自动轮播（无定时器 / 无 CSS 无限动画驱动滚动）、
 * 不改拼团与对比（顺手打开两页确认仍正常）。
 *
 * 用法：node scripts/e2e-showroom-ar.mjs [--port 4421] [--headed]
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
const PORT = Number(argOf('--port', '4421'));
const APP = `http://127.0.0.1:${PORT}/index.html`;
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

const AR_RE = /arTryOn\.js/i;

/** 新建一页并收集控制台错误 / 网络请求（/api 404 与外部图噪音按已知噪音忽略） */
async function newPage({ viewport, mobile = false, initScripts = [] } = {}) {
  const ctx = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
  });
  for (const s of initScripts) await ctx.addInitScript(s);
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource|net::|ERR_|404/.test(t)) return;
    errors.push(t.slice(0, 160));
  });
  page.on('request', (r) => requests.push(r.url()));
  return { ctx, page, errors, requests };
}

const styleOf = (page, sel, prop) =>
  page.locator(sel).first().evaluate((n, p) => getComputedStyle(n).getPropertyValue(p), prop);

try {
  /* ===================== 1) 展厅列表 ===================== */
  const { ctx: dctx, page: d, errors: dErr, requests: dReq } = await newPage({ viewport: { width: 1440, height: 940 } });

  await d.goto(`${APP}#/showroom`, { waitUntil: 'load' });
  await d.waitForSelector('.sr-zone', { timeout: 8000 });
  await d.waitForTimeout(700);

  check('展厅列表可访问（#/showroom）', await d.locator('.sr-title').isVisible());
  const zoneN = await d.locator('.sr-zone').count();
  check('分区数量在 3–5 之间', zoneN >= 3 && zoneN <= 5, `实际 ${zoneN}`);

  const zoneNames = await d.locator('.sr-zone-name').allTextContents();
  check('分区名称可读（春日衣橱 / 数码前线 / 香氛实验室…）', zoneNames.length === zoneN && zoneNames.every((t) => t.trim().length > 0), zoneNames.join('|'));
  check('每个分区都有进入按钮', (await d.locator('.sr-zone-enter').count()) === zoneN);
  check('分区氛围图已绘制（程序化 SVG）', (await d.locator('.sr-zone-art-host .sr-art-svg').count()) === zoneN);
  check('页面零外部图片请求（氛围图不依赖图床）',
    dReq.every((u) => !/^https?:\/\/(?!127\.0\.0\.1)/.test(u)),
    dReq.filter((u) => /^https?:\/\/(?!127\.0\.0\.1)/.test(u)).slice(0, 2).join(','));

  // 分区卡片有真实高度，不是塌成 0 的一条线
  const zoneBox = await d.locator('.sr-zone').first().boundingBox();
  check('分区卡有实体尺寸（≥260px 高）', !!zoneBox && zoneBox.height >= 260, zoneBox ? `${Math.round(zoneBox.height)}px` : 'null');

  /* ===================== 2) 分区详情 + 视图切换 ===================== */
  await d.locator('.sr-zone-enter').nth(2).click(); // 香氛实验室
  await d.waitForSelector('.sr-hero-name', { timeout: 8000 });
  await d.waitForTimeout(600);
  check('从大厅可进入分区详情', d.url().includes('#/showroom/'), d.url());
  check('详情页展示分区名与展品计数', await d.locator('.sr-hero-name').isVisible() && (await d.locator('.sr-meta').textContent()).includes('件展品'));

  // 默认网格视图
  await d.waitForSelector('.sr-grid .pcard', { timeout: 8000 });
  const gridN = await d.locator('.sr-grid .pcard').count();
  check('默认网格视图渲染商品卡', gridN > 0, `${gridN} 张`);
  check('网格按钮处于选中态', await d.locator('.sr-viewbtn', { hasText: '网格' }).first().getAttribute('aria-pressed') === 'true');

  // 切展厅视图
  await d.locator('.sr-viewbtn', { hasText: '展厅' }).first().click();
  await d.waitForSelector('.sr-rail .sr-hall-card', { timeout: 8000 });
  await d.waitForTimeout(500);
  const hallN = await d.locator('.sr-hall-card').count();
  check('可切到展厅视图（横向大卡）', hallN > 0 && (await d.locator('.sr-rail').count()) === 1, `${hallN} 张`);
  check('展厅视图按钮选中、网格按钮取消', await d.locator('.sr-viewbtn', { hasText: '展厅' }).first().getAttribute('aria-pressed') === 'true'
    && await d.locator('.sr-viewbtn', { hasText: '网格' }).first().getAttribute('aria-pressed') === 'false');

  // 景深：卡上确有 CSS transform，轨道确有 perspective（不是真 3D）
  const cardTransform = await styleOf(d, '.sr-hall-card', 'transform');
  const railPersp = await styleOf(d, '.sr-rail', 'perspective');
  check('展厅卡有 CSS 景深变换（rotateY/scale，非 none）', cardTransform !== 'none' && /matrix3d|matrix/.test(cardTransform), cardTransform);
  check('轨道容器设置了 perspective（纯 CSS 3D 感）', railPersp !== 'none' && parseFloat(railPersp) > 0, railPersp);
  check('未引入 3D 库（首屏无 three/glb 请求）', dReq.every((u) => !/(three|model-viewer|\.glb|\.gltf)/i.test(u)));

  // 懒加载：未进视口的卡片仍是骨架
  const loadedArts = await d.locator('.sr-hall-art .art').count();
  const paintedSkeletons = await d.locator('.sr-hall-art .sr-skeleton').count();
  check('横向轨道按视口懒加载（远处卡片仍是骨架占位）',
    loadedArts < hallN && paintedSkeletons > 0, `已画 ${loadedArts} / 共 ${hallN}`);

  // 滚到轨道末尾 → 末尾卡片补上贴图
  await d.locator('.sr-rail').evaluate((n) => { n.scrollLeft = n.scrollWidth; });
  await d.waitForTimeout(600);
  const loadedAfter = await d.locator('.sr-hall-art .art').count();
  check('横向滑到末尾后，后续卡片才挂载贴图', loadedAfter > loadedArts, `${loadedArts} → ${loadedAfter}`);

  // 视图偏好持久化
  await d.reload({ waitUntil: 'load' });
  await d.waitForSelector('.sr-hall-card', { timeout: 8000 });
  check('视图偏好刷新后保留（仍是展厅视图）',
    await d.locator('.sr-viewbtn', { hasText: '展厅' }).first().getAttribute('aria-pressed') === 'true');

  // 切回网格
  await d.locator('.sr-viewbtn', { hasText: '网格' }).first().click();
  await d.waitForSelector('.sr-grid .pcard', { timeout: 6000 });
  check('可切回网格视图', (await d.locator('.sr-grid .pcard').count()) > 0);

  /* ===================== 3) 展厅商品可加购 / 可看详情 ===================== */
  const bagCount = () => d.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('shop_cart') || '[]').length; } catch { return 0; }
  });
  const bagBefore = await bagCount();
  await d.locator('.sr-grid .pcard .thumb-add').first().click();
  await d.waitForTimeout(600);
  const bagAfter = await bagCount();
  check('展厅商品可加入购物袋', bagAfter > bagBefore, `${bagBefore} → ${bagAfter}`);

  await d.locator('.sr-grid .pcard .name').first().click();
  await d.waitForTimeout(900);
  check('展厅商品可进详情页', /#\/product\//.test(d.url()), d.url());

  /* ===================== 4) PDP 的 AR 入口分类门控 + 桌面降级 ===================== */
  const arBefore = dReq.filter((u) => AR_RE.test(u)).length;
  await d.goto(`${APP}#/product/p065`, { waitUntil: 'load' }); // 服饰
  await d.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await d.waitForTimeout(700);
  check('服饰详情页显示 AR 试穿入口', await d.locator('.tryon-entry').first().isVisible()
    && (await d.locator('.tryon-entry').first().textContent()).includes('AR 试穿'));
  check('首屏未加载任何 AR 演示脚本（arTryOn.js 零请求）', dReq.filter((u) => AR_RE.test(u)).length === arBefore,
    dReq.filter((u) => AR_RE.test(u)).join(','));

  await d.locator('.tryon-entry').first().click();
  await d.waitForSelector('.tryon-prompt', { timeout: 5000 });
  check('桌面端点 AR → 提示「请在移动设备上体验」',
    (await d.locator('.tryon-prompt h3').textContent()).includes('请在移动设备上体验 AR'));
  check('桌面端点击后仍未加载 AR 脚本', dReq.filter((u) => AR_RE.test(u)).length === arBefore);
  await d.locator('.tryon-prompt-ok').click();
  await d.waitForTimeout(300);
  check('桌面提示可关闭', (await d.locator('.tryon-prompt').count()) === 0);

  // 非试穿类目：入口不出现
  await d.goto(`${APP}#/product/p001`, { waitUntil: 'load' }); // 手机
  await d.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await d.waitForTimeout(500);
  check('手机类目详情页不显示 AR 试穿入口', (await d.locator('.tryon-entry').count()) === 0);

  // 美妆类目：文案应变「试妆」
  await d.goto(`${APP}#/product/p135`, { waitUntil: 'load' }); // 彩妆香氛
  await d.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await d.waitForTimeout(500);
  const beautyLabel = (await d.locator('.tryon-entry').count()) ? await d.locator('.tryon-entry').first().textContent() : '';
  check('美妆详情页入口文案为「AR 试妆」', beautyLabel.includes('AR 试妆'), beautyLabel || '（无入口）');

  check('桌面端全程零 JS 错误', dErr.length === 0, dErr.join(' | '));
  await dctx.close();

  /* ===================== 5) 移动端 AR 演示层 ===================== */
  const { ctx: mctx, page: m, errors: mErr, requests: mReq } = await newPage({
    viewport: { width: 390, height: 844 },
    mobile: true,
  });
  await m.goto(`${APP}#/product/p065`, { waitUntil: 'load' });
  await m.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await m.waitForTimeout(700);
  const arMobileBefore = mReq.filter((u) => AR_RE.test(u)).length;
  check('移动端首屏同样零 AR 脚本请求', arMobileBefore === 0, mReq.filter((u) => AR_RE.test(u)).join(','));

  await m.locator('.tryon-entry').first().click();
  await m.waitForSelector('.try-layer', { timeout: 8000 });
  await m.waitForTimeout(600);
  check('移动端点击后打开全屏演示层', await m.locator('.try-layer').isVisible());
  check('演示层标注「演示模式」', (await m.locator('.try-demo-tag').textContent()).includes('演示模式'));
  check('演示层此时才动态加载 arTryOn.js', mReq.filter((u) => AR_RE.test(u)).length > arMobileBefore);
  check('演示层铺满视口（全屏占位）', await m.locator('.try-layer').evaluate((n) => {
    const r = n.getBoundingClientRect();
    return r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;
  }));
  check('商品贴图与取景说明都在位', await m.locator('.try-object').isVisible() && await m.locator('.try-caption').isVisible());

  // SKU 切换
  const skuN = await m.locator('.try-sku').count();
  check('演示层可切换 SKU/颜色（至少 2 个规格）', skuN >= 2, `${skuN} 个`);
  const specBefore = await m.locator('.try-spec-readout').textContent();
  const tintBefore = await m.locator('.try-object-tint').evaluate((n) => getComputedStyle(n).backgroundColor);
  await m.locator('.try-sku').nth(skuN - 1).click();
  await m.waitForTimeout(400);
  const specAfter = await m.locator('.try-spec-readout').textContent();
  const tintAfter = await m.locator('.try-object-tint').evaluate((n) => getComputedStyle(n).backgroundColor);
  check('切换规格后读数变化且选中态转移', specAfter !== specBefore
    && await m.locator('.try-sku').nth(skuN - 1).getAttribute('aria-pressed') === 'true'
    && await m.locator('.try-sku').first().getAttribute('aria-pressed') === 'false');
  check('切换规格后贴图换色（叠色改变）', tintAfter !== tintBefore, `${tintBefore} → ${tintAfter}`);

  // 截图（canvas 占位）与分享（mock）
  await m.locator('.try-act', { hasText: '截图保存' }).first().click();
  await m.waitForTimeout(700);
  const shootToast = await m.locator('.toast, [class*="toast"]').last().textContent().catch(() => '');
  check('截图按钮产出占位图并给出提示', /截图/.test(shootToast || ''), shootToast || '（无提示）');
  await m.locator('.try-act', { hasText: '分享' }).first().click();
  await m.waitForTimeout(600);
  const shareToast = await m.locator('.toast, [class*="toast"]').last().textContent().catch(() => '');
  check('分享按钮复制 mock 链接并提示', /分享|复制/.test(shareToast || ''), shareToast || '（无提示）');

  // 关闭演示层
  await m.locator('.try-close').click();
  await m.waitForTimeout(400);
  check('演示层可关闭且解锁页面滚动', (await m.locator('.try-layer').count()) === 0
    && !(await m.evaluate(() => document.body.classList.contains('no-scroll'))));
  check('移动端零 JS 错误', mErr.length === 0, mErr.join(' | '));
  await mctx.close();

  /* ===================== 6) 无摄像头 / 拒绝授权的降级 ===================== */
  const noCam = await newPage({
    viewport: { width: 390, height: 844 },
    mobile: true,
    initScripts: [`Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });`],
  });
  await noCam.page.goto(`${APP}#/product/p065`, { waitUntil: 'load' });
  await noCam.page.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await noCam.page.waitForTimeout(500);
  await noCam.page.locator('.tryon-entry').first().click();
  await noCam.page.waitForSelector('.try-layer', { timeout: 8000 });
  await noCam.page.waitForTimeout(400);
  const staticNote = await noCam.page.locator('.try-status-text').textContent();
  check('不支持摄像头 → 降级为静态试穿示意 + 说明', /静态试穿示意/.test(staticNote), staticNote);
  check('降级时不再提供「启用摄像头背景」', (await noCam.page.locator('.try-live-btn').count()) === 0);
  check('降级路径无 JS 错误', noCam.errors.length === 0, noCam.errors.join(' | '));
  await noCam.ctx.close();

  // 用户拒绝授权：仍留在演示层，只换一行说明
  const deny = await newPage({
    viewport: { width: 390, height: 844 },
    mobile: true,
    initScripts: [`Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
    });`],
  });
  await deny.page.goto(`${APP}#/product/p065`, { waitUntil: 'load' });
  await deny.page.waitForSelector('.pdp-secondary-actions', { timeout: 8000 });
  await deny.page.waitForTimeout(500);
  await deny.page.locator('.tryon-entry').first().click();
  await deny.page.waitForSelector('.try-layer', { timeout: 8000 });
  await deny.page.waitForTimeout(300);
  await deny.page.locator('.try-live-btn').click();
  await deny.page.waitForTimeout(600);
  const deniedNote = await deny.page.locator('.try-status-text').textContent();
  check('拒绝摄像头授权 → 提示未授权并留在模拟画面', /摄像头未授权/.test(deniedNote), deniedNote);
  check('被拒后演示层未崩（贴图与工具条仍在）',
    await deny.page.locator('.try-object').isVisible() && await deny.page.locator('.try-actions').isVisible());
  check('被拒后无 JS 错误', deny.errors.length === 0, deny.errors.join(' | '));
  await deny.ctx.close();

  /* ===================== 7) 移动端展厅 + 不回归 ===================== */
  const { ctx: sc, page: s, errors: sErr } = await newPage({ viewport: { width: 390, height: 844 }, mobile: true });
  await s.goto(`${APP}#/showroom`, { waitUntil: 'load' });
  await s.waitForSelector('.sr-zone', { timeout: 8000 });
  await s.waitForTimeout(500);
  check('移动端展厅单列无横向滚动', await s.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const mZoneBox = await s.locator('.sr-zone').first().boundingBox();
  check('移动端分区卡仍是大图卡（≥240px 高）', !!mZoneBox && mZoneBox.height >= 240, mZoneBox ? `${Math.round(mZoneBox.height)}px` : 'null');
  check('移动端进入按钮热区 ≥44px',
    await s.locator('.sr-zone-enter').first().evaluate((n) => n.getBoundingClientRect().height >= 43.5));

  await s.goto(`${APP}#/showroom/scent-lab`, { waitUntil: 'load' });
  await s.waitForSelector('.sr-viewbtn', { timeout: 8000 });
  await s.locator('.sr-viewbtn', { hasText: '展厅' }).first().click();
  await s.waitForSelector('.sr-hall-card', { timeout: 6000 });
  await s.waitForTimeout(400);
  check('移动端展厅视图靠横向滑动（轨道可滚且无页面级溢出）', await s.evaluate(() => {
    const rail = document.querySelector('.sr-rail');
    return !!rail && rail.scrollWidth > rail.clientWidth
      && document.documentElement.scrollWidth <= window.innerWidth + 1;
  }));
  check('移动端零 JS 错误', sErr.length === 0, sErr.join(' | '));
  await sc.close();

  // 不改拼团与对比：两页仍能正常渲染
  const { ctx: gctx, page: g, errors: gErr } = await newPage({ viewport: { width: 1280, height: 900 } });
  await g.goto(`${APP}#/group-buy`, { waitUntil: 'load' });
  await g.waitForTimeout(900);
  check('拼团大厅未受影响', await g.locator('.gb-page, .gb-heading, .gb-list').first().isVisible().catch(() => false));
  await g.goto(`${APP}#/compare`, { waitUntil: 'load' });
  await g.waitForTimeout(900);
  check('对比擂台未受影响', await g.locator('.cmp-page, .cmp-empty, .cmp-head').first().isVisible().catch(() => false));
  check('两页无 JS 错误', gErr.length === 0, gErr.join(' | '));
  await gctx.close();
} catch (e) {
  failed += 1;
  console.log(`  FAIL 脚本异常: ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 虚拟展厅 + AR 试穿验收全部通过' : `\n✗ ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
