// 商家侧 ↔ 消费者侧数据联动验收（**不需要网关**——联动的是演示仓 localStorage）。
//
// 真网关链路（商家商品真进平台库）由 e2e-merchant-workspace.mjs 覆盖；
// 这里验的是演示模式的闭环：
//   1) 工作台演示仓里「商家自建且在售」的商品出现在消费者端（首页精选/列表/搜索）
//   2) 卡片角落有极小「商家」标签，其余卡片样式不动
//   3) 下架后消费者端不再展示；重新上架又回来（刷新即最新，不做实时推送）
//   4) 种子演示商品不进消费者列表（否则每逛一家演示店商城多三件同款）
//   5) 消费者主流程不破坏：内置演示商品照常、PDP 可看可加购
//   6) 移动端无横向滚动、无 JS 错误
//
// 用法：node scripts/e2e-merchant-link.mjs [--port 5516] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5516;
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

/* 预置一家演示店的桶：2 件自建商品（1 在售 1 下架）+ 1 件种子在售商品。
   种子件带 seed 字段——正是生产代码里区分「商家自建」与「演示种子」的依据。 */
const MID = 'MA-E2E-LINK';
const T = '2026-10-31T10:00:00.000Z';
const BUCKET = {
  schema: 1,
  merchantId: MID,
  seededAt: T,
  shop: { name: '山物手作', intro: '演示店铺', logoText: '山', logoColor: 0, updatedAt: T },
  products: [
    { id: 'MP9001', name: '商家直供·粗陶盖碗', categoryId: 'home', price: 128, stock: 40, warnAt: 8, status: 'on', createdAt: T, updatedAt: T },
    { id: 'MP9002', name: '商家直供·亚麻桌旗', categoryId: 'home', price: 88, stock: 12, warnAt: 8, status: 'off', createdAt: T, updatedAt: T },
    { id: 'MP0001', name: '手作粗陶马克杯', categoryId: 'home', price: 68, stock: 42, warnAt: 10, status: 'on', seed: MID, createdAt: T, updatedAt: T },
  ],
  orders: [],
};

const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
// 只在桶不存在时种底：init script 每次导航/刷新都会执行，无条件覆盖会把
// 页内改动（下架/第二家店）冲掉——联动验收恰恰要验这些改动活得过刷新
await ctx.addInitScript(([key, bucket]) => {
  if (!localStorage.getItem(key)) localStorage.setItem(key, bucket);
}, ['maison_merchant_shop_v1', JSON.stringify({ [MID]: BUCKET })]);

const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  if (/Failed to load resource/.test(t)) return; // 无网关时 /api 404 是预期
  consoleErrors.push(t.slice(0, 160));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

