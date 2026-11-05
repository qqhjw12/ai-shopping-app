#!/usr/bin/env node
/**
 * AI 盲盒 / 每日一签验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖：首页入口与呼吸动效 / 今日一签每天只生成一次 + 收下 + 20 积分再抽 /
 *       偏好可选可不选且最多 2 个 / 开盒 300ms 一次性动效 / 推荐理由结合偏好 /
 *       结果来自真实商品库 / 收藏·加购·详情 / 换一个每日 3 次 + 积分兑换 + 硬上限 /
 *       刷新持久化 / 按用户与日期隔离 / 移动端单列 44px / reduced-fx 降级 / 控制台零错。
 *
 * 用法：node scripts/e2e-blindbox.mjs [--port 4415] [--headed]
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
const PORT = Number(argOf('--port', '4415'));
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
    // 无后端演示站的 /api 404、外部演示图 ERR_CONNECTION_CLOSED 均属已知网络噪音
    if (/Failed to load resource|net::|ERR_|404/.test(t)) return;
    consoleErrors.push(t.slice(0, 140));
  });
};
attachErrors(page);

const bbState = () => page.evaluate(async () => {
  const S = await import('/js/store/blindboxStore.js');
  return S.getSnapshot();
});
const ptsState = () => page.evaluate(async () => {
  const P = await import('/js/store/pointsStore.js');
  return P.getSnapshot();
});
const call = (mod, fn, ...a) => page.evaluate(async ({ m, f, args: ar }) => {
  const M = await import(`/js/${m}`);
  return M[f](...ar);
}, { m: mod, f: fn, args: a });

async function grantPoints(n) {
  await page.evaluate(async (v) => {
    const P = await import('/js/store/pointsStore.js');
    const st = P.getSnapshot();
    st.account.points = v;
    st.account.totalEarned = Math.max(st.account.totalEarned, v);
    localStorage.setItem(P.storageKey(), JSON.stringify(st));
  }, n);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
}

async function home() {
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.waitForSelector('.ft-card', { timeout: 30000 });
  await page.waitForTimeout(300);
}
async function boxPage() {
  await page.goto(`${APP}#/blindbox`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.querySelector('#bb-open-btn');
    // 已开盒时必须等商品池到位后重绘出的真实卡片，避免拿到 pool=[] 的占位态
    return Boolean(document.querySelector('.bb-pcard')) || (b && !b.disabled);
  }, null, { timeout: 30000 });
  await page.waitForTimeout(250);
}
const curReason = () => page.locator('.bb-reason-text').textContent();

try {
  /* ---------------- 0) 干净起点 ---------------- */
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await home();

  /* ---------------- 1) 首页入口 ---------------- */
  const entry = await page.evaluate(() => {
    const a = document.querySelector('.hp-mod--blindbox');
    if (!a) return null;
    const s = getComputedStyle(a);
    return {
      href: a.getAttribute('href'),
      n: a.querySelector('.hp-mod-n')?.textContent,
      title: a.querySelector('.hp-mod-t')?.textContent,
      border: s.borderTopWidth,
      anim: s.animationName,
      iter: s.animationIterationCount,
      col: s.gridColumnStart,
    };
  });
  check('首页第 07 张模块卡「AI 盲盒」指向 #/blindbox',
    Boolean(entry) && entry.href === '#/blindbox' && entry.n === '07' && entry.title === 'AI 盲盒',
    JSON.stringify(entry));
  check('入口用 1px 青色细线，呼吸只做有限 3 次且不循环',
    Boolean(entry) && entry.border === '1px' && entry.anim === 'bb-breathe' && entry.iter === '3',
    JSON.stringify(entry));
  await page.locator('.hp-mod--blindbox').click();
  await page.waitForTimeout(700);
  check('点击入口真的路由到 #/blindbox', page.url().includes('#/blindbox'), page.url());

  /* ---------------- 2) 首页「今日一签」 ---------------- */
  await home();
  const ft = await page.evaluate(() => {
    const c = document.querySelector('.ft-card');
    if (!c) return null;
    const q = c.querySelector('.ft-quote');
    const d = c.querySelector('.ft-date');
    return {
      bg: getComputedStyle(c).backgroundColor,
      quote: q?.textContent,
      quoteSize: q && parseFloat(getComputedStyle(q).fontSize),
      serif: q && /Playfair|Songti|SimSun|Georgia|serif/i.test(getComputedStyle(q).fontFamily),
      date: d?.textContent,
      mono: d && /mono|Menlo|Consolas/i.test(getComputedStyle(d).fontFamily),
      good: c.querySelector('.ft-good-name')?.textContent,
      href: c.querySelector('.ft-good-name')?.getAttribute('href'),
    };
  });
  check('首页今日一签卡：surface-2 底 / 衬线 18–20px 签文 / 等宽日期',
    Boolean(ft) && ft.bg === 'rgb(20, 27, 37)' && ft.quoteSize >= 18 && ft.quoteSize <= 20
    && ft.serif && ft.mono && /^\d{4} \/ \d{2} \/ \d{2}$/.test(ft.date || ''),
    JSON.stringify(ft));
  const f0 = await bbState();
  check('签文与今日好物已生成，签文是安静短句（无运势/中奖措辞）',
    Boolean(f0.fortune.quote) && f0.fortune.quote.length >= 8
    && !/吉|凶|运势|中奖|抽奖|转运/.test(f0.fortune.quote) && Boolean(ft.good),
    f0.fortune.quote);
  const goodInCatalog = await page.evaluate(async (href) => {
    const V = await import('/js/views.js');
    const list = await V.getProducts();
    const id = decodeURIComponent(String(href || '').split('#/product/')[1] || '').split('?')[0];
    return list.some((p) => String(p.id) === id);
  }, ft.href);
  check('今日好物来自真实商品库且可点进详情', goodInCatalog && String(ft.href).includes('#/product/'), ft.href);

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.ft-card', { timeout: 30000 });
  const f1 = await bbState();
  check('刷新后签文 / 好物 / 日期不变（每天只生成一次）',
    f1.fortune.quote === f0.fortune.quote && f1.fortune.productId === f0.fortune.productId
    && f1.fortune.date === f0.fortune.date,
    `${f0.fortune.quoteId} → ${f1.fortune.quoteId}`);

  /* 收下今日好物 */
  const favBefore = await call('store/favoriteStore.js', 'favoriteIds');
  await page.locator('.ft-accept').click();
  await page.waitForTimeout(350);
  const favAfter = await call('store/favoriteStore.js', 'favoriteIds');
  const accepted = await bbState();
  check('「收下今日好物」真的写入收藏夹，按钮变「已收下」',
    favAfter.includes(f1.fortune.productId) && favAfter.length === favBefore.length + 1
    && accepted.fortune.accepted && await page.locator('.ft-accept').isDisabled(),
    JSON.stringify({ pid: f1.fortune.productId, favAfter }));

  /* 再抽一次：积分不足禁用 → 补足后真实扣 20 分 */
  check('积分不足时「再抽一次」按钮禁用', await page.locator('.ft-reroll').isDisabled());
  await grantPoints(60);
  await home();
  const pBefore = (await ptsState()).account.points;
  const rerollEnabled = !(await page.locator('.ft-reroll').isDisabled());
  await page.locator('.ft-reroll').click();
  await page.waitForTimeout(400);
  const pAfter = await ptsState();
  const f2 = await bbState();
  check('再抽一次真实扣 20 积分并写「兑换」流水',
    rerollEnabled && pBefore - pAfter.account.points === 20
    && pAfter.ledger[0].type === '兑换' && pAfter.ledger[0].amount === -20,
    JSON.stringify({ pBefore, after: pAfter.account.points, top: pAfter.ledger[0] }));
  check('再抽后签文与好物都变，且每日限 1 次（按钮禁用）',
    f2.fortune.quote !== f1.fortune.quote && f2.fortune.productId !== f1.fortune.productId
    && f2.fortune.rerolls === 1 && await page.locator('.ft-reroll').isDisabled(),
    JSON.stringify({ q: f2.fortune.quote, pid: f2.fortune.productId, rerolls: f2.fortune.rerolls }));
  const twice = await page.evaluate(async () => {
    const S = await import('/js/store/blindboxStore.js');
    const V = await import('/js/views.js');
    return S.doRerollFortune(await V.getProducts());
  });
  check('第二次再抽被数据层拦截，积分不重复扣', twice.ok === false && twice.reason === 'limit'
    && (await ptsState()).account.points === pAfter.account.points, JSON.stringify(twice));

  /* ---------------- 3) 盲盒页结构与偏好 ---------------- */
  await boxPage();
  const panel = await page.evaluate(() => {
    const n = document.querySelector('.bb-panel');
    const s = n && getComputedStyle(n);
    return s && { bg: s.backgroundColor, border: s.borderTopWidth, borderColor: s.borderTopColor, radius: s.borderTopLeftRadius };
  });
  check('盲盒面板：surface-1 + 1px 青色边框 + 16px 圆角',
    Boolean(panel) && panel.bg === 'rgb(15, 20, 28)' && panel.border === '1px'
    && panel.radius === '16px' && /34, 211, 238/.test(panel.borderColor),
    JSON.stringify(panel));

  const dims = await page.locator('.bb-pref-row').count();
  const chips = await page.locator('.bb-chip').count();
  check('三个偏好维度（预算 / 场景 / 心情）且可不选', dims === 3 && chips === 14,
    `dims=${dims} chips=${chips}`);
  await page.locator('.bb-chip[data-pref="b1"]').click();
  await page.locator('.bb-chip[data-pref="s1"]').click();
  await page.locator('.bb-chip[data-pref="m1"]').click();
  await page.waitForTimeout(200);
  check('最多同时选 2 个偏好维度，第三个被拦（含 toast 提示）',
    await page.locator('.bb-chip[data-pref="b1"]').getAttribute('aria-pressed') === 'true'
    && await page.locator('.bb-chip[data-pref="s1"]').getAttribute('aria-pressed') === 'true'
    && await page.locator('.bb-chip[data-pref="m1"]').getAttribute('aria-pressed') === 'false'
    && (await bbState()).box.opened === false);
  await page.locator('#bb-prefs-clear').click();
  await page.waitForTimeout(150);
  check('可清空偏好回到「不设限」', (await page.locator('.bb-prefs-summary').textContent()).includes('不设限'));

  /* ---------------- 4) 开盒与一次性动效 ---------------- */
  await page.locator('.bb-chip[data-pref="b1"]').click();
  await page.locator('.bb-chip[data-pref="s1"]').click();
  await page.waitForTimeout(150);
  await page.locator('#bb-open-btn').click();
  const anim = await page.evaluate(() => {
    const w = document.querySelector('.bb-result');
    const f = w && w.querySelector('.bb-reveal-frame');
    const s = f && getComputedStyle(f);
    return {
      opening: Boolean(w && w.classList.contains('is-opening')),
      name: s && s.animationName,
      dur: s && s.animationDuration,
      iter: s && s.animationIterationCount,
      border: s && s.borderTopWidth,
    };
  });
  check('开盒动效：1px 青色方框从中心展开 300ms、只播一次',
    anim.opening && anim.name === 'bb-open' && anim.dur === '0.3s'
    && anim.iter === '1' && anim.border === '1px', JSON.stringify(anim));
  await page.waitForTimeout(620);
  check('动效一次性结束后自动移除 is-opening（无无限循环）',
    await page.locator('.bb-result.is-opening').count() === 0);

  const openState = await bbState();
  const cardInfo = await page.evaluate(() => ({
    tag: document.querySelector('.bb-result-tag')?.textContent,
    name: document.querySelector('.bb-pcard .name')?.textContent,
    reason: document.querySelector('.bb-reason-text')?.textContent,
    hasFav: Boolean(document.querySelector('.bb-pcard .card-fav')),
    hasAdd: Boolean(document.querySelector('.bb-pcard .thumb-add')),
    hasDetail: Boolean(document.querySelector('.bb-pcard .actions .ghost')),
  }));
  check('结果展示商品卡 + 等宽小字「AI BLINDBOX / 盲盒开出」+ 一行推荐理由',
    Boolean(cardInfo.name) && /AI BLINDBOX/.test(cardInfo.tag || '')
    && (cardInfo.reason || '').length > 8 && cardInfo.hasFav && cardInfo.hasAdd && cardInfo.hasDetail,
    JSON.stringify(cardInfo));
  check('推荐理由结合了所选偏好（含「300 元以内」）',
    (cardInfo.reason || '').includes('300 元以内'), cardInfo.reason);
  const inCatalog = await page.evaluate(async (id) => {
    const V = await import('/js/views.js');
    return (await V.getProducts()).some((p) => String(p.id) === String(id));
  }, openState.box.current.productId);
  check('开出的商品 id 能在真实商品库中找到（结果与商品库有关）', inCatalog,
    openState.box.current.productId);

  /* ---------------- 5) 收藏 / 加购 / 详情 ---------------- */
  const pid = openState.box.current.productId;
  const favB = await call('store/favoriteStore.js', 'favoriteIds');
  await page.locator('.bb-pcard .card-fav').click();
  await page.waitForTimeout(300);
  const favA = await call('store/favoriteStore.js', 'favoriteIds');
  check('盲盒商品可加入收藏（写入按用户隔离的收藏夹）',
    !favB.includes(pid) && favA.includes(pid), JSON.stringify({ pid, favA }));

  const cartB = await call('state.js', 'getCart');
  await page.locator('.bb-pcard .thumb-add').click();
  await page.waitForTimeout(300);
  const cartA = await call('state.js', 'getCart');
  check('盲盒商品可加入购物袋', cartA.length === cartB.length + 1
    && cartA.some((i) => String(i.id) === String(pid)), JSON.stringify({ before: cartB.length, after: cartA.length }));

  await page.locator('.bb-pcard .actions .ghost').click();
  await page.waitForTimeout(800);
  check('盲盒商品可查看详情（真实 #/product/ 路由）',
    page.url().includes(`#/product/${pid}`), page.url());

  /* ---------------- 6) 换一个：3 次免费 + 2 次积分 + 硬上限 ---------------- */
  await boxPage();
  const afterRefresh = await bbState();
  check('刷新后已开出的盲盒结果、理由、次数都保持',
    afterRefresh.box.opened && afterRefresh.box.current.productId === pid
    && afterRefresh.box.current.reason === cardInfo.reason && afterRefresh.box.draws === 1,
    JSON.stringify({ pid: afterRefresh.box.current.productId, draws: afterRefresh.box.draws }));

  const swapIds = [pid];
  const swapReasons = [cardInfo.reason];
  for (let i = 0; i < 3; i += 1) {
    await page.locator('#bb-swap-btn').click();
    await page.waitForTimeout(420);
    const s = await bbState();
    swapIds.push(s.box.current.productId);
    swapReasons.push(await curReason());
  }
  const q3 = await bbState();
  check('「换一个」每日免费 3 次，每次商品不重复且理由不与上一次相同',
    q3.box.swaps === 3 && q3.box.draws === 4
    && new Set(swapIds).size === 4
    && swapReasons.every((r, i) => i === 0 || r !== swapReasons[i - 1]),
    JSON.stringify({ ids: swapIds, swaps: q3.box.swaps, reasons: swapReasons }));

  await grantPoints(100);
  await boxPage();
  const via = await page.locator('#bb-swap-btn').getAttribute('data-via');
  const pPre = (await ptsState()).account.points;
  check('免费额度用尽后按钮切换为「20 积分兑换 1 次」', via === 'points'
    && (await page.locator('#bb-swap-btn').textContent()).includes('20 积分'), String(via));
  await page.locator('#bb-swap-btn').click();
  await page.waitForTimeout(420);
  await page.locator('#bb-swap-btn').click();
  await page.waitForTimeout(420);
  const q6 = await bbState();
  const pPost = (await ptsState()).account.points;
  check('积分兑换 2 次共扣 40 分并写「兑换」流水，总抽取达硬上限 6 次',
    q6.box.pointSwaps === 2 && q6.box.draws === 6 && pPre - pPost === 40
    && (await ptsState()).ledger.filter((x) => x.type === '兑换' && x.amount === -20).length >= 2,
    JSON.stringify({ draws: q6.box.draws, pointSwaps: q6.box.pointSwaps, pPre, pPost }));
  check('第 7 次被硬上限拦住：按钮禁用 + 耗尽提示 + 任务中心入口',
    await page.locator('#bb-swap-btn').isDisabled()
    && await page.locator('.bb-exhausted').count() === 1
    && (await page.locator('.bb-exhausted').textContent()).includes('去任务中心'),
    JSON.stringify(await bbState().then((s) => s.box.draws)));
  const over = await page.evaluate(async () => {
    const S = await import('/js/store/blindboxStore.js');
    const V = await import('/js/views.js');
    return S.doSwap(await V.getProducts(), {});
  });
  check('数据层同样拒绝超额抽取，积分不重复扣',
    over.ok === false && over.reason === 'limit'
    && (await ptsState()).account.points === pPost, JSON.stringify(over));

  /* ---------------- 7) 按日期与用户隔离 ---------------- */
  await page.evaluate(async () => {
    const S = await import('/js/store/blindboxStore.js');
    const st = S.getSnapshot();
    st.date = '2026-11-04';
    localStorage.setItem(S.storageKey(), JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const nextDay = await bbState();
  check('跨天后当日次数与一签状态整体重置',
    nextDay.box.draws === 0 && !nextDay.box.opened && nextDay.fortune.date === '');

  const ownKey = await page.evaluate(async () => (await import('/js/store/blindboxStore.js')).storageKey());
  await page.evaluate(() => localStorage.setItem('current_user', JSON.stringify({ id: 'u_bb_other' })));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const other = await bbState();
  check('切到另一用户：盲盒与一签都是全新的，积分归零',
    other.scope !== nextDay.scope && other.box.draws === 0 && other.fortune.date === ''
    && (await ptsState()).account.points === 0,
    JSON.stringify({ scope: other.scope, draws: other.box.draws }));
  await page.evaluate(() => localStorage.removeItem('current_user'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(700);
  const back = await bbState();
  check('切回原用户：状态按原桶恢复，storageKey 不变',
    back.scope === nextDay.scope
    && (await page.evaluate(async () => (await import('/js/store/blindboxStore.js')).storageKey())) === ownKey,
    JSON.stringify({ scope: back.scope, ownKey }));

  /* ---------------- 8) 移动端与降级 ---------------- */
  const mobile = await browser.newPage({
    viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
  });
  attachErrors(mobile);
  await mobile.goto(`${APP}#/blindbox`, { waitUntil: 'load' });
  await mobile.waitForSelector('.bb-panel', { timeout: 30000 });
  await mobile.waitForTimeout(700);
  const m = await mobile.evaluate(() => {
    const row = document.querySelector('.bb-pref-row');
    const chip = document.querySelector('.bb-chip');
    const btn = document.querySelector('.bb-btn');
    return {
      cols: row && getComputedStyle(row).gridTemplateColumns.split(' ').length,
      chipH: chip && chip.getBoundingClientRect().height,
      btnH: btn && btn.getBoundingClientRect().height,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      reduced: document.documentElement.classList.contains('reduced-fx'),
    };
  });
  check('移动端单列、偏好与按钮热区 ≥44px、无横向滚动、reduced-fx 自动开启',
    m.cols === 1 && m.chipH >= 44 && m.btnH >= 44 && m.overflow <= 1 && m.reduced,
    JSON.stringify(m));

  await mobile.evaluate(() => localStorage.clear());
  await mobile.reload({ waitUntil: 'load' });
  await mobile.waitForSelector('#bb-open-btn:not([disabled])', { timeout: 30000 });
  await mobile.locator('#bb-open-btn').click();
  const degraded = await mobile.evaluate(() => {
    const f = document.querySelector('.bb-reveal-frame');
    return f ? getComputedStyle(f).animationName : 'missing';
  });
  check('reduced-fx 下开盒动效关闭但结果照常显示',
    degraded === 'none' && await mobile.locator('.bb-pcard').count() === 1, degraded);

  await mobile.goto(`${APP}#/`, { waitUntil: 'load' });
  await mobile.waitForSelector('.hp-mod--blindbox', { timeout: 30000 });
  const homeEntry = await mobile.evaluate(() => {
    const a = document.querySelector('.hp-mod--blindbox');
    return { col: a && getComputedStyle(a).gridColumnStart, anim: a && getComputedStyle(a).animationName };
  });
  check('移动端首页盲盒入口跨整行且呼吸动画降级',
    homeEntry.anim === 'none' && homeEntry.col !== 'auto', JSON.stringify(homeEntry));

  check('控制台零 JS 错误（过滤外部图与 /api 噪音）', consoleErrors.length === 0, consoleErrors.join(' | '));
  await mobile.close();
} catch (e) {
  failed += 1;
  console.log(`  FAIL 套件异常: ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ AI 盲盒 / 每日一签验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
