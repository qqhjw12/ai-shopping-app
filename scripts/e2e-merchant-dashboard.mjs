// 商家工作台验收（#/merchant/dashboard，**不需要网关**）。
//
// 与 e2e-merchant-demo.mjs 的分工：那一套管「入驻 → 审核 → 进门」这条链路能不能走通，
// 这一套管「进门之后活干不干得成」——五个模块逐个点、每条经营规则逐条撞。
//
// 断言分七组：
//   1) 概览四张卡的数字口径（在售 / 今日订单 / 待发货 / 库存预警）
//   2) 五个模块可访问，tab 走 query，刷新不丢当前模块
//   3) 商品：筛选计数、上下架、审核中不可上下架、新增商品必须进「审核中」、表单校验
//   4) 库存：内联改数量、低于阈值标预警、已下架商品不参与预警、非法值不写入
//   5) 订单：待发货筛选、运单号校验、发货、重复发货被拒、详情抽屉与时间线
//   6) 店铺设置：改名保存、侧栏同步、刷新仍在
//   7) 数据隔离：两家店各自一份桶，互不串货；移动端底部标签栏、无横向滚动
//
// 用法：node scripts/e2e-merchant-dashboard.mjs [--port 5512] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5512;
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
const srv = serving
  ? null
  : spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], {
    stdio: 'ignore',
  });
if (!serving) await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

/* ---------------- 两家店：用来验「按商家分桶」 ---------------- */

const A = { id: 'ML202501010001', key: 'key-shop-a', brand: '素白 SUBAI', categories: ['home', 'kitchen'], priceRange: '100-500' };
const B = { id: 'ML202501010002', key: 'key-shop-b', brand: '拾光 SHIGUANG', categories: ['book', 'stationery'], priceRange: 'lt100' };

const nowIso = new Date().toISOString();
const mkRecord = (o) => ({
  id: o.id,
  key: o.key,
  status: 'approved',
  reviewNote: '',
  createdAt: nowIso,
  updatedAt: nowIso,
  reviewedAt: nowIso,
  company: `${o.brand} 工作室`,
  brand: o.brand,
  contact: '沈素',
  phoneMasked: '139****9000',
  emailMasked: 's***@subai.studio',
  categories: o.categories,
  materials: [{ kind: 'license', name: '营业执照.jpg', size: 204800 }],
  entityKind: 'studio',
  brandSource: 'own',
  skuRange: '20-50',
  priceRange: o.priceRange,
  dropship: false,
  bankAccount: `${o.brand} 工作室`,
  bankBranch: '',
  bankNoMasked: '6225****7766',
  returnPolicy: '7days',
  shipWithin: '48h',
  note: '',
  revisionCount: 0,
  withdrawnAt: null,
  notices: [],
  local: true,
});
const RECORDS = [mkRecord(A), mkRecord(B)];

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