const go = async (hash, wait = 900) => {
  await page.goto(base + hash, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
/** 同地址也要重开：goto 到相同 hash 不会重新加载页面（刷新即读最新数据） */
const openAt = async (hash, wait = 900) => {
  await go(hash, wait);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
/** 在消费者列表里找某张卡的容器 */
const cardOf = (name) => page.locator('.pcard', { hasText: name }).first();

/** 直接改演示仓状态，模拟商家在工作台上架/下架（数据源与工作台同一条 localStorage） */
const setProductStatus = (productId, status) => page.evaluate(([mid, pid, st]) => {
  const all = JSON.parse(localStorage.getItem('maison_merchant_shop_v1') || '{}');
  const p = (all[mid] || {}).products?.find((x) => x.id === pid);
  if (p) { p.status = st; p.updatedAt = new Date().toISOString(); localStorage.setItem('maison_merchant_shop_v1', JSON.stringify(all)); }
  return Boolean(p);
}, [MID, productId, status]);

try {
  /* ---------- 1. 首页精选出现商家商品 ---------- */
  console.log('\n— 首页精选 —');
  await go('#/', 1300);
  const card = cardOf('商家直供·粗陶盖碗');
  check('商家自建在售商品出现在首页', (await card.count()) === 1);
  check('卡片角落有「商家」标签', (await card.locator('.badge-merchant').count()) === 1);
  check('meta 行标明店铺来源', ((await card.locator('.card-meta').innerText()) || '').includes('山物手作'));
  check('下架商品不在首页', (await page.locator('.pcard', { hasText: '亚麻桌旗' }).count()) === 0);
  check('种子商品不进消费者列表', (await page.locator('.pcard', { hasText: '手作粗陶马克杯' }).count()) === 0);
  check('内置演示商品照常（主流程没被挤掉）', (await page.locator('.pcard', { hasText: '极光 Pro 5G 智能手机' }).count()) >= 1);
  check('普通卡片没有「商家」标签', (await cardOf('极光 Pro 5G 智能手机').locator('.badge-merchant').count()) === 0);
  await page.screenshot({ path: `${ROOT}/.shots/link-1-home.png` });

  /* ---------- 2. 商品列表（分类筛选）---------- */
  console.log('\n— 商品列表 / 分类 —');
  await openAt('#/products?cat=home', 1100);
  check('家居分类列表里有商家商品', (await cardOf('商家直供·粗陶盖碗').count()) === 1);
  check('列表卡带「商家」标签', (await cardOf('商家直供·粗陶盖碗').locator('.badge-merchant').count()) === 1);
  // 关键词筛选也认它（列表页的 q 走同一套 filterOnly）
  await openAt('#/products?q=' + encodeURIComponent('粗陶盖碗'), 1100);
  check('列表页关键词能搜到商家商品', (await cardOf('商家直供·粗陶盖碗').count()) === 1);

  /* ---------- 3. 搜索页（演示检索）---------- */
  console.log('\n— 搜索 —');
  await openAt('#/search?q=' + encodeURIComponent('粗陶盖碗'), 1300);
  check('搜索页能搜到商家商品', (await cardOf('商家直供·粗陶盖碗').count()) === 1);
  await openAt('#/search?q=' + encodeURIComponent('亚麻桌旗'), 1300);
  check('下架商品搜不到', (await page.locator('.pcard').count()) === 0
    || (await cardOf('商家直供·亚麻桌旗').count()) === 0);

  /* ---------- 4. 详情页可看可加购 ---------- */
  console.log('\n— 详情与加购 —');
  await openAt('#/product/' + encodeURIComponent(`${MID}::MP9001`), 1200);
  check('PDP 能打开商家商品', (await page.locator('h1, .pdp-name, .detail-name', { hasText: '粗陶盖碗' }).count()) >= 1
    || ((await page.locator('body').innerText()).includes('粗陶盖碗')));
  const addBtn = page.getByRole('button', { name: /加入购物/ }).first();
  check('PDP 有加购按钮', (await addBtn.count()) >= 1);
  await addBtn.click();
  await page.waitForTimeout(500);
  check('加购成功（toast 确认）', ((await page.locator('.toast, [class*="toast"]').innerText().catch(() => '')) || '').includes('已加入购物袋'));

  /* ---------- 5. 下架 → 消失；重新上架 → 回来 ---------- */
  console.log('\n— 上下架联动 —');
  check('模拟商家下架', await setProductStatus('MP9001', 'off') === true);
  await openAt('#/products?cat=home', 1100);
  check('下架后列表里消失', (await page.locator('.pcard', { hasText: '商家直供·粗陶盖碗' }).count()) === 0);
  await openAt('#/', 1200);
  check('下架后首页也消失', (await page.locator('.pcard', { hasText: '商家直供·粗陶盖碗' }).count()) === 0);
  check('模拟商家重新上架', await setProductStatus('MP9001', 'on') === true);
  await openAt('#/products?cat=home', 1100);
  check('重新上架后回来（刷新即最新）', (await cardOf('商家直供·粗陶盖碗').count()) === 1);
  await page.screenshot({ path: `${ROOT}/.shots/link-2-list.png` });

  /* ---------- 6. 工作台真入口走一遍（页面级串通） ---------- */
  console.log('\n— 经工作台上架（页面级）—');
  // 直接用页面里的数据层造一件新货并放行，验证「工作台建品→放行→消费者可见」整链
  const created = await page.evaluate(async () => {
    const { ensureShop, createProduct, approveProduct } = await import('./js/store/merchantShopStore.js');
    ensureShop({ id: 'ML-E2E-LINK-B', brand: '第二家店', categories: ['kitchen'], priceRange: '100-500' });
    const p = createProduct('ML-E2E-LINK-B', { name: '铸铁小奶锅（第二家）', price: 199, stock: 30, categoryId: 'kitchen' });
    approveProduct('ML-E2E-LINK-B', p.id);
    return p.id;
  });
  check('工作台数据层建品+放行成功', Boolean(created), String(created));
  await openAt('#/products?cat=kitchen', 1100);
  check('第二家店的商品也进消费者列表（跨店不串）', (await cardOf('铸铁小奶锅（第二家）').count()) === 1);
  check('跨店徽章来源正确', ((await cardOf('铸铁小奶锅（第二家）').locator('.card-meta').innerText()) || '').includes('第二家店'));

  /* ---------- 7. 移动端 ---------- */
  console.log('\n— 移动端 —');
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mob.addInitScript(([key, bucket]) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, bucket);
  }, ['maison_merchant_shop_v1', JSON.stringify({ [MID]: BUCKET })]);
  const mpage = await mob.newPage();
  const mobErrors = [];
  mpage.on('pageerror', (e) => mobErrors.push(String(e).slice(0, 120)));
  await mpage.goto(base + '#/', { waitUntil: 'load' });
  await mpage.waitForTimeout(1200);
  check('移动端首页出现商家商品卡', (await mpage.locator('.pcard', { hasText: '商家直供·粗陶盖碗' }).count()) === 1);
  check('移动端「商家」标签可见', (await mpage.locator('.pcard', { hasText: '商家直供·粗陶盖碗' }).locator('.badge-merchant').count()) === 1);
  const scrollW = await mpage.evaluate(() => document.documentElement.scrollWidth);
  check('移动端无横向滚动', scrollW <= 390, String(scrollW));
  await mpage.screenshot({ path: `${ROOT}/.shots/link-3-mobile.png` });
  await mob.close();

  /* ---------- 8. 控制台干净 ---------- */
  console.log('\n— 控制台 —');
  check('全程无 JS 错误', consoleErrors.length === 0 && mobErrors.length === 0, consoleErrors.concat(mobErrors).slice(0, 2).join(' | '));
} finally {
  await browser.close();
  if (srv) srv.kill();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
