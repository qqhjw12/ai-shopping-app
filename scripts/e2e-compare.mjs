#!/usr/bin/env node
/**
 * 商品对比擂台 / AI 搭配师验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖：商品卡与详情页「加入对比」/ 悬浮条计数与去对比 / 对比页细线表格与等宽表头 /
 *       最优项 1px 青线 + 浅青底（无红绿）/ 只看差异项 / 移除单个 / 清空 /
 *       刷新不丢 + 上限 4 / 详情页 AI 搭配按分类出 2–4 件 + 理由 + 95 折总价 /
 *       单件替换 / 一键加购套装 / 移动端横向滚动固定宽卡片 + 悬浮条不遮吸底栏 /
 *       reduced-fx 降级 / 控制台零错误。
 *
 * 用法：node scripts/e2e-compare.mjs [--port 4417] [--headed]
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
const PORT = Number(argOf('--port', '4417'));
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
const attachErrors = (p) => {
  p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 140)}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    // 无后端演示站的 /api 404、外部演示图 ERR_CONNECTION_CLOSED 属已知网络噪音
    if (/Failed to load resource|net::|ERR_|404/.test(t)) return;
    consoleErrors.push(t.slice(0, 140));
  });
};
attachErrors(page);

const cmpState = () => page.evaluate(async () => {
  const S = await import('/js/store/compareStore.js');
  return S.getSnapshot();
});

const money = (text) => Number(String(text).replace(/[^\d.]/g, '')) || 0;

try {
  /* ================= 1) 商品卡加入对比 ================= */
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.pcard', { timeout: 30000 });
  await page.waitForTimeout(400);

  const cardBtns = await page.locator('.pcard .cmp-toggle').count();
  check('商品卡上有「加入对比」按钮', cardBtns > 0, `count=${cardBtns}`);
  check('未选商品时底部悬浮条隐藏', await page.locator('#cmp-dock').isHidden());

  await page.locator('.pcard .cmp-toggle').nth(0).click();
  await page.waitForTimeout(200);
  const dock1 = await page.evaluate(() => {
    const d = document.querySelector('#cmp-dock');
    return {
      hidden: d.hidden,
      count: document.querySelector('#cmp-dock-count')?.textContent || '',
      cta: document.querySelector('#cmp-dock-go')?.textContent || '',
    };
  });
  check('点一次后悬浮条出现并显示 1/4 与「去对比」',
    !dock1.hidden && /1/.test(dock1.count) && /4/.test(dock1.count) && dock1.cta.includes('去对比'),
    JSON.stringify(dock1));
  check('按钮切到「已加入」并 aria-pressed=true',
    await page.locator('.pcard .cmp-toggle').nth(0).getAttribute('aria-pressed') === 'true'
    && (await page.locator('.pcard .cmp-toggle').nth(0).textContent()).includes('已加入'));

  /* ================= 2) 上限 4 ================= */
  for (let i = 1; i <= 3; i += 1) {
    await page.locator('.pcard .cmp-toggle').nth(i).click();
    await page.waitForTimeout(120);
  }
  const at4 = await cmpState();
  check('连加到 4 件（上限）', at4.ids.length === 4, JSON.stringify(at4.ids));

  await page.locator('.pcard .cmp-toggle').nth(4).click();
  await page.waitForTimeout(250);
  const over = await cmpState();
  const toastText = await page.locator('.toast').last().textContent().catch(() => '');
  check('第 5 件被拒绝并提示移除（数据层仍是 4 件）',
    over.ids.length === 4 && /已满|移除/.test(toastText || ''), `ids=${over.ids.length} toast=${toastText}`);

  /* ================= 3) 对比页结构与维度 ================= */
  await page.locator('#cmp-dock-go').click();
  await page.waitForSelector('#cmp-table', { timeout: 15000 });
  await page.waitForTimeout(400);

  const struct = await page.evaluate(() => {
    const table = document.querySelector('#cmp-table');
    const th = document.querySelector('.cmp-th-dim');
    const thItem = document.querySelectorAll('.cmp-th-item');
    const rows = [...document.querySelectorAll('.cmp-row')];
    return {
      cols: thItem.length,
      rows: rows.length,
      dims: rows.map((r) => r.getAttribute('data-dim')),
      labels: rows.map((r) => r.querySelector('.cmp-dim-label')?.textContent || ''),
      fontFamily: getComputedStyle(th).fontFamily,
      fontSize: parseFloat(getComputedStyle(th).fontSize),
      hasTable: Boolean(table),
      dockOnCompare: document.querySelector('#cmp-dock').hidden,
    };
  });
  check('对比页 4 列并列出价格/评分/销量/库存/售后/AI 指数',
    struct.cols === 4 && struct.hasTable
    && ['price', 'rating', 'sales', 'stock', 'aftersale', 'aiIndex'].every((k) => struct.dims.includes(k)),
    JSON.stringify({ cols: struct.cols, dims: struct.dims }));
  check('表头用等宽小字（mongram mono / ≤12px）',
    /mono/i.test(struct.fontFamily) && struct.fontSize <= 12,
    `${struct.fontFamily} @${struct.fontSize}`);
  check('对比页不重复显示悬浮条', struct.dockOnCompare === true);

  /* ================= 4) 最优项高亮 ================= */
  const best = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.cmp-row')].find((r) => r.getAttribute('data-dim') === 'price');
    const cells = [...row.querySelectorAll('.cmp-val')];
    const values = cells.map((c) => Number(String(c.textContent).replace(/[^\d.]/g, '')) || 0);
    const min = Math.min(...values);
    const bestCells = cells.filter((c) => c.getAttribute('data-best') === '1');
    const cs = bestCells.length ? getComputedStyle(bestCells[0]) : null;
    return {
      values,
      min,
      bestCount: bestCells.length,
      allMin: bestCells.every((c) => (Number(String(c.textContent).replace(/[^\d.]/g, '')) || 0) === min),
      bg: cs ? cs.backgroundColor : '',
      shadow: cs ? cs.boxShadow : '',
      color: cs ? cs.color : '',
      redGreen: cells.some((c) => {
        const s = getComputedStyle(c);
        return /rgb\((2[0-5]\d|1[5-9]\d),\s*([0-9]{1,2}),\s*([0-9]{1,2})\)/.test(s.color);
      }),
    };
  });
  check('价格行只把最低价标为最优项', best.bestCount >= 1 && best.allMin, JSON.stringify(best.values));
  check('最优项用 1px 青线 + 浅青底（inset box-shadow，无红绿块）',
    /inset/.test(best.shadow) && /rgba?\(34,\s*211,\s*238/.test(best.shadow)
    && /rgba?\(34,\s*211,\s*238/.test(best.bg),
    `bg=${best.bg} shadow=${best.shadow}`);

  /* ================= 5) 只看差异项 ================= */
  const beforeDiff = await page.locator('.cmp-row:visible').count();
  await page.locator('#cmp-diff-toggle').check();
  await page.waitForTimeout(250);
  const afterDiff = await page.locator('.cmp-row:visible').count();
  const hiddenRows = await page.evaluate(() => [...document.querySelectorAll('.cmp-row')]
    .filter((r) => r.getAttribute('data-diff') === '0')
    .every((r) => getComputedStyle(r).display === 'none'));
  check('「只看差异项」隐藏所有无差异行',
    afterDiff < beforeDiff && hiddenRows, `${beforeDiff} → ${afterDiff}`);
  await page.locator('#cmp-diff-toggle').uncheck();
  await page.waitForTimeout(200);

  /* ================= 6) 移除单个 / 刷新保持 / 清空 ================= */
  await page.locator('.cmp-col-remove').first().click();
  await page.waitForTimeout(300);
  const afterRemove = await cmpState();
  check('移除单个后剩 3 件且列数同步', afterRemove.ids.length === 3
    && (await page.locator('.cmp-th-item').count()) === 3, `ids=${afterRemove.ids.length}`);

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#cmp-table', { timeout: 15000 });
  await page.waitForTimeout(400);
  const afterReload = await cmpState();
  check('刷新后对比列表不丢（按 localStorage 还原）',
    afterReload.ids.length === 3 && (await page.locator('.cmp-th-item').count()) === 3,
    JSON.stringify(afterReload.ids));

  /* 首屏：商品池是异步的，未就绪时只能显示加载占位，不能先闪一帧「不在库中」 */
  await page.route('**/api/products', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.abort();
  });
  // 换一个 URL（加查询串）强制真实导航；只改 hash 不会重新加载模块
  await page.goto(`${APP}?fresh=1#/compare`, { waitUntil: 'domcontentloaded' });
  const firstFrame = await page.evaluate(() => ({
    loading: Boolean(document.querySelector('#cmp-loading')),
    body: document.body.textContent || '',
  }));
  check('首屏商品池未就绪时只显示加载占位，不误报「不在库中」',
    firstFrame.loading && !/不在当前商品库/.test(firstFrame.body),
    JSON.stringify({ loading: firstFrame.loading }));
  await page.unroute('**/api/products');
  await page.waitForSelector('#cmp-table', { timeout: 20000 });
  await page.waitForTimeout(300);

  await page.locator('#cmp-clear').click();
  await page.waitForTimeout(300);
  const cleared = await cmpState();
  check('清空对比后回到空态',
    cleared.ids.length === 0 && (await page.locator('.cmp-empty').count()) === 1);

  /* ================= 7) 详情页 AI 搭配 ================= */
  await page.goto(`${APP}#/products`, { waitUntil: 'load' });
  await page.waitForSelector('.pcard', { timeout: 30000 });
  await page.locator('.pcard .name').first().click();
  await page.waitForSelector('#pdp-outfit', { timeout: 20000 });
  await page.waitForTimeout(500);

  check('详情页有「加入对比」按钮', (await page.locator('.pdp-secondary-actions .cmp-toggle').count()) === 1);
  await page.locator('.pdp-secondary-actions .cmp-toggle').click();
  await page.waitForTimeout(250);
  check('详情页加入对比后悬浮条出现',
    !(await page.locator('#cmp-dock').isHidden()) && (await cmpState()).ids.length === 1);

  await page.locator('#ot-enter').click();
  await page.waitForSelector('.ot-mate', { timeout: 20000 });
  await page.waitForTimeout(300);

  const outfit = await page.evaluate(() => {
    const mates = [...document.querySelectorAll('.ot-mate')];
    const subtotal = Number(String(document.querySelector('.ot-total-sub')?.textContent || '').replace(/[^\d.]/g, '')) || 0;
    const save = Number(String(document.querySelector('.ot-total-save')?.textContent || '').replace(/[^\d.]/g, '')) || 0;
    const total = Number(String(document.querySelector('#ot-total-value')?.textContent || '').replace(/[^\d.]/g, '')) || 0;
    const mainPrice = Number(String(document.querySelector('.ot-main-price')?.textContent || '').replace(/[^\d.]/g, '')) || 0;
    return {
      count: mates.length,
      ids: mates.map((m) => m.getAttribute('data-mate')),
      reasons: mates.map((m) => (m.querySelector('.ot-mate-reason')?.textContent || '').trim()),
      reasonIds: mates.map((m) => m.querySelector('.ot-mate-reason')?.getAttribute('data-reason') || ''),
      links: mates.map((m) => m.querySelector('.ot-mate-thumb')?.getAttribute('href') || ''),
      subtotal, save, total, mainPrice,
      mono: /mono/i.test(getComputedStyle(document.querySelector('#ot-total-value')).fontFamily),
      cyan: getComputedStyle(document.querySelector('#ot-total-value')).color,
    };
  });
  check('搭配给 2–4 件', outfit.count >= 2 && outfit.count <= 4, `count=${outfit.count}`);
  check('每件搭配都有一行理由且无残留占位符',
    outfit.reasons.every((r) => r.length > 0 && !/[{}]/.test(r))
    && new Set(outfit.reasonIds).size >= Math.min(2, outfit.count),
    JSON.stringify(outfit.reasons));
  check('搭配商品都能跳详情（结果不脱库）',
    outfit.links.every((h) => /^#\/product\/.+/.test(h)), JSON.stringify(outfit.links));
  check('套装总价 = 原价合计 × 95 折，省额与总价加和等于原价',
    Math.abs(outfit.total - outfit.subtotal * 0.95) <= 0.02
    && Math.abs((outfit.total + outfit.save) - outfit.subtotal) <= 0.02
    && outfit.subtotal > outfit.mainPrice,
    JSON.stringify({ subtotal: outfit.subtotal, total: outfit.total, save: outfit.save }));
  check('套装总价等宽青色',
    outfit.mono && /rgba?\(34,\s*211,\s*238/.test(outfit.cyan), `${outfit.cyan}`);

  /* ================= 8) 单个替换 ================= */
  const firstBefore = outfit.ids[0];
  await page.locator('.ot-mini[data-replace]').first().click();
  await page.waitForTimeout(350);
  const replaced = await page.evaluate(() => [...document.querySelectorAll('.ot-mate')].map((m) => m.getAttribute('data-mate')));
  check('「换一件」把该位置换成另一件，其余搭配不变',
    replaced[0] !== firstBefore && replaced.slice(1).join(',') === outfit.ids.slice(1).join(','),
    `${firstBefore} → ${replaced[0]}`);

  /* ================= 9) 一键加购套装 ================= */
  const bagBefore = Number(await page.locator('#cart-count').textContent().catch(() => '0')) || 0;
  const mateCount = await page.locator('.ot-mate').count();
  await page.locator('#ot-add-all').click();
  await page.waitForTimeout(500);
  const bagAfter = Number(await page.locator('#cart-count').textContent().catch(() => '0')) || 0;
  check('一键加购把主商品 + 全部搭配放进购物袋',
    bagAfter - bagBefore === mateCount + 1, `${bagBefore} → ${bagAfter}（应 +${mateCount + 1}）`);

  /* ================= 10) 移动端 ================= */
  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  attachErrors(mobile);
  // 新 page 是全新 context（localStorage 独立）：先在移动端自己挑 3 件，再看对比页
  await mobile.goto(`${APP}#/products`, { waitUntil: 'load' });
  await mobile.waitForSelector('.pcard .cmp-toggle', { timeout: 30000 });
  for (let i = 0; i < 3; i += 1) {
    await mobile.locator('.pcard .cmp-toggle').nth(i).click();
    await mobile.waitForTimeout(120);
  }
  await mobile.goto(`${APP}#/compare`, { waitUntil: 'load' });
  await mobile.waitForSelector('.cmp-card', { timeout: 20000 });
  await mobile.waitForTimeout(500);

  const m = await mobile.evaluate(() => {
    const cards = document.querySelector('.cmp-cards');
    const card = document.querySelector('.cmp-card');
    const table = document.querySelector('.cmp-table');
    return {
      cardsShown: cards ? getComputedStyle(cards).display !== 'none' : false,
      tableHidden: table ? getComputedStyle(table).display === 'none' : false,
      cardWidth: card ? card.getBoundingClientRect().width : 0,
      flexBasis: card ? getComputedStyle(card).flexBasis : '',
      scrollable: cards ? cards.scrollWidth > cards.clientWidth + 1 : false,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      removeH: (() => { const b = document.querySelector('.cmp-col-remove'); return b ? b.getBoundingClientRect().height : 0; })(),
    };
  });
  check('移动端对比改为横向滚动卡片（表格隐藏、卡片固定 248px）',
    m.cardsShown && m.tableHidden && Math.round(m.cardWidth) === 248 && /248px/.test(m.flexBasis),
    JSON.stringify(m));
  check('移动端对比卡片可横向滚动且页面无横向溢出',
    m.scrollable && m.overflow <= 1, JSON.stringify(m));

  await mobile.goto(`${APP}#/products`, { waitUntil: 'load' });
  await mobile.waitForSelector('.pcard .name', { timeout: 30000 });
  await mobile.locator('.pcard .name').first().click();
  await mobile.waitForSelector('.pdp-mobile-actions', { timeout: 20000 });
  await mobile.waitForTimeout(600);
  await mobile.locator('.pdp-secondary-actions .cmp-toggle').click();
  await mobile.waitForTimeout(400);

  const dockGeom = await mobile.evaluate(() => {
    const dock = document.querySelector('#cmp-dock').getBoundingClientRect();
    const bar = document.querySelector('.pdp-mobile-actions').getBoundingClientRect();
    return {
      dockBottom: dock.bottom,
      dockTop: dock.top,
      barTop: bar.top,
      viewportH: window.innerHeight,
      barVisible: getComputedStyle(document.querySelector('.pdp-mobile-actions')).display !== 'none',
      pagePadBottom: getComputedStyle(document.querySelector('.pdp-page')).paddingBottom,
    };
  });
  check('移动端悬浮条不遮挡详情吸底操作栏（浮在它上方）',
    dockGeom.barVisible && dockGeom.dockBottom <= dockGeom.barTop + 1,
    JSON.stringify(dockGeom));
  check('详情页为悬浮条 + 吸底栏补足底部留白',
    parseFloat(dockGeom.pagePadBottom) >= 140, dockGeom.pagePadBottom);

  const reduced = await mobile.evaluate(() => {
    document.documentElement.classList.add('reduced-fx');
    const cs = getComputedStyle(document.querySelector('#cmp-dock'));
    const anim = cs.animationName;
    document.documentElement.classList.remove('reduced-fx');
    return anim;
  });
  check('reduced-fx 下悬浮条动效关闭', reduced === 'none', reduced);

  check('控制台零 JS 错误（过滤外部图与 /api 噪音）', consoleErrors.length === 0, consoleErrors.join(' | '));
  await mobile.close();
} catch (e) {
  failed += 1;
  console.log(`  FAIL 执行异常: ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 商品对比 / AI 搭配验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
