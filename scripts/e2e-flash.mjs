// 首页秒杀验收（#/ 与 #/admin/flash，**不需要网关**——秒杀配置是本地演示数据）。
//
// 覆盖：
//   1) 首页顶部秒杀区：位置在 Hero 之前、倒计时在走、卡片带秒杀价/原价划线/进度条
//   2) 实时购买：「立即抢购」按秒杀价进购物袋并跳结算；「加购」不跳转；进度实时累加
//   3) 后台配置：口令门（首次设置 → 进入）→ 顶部读数 → 保存即开抢
//   4) 跨标签页实时联动：后台改配置，前台那个标签页**不刷新**就跟着变（storage 事件）
//   5) 暂停 / 结束：暂停后按钮禁用；把结束时间拨到过去 → 「本场结束」
//   6) 不破坏消费者主流程：首页 Hero、发现区、详情页照旧
//   7) 移动端无横向滚动、无 JS 错误
//
// 用法：node scripts/e2e-flash.mjs [--port 5582] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5582;
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
  .then((r) => r.ok).catch(() => false);
const srv = serving ? null : spawn(process.execPath, [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')], { stdio: 'ignore' });
if (!serving) await new Promise((r) => setTimeout(r, 1000));
mkdirSync(`${ROOT}/.shots`, { recursive: true });

const base = `http://127.0.0.1:${PORT}/index.html`;
const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
// 结算是受保护路径：预置一个登录态买家，否则「立即抢购」会先被守卫送到登录页
// （这与普通商品立即购买的行为一致，本用例要验的是秒杀本身，所以直接给登录态）
await ctx.addInitScript(() => {
  if (!localStorage.getItem('current_user')) {
    localStorage.setItem('current_user', JSON.stringify({ id: 'u_flash_e2e', name: '秒杀买家' }));
  }
});

const consoleErrors = [];
const watchErrors = (page) => {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    if (/Failed to load resource/.test(t)) return; // 无网关时 /api 404 是预期
    consoleErrors.push(t.slice(0, 160));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
};

/* ---------------- 前台标签页 ---------------- */
const home = await ctx.newPage();
watchErrors(home);
await home.goto(`${base}#/`, { waitUntil: 'load' });
await home.waitForSelector('.fs-sale', { timeout: 20000 });
await home.waitForTimeout(500);

// 1) 位置：首页重构为任务面板后，秒杀区在「任务简报 → 读数 → 模块 → 任务条带
//    → 扫描结果」之后——首屏属于系统状态，秒杀是时间窗内的活动位。
//    面板嵌套比旧版深一层，用 compareDocumentPosition 比先后，不再依赖子元素层级。
const orderOk = await home.evaluate(() => {
  const panel = document.querySelector('.home-panel');
  const hero = panel?.querySelector('.hp-hero');
  const results = panel?.querySelector('.hp-results');
  const fs = panel?.querySelector('.fs-sale');
  if (!hero || !results || !fs) return false;
  const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  return after(hero, results) && after(results, fs);
});
check('秒杀区在扫描结果之后（首屏留给任务简报）', orderOk);

// 2) 倒计时在走：隔 1.2s 两次读数不同（textContent 不带排版换行）
const readClock = () => home.evaluate(() => document.querySelector('.fs-digits').textContent);
const t1 = await readClock();
await home.waitForTimeout(1300);
const t2 = await readClock();
check(`倒计时每秒走（${t1} → ${t2}）`, t1 !== t2);

// 3) 卡片结构：秒杀价 + 原价划线 + 进度条
const cardCount = await home.locator('.fs-card').count();
check(`秒杀卡片就位（${cardCount} 件）`, cardCount >= 3);
const cardOk = await home.evaluate(() => {
  const card = document.querySelector('.fs-card');
  return Boolean(
    card.querySelector('.fs-price')?.textContent.match(/^¥\d/)
    && card.querySelector('.fs-was')
    && card.querySelector('.fs-bar-fill')
    && card.querySelector('.fs-buy')?.textContent.includes('立即抢购'),
  );
});
check('卡片带秒杀价 / 原价划线 / 进度条 / 抢购按钮', cardOk);

// 4) 实时购买：加购 → 购物袋条目价格 = 秒杀价、spec 带「秒杀」标记、进度 +1
const soldBefore = await home.evaluate(() => Number(JSON.parse(localStorage.getItem('maison_flash_sale_v1')).sale.items[0].sold));
const priceBefore = await home.evaluate(() => Number(JSON.parse(localStorage.getItem('maison_flash_sale_v1')).sale.items[0].price));
await home.locator('.fs-card').first().locator('.fs-add').click();
await home.waitForTimeout(400);
const cartOk = await home.evaluate(({ price }) => {
  const cart = JSON.parse(localStorage.getItem('shop_cart') || '[]');
  const it = cart.find((x) => String(x.skuId || '').startsWith('flash-'));
  return Boolean(it && Number(it.price) === price && String(it.spec || '').includes('秒杀'));
}, { price: priceBefore });
check('加购后购物袋按秒杀价入袋（spec 带秒杀标记）', cartOk);
const soldAfter = await home.evaluate(() => Number(JSON.parse(localStorage.getItem('maison_flash_sale_v1')).sale.items[0].sold));
check(`进度实时累加（已抢 ${soldBefore} → ${soldAfter}）`, soldAfter === soldBefore + 1);

// 5) 立即抢购：跳结算（已登录买家直达；未登录会被守卫送登录页并带 redirect，与普通商品一致）
await home.locator('.fs-card').first().locator('.fs-buy').click();
await home.waitForTimeout(800);
check('「立即抢购」直达结算页', /#\/checkout(\?|$)/.test(home.url().split('#')[1] ? `#${home.url().split('#')[1]}` : home.url()), home.url());
// 回到首页继续后面的跨标签页联动用例
await home.goto(`${base}#/`, { waitUntil: 'load' });
await home.waitForSelector('.fs-sale', { timeout: 20000 });
await home.waitForTimeout(400);

/* ---------------- 后台标签页（同一浏览器上下文 → 跨标签页联动） ---------------- */
const admin = await ctx.newPage();
watchErrors(admin);
await admin.goto(`${base}#/admin/flash`, { waitUntil: 'load' });
await admin.waitForTimeout(400);

// 6) 口令门：首次进入是「设置」
const gateFirst = await admin.locator('.fs-gate').count() === 1
  && (await admin.locator('.fs-gate button[type=submit]').innerText()).includes('设置');
check('后台有口令门（首次进入要求设置口令）', gateFirst);
await admin.locator('.fs-input[type=password]').fill('ops-demo-2026');
await admin.locator('.fs-gate button[type=submit]').click();
await admin.waitForSelector('.fs-readbar', { timeout: 8000 });
check('设置口令后进入控制台（读数条就位）', true);

// 7) 口令门复验：错误口令进不去
const admin2 = await ctx.newPage();
watchErrors(admin2);
await admin2.goto(`${base}#/admin/flash`, { waitUntil: 'load' });
await admin2.waitForTimeout(400);
await admin2.locator('.fs-input[type=password]').fill('wrong-key');
await admin2.locator('.fs-gate button[type=submit]').click();
await admin2.waitForTimeout(300);
const gateErr = (await admin2.locator('.fs-gate-err').innerText()).includes('口令不对');
check('口令不对进不去控制台', gateErr);
await admin2.close();

// 8) 后台改标题 → 保存 → 前台标签页**不刷新**自动跟着变（storage 事件）
const newTitle = '深空闪购 · 第二场';
await admin.locator('.fs-fields .fs-field').first().locator('input').fill(newTitle);
await admin.locator('button', { hasText: '保存并开抢' }).click();
await admin.waitForTimeout(600);
const liveTitle = await home.locator('.fs-title').innerText();
check(`后台保存后前台免刷新生效（→「${liveTitle.trim()}」）`, liveTitle.includes(newTitle));

// 9) 暂停 → 前台按钮禁用、状态 HOLD
await admin.locator('button', { hasText: '开抢 / 暂停' }).click();
await home.waitForTimeout(700);
const pausedOk = await home.evaluate(() => {
  const sale = document.querySelector('.fs-sale');
  return sale.dataset.phase === 'paused'
    && [...sale.querySelectorAll('.fs-buy')].every((b) => b.disabled);
});
check('暂停后前台切到 HOLD、按钮全部禁用', pausedOk);
await admin.locator('button', { hasText: '开抢 / 暂停' }).click(); // 恢复
await home.waitForTimeout(700);

// 10) 结束：把结束时间拨到过去 → 「本场结束」
await home.evaluate(() => {
  const raw = JSON.parse(localStorage.getItem('maison_flash_sale_v1'));
  raw.sale.endAt = Date.now() - 1000;
  localStorage.setItem('maison_flash_sale_v1', JSON.stringify(raw));
});
await home.reload({ waitUntil: 'load' });
await home.waitForSelector('.fs-sale', { timeout: 20000 });
const endedOk = await home.evaluate(() => {
  const sale = document.querySelector('.fs-sale');
  return sale.dataset.phase === 'ended'
    && [...sale.querySelectorAll('.fs-buy')].every((b) => b.disabled && b.textContent.includes('结束'));
});
check('时间窗走完后前台显示「本场结束」且不可再抢', endedOk);

/* ---------------- 不破坏消费者主流程 ---------------- */
await home.goto(`${base}#/`, { waitUntil: 'load' });
await home.waitForSelector('.fs-sale', { timeout: 20000 });
check('首页任务简报照旧（Hero 在最前，读数/模块/结果齐备）',
  await home.evaluate(() => {
    const panel = document.querySelector('.home-panel');
    const kids = panel ? [...panel.children] : [];
    return kids[0]?.classList.contains('hp-hero')
      && (panel.querySelector('.hp-readbar')?.textContent || '').includes('已匹配')
      && panel.querySelectorAll('.hp-mod').length === 7
      && panel.querySelectorAll('.scan-item').length >= 5;
  }));
check('商品详情页可达', await (async () => {
  // 直接从秒杀卡取一件真实存在的商品深链过去：比点卡片里的第一个 <a> 稳
  // （第一眼看到的 a 可能是收藏按钮或图占位，不是详情链接）
  const pid = await home.evaluate(() => document.querySelector('.fs-card')?.getAttribute('data-pid') || '');
  if (!pid) return false;
  await home.goto(`${base}#/product/${encodeURIComponent(pid)}?from=home`, { waitUntil: 'load' });
  await home.waitForTimeout(800);
  return home.url().includes(`#/product/${pid}`);
})());

/* ---------------- 移动端 ---------------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const mpage = await mctx.newPage();
watchErrors(mpage);
await mpage.goto(`${base}#/`, { waitUntil: 'load' });
await mpage.waitForSelector('.fs-sale', { timeout: 20000 });
await mpage.waitForTimeout(500);
const mOk = await mpage.evaluate(() => ({
  noHScroll: document.documentElement.scrollWidth <= window.innerWidth + 1,
  cards: document.querySelectorAll('.fs-card').length,
}));
check('移动端秒杀区无横向滚动', mOk.noHScroll, `scrollWidth=${mOk.noHScroll}`);
check(`移动端卡片可横滑（${mOk.cards} 件在轨）`, mOk.cards >= 3);
await mpage.screenshot({ path: `${ROOT}/.shots/flash-e2e-mobile.png` });

/* ---------------- 收尾 ---------------- */
const errs = consoleErrors.filter((t) => !/net::|ERR_/.test(t));
check('无 JS 报错', errs.length === 0, errs.join(' | '));

await browser.close();
if (srv) srv.kill();

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length === 0 ? `\n✓ 秒杀验收 ${results.length}/${results.length} 全部通过` : `\n✗ ${failed.length}/${results.length} 失败`);
process.exit(failed.length ? 1 : 0);
