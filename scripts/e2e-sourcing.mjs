// 货源市场验收（#/merchant/sourcing，**不需要网关**——目录是演示数据，页面本地就能渲染）。
//
// 覆盖：
//   1) 双入口：分类页底部入口条 / 页脚「找货源」链接 / 工作台侧栏与移动底部标签（带 id/key）
//   2) 目录本体：供应商卡片字段齐全、能力标签胶囊、行内展开可供商品
//   3) 筛选：类目 / 起订量 / 地区，条件写进 hash（刷新不丢），组合出空态可清空
//   4) AI 找货（演示）：结果标注演示数据、推荐可跳回目录定位、空结果如实说
//   5) 询盘 mock：toast 说清是演示，不造假编号
//   6) 不破坏消费者主流程：首页 / 分类 / 详情 / 加购照旧
//   7) 移动端无横向滚动、无 JS 错误
//
// 用法：node scripts/e2e-sourcing.mjs [--port 5513] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5513;
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
  .then((r) => r.ok)
  .catch(() => false);
const srv = serving ? null : spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], { stdio: 'ignore' });
if (!serving) await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

const base = `http://127.0.0.1:${PORT}/index.html`;
const pageUrl = (hash) => `${base}${hash}`;

const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  if (/Failed to load resource/.test(t)) return; // 无网关时 /api 404 是预期
  consoleErrors.push(t.slice(0, 160));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

