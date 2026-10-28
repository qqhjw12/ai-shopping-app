#!/usr/bin/env node
/**
 * 检索 / 筛选 / 排序真实浏览器验收（playwright-core + 本机 Edge，无头）。
 *
 * 为什么必须跑真机：DOM 垫片能证明「结构存在、纯函数正确」，但证明不了
 *   - 顶部搜索栏是不是真的 48px 胶囊、聚焦时有没有金色光晕
 *   - 点筛选后 URL 是否真的写回 hash、刷新/新标签页是否还原同一屏
 *   - 移动端是不是弹层（而不是把侧栏横向压扁）
 *   - 结果网格是否被新控件挤坏
 *
 * 用法：node scripts/e2e-search.mjs [--port 4321] [--headed]
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
const PORT = Number((args[args.indexOf('--port') + 1] || '').match(/^\d+$/) ? args[args.indexOf('--port') + 1] : 4321);
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
const results = [];
function check(label, ok, extra = '') {
  results.push({ label, ok });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const server = spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], {
  stdio: 'ignore',
});

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitForServer(`${BASE}/index.html`))) throw new Error('静态服务器没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  const hash = () => page.evaluate(() => location.hash);
  const go = async (h) => {
    await page.goto(`${BASE}/index.html${h}`, { waitUntil: 'load' });
    await page.waitForTimeout(320);
  };
  const countText = async () => (await page.locator('.result-count').textContent()) || '';
  const countNum = async () => {
    const m = /共 (\d+) 件商品/.exec(await countText());
    return m ? Number(m[1]) : -1;
  };
  const activeTags = () => page.locator('.flt-tag').count();
  const chipByText = (text) => page.locator('.flt-chip').filter({ hasText: text }).first();

  console.log('\n检索 / 筛选 / 排序 e2e');

  /* 1) 顶部搜索栏：48px 胶囊 + 聚焦金色光晕 */
  await go('#/products');
  await page.waitForSelector('.pcard', { timeout: 10000 });
  const searchBox = await page.locator('.search').boundingBox();
  check('搜索栏是 48px 胶囊', Math.round(searchBox.height) === 48, `${Math.round(searchBox.width)}×${Math.round(searchBox.height)}`);
  const radius = await page.locator('.search').evaluate((n) => getComputedStyle(n).borderRadius);
  check('搜索栏为胶囊圆角', /999|px/.test(radius) && parseFloat(radius) >= 20, radius);
  await page.locator('#search-input').focus();
  await page.waitForTimeout(260);
  const glow = await page.locator('.search').evaluate((n) => getComputedStyle(n).boxShadow);
  check('聚焦时外圈有柔和金色光晕', /200,\s*169,\s*110/.test(glow), glow.slice(0, 64));

  /* 2) 搜索出结果 + URL 带 q */
  const totalAll = await countNum();
  await page.locator('#search-input').fill('耳机');
  await page.locator('#search-input').press('Enter');
  await page.waitForTimeout(600);
  const searchHash = await hash();
  const searchCount = await countNum();
  check('搜索词写入 hash', decodeURIComponent(searchHash).includes('q=耳机'), searchHash);
  check('搜索返回结果', searchCount > 0 && searchCount < totalAll, `${searchCount} / 全站 ${totalAll}`);
  check('搜索结果有商品卡片', (await page.locator('.pcard').count()) > 0);
  check('搜索栏回填关键词', (await page.locator('#search-input').inputValue()) === '耳机');

  /* 3) 无结果空态 + 恢复 */
  await page.locator('#search-input').fill('压根不存在的关键词XYZ');
  await page.locator('#search-input').press('Enter');
  await page.waitForTimeout(500);
  check('无结果显示安静空态', (await page.locator('.empty-editorial').count()) === 1);
  check('无结果提示可清空条件', /换个关键词|清空筛选/.test((await page.locator('.empty-editorial').textContent()) || ''));
  await page.locator('.empty-editorial .btn-primary').click();
  await page.waitForTimeout(500);
  check('空态可回到热门搜索', (await page.locator('.hot-word').count()) >= 6, `${await page.locator('.hot-word').count()} 个热门词`);

  /* 4) 空关键词热门搜索：点一个词就能搜到 */
  await go('#/search');
  const hotWords = await page.locator('.hot-word').count();
  check('空关键词显示热门搜索占位', hotWords >= 6, `${hotWords} 个`);
  await page.locator('.hot-word').first().click();
  await page.waitForTimeout(500);
  check('热门词可点出结果', (await countNum()) > 0, await countText());

  /* 5) 筛选：品类多选 */
  await go('#/products');
  await page.waitForSelector('.flt-chip', { timeout: 8000 });
  await chipByText('手机数码').click();
  await page.waitForTimeout(320);
  const phoneCount = await countNum();
  const phoneHash = await hash();
  check('筛选写回 hash（cat）', /cat=phone/.test(phoneHash), phoneHash);
  check('品类筛选收窄结果', phoneCount > 0 && phoneCount < totalAll, `${phoneCount}`);
  await chipByText('音频耳机').click();
  await page.waitForTimeout(320);
  const multiHash = await hash();
  const multiCount = await countNum();
  check('同维度多选（OR）生效', /cat=phone(%2C|,)audio/.test(multiHash) && multiCount > phoneCount, `${multiCount} · ${multiHash}`);
  check('已选条件出现 2 个标签', (await activeTags()) === 2, String(await activeTags()));

  /* 6) 价格 + 属性 + 库存 组合收窄 */
  await chipByText('¥1000–3000').click();
  await page.waitForTimeout(300);
  const priceCount = await countNum();
  check('价格区间继续收窄', priceCount > 0 && priceCount <= multiCount, `${priceCount}`);
  const colorChip = page.locator('.flt-chip').filter({ hasText: /^灰色|黑色|白色|蓝色/ }).first();
  const hasColorChip = (await colorChip.count()) > 0;
  if (hasColorChip) {
    await colorChip.click();
    await page.waitForTimeout(300);
    check('属性（颜色）筛选生效', (await countNum()) <= priceCount, `${await countNum()}`);
  } else {
    check('属性（颜色）筛选生效', false, '面板里没找到颜色胶囊');
  }
  await chipByText('仅看有货').click();
  await page.waitForTimeout(300);
  const comboHash = await hash();
  check('组合条件全部写进 URL', /cat=/.test(comboHash) && /price=/.test(comboHash) && /color=/.test(comboHash) && /stock=1/.test(comboHash), comboHash);
  const comboTags = await activeTags();
  check('已选标签数 = 条件数', comboTags === 5, String(comboTags));

  /* 7) 刷新后条件与结果保持 */
  const beforeReload = { hash: comboHash, n: await countNum(), tags: comboTags };
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  check('刷新后 URL 不变', (await hash()) === beforeReload.hash, await hash());
  check('刷新后结果数一致', (await countNum()) === beforeReload.n, `${await countNum()} vs ${beforeReload.n}`);
  check('刷新后已选标签还在', (await activeTags()) === beforeReload.tags, String(await activeTags()));

  /* 8) 排序：价格升序 + 销量 + 上新 */
  await page.locator('.sort-select').selectOption('price_asc');
  await page.waitForTimeout(500);
  const prices = async () => (await page.locator('.pcard .price').allTextContents()).map((t) => Number(String(t).replace(/[^\d.]/g, '')));
  const asc = await prices();
  const ascOk = asc.length > 1 && asc.every((v, i) => i === 0 || asc[i - 1] <= v);
  check('价格升序生效', ascOk, asc.slice(0, 3).join(' < '));
  check('排序写回 hash', /sort=price_asc/.test(await hash()), await hash());
  await page.locator('.sort-select').selectOption('price_desc');
  await page.waitForTimeout(500);
  const desc = await prices();
  check('价格降序生效', desc.length > 1 && desc.every((v, i) => i === 0 || desc[i - 1] >= v), desc.slice(0, 3).join(' > '));
  await page.locator('.sort-select').selectOption('sales');
  await page.waitForTimeout(500);
  check('销量排序可切换', /sort=sales/.test(await hash()), await hash());
  await page.locator('.sort-select').selectOption('new');
  await page.waitForTimeout(500);
  check('上新排序可切换', /sort=new/.test(await hash()), await hash());
  check('排序下拉共 5 项', (await page.locator('.sort-select option').count()) === 5);

  /* 9) 深链分享：全新上下文打开同一 URL → 同一屏 */
  const shareUrl = `${BASE}/index.html${await hash()}`;
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page2 = await ctx2.newPage();
  await page2.goto(shareUrl, { waitUntil: 'load' });
  await page2.waitForTimeout(900);
  const sharedCount = /共 (\d+) 件商品/.exec((await page2.locator('.result-count').textContent()) || '');
  check('分享链接还原条件', (await page2.locator('.flt-tag').count()) === 5, String(await page2.locator('.flt-tag').count()));
  check('分享链接还原结果', sharedCount && Number(sharedCount[1]) === beforeReload.n, sharedCount ? sharedCount[0] : 'n/a');
  await ctx2.close();

  /* 10) 清空全部（排序不算条件，保留是预期行为） */
  await page.locator('.flt-clear-all').click();
  await page.waitForTimeout(400);
  check('清空全部后筛选条件归零', !/[?&](cat|price|color|stock)=/.test(await hash()), await hash());
  check('清空全部后结果回到全站', (await countNum()) === totalAll, `${await countNum()} / ${totalAll}`);

  /* 11) 分类页：价格区间 + 排序 */
  await go('#/categories');
  await page.waitForSelector('.cat-tools', { timeout: 8000 });
  const catCardsAll = await page.locator('.cat-card').count();
  check('分类页有筛选排序栏', (await page.locator('.cat-tools').count()) === 1);
  await chipByText('¥1000–3000').click();
  await page.waitForTimeout(400);
  const catCardsBand = await page.locator('.cat-card').count();
  check('分类页价格区间生效', catCardsBand > 0 && catCardsBand <= catCardsAll, `${catCardsBand} / ${catCardsAll}`);
  check('分类页条件写回 hash', /price=p1000_3000/.test(await hash()), await hash());
  await page.locator('.sort-select').selectOption('count');
  await page.waitForTimeout(300);
  check('分类页排序写回 hash', /sort=count/.test(await hash()), await hash());
  await page.locator('.cat-card').first().click();
  await page.waitForTimeout(700);
  const intoList = await hash();
  check('进类目带上价格条件', /\/products\?cat=/.test(intoList) && /price=p1000_3000/.test(intoList), intoList);
  check('列表页认这条价格条件', (await activeTags()) >= 1, String(await activeTags()));

  /* 12) 商品卡布局没被挤坏 */
  const cardBox = await page.locator('.pcard').first().boundingBox();
  const gridCols = await page.locator('.grid').first().evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  check('桌面端网格仍为多列', gridCols >= 2, `${gridCols} 列`);
  check('商品卡宽度正常', cardBox.width > 150, `${Math.round(cardBox.width)}px`);

  /* 13) 移动端：筛选走底部弹层，不横向挤压 */
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#/products');
  await page.waitForSelector('.flt-open', { timeout: 8000 });
  const asideVisible = await page.locator('.shop-filter').isVisible();
  const openVisible = await page.locator('.flt-open').isVisible();
  check('移动端隐藏侧栏筛选', !asideVisible);
  check('移动端出现「筛选」按钮', openVisible);
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('移动端无横向溢出', noOverflow, await page.evaluate(() => `${document.documentElement.scrollWidth}/${window.innerWidth}`));
  await page.locator('.flt-open').click();
  await page.waitForTimeout(420);
  const sheetOpen = await page.locator('.flt-sheet').evaluate((n) => n.classList.contains('is-open'));
  check('筛选弹层打开', sheetOpen);
  const panelInSheet = await page.locator('.flt-sheet .flt-panel').isVisible();
  check('筛选面板移入弹层', panelInSheet);
  const sheetBox = await page.locator('.flt-sheet-body').boundingBox();
  check('弹层贴底且未横向撑破', sheetBox && Math.round(sheetBox.width) <= 391 && sheetBox.y > 100, sheetBox ? `${Math.round(sheetBox.width)}×${Math.round(sheetBox.height)}` : 'n/a');
  const beforeMobileCount = await page.locator('.flt-sheet-count').textContent();
  await page.locator('.flt-sheet .flt-chip').filter({ hasText: '手机数码' }).first().click();
  await page.waitForTimeout(360);
  check('弹层内筛选即时生效', (await page.locator('.flt-sheet-count').textContent()) !== beforeMobileCount, `${beforeMobileCount} → ${await page.locator('.flt-sheet-count').textContent()}`);
  check('筛选后弹层仍开着', await page.locator('.flt-sheet').evaluate((n) => n.classList.contains('is-open')));
  await page.locator('.flt-sheet-apply').click();
  await page.waitForTimeout(320);
  check('点「查看 N 件」收起弹层', !(await page.locator('.flt-sheet').evaluate((n) => n.classList.contains('is-open'))));
  const mobileCols = await page.locator('.grid').first().evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  check('移动端网格自适应', mobileCols >= 1, `${mobileCols} 列`);

  /* 14) 控制台 */
  const jsErrors = consoleErrors.filter((t) => !/Failed to load resource/i.test(t));
  const net404 = consoleErrors.filter((t) => /Failed to load resource/i.test(t)).length;
  check('控制台无 JS 错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  console.log(`  info 静态演示站的 /api 探测 404 日志：${net404} 条（非 JS 错误）`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed}/${results.length} 项通过`);
} catch (e) {
  failed += 1;
  console.log(`\n✗ e2e 异常: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
}
process.exit(failed === 0 ? 0 : 1);
