// PDP 评价 / 问答真机验收：playwright-core + 系统 Edge 无头。
// 覆盖：评价区渲染、只看有图、写评价持久化、问答 mock 提交、
// AI 摘要卡不遮挡、刷新不丢、控制台零错误。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PORT = process.env.E2E_PORT || 4361;
const results = [];
const check = (label, ok, extra = '') => {
  results.push([label, ok]);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

const srv = spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  // 静态演示站 /api 探测 404 是已知网络噪音（无后端），非 JS 错误
  if (/Failed to load resource.*404/.test(t)) return;
  consoleErrors.push(t.slice(0, 120));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 120)}`));

const base = `http://127.0.0.1:${PORT}/index.html`;
const go = async (h, wait = 900) => {
  await page.goto(`${base}#${h}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};

try {
  /* 1) 详情页渲染：评价区 + 问答区 + AI 卡 */
  await go('/product/p017', 1600);
  check('评价区渲染（概览+分布条）', await page.locator('.pdp-review-overview').count() === 1
    && await page.locator('.pdp-dist-row').count() === 5);
  check('评价卡含用户名/星级/规格/时间', await page.locator('.review .rv-name').first().textContent() !== ''
    && await page.locator('.review .stars').first().count() >= 1
    && (await page.locator('.review').first().textContent()).includes('已购规格'));
  check('买家秀缩略图渲染', await page.locator('.pdp-review-thumb').count() >= 3);
  check('问答区渲染（内置 3 问）', await page.locator('.pdp-qa-item').count() === 3);
  check('AI 摘要卡渲染', await page.locator('.pdp-ai-summary').count() === 1);

  /* 2) 只看有图 */
  await page.locator('.pdp-review-filter', { hasText: '有图' }).click();
  await page.waitForTimeout(300);
  const picRows = await page.locator('.review').count();
  const allHaveImg = await page.locator('.review').evaluateAll(
    (nodes) => nodes.every((n) => n.querySelectorAll('.pdp-review-thumb').length >= 1),
  );
  check(`只看有图筛选生效（${picRows} 条全带图）`, picRows >= 2 && allHaveImg);
  await page.locator('.pdp-review-filter', { hasText: '全部' }).click();
  await page.waitForTimeout(300);

  /* 3) 写评价 → 列表更新 */
  await page.locator('.pdp-write-review').click();
  await page.locator('.pdp-form-star').nth(4).click();
  await page.locator('.pdp-form-textarea').fill('真机验收评价：屏幕通透，键盘手感扎实，值得推荐。');
  await page.locator('.pdp-form-submit').click();
  await page.waitForTimeout(700);
  const mineTag = await page.locator('.review.is-mine').count();
  check('提交后列表出现我的评价', mineTag >= 1);

  /* 4) 刷新不丢（localStorage / 服务端降级持久化） */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  const mineAfterReload = await page.locator('.review.is-mine').count();
  check('刷新后评价仍在', mineAfterReload >= 1);

  /* 5) 问答 mock 提交 */
  await page.locator('.pdp-qa-ask').click();
  await page.locator('.pdp-qa-input').fill('请问支持扩展内存吗？');
  await page.locator('.pdp-qa-submit').click();
  await page.waitForTimeout(1100);
  const qaMine = await page.locator('.pdp-qa-item.is-mine').count();
  check('提问后出现回答（官方客服）', qaMine === 1
    && (await page.locator('.pdp-qa-item.is-mine').first().textContent()).includes('官方客服'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  check('刷新后问答仍在', await page.locator('.pdp-qa-item.is-mine').count() === 1);

  /* 6) AI 卡不遮挡操作区：与加购按钮行无几何重叠（AI 卡在其下方同列排布） */
  const overlap = await page.evaluate(() => {
    const ai = document.querySelector('.pdp-ai-summary')?.getBoundingClientRect();
    const buy = document.querySelector('.pdp-primary-actions')?.getBoundingClientRect();
    if (!ai || !buy) return 'missing';
    return !(ai.right <= buy.left || buy.right <= ai.left || ai.bottom <= buy.top || buy.bottom <= ai.top);
  });
  check('AI 摘要卡不遮挡操作区', overlap === false, String(overlap));
  await page.locator('#pdp-reviews').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${ROOT}/.shots/pdp-reviews.png` });
  await page.locator('#pdp-qa').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${ROOT}/.shots/pdp-qa.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${ROOT}/.shots/pdp-ai.png` });

  /* 7) 移动端抽查 */
  await page.setViewportSize({ width: 390, height: 844 });
  await go('/product/p017', 1400);
  const qaH = await page.locator('.pdp-qa-item').first().evaluate((n) => n.getBoundingClientRect().width);
  check('移动端问答卡不溢出（390px）', qaH > 0 && qaH <= 391, `${qaH}px`);

  check('控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  srv.kill();
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