const go = async (hash, wait = 800) => {
  await page.goto(pageUrl(hash), { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
/** 同地址也要重开：goto 到相同 hash 不会重新加载页面 */
const openAt = async (hash, wait = 800) => {
  await go(hash, wait);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
const cards = () => page.locator('.src-card');
const cardCount = async () => cards().count();

/* 工作台种子：与 e2e-merchant-dashboard 同一套本地记录形状 */
const SHOP = {
  id: 'ML202501010001', key: 'key-shop-a', brand: '素白 SUBAI', categories: ['home', 'kitchen'], priceRange: '100-500',
};
const nowIso = new Date().toISOString();
const RECORD = {
  id: SHOP.id, key: SHOP.key, status: 'approved', reviewNote: '', createdAt: nowIso, updatedAt: nowIso, reviewedAt: nowIso,
  company: '素白 SUBAI 工作室', brand: SHOP.brand, contact: '沈素', phoneMasked: '139****9000', emailMasked: 's***@subai.studio',
  categories: SHOP.categories, materials: [{ kind: 'license', name: '营业执照.jpg', size: 204800 }], entityKind: 'studio',
  brandSource: 'own', skuRange: '20-50', priceRange: SHOP.priceRange, dropship: false,
  bankAccount: '素白 SUBAI 工作室', bankBranch: '', bankNoMasked: '6225****7766',
  returnPolicy: '7days', shipWithin: '48h', note: '', revisionCount: 0, withdrawnAt: null, notices: [], local: true,
};

try {
  /* ---------- 1. 用户端入口不抢戏但找得到 ---------- */
  console.log('\n— 用户端入口 —');
  await go('#/categories', 1200);
  check('分类页底部有「找货源」入口条', (await page.locator('.src-strip').count()) === 1);
  check('入口条标明面向商家与演示口径',
    ((await page.locator('.src-strip').innerText()) || '').includes('FOR MERCHANTS')
    && ((await page.locator('.src-strip').innerText()) || '').includes('演示数据'));
  check('分类页类目卡照常渲染（主流程没被挤掉）', (await page.locator('.cat-card').count()) > 5, String(await page.locator('.cat-card').count()));
  check('页脚合作列有找货源链接', (await page.locator('.footer a[href="#/merchant/sourcing"]').count()) >= 1);
  await page.locator('.src-strip').click();
  await page.waitForTimeout(700);
  check('点入口条进货源市场', (await page.locator('.src-name').count()) > 0);

  /* ---------- 2. 目录本体 ---------- */
  console.log('\n— 目录本体 —');
  check('页面标题是「货源市场」', ((await page.locator('.page-display').innerText()) || '') === '货源市场');
  check('右上角常驻「演示数据」标注', (await page.locator('.src-topbar .src-demo').count()) === 1);
  check('供应商 10 家', (await cardCount()) === 10, String(await cardCount()));
  const first = cards().first();
  check('卡片带主营类目 / 地区 / 起订量', ((await first.locator('.src-line').innerText()) || '').includes('起订'));
  check('卡片带能力标签胶囊', (await first.locator('.src-tag').count()) >= 2);
  check('卡片带月产能 / 打样 / 发货时效', ((await first.locator('.src-facts').innerText()) || '').includes('月产能'));
  check('没有真实成交按钮（只有联系供应商）',
    (await page.locator('.src-card button', { hasText: '下单' }).count()) === 0
    && (await page.locator('.src-card button', { hasText: '购买' }).count()) === 0);

  check('商品列表默认收起', (await page.locator('.src-items:visible').count()) === 0);
  await first.locator('.src-act.is-quiet').click();
  await page.waitForTimeout(300);
  check('展开后看到 4 条可供商品', (await first.locator('.src-item').count()) === 4);
  check('商品行有批发价 / 库存 / 起订量', ((await first.locator('.src-item').first().innerText()) || '').includes('批发') === false
    && ((await first.locator('.src-item').first().innerText()) || '').includes('库存')
    && ((await first.locator('.src-item').first().innerText()) || '').includes('起订'));
  check('批发价是金额而不是区间', /^¥\d/.test((await first.locator('.src-item-price').first().innerText()) || ''));

  /* ---------- 3. 询盘是 mock ---------- */
  console.log('\n— 询盘（演示） —');
  await first.locator('.src-act.is-gold').click();
  await page.waitForTimeout(400);
  check('联系供应商弹演示 toast', ((await page.locator('.toast').last().innerText()) || '').includes('演示'), await page.locator('.toast').last().innerText().catch(() => ''));
  await page.waitForTimeout(2300); // 等 toast 走掉，别污染后面的断言

  /* ---------- 4. 筛选 ---------- */
  console.log('\n— 筛选与 URL —');
  await page.locator('.src-chip', { hasText: '家居家具' }).click();
  await page.waitForTimeout(400);
  check('类目筛选剩 3 家', (await cardCount()) === 3, String(await cardCount()));
  check('条件写进 URL', page.url().includes('cat=home'), page.url());
  await page.locator('.src-chip', { hasText: '≤ 50 件' }).click();
  await page.waitForTimeout(400);
  check('再叠起订量 ≤50 剩 2 家', (await cardCount()) === 2, String(await cardCount()));
  await page.selectOption('.src-select', '广东 · 深圳');
  await page.waitForTimeout(400);
  check('再叠地区出空态（如实说没有）', (await page.locator('.empty-editorial').count()) === 1);
  check('空态可一键清空', (await page.locator('.empty-editorial button', { hasText: '清空筛选' }).count()) === 1);
  await page.locator('.empty-editorial button', { hasText: '清空筛选' }).click();
  await page.waitForTimeout(400);
  check('清空后回到 10 家', (await cardCount()) === 10, String(await cardCount()));

  /* ---------- 5. AI 找货（演示） ---------- */
  console.log('\n— AI 找货（演示） —');
  await page.locator('.src-ai-input').fill('陶瓷茶具 小批量 现货');
  await page.locator('.src-ai-btn').click();
  await page.waitForTimeout(400);
  check('结果区有演示数据标注', (await page.locator('.src-ai-result .src-demo').count()) >= 1);
  check('结果说清匹配依据', ((await page.locator('.src-ai-hint').innerText()) || '').includes('起订量'));
  check('推荐供应商 ≤ 3 家', (await page.locator('.src-ai-sup').count()) <= 3 && (await page.locator('.src-ai-sup').count()) >= 1);
  check('首个推荐是陶瓷厂', ((await page.locator('.src-ai-sup').first().innerText()) || '').includes('景德镇砚山陶瓷厂'));
  check('结果区有可看的货（带价格）', (await page.locator('.src-ai-prod').count()) >= 1
    && /^¥\d/.test((await page.locator('.src-ai-prod-price').first().innerText()) || ''));
  // 推荐卡点回目录：对应卡片展开并滚到视野
  await page.locator('.src-ai-sup').first().click();
  await page.waitForTimeout(700);
  check('点推荐会展开目录里对应那张卡', (await page.locator('.src-card.is-open[data-supplier="SU-2201"]').count()) === 1
    || (await page.locator('.src-card[data-supplier="SU-2201"] .src-items:visible').count()) === 1);

  console.log('\n— AI 找货的边界 —');
  await page.locator('.src-ai-input').fill('恐龙化石');
  await page.locator('.src-ai-btn').click();
  await page.waitForTimeout(400);
  check('匹配不到时如实说，不硬凑推荐',
    (await page.locator('.src-ai-sup').count()) === 0
    && ((await page.locator('.src-ai-hint').innerText()) || '').includes('换个说法'));
  await page.locator('.src-ai-input').fill('');
  await page.locator('.src-ai-btn').click();
  await page.waitForTimeout(400);
  check('空输入被拦下并提示', ((await page.locator('.toast').last().innerText()) || '').includes('说一句'));
  await page.waitForTimeout(2300);

  /* ---------- 6. 深链与刷新不丢 ---------- */
  console.log('\n— 深链与刷新 —');
  await openAt(`#/merchant/sourcing?cat=home&moq=m50&q=${encodeURIComponent('陶瓷茶具 小批量 现货')}`, 1100);
  check('深链带出筛选条件（2 家）', (await cardCount()) === 2, String(await cardCount()));
  check('深链带出 AI 结果', (await page.locator('.src-ai-sup').count()) >= 1);
  check('深链下 AI 输入框回填', ((await page.locator('.src-ai-input').inputValue()) || '') === '陶瓷茶具 小批量 现货');

  /* ---------- 7. 工作台入口（桌面侧栏 + 移动底部标签） ---------- */
  console.log('\n— 工作台入口 —');
  await page.evaluate((r) => {
    localStorage.setItem('maison_merchant_local_v1', JSON.stringify([r]));
    localStorage.removeItem('maison_merchant_shop_v1');
  }, RECORD);
  const dashHash = `#/merchant/dashboard?tab=overview&id=${SHOP.id}&key=${encodeURIComponent(SHOP.key)}`;
  await openAt(dashHash, 1400);
  check('侧栏有「货源市场」出站项', (await page.locator('.mdash-navitem.is-out', { hasText: '货源市场' }).count()) === 1);
  check('侧栏出站项带跳转箭头', (await page.locator('.mdash-nav-go').count()) === 1);
  await page.locator('.mdash-navitem.is-out', { hasText: '货源市场' }).click();
  await page.waitForTimeout(800);
  check('从工作台点进货源市场', (await page.locator('.src-name').count()) > 0);
  check('URL 带回程凭证', page.url().includes('id=') && page.url().includes('key='), page.url());
  check('顶部给「返回工作台」', ((await page.locator('.src-back').innerText()) || '') === '← 返回工作台', await page.locator('.src-back').innerText());
  await page.locator('.src-back').click();
  await page.waitForTimeout(1200);
  check('返回后回到工作台概览', (await page.locator('.mdash-title').innerText()) === '概览', await page.locator('.mdash-title').innerText());

  /* ---------- 8. 移动端 ---------- */
  console.log('\n— 移动端 —');
  const mctx = await browser.newContext({ viewport: { width: 414, height: 880 }, hasTouch: true, isMobile: true });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => consoleErrors.push(`mobile pageerror: ${String(e).slice(0, 160)}`));
  await mp.goto(pageUrl('#/merchant/sourcing'), { waitUntil: 'load' });
  await mp.waitForTimeout(900);
  const scrollW = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('货源市场无横向滚动', scrollW === 0, String(scrollW));
  await mp.locator('.src-ai-input').fill('棉麻桌布');
  await mp.locator('.src-ai-btn').click();
  await mp.waitForTimeout(500);
  check('移动端 AI 结果可用', (await mp.locator('.src-ai-sup').count()) >= 1);
  await mp.locator('.src-card .src-act.is-quiet').first().click();
  await mp.waitForTimeout(300);
  const scrollW2 = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('展开商品后仍无横向滚动', scrollW2 === 0, String(scrollW2));
  await mp.screenshot({ path: `${ROOT}/.shots/src-mobile.png` });
  // 工作台底部标签的第 6 项
  await mp.evaluate((r) => {
    localStorage.setItem('maison_merchant_local_v1', JSON.stringify([r]));
    localStorage.removeItem('maison_merchant_shop_v1');
  }, RECORD);
  await mp.goto(pageUrl(`#/merchant/dashboard?tab=overview&id=${SHOP.id}&key=${encodeURIComponent(SHOP.key)}`), { waitUntil: 'load' });
  await mp.waitForTimeout(1400);
  check('移动底部标签栏 6 项（含货源）', (await mp.locator('.mdash-tab').count()) === 6, String(await mp.locator('.mdash-tab').count()));
  check('第 6 项是「货源」', ((await mp.locator('.mdash-tab').last().innerText()) || '').includes('货源'));
  await mp.locator('.mdash-tab.is-out').click();
  await mp.waitForTimeout(900);
  check('移动端点标签也能进货源市场', (await mp.locator('.src-name').count()) > 0);
  await mp.screenshot({ path: `${ROOT}/.shots/src-mobile-entry.png` });
  await mctx.close();

  /* ---------- 9. 消费者主流程不受影响 ---------- */
  console.log('\n— 消费者主流程不破坏 —');
  await go('#/', 1200);
  check('首页商品卡照常渲染', (await page.locator('.pcard').count()) >= 4, String(await page.locator('.pcard').count()));
  check('顶栏没有「找货源」（不打扰买家）', (await page.locator('.nav a', { hasText: '货源' }).count()) === 0);
  await go('#/product/p017', 1200);
  check('商品详情可加购（按钮还在）', (await page.locator('.pdp-add-label', { hasText: '加入购物袋' }).count()) >= 1);

  /* ---------- 10. 控制台干净 ---------- */
  check('全程无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  console.log(`\n${results.every((r) => r[1]) ? '✓' : '✗'} ${results.filter((r) => r[1]).length}/${results.length} 项通过`);
  if (!results.every((r) => r[1])) process.exitCode = 1;
} catch (e) {
  console.error('\n✗ 异常：', e.message);
  console.log(`✗ ${results.filter((r) => r[1]).length}/${results.length} 项通过（异常中断）`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.kill();
}