const base = `http://127.0.0.1:${PORT}/index.html`;
const dashHash = (app, tab) => `/merchant/dashboard?${tab ? `tab=${tab}&` : ''}id=${app.id}&key=${encodeURIComponent(app.key)}`;
const go = async (hash, wait = 900) => {
  await page.goto(`${base}#${hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
const title = () => page.locator('.mdash-title').innerText();
const nav = async (label) => {
  await page.locator('.mdash-navitem', { hasText: label }).click();
  await page.waitForTimeout(700);
};
const rowOf = (id) => page.locator(`.mdash-table tbody tr[data-product="${id}"]`);
const chipTexts = async () => (await page.locator('.mdash-chip').allInnerTexts()).map((s) => s.trim());
const cardValue = async (label) => {
  const card = page.locator('.mdash-card', { hasText: label }).first();
  return (await card.locator('.mdash-card-value').innerText()).trim();
};
const storeOf = (id) => page.evaluate((mid) => {
  const all = JSON.parse(localStorage.getItem('maison_merchant_shop_v1') || '{}');
  return all[mid] || null;
}, id);

try {
  await page.goto(`${base}#/`, { waitUntil: 'load' });
  await page.evaluate((records) => {
    localStorage.setItem('maison_merchant_local_v1', JSON.stringify(records));
    localStorage.removeItem('maison_merchant_shop_v1');
    localStorage.removeItem('maison_merchant_last_application_v1');
  }, RECORDS);

  /* ---------- 1. 概览口径 ---------- */
  console.log('\n— 概览四张卡 —');
  await go(dashHash(A));
  check('工作台打开并停在概览', (await title()) === '概览', await title());
  check('概览 4 张数据卡', (await page.locator('.mdash-card').count()) === 4, String(await page.locator('.mdash-card').count()));
  // 种子：5 个商品（在售 3 / 下架 1 / 审核中 1）、4 笔订单（今日 2、待发货 2）
  check('在售商品 = 3', (await cardValue('在售商品')) === '3', await cardValue('在售商品'));
  check('今日订单 = 2', (await cardValue('今日订单')) === '2', await cardValue('今日订单'));
  check('待发货 = 2', (await cardValue('待发货')) === '2', await cardValue('待发货'));
  // 42 / 6 / 118 / 23(已下架) / 3(审核中) → 预警只算在售或待卖：6 与 3 命中
  check('库存预警 = 2（下架的那件不算）', (await cardValue('库存预警')) === '2', await cardValue('库存预警'));
  check('预警卡带 is-warn 强调', (await page.locator('.mdash-card.is-warn').count()) === 1);
  check('最近订单表里有单号', (await page.locator('.mdash-order-id').count()) >= 3);
  check('概览常驻「演示」标注', (await page.locator('.mdash-note').innerText()).includes('本机示例数据'));

  /* ---------- 2. 五个模块 + tab 走 query ---------- */
  console.log('\n— 五个模块与 tab 参数 —');
  await nav('商品管理');
  check('进商品管理', (await title()) === '商品管理', await title());
  check('URL 带 tab=products', page.url().includes('tab=products'), page.url());
  check('当前导航有 is-active', (await page.locator('.mdash-navitem.is-active').innerText()).includes('商品管理'));

  await nav('库存管理');
  check('进库存管理', (await title()) === '库存管理', await title());
  await nav('订单管理');
  check('进订单管理', (await title()) === '订单管理', await title());
  await nav('店铺设置');
  check('进店铺设置', (await title()) === '店铺设置', await title());

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);
  check('刷新后仍停在店铺设置（tab 走 query）', (await title()) === '店铺设置', await title());

  await go(dashHash(A, 'inventory'));
  check('直链 tab=inventory 打开库存管理', (await title()) === '库存管理', await title());

  /* ---------- 3. 商品管理 ---------- */
  console.log('\n— 商品：筛选 / 上下架 / 审核中 —');
  await go(dashHash(A, 'products'));
  check('商品 5 行', (await page.locator('.mdash-table tbody tr[data-product]').count()) === 5,
    String(await page.locator('.mdash-table tbody tr[data-product]').count()));
  check('筛选计数 全部5/在售3/下架1/审核1/未通过0',
    (await chipTexts()).join('|') === '全部 5|在售 3|已下架 1|审核中 1|未通过 0', (await chipTexts()).join('|'));

  const reviewingRow = page.locator('tr[data-product="MP0005"]');
  check('审核中商品标「审核中」', (await reviewingRow.locator('.mdash-pill').innerText()).includes('审核中'));
  check('审核中商品不给上下架（只有模拟通过）',
    (await reviewingRow.locator('button.mdash-link').innerText()).includes('模拟通过'));

  // 下架一条在售
  await page.locator('tr[data-product="MP0003"] button.mdash-link').click();
  await page.waitForTimeout(700);
  check('下架后在售数变 2', (await chipTexts())[1] === '在售 2', (await chipTexts()).join('|'));
  check('状态胶囊变「已下架」', (await rowOf('MP0003').locator('.mdash-pill').innerText()).includes('已下架'));
  check('store 里 MP0003 状态是 off', (await storeOf(A.id)).products.find((p) => p.id === 'MP0003').status === 'off');

  // 再上架回来
  await rowOf('MP0003').locator('button.mdash-link').click();
  await page.waitForTimeout(700);
  check('上架后在售数回到 3', (await chipTexts())[1] === '在售 3', (await chipTexts()).join('|'));

  console.log('\n— 商品：新增进「审核中」—');
  await page.locator('.mdash-btn.is-gold', { hasText: '新增商品' }).click();
  await page.waitForTimeout(500);
  check('新增商品是右侧抽屉', (await page.locator('.modal.is-sheet').count()) === 1);
  check('抽屉说明图片是占位', (await page.locator('.mdash-imgbox').innerText()).includes('占位'));

  const sheetField = (label) => page.locator('.modal.is-sheet .mdash-field', { hasText: label }).first();
  await page.locator('.modal.is-sheet button[type="submit"]').click();
  await page.waitForTimeout(400);
  check('空表单提交被拦住（名称）', (await page.locator('.mdash-error').innerText()).includes('至少 2 个字'),
    await page.locator('.mdash-error').innerText());
  check('校验失败不关抽屉（不吞数据）', (await page.locator('.modal.is-sheet').count()) === 1);

  await sheetField('商品名称').locator('input').fill('素白手作盖碗');
  await page.locator('.modal.is-sheet button[type="submit"]').click();
  await page.waitForTimeout(400);
  check('价格为空被拦住', (await page.locator('.mdash-error').innerText()).includes('价格'),
    await page.locator('.mdash-error').innerText());

  await sheetField('价格（元）').locator('input').fill('128');
  await sheetField('初始库存').locator('input').fill('30');
  await sheetField('类目').locator('select').selectOption('home');
  await page.locator('.modal.is-sheet button[type="submit"]').click();
  await page.waitForTimeout(900);
  check('提交后抽屉关闭', (await page.locator('.modal.is-sheet').count()) === 0);
  check('商品数变 6', (await page.locator('.mdash-table tbody tr[data-product]').count()) === 6,
    String(await page.locator('.mdash-table tbody tr[data-product]').count()));

  const created = (await storeOf(A.id)).products.find((p) => p.name === '素白手作盖碗');
  check('新商品落库且状态是 reviewing', Boolean(created) && created.status === 'reviewing',
    JSON.stringify(created && created.status));
  check('新商品价格库存入账', created && created.price === 128 && created.stock === 30,
    JSON.stringify(created && { price: created.price, stock: created.stock }));
  const newRow = page.locator(`tr[data-product="${created.id}"]`);
  check('列表里新商品标「审核中」', (await newRow.locator('.mdash-pill').innerText()).includes('审核中'));
  check('审核中看不到「下架」按钮', !(await newRow.locator('button.mdash-link').innerText()).includes('下架'));
  await page.screenshot({ path: '.shots/mdash-products.png', fullPage: true });

  await newRow.locator('button.mdash-link').click();
  await page.waitForTimeout(700);
  check('模拟通过后新商品在售', (await page.locator(`tr[data-product="${created.id}"] .mdash-pill`).innerText()).includes('在售'));
  check('在售数变 4', (await chipTexts())[1] === '在售 4', (await chipTexts()).join('|'));

  /* ---------- 4. 库存 ---------- */
  console.log('\n— 库存：内联改数量与预警口径 —');
  await go(dashHash(A, 'inventory'));
  check('库存页列出 6 个商品', (await page.locator('.mdash-table tbody tr[data-product]').count()) === 6);
  const stockIn = rowOf(created.id).locator('.mdash-stock-input');
  check('库存输入框带 aria-label', Boolean(await stockIn.getAttribute('aria-label')));

  await stockIn.fill('5');
  await stockIn.press('Enter');
  await page.waitForTimeout(700);
  check('改成 5 后行标 is-low', (await rowOf(created.id).getAttribute('class')).includes('is-low'),
    await rowOf(created.id).getAttribute('class'));
  check('出现「库存预警」胶囊', (await rowOf(created.id).innerText()).includes('库存预警'));
  check('store 库存是 5', (await storeOf(A.id)).products.find((p) => p.id === created.id).stock === 5);

  await page.locator('.mdash-navitem', { hasText: '概览' }).click();
  await page.waitForTimeout(700);
  check('概览库存预警跟着变 3', (await cardValue('库存预警')) === '3', await cardValue('库存预警'));

  await go(dashHash(A, 'inventory'));
  await rowOf(created.id).locator('.mdash-stock-input').fill('60');
  await rowOf(created.id).locator('.mdash-stock-input').press('Enter');
  await page.waitForTimeout(700);
  check('改到 60 后预警消失', !(await rowOf(created.id).innerText()).includes('库存预警'));

  await rowOf(created.id).locator('.mdash-stock-input').fill('-1');
  await rowOf(created.id).locator('.mdash-stock-input').press('Enter');
  await page.waitForTimeout(600);
  check('负数被拒并回退显示 60',
    (await rowOf(created.id).locator('.mdash-stock-input').inputValue()) === '60',
    await rowOf(created.id).locator('.mdash-stock-input').inputValue());
  check('负数没写进 store', (await storeOf(A.id)).products.find((p) => p.id === created.id).stock === 60);

  // 步进器
  await rowOf(created.id).locator('.mdash-step', { hasText: '+' }).click();
  await page.waitForTimeout(600);
  check('步进器 +1 生效', (await storeOf(A.id)).products.find((p) => p.id === created.id).stock === 61);

  // 已下架商品不参与预警：先改到 3，再下架，回库存页不该标预警
  await rowOf(created.id).locator('.mdash-stock-input').fill('3');
  await rowOf(created.id).locator('.mdash-stock-input').press('Enter');
  await page.waitForTimeout(600);
  await nav('商品管理');
  await page.locator(`tr[data-product="${created.id}"] button.mdash-link`).click();
  await page.waitForTimeout(700);
  await nav('库存管理');
  check('已下架商品不标库存预警', !(await rowOf(created.id).innerText()).includes('库存预警'),
    await rowOf(created.id).innerText());
  await page.locator('.mdash-navitem', { hasText: '概览' }).click();
  await page.waitForTimeout(700);
  check('下架后概览预警回到 2', (await cardValue('库存预警')) === '2', await cardValue('库存预警'));
  await page.screenshot({ path: '.shots/mdash-inventory.png', fullPage: true });

  // 上架回来收尾，让后面订单/隔离的断言看到稳定的 3 个在售
  await nav('商品管理');
  await page.locator(`tr[data-product="${created.id}"] button.mdash-link`).click();
  await page.waitForTimeout(700);

  /* ---------- 5. 订单 ---------- */
  console.log('\n— 订单：待发货 / 运单号 / 发货 —');
  await go(dashHash(A, 'orders'));
  check('订单筛选 全部4/待发货2/已发1/完成1',
    (await chipTexts()).join('|') === '全部 4|待发货 2|已发货 1|已完成 1', (await chipTexts()).join('|'));

  await page.locator('.mdash-chip', { hasText: '待发货' }).click();
  await page.waitForTimeout(600);
  check('筛待发货剩 2 行', (await page.locator('.mdash-table tbody tr[data-order]').count()) === 2);

  const pendingRow = page.locator('.mdash-table tbody tr[data-order]').first();
  const pendingId = await pendingRow.getAttribute('data-order');
  await pendingRow.locator('button.mdash-link', { hasText: '发货' }).click();
  await page.waitForTimeout(500);
  check('发货抽屉打开', (await page.locator('.modal.is-sheet').count()) === 1);
  check('抽屉里能看到订单号', (await page.locator('.mdash-sheet-sub').innerText()).includes(pendingId));

  const trackIn = page.locator('.modal.is-sheet .mdash-field', { hasText: '运单号' }).locator('input');
  await trackIn.fill('abc');
  await page.locator('.modal.is-sheet button[type="submit"]').click();
  await page.waitForTimeout(400);
  check('运单号太短被拒', (await page.locator('.mdash-error').innerText()).includes('6–32'),
    await page.locator('.mdash-error').innerText());
  check('被拒后不关抽屉', (await page.locator('.modal.is-sheet').count()) === 1);

  await page.locator('.modal.is-sheet .mdash-field', { hasText: '快递公司' }).locator('select').selectOption('顺丰速运');
  await trackIn.fill('sf139700228842');
  await page.locator('.modal.is-sheet button[type="submit"]').click();
  await page.waitForTimeout(900);
  check('发货后抽屉关闭', (await page.locator('.modal.is-sheet').count()) === 0);
  check('待发货剩 1', (await chipTexts())[1] === '待发货 1', (await chipTexts()).join('|'));
  check('已发货变 2', (await chipTexts())[2] === '已发货 2', (await chipTexts()).join('|'));

  const shipped = (await storeOf(A.id)).orders.find((o) => o.id === pendingId);
  check('store 里状态 shipped', shipped.status === 'shipped', shipped.status);
  check('运单号已入库并大写', shipped.trackingNo === 'SF139700228842', shipped.trackingNo);
  check('发货时间已记录', Boolean(shipped.shippedAt));

  await page.locator('.mdash-chip', { hasText: '已发货' }).click();
  await page.waitForTimeout(600);
  const shippedRow = page.locator(`tr[data-order="${pendingId}"]`);
  check('已发货行不再给「发货」按钮', !(await shippedRow.locator('button.mdash-link').innerText()).includes('发货'),
    await shippedRow.locator('button.mdash-link').innerText());

  await shippedRow.locator('button.mdash-link', { hasText: '详情' }).click();
  await page.waitForTimeout(600);
  check('订单详情是抽屉', (await page.locator('.modal.is-sheet').count()) === 1);
  check('详情里时间线 3 步', (await page.locator('.mdash-tl-step').count()) === 3,
    String(await page.locator('.mdash-tl-step').count()));
  check('详情显示物流单号', (await page.locator('.mdash-kv-list').innerText()).includes('SF139700228842'));
  await page.screenshot({ path: '.shots/mdash-order-sheet.png', fullPage: true });

  await page.locator('.modal.is-sheet button.mdash-btn', { hasText: '模拟确认收货' }).click();
  await page.waitForTimeout(800);
  const done = (await storeOf(A.id)).orders.find((o) => o.id === pendingId);
  check('模拟确认收货后状态 done', done.status === 'done', done.status);
  check('完成时间已记录', Boolean(done.finishedAt));

  /* ---------- 6. 店铺设置 ---------- */
  console.log('\n— 店铺设置：改名保存 —');
  await go(dashHash(A, 'settings'));
  const nameField = page.locator('.mdash-field', { hasText: '店铺名称' }).first().locator('input');
  check('设置页带出当前店名', (await nameField.inputValue()).includes('素白'), await nameField.inputValue());
  await nameField.fill('素白器物');
  await page.locator('.mdash-field', { hasText: '店铺简介' }).locator('textarea').fill('做几只自己天天用的碗。');
  await page.locator('.mdash-field', { hasText: '字标' }).locator('input').fill('素');
  await page.locator('.mdash-tone').nth(2).click();
  await page.locator('button[type="submit"]', { hasText: '保存修改' }).click();
  await page.waitForTimeout(800);
  check('侧栏店名同步更新', (await page.locator('.mdash-shop-name').innerText()) === '素白器物',
    await page.locator('.mdash-shop-name').innerText());
  const shop = (await storeOf(A.id)).shop;
  check('简介写进 store', shop.intro === '做几只自己天天用的碗。', shop.intro);
  check('字标与主色写进 store', shop.logoText === '素' && shop.logoColor === 2, `${shop.logoText}/${shop.logoColor}`);

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1000);
  check('刷新后店名还在', (await page.locator('.mdash-shop-name').innerText()) === '素白器物');

  /* ---------- 7. 刷新不丢 + 商家隔离 ---------- */
  console.log('\n— 刷新不丢 / 两家店不串货 —');
  await go(dashHash(A, 'products'));
  check('刷新后商品仍是 6 个（新增的没丢）', (await page.locator('.mdash-table tbody tr[data-product]').count()) === 6,
    String(await page.locator('.mdash-table tbody tr[data-product]').count()));

  await go(dashHash(B));
  const bName = await page.locator('.mdash-shop-name').innerText();
  check('切到 B 店显示 B 的店名', bName.includes('拾光'), bName);
  await nav('商品管理');
  check('B 店是 5 个商品（不受 A 店新增影响）',
    (await page.locator('.mdash-table tbody tr[data-product]').count()) === 5,
    String(await page.locator('.mdash-table tbody tr[data-product]').count()));
  check('B 店看不到 A 店新增的商品',
    !(await page.locator('.mdash-table tbody').innerText()).includes('素白手作盖碗'));
  const both = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('maison_merchant_shop_v1') || '{}')));
  check('本机按商家分两个桶', both.length === 2 && both.includes('ML202501010001') && both.includes('ML202501010002'),
    both.join(','));
  check('B 店订单也是自己那份（4 单）', (await storeOf(B.id)).orders.length === 4);

  /* ---------- 8. 移动端 ---------- */
  console.log('\n— 移动端：底部标签栏 / 无横滚 —');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mctx.addInitScript((records) => {
    try {
      if (!localStorage.getItem('maison_merchant_local_v1')) {
        localStorage.setItem('maison_merchant_local_v1', JSON.stringify(records));
      }
    } catch { /* 隐私模式下忽略 */ }
  }, RECORDS);
  const mpage = await mctx.newPage();
  const mErrors = [];
  mpage.on('pageerror', (e) => mErrors.push(String(e).slice(0, 120)));
  await mpage.goto(`${base}#${dashHash(A)}`, { waitUntil: 'load' });
  await mpage.waitForTimeout(1400);

  check('移动端侧栏收起', !(await mpage.locator('.mdash-side').isVisible()));
  check('移动端底部标签栏出现', await mpage.locator('.mdash-tabbar').isVisible());
  check('底部标签 5 个', (await mpage.locator('.mdash-tab').count()) === 5,
    String(await mpage.locator('.mdash-tab').count()));

  const overflow = () => mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端概览无横向滚动', (await overflow()) <= 1, String(await overflow()));
  for (const [label, tab] of [['商品', 'products'], ['库存', 'inventory'], ['订单', 'orders'], ['设置', 'settings']]) {
    await mpage.locator('.mdash-tab', { hasText: label }).click();
    await mpage.waitForTimeout(700);
    check(`移动端${label}页无横向滚动`, (await overflow()) <= 1, String(await overflow()));
  }
  check('移动端无 JS 错误', mErrors.length === 0, mErrors.join(' | '));
  await mpage.screenshot({ path: '.shots/mdash-mobile.png', fullPage: true });
  await mctx.close();

  check('桌面端无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (e) {
  check('脚本执行未抛异常', false, String(e && e.stack ? e.stack.split('\n')[0] : e));
} finally {
  await browser.close();
  if (srv) srv.kill();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${failed.length ? '✗' : '✓'} ${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  failed.forEach(([label, , extra]) => console.log(`  FAIL ${label}${extra ? ` → ${extra}` : ''}`));
  process.exitCode = 1;
}
