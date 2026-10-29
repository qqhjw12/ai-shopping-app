// 收藏 / 最近浏览 / AI 导购 / 图片搜索 真机验收：playwright-core + 系统 Edge 无头。
// 覆盖：卡片与详情页收藏（刷新不丢）、收藏页取消与加购、按用户隔离、
// 最近浏览自动记录与清空、AI 抽屉 mock 推荐、图片搜索演示提示、
// 顶栏入口桌面/移动端可达、控制台零错误。
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const PORT = process.env.E2E_PORT || 4366;
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
  // 静态演示站 /api 探测 404 属已知网络噪音（没有后端），不是 JS 错误
  if (/Failed to load resource.*404/.test(t)) return;
  consoleErrors.push(t.slice(0, 140));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));

const base = `http://127.0.0.1:${PORT}/index.html`;
const go = async (h, wait = 1100) => {
  await page.goto(`${base}#${h}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};

// 1×1 PNG：用于图片搜索的真实文件选择（占位流程也要能吃到真文件）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

try {
  /* 1) 首页：收藏按钮铺满卡片、最近浏览为空、顶栏入口存在 */
  await go('/', 1500);
  const cardFavs = await page.locator('.pcard .card-fav').count();
  check(`商品卡都有收藏按钮（${cardFavs} 个）`, cardFavs >= 4);
  check('初始无最近浏览区', await page.locator('.recent-section').count() === 0);
  check('顶栏收藏入口可见', await page.locator('#fav-btn').isVisible());
  check('顶栏 AI 导购 / 图片搜索入口可见',
    await page.locator('#ai-guide-btn').isVisible() && await page.locator('#img-search-btn').isVisible());

  /* 2) 卡片收藏 → 刷新不丢 */
  const firstFav = page.locator('.pcard .card-fav').first();
  await firstFav.click();
  await page.waitForTimeout(320);
  const pressedAfterClick = await firstFav.getAttribute('aria-pressed');
  const badgeAfterClick = (await page.locator('#fav-count').textContent()).trim();
  check('卡片收藏按钮进入选中态', pressedAfterClick === 'true');
  check('顶栏收藏角标 +1', badgeAfterClick === '1', badgeAfterClick);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1300);
  const badgeAfterReload = (await page.locator('#fav-count').textContent()).trim();
  const activeAfterReload = await page.locator('.pcard .card-fav.is-active').count();
  check('刷新后收藏仍在（角标）', badgeAfterReload === '1', badgeAfterReload);
  check('刷新后收藏按钮仍为选中态', activeAfterReload === 1, String(activeAfterReload));

  /* 3) 详情页收藏：状态与卡片联动 */
  await go('/product/p017', 1500);
  const pdpFav = page.locator('.pdp-fav').first();
  const beforePdp = await pdpFav.getAttribute('aria-pressed');
  await pdpFav.click();
  await page.waitForTimeout(320);
  const afterPdp = await pdpFav.getAttribute('aria-pressed');
  check('详情页收藏可切换', beforePdp !== afterPdp, `${beforePdp} → ${afterPdp}`);
  // 收敛到「已收藏」：后面几步需要有至少一件收藏可操作
  if (afterPdp !== 'true') {
    await pdpFav.click();
    await page.waitForTimeout(300);
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const keptPdp = await page.locator('.pdp-fav').first().getAttribute('aria-pressed');
  check('详情页收藏刷新不丢', keptPdp === 'true', String(keptPdp));

  /* 3b) 再收一件，保证至少两条收藏，才能验证「取消一件后列表仍有内容」 */
  await go('/products', 1700);
  const activeOnList = await page.locator('.pcard .card-fav.is-active').count();
  if (activeOnList < 2) {
    const spare = page.locator('.pcard .card-fav:not(.is-active)').first();
    await spare.click();
    await page.waitForTimeout(320);
  }

  /* 4) 收藏页：列表 / 取消收藏 / 加入购物袋 */
  await go('/favorites', 1400);
  const favCards = await page.locator('.fav-page .pcard').count();
  const favWord = (await page.locator('.fav-count-word').textContent()).trim();
  check(`收藏页渲染卡片（${favCards} 张）`, favCards >= 2);
  check('收藏页条数与卡片一致', favWord.includes(String(favCards)), favWord);
  check('收藏页包含刚在详情页收藏的商品', await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('maison_favorites_v2') || '{}');
    const key = Object.keys(all).find((k) => k.startsWith('l:')) || Object.keys(all)[0] || '';
    return (all[key] || []).some((i) => String(i.id) === 'p017');
  }));

  const cartBefore = Number((await page.locator('#cart-count').textContent()).trim() || 0);
  await page.locator('.fav-page .pcard .actions button:not(.ghost)').first().click();
  await page.waitForTimeout(400);
  const cartAfter = Number((await page.locator('#cart-count').textContent()).trim() || 0);
  check('收藏页可加入购物袋', cartAfter > cartBefore, `${cartBefore} → ${cartAfter}`);

  await page.locator('.fav-page .pcard .card-fav').first().click();
  await page.waitForTimeout(420);
  const favCardsAfter = await page.locator('.fav-page .pcard').count();
  check('收藏页取消收藏即时移除', favCardsAfter === favCards - 1, `${favCards} → ${favCardsAfter}`);
  const badgeAfterRemove = (await page.locator('#fav-count').textContent()).trim();
  check('取消后顶栏角标同步', badgeAfterRemove === String(favCards - 1), badgeAfterRemove);

  /* 5) 用户隔离：换一个本地身份 → 收藏不可见（切回后恢复） */
  // 直接 goto 同一个 hash 不会重新渲染，必须 reload 才能真正读到新作用域
  const originalUid = await page.evaluate(() => localStorage.getItem('maison_local_uid'));
  await page.evaluate(() => localStorage.setItem('maison_local_uid', 'l_isolation_probe'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1300);
  check('换用户后收藏按账号隔离（为空）', await page.locator('.fav-page .pcard').count() === 0);
  await page.evaluate((uid) => localStorage.setItem('maison_local_uid', uid), originalUid);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1300);
  check('切回原用户收藏恢复', await page.locator('.fav-page .pcard').count() === favCardsAfter);

  /* 6) 最近浏览：自动记录 → 首页轨道 → 清空 */
  await go('/product/p033', 1500);
  await go('/product/p017', 1500);
  await go('/', 1500);
  const railItems = await page.locator('.recent-rail .recent-card').count();
  check(`首页最近浏览轨道自动记录（${railItems} 个）`, railItems >= 2);
  const railFirstHref = await page.locator('.recent-rail .recent-card').first().getAttribute('href');
  check('最近浏览最新的排在最前', String(railFirstHref).includes('p017'), String(railFirstHref));
  const railOverflow = await page.locator('.recent-rail').evaluate((n) => getComputedStyle(n).overflowX);
  check('最近浏览为横向滚动容器', railOverflow === 'auto' || railOverflow === 'scroll', railOverflow);
  await page.screenshot({ path: `${ROOT}/.shots/recent-home.png` });

  await page.locator('.recent-clear').click();
  await page.waitForTimeout(360);
  check('清空后轨道消失', await page.locator('.recent-section').count() === 0);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1300);
  check('清空后刷新不复活', await page.locator('.recent-section').count() === 0);

  /* 7) AI 导购抽屉：打开 → 演示提示 → mock 推荐卡 */
  await page.locator('#ai-guide-btn').click();
  await page.waitForTimeout(420);
  const drawerOpen = await page.locator('.guide-drawer:not(.hidden)').count() === 1;
  check('AI 抽屉可打开', drawerOpen);
  const demoText = (await page.locator('.gd-demo').textContent()).trim();
  check('抽屉标注演示数据', demoText.includes('演示数据'), demoText);
  const glow = await page.locator('.gd-glow').evaluate((n) => getComputedStyle(n).backgroundImage);
  check('抽屉顶部微光存在', /gradient/.test(glow), glow.slice(0, 40));
  const glass = await page.locator('.guide-drawer').evaluate((n) => getComputedStyle(n).backdropFilter);
  check('抽屉为玻璃背景', /blur/.test(glass), glass);

  await page.locator('#gd-input').fill('预算 1000 元以内的通勤礼物');
  await page.locator('#gd-input').press('Enter');
  await page.waitForTimeout(2200);
  const recCards = await page.locator('.gd-answer .gd-cards .pcard').count();
  const recNote = await page.locator('.gd-answer .gd-note').last().textContent();
  check(`AI 抽屉返回 mock 推荐卡（${recCards} 张）`, recCards >= 1);
  check('推荐卡带演示说明', /演示数据/.test(recNote || ''), String(recNote).slice(0, 40));
  const recPrice = await page.locator('.gd-answer .gd-cards .price').first().textContent();
  check('推荐卡复用商品卡样式（含价格）', /¥/.test(recPrice || ''), String(recPrice));
  await page.screenshot({ path: `${ROOT}/.shots/ai-drawer.png` });

  /* 8) 抽屉里的推荐卡可收藏（卡片组件复用即生效） */
  const recFav = page.locator('.gd-answer .gd-cards .card-fav').first();
  await recFav.click();
  await page.waitForTimeout(300);
  check('抽屉推荐卡可收藏', await recFav.getAttribute('aria-pressed') === 'true');
  await page.locator('.gd-close').click();
  await page.waitForTimeout(320);
  check('AI 抽屉可关闭', await page.locator('.guide-drawer:not(.hidden)').count() === 0);

  /* 9) 图片搜索：上传交互 + 演示提示 + 模拟结果 */
  await page.locator('#img-search-btn').click();
  await page.waitForTimeout(420);
  const imgDemo = (await page.locator('.img-demo').textContent()).trim();
  check('图片搜索标注演示功能', imgDemo.includes('演示') && imgDemo.includes('不'), imgDemo.slice(0, 40));
  await page.locator('#img-search-file').setInputFiles({ name: 'knit.png', mimeType: 'image/png', buffer: PNG_1PX });
  await page.waitForTimeout(2200);
  const imgCards = await page.locator('.img-result-grid .pcard').count();
  const imgNote = (await page.locator('.img-result-note').textContent()) || '';
  check(`上传后返回模拟结果（${imgCards} 张）`, imgCards >= 1);
  check('模拟结果带演示说明', imgNote.includes('演示结果') && imgNote.includes('未做真实图像识别'), imgNote.slice(0, 40));
  check('上传后有预览图', await page.locator('.img-preview-img').count() === 1);
  await page.screenshot({ path: `${ROOT}/.shots/img-search.png` });
  await page.locator('.img-search-modal .modal-close').click();
  await page.waitForTimeout(300);

  /* 10) 洞察页命名与 AI 工坊区分 */
  await go('/analytics', 1400);
  const h1 = (await page.locator('.page-display').first().textContent()).trim();
  const intro = (await page.locator('.page-intro-copy p').first().textContent()).trim();
  check('洞察页标题明确为「选购洞察」', h1.includes('选购洞察'), h1);
  check('洞察页说明点明「分析报告」并与 AI 工坊区分', intro.includes('分析报告') && intro.includes('AI 工坊'), intro);
  const navText = (await page.locator('.nav a[data-nav="analytics"]').textContent()).trim();
  check('导航文案为选购洞察', navText.includes('选购洞察'), navText);

  /* 11) 移动端：入口可达且不挡主操作 */
  await page.setViewportSize({ width: 390, height: 844 });
  await go('/', 1600);
  const favBox = await page.locator('#fav-btn').boundingBox();
  const cartBox = await page.locator('#cart-btn').boundingBox();
  const searchBox = await page.locator('.search').boundingBox();
  check('移动端收藏入口可见', Boolean(favBox && favBox.width > 30));
  check('收藏按钮不与购物袋重叠',
    Boolean(favBox && cartBox) && favBox.x + favBox.width <= cartBox.x + 1,
    `${JSON.stringify(favBox)} / ${JSON.stringify(cartBox)}`);
  check('工具按钮不压住搜索框',
    Boolean(favBox && searchBox) && favBox.y + favBox.height <= searchBox.y + 1,
    `${JSON.stringify(favBox)} / ${JSON.stringify(searchBox)}`);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('移动端无横向溢出', noHScroll);
  await page.locator('#fav-btn').click();
  await page.waitForTimeout(1200);
  check('移动端可进入收藏页', page.url().includes('/favorites'));
  await page.screenshot({ path: `${ROOT}/.shots/mobile-favorites.png` });

  await go('/', 1500);
  await page.locator('#ai-guide-btn').click();
  await page.waitForTimeout(500);
  const drawerBox = await page.locator('.guide-drawer').boundingBox();
  check('移动端抽屉占满宽度', Boolean(drawerBox) && drawerBox.width >= 380, JSON.stringify(drawerBox));
  await page.screenshot({ path: `${ROOT}/.shots/mobile-ai-drawer.png` });
  await page.locator('.gd-close').click();

  check('控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  srv.kill();
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length ? 1 : 0);
