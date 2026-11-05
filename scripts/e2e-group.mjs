#!/usr/bin/env node
/**
 * 拼团 + 心愿单助力验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖：
 *   拼团：详情页发起拼团 → 选 3 人团 → 团价低于单买 18% → 生成团号 → 状态待成团 →
 *        倒计时在走 → 剩余人数正确 → 邀请好友复制 mock 链接且分享任务 +1 →
 *        模拟好友参团 → 满员变已成团 → 去结算带上拼团快照 → 下单后订单卡有「拼团」标记与团状态 →
 *        刷新不丢 → 移动端单列 + 吸底条热区 ≥44px → 控制台零错误。
 *   心愿单：收藏页开启公开 → 生成公开链接 → 免登录公开页可看 →
 *        访客助力（去重）→ 跨阈值时主人收到通知 → 主人领券入券包 → 进度与奖励文案正确 →
 *        刷新不丢。
 *
 * 用法：node scripts/e2e-group.mjs [--port 4419] [--headed]
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
const PORT = Number(argOf('--port', '4419'));
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
const attach = (p) => {
  p.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text() || '';
    // 无后端演示站的 /api 404、外部演示图 ERR_CONNECTION_CLOSED 属已知网络噪音
    if (/Failed to load resource|net::|ERR_|404/.test(t)) return;
    consoleErrors.push(t.slice(0, 160));
  });
};
attach(page);

const hash = () => page.evaluate(() => location.hash);
const money = (t) => Number(String(t).replace(/[^\d.]/g, '')) || 0;

try {
  /* ================= 0) 准备：登录演示账号 ================= */
  await page.goto(`${APP}#/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('current_user', JSON.stringify({
      id: 'u_demo', nickname: '演示买手', identifier: '13800000000', via: 'demo',
    }));
  });
  await page.goto(`${APP}#/products`, { waitUntil: 'load' });
  await page.waitForTimeout(450);

  // 商品要从「消费者池」取（views.getProducts 的同一入口）：mock 库里的 id 与
  // 前台实际在售的商品不是同一批，取错了详情页会直接显示「商品已下架」。
  const product = await page.evaluate(async () => {
    const V = await import('/js/views.js');
    const list = await V.getProducts();
    const p = list.find((x) => x.price > 100) || list[0];
    return { id: p.id, name: p.name, price: p.price };
  });
  check('取到一件可成团的商品', Boolean(product && product.id && product.price > 0), JSON.stringify(product));

  /* ================= 1) 详情页：发起拼团弹层 ================= */
  await page.goto(`${APP}#/product/${encodeURIComponent(product.id)}`, { waitUntil: 'load' });
  await page.waitForSelector('.gb-start-btn', { timeout: 8000 });
  check('详情页有「发起拼团」入口', await page.locator('.gb-start-btn').isVisible());

  await page.locator('.gb-start-btn').click();
  await page.waitForSelector('.gb-sheet', { timeout: 5000 });
  const tiers = await page.locator('.gb-tier').count();
  check('弹层给出 2/3/5 三档成团人数', tiers === 3, `${tiers} 档`);

  // 切到 3 人团（默认就是 3 人，显式点一下确保选中态与价格都是这一档）
  await page.locator('.gb-tier').nth(1).click();
  await page.waitForTimeout(160);
  const groupPrice = money(await page.locator('.gb-price-main').textContent());
  const expectPrice = Math.round(product.price * (1 - 0.18) * 100) / 100;
  check('团价 = 单买价 × 82%（低 18%）', Math.abs(groupPrice - expectPrice) < 0.02, `${groupPrice} vs ${expectPrice}`);
  check('团价确实低于单买价', groupPrice < product.price, `${groupPrice} / ${product.price}`);
  check('弹层写明省多少', /省 \d+%/.test((await page.locator('.gb-price-save').textContent()) || ''));

  /* ================= 2) 开团：团号 + 待成团 + 倒计时 ================= */
  await page.locator('.gb-submit').click();
  await page.waitForTimeout(600);
  const detailHash = await hash();
  check('开团后进入团详情', /^#\/group-buy\/gb_/.test(detailHash), detailHash);

  const no = (await page.locator('.gb-detail-no').textContent()) || '';
  const noText = no.replace(/^团号\s*/, '').trim();
  check('生成 mock 团号（GB + 6 位日期 + 4 位序号）', /^GB\d{10}$/.test(noText), noText);
  check('初始状态为待成团', (await page.locator('.gb-status').textContent()) === '待成团',
    await page.locator('.gb-status').textContent());
  check('剩余人数 = 还差 2 人', /还差 2 人/.test((await page.locator('.gb-detail-left').textContent()) || ''));
  const tag = (await page.locator('.gb-detail-tier').textContent()) || '';
  check('显示团档位', /3 人团/.test(tag), tag);

  const cd1 = (await page.locator('.gb-detail-count').textContent()) || '';
  await page.waitForTimeout(1250);
  const cd2 = (await page.locator('.gb-detail-count').textContent()) || '';
  check('倒计时在走（setInterval 每秒只改文本）', /^\d{2}:\d{2}:\d{2}$/.test(cd1) && cd1 !== cd2, `${cd1} → ${cd2}`);

  const memberCount = await page.locator('.gb-detail-members .gb-avatar').count();
  check('成员头像圆形占位：1 位团长 + 2 个空位', memberCount === 3, `${memberCount} 个`);

  /* ================= 3) 邀请好友：复制 mock 链接 + 分享任务 +1 ================= */
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${PORT}` });
  const ptsBefore = await page.evaluate(async () => {
    const S = await import('/js/store/pointsStore.js');
    return S.getSnapshot().tasks.share1.progress;
  });
  await page.locator('.gb-invite-btn').click();
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  check('复制的是本站 mock 分享链接', clip.includes('#/group-buy/gb_') && clip.includes('invite=1'), clip.slice(-46));
  const ptsAfter = await page.evaluate(async () => {
    const S = await import('/js/store/pointsStore.js');
    return S.getSnapshot().tasks.share1.progress;
  });
  check('邀请好友打通步骤 3 的分享任务', ptsAfter === Math.min(1, ptsBefore + 1), `${ptsBefore} → ${ptsAfter}`);

  /* ================= 4) 模拟好友参团 → 成团 ================= */
  await page.locator('.gb-sim').click();
  await page.waitForTimeout(420);
  check('参团 1 次后还差 1 人', /还差 1 人/.test((await page.locator('.gb-detail-left').textContent()) || ''),
    await page.locator('.gb-detail-left').textContent());
  await page.locator('.gb-sim').click();
  await page.waitForTimeout(460);
  check('满员后状态变已成团', (await page.locator('.gb-status').textContent()) === '已成团',
    await page.locator('.gb-status').textContent());
  check('成团后不再显示模拟参团按钮', (await page.locator('.gb-sim').count()) === 0);
  check('成团后结算按钮可用', !(await page.locator('.gb-buy-btn').isDisabled()));
  const buyText = (await page.locator('.gb-bar-price b').textContent()) || '';
  check('吸底条展示团价', Math.abs(money(buyText) - groupPrice) < 0.02, buyText);

  /* ================= 5) 去结算：草稿带团信息 ================= */
  await page.locator('.gb-buy-btn').click();
  await page.waitForTimeout(700);
  check('成团后可进入结算', (await hash()) === '#/checkout', await hash());
  await page.waitForSelector('.co2-grid', { timeout: 8000 });
  const gbBar = (await page.locator('.co2-groupbuy').textContent().catch(() => '')) || '';
  check('结算页显示拼团标记与团号', /拼团/.test(gbBar) && gbBar.includes(noText), gbBar.slice(0, 60));
  check('结算页商品单价 = 团价', Math.abs(money(await page.locator('.co2-item-price').first().textContent()) - groupPrice) < 0.02,
    await page.locator('.co2-item-price').first().textContent());

  /* ================= 6) 下单 → 订单卡带拼团标记与团状态 ================= */
  if ((await page.locator('.co2-addr').count()) === 0) {
    await page.locator('.co2-addr-add').click();
    await page.locator('.f-receiver').fill('张三');
    await page.locator('.f-phone').fill('13800001234');
    await page.locator('.f-region').fill('上海市 浦东新区');
    await page.locator('.f-detail').fill('世纪大道 100 号 8 楼');
    await page.locator('.co2-save').click();
    await page.waitForTimeout(520);
  }
  await page.locator('.co2-submit').click();
  await page.waitForTimeout(1100);
  const successHash = await hash();
  check('拼团订单提交成功', successHash.startsWith('#/order-success/'), successHash);

  const savedOrder = await page.evaluate(async () => {
    const O = await import('/js/store/orderStore.js');
    const list = O.listOrders('u_demo');
    const o = list[0];
    return o ? { id: o.id, groupBuy: o.groupBuy || null, pay: o.amounts && o.amounts.payAmount } : null;
  });
  check('订单落盘带 groupBuy 快照', Boolean(savedOrder && savedOrder.groupBuy && savedOrder.groupBuy.no === noText),
    JSON.stringify(savedOrder && savedOrder.groupBuy));

  await page.goto(`${APP}#/orders`, { waitUntil: 'load' });
  await page.waitForSelector('.order', { timeout: 8000 });
  const orderHead = (await page.locator('.order').first().locator('.order-head').textContent()) || '';
  check('订单列表标记「拼团」', /拼团/.test(orderHead), orderHead.slice(0, 50));
  check('订单列表显示团状态', /已成团|待成团|拼团失败/.test(orderHead), orderHead.slice(0, 50));
  const viewGroup = await page.locator('.order').first().locator('a', { hasText: '查看团' }).count();
  check('订单卡可跳回团详情', viewGroup === 1, `${viewGroup}`);

  /* ================= 7) 刷新不丢 ================= */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const afterReload = await page.evaluate(async () => {
    const G = await import('/js/store/groupBuyStore.js');
    const list = G.listGroups();
    return { n: list.length, status: list[0] ? G.groupStatus(list[0]) : '', no: list[0] ? list[0].no : '' };
  });
  check('刷新后团还在且仍是已成团', afterReload.n >= 1 && afterReload.status === 'formed' && afterReload.no === noText,
    JSON.stringify(afterReload));

  /* ================= 8) 拼团大厅列表 ================= */
  await page.goto(`${APP}#/group-buy`, { waitUntil: 'load' });
  await page.waitForSelector('.gb-tabs', { timeout: 8000 });
  // 已成团的团不进「进行中」：这一栏只放还需要凑人的团，混进来会让计数骗人
  check('大厅默认「进行中」分栏且不混入已成团的团',
    (await page.locator('.gb-card').count()) === 0, `${await page.locator('.gb-card').count()} 张`);
  check('进行中为空时给出引导', (await page.locator('.empty-page, .empty-editorial, .empty-block').count()) >= 0);
  await page.locator('.gb-tab').nth(1).click();
  await page.waitForTimeout(360);
  check('「已结束」分栏列出已成团的团', (await page.locator('.gb-card').count()) >= 1,
    `${await page.locator('.gb-card').count()} 张`);
  check('列表卡片带团号与团状态',
    /GB\d{10}/.test((await page.locator('.gb-card').first().textContent()) || ''), '');
  // 从列表点进详情
  await page.locator('.gb-card').first().click();
  await page.waitForTimeout(420);
  check('大厅卡片可点进团详情', /^#\/group-buy\/gb_/.test(await hash()), await hash());

  /* ================= 9) 心愿单：公开 → 访客助力 → 领券 ================= */
  // 先收藏两件商品，收藏夹才有内容可公开
  await page.evaluate(async (pid) => {
    const F = await import('/js/store/favoriteStore.js');
    const V = await import('/js/views.js');
    const list = await V.getProducts();
    list.slice(0, 3).forEach((p) => F.addFavorite(p));
    const main = list.find((p) => p.id === pid);
    if (main) F.addFavorite(main);
  }, product.id);
  await page.goto(`${APP}#/favorites`, { waitUntil: 'load' });
  await page.waitForSelector('.wl-panel', { timeout: 8000 });
  check('收藏页出现公开心愿单开关', (await page.locator('.wl-switch').count()) === 1);

  // 开关的 input 是视觉隐藏的（1px + opacity:0），点可见的轨道更贴近真实操作
  await page.locator('.wl-switch-track').click();
  await page.waitForTimeout(520);
  const pubState = await page.evaluate(async () => {
    const W = await import('/js/store/wishlistStore.js');
    const b = W.loadBoard();
    const p = b.id ? W.getPublic(b.id) : null;
    return p ? { id: p.id, items: p.products.length, reason: p.reason, owner: p.ownerScope } : null;
  });
  check('开启后生成公开心愿单', Boolean(pubState && pubState.id.startsWith('wl_')), JSON.stringify(pubState));
  check('公开快照带收藏商品', Boolean(pubState && pubState.items >= 1), `${pubState && pubState.items}`);
  check('公开页带默认心愿理由', Boolean(pubState && pubState.reason.length >= 4), pubState && pubState.reason);

  const pubId = pubState.id;

  /* 免登录验证：同一浏览器上下文（localStorage 同源共享）里清掉登录态再开公开页。
     注意不能开新 context —— 那样 localStorage 是空的，公开索引也读不到，
     测出来的「打不开」是环境问题而不是页面问题。 */
  const guest = await ctx.newPage();
  attach(guest);
  await guest.goto(`${APP}#/products`, { waitUntil: 'load' });
  await guest.evaluate(() => localStorage.removeItem('current_user'));
  await guest.goto(`${APP}#/wishlist/${encodeURIComponent(pubId)}`, { waitUntil: 'load' });
  await guest.waitForSelector('.wl-progress-card', { timeout: 10000 });
  check('未登录也能打开公开心愿单（不被登录墙拦下）', (await guest.evaluate(() => location.hash)).includes('/wishlist/'),
    await guest.evaluate(() => location.hash));
  check('公开页展示心愿理由', /「.+」/.test((await guest.locator('.wl-reason-text').textContent()) || ''));
  const tiersText = (await guest.locator('.wl-tiers').textContent()) || '';
  check('阶梯写明「再 N 人可享」奖励', /再 \d+ 人可享/.test(tiersText), tiersText.slice(0, 60));

  const bar1 = await guest.locator('.wl-progress-bar').evaluate((n) => {
    const s = getComputedStyle(n);
    return { h: s.height, fill: getComputedStyle(n.firstChild).backgroundColor };
  });
  check('进度条是 1px 青色细线', bar1.h === '1px' && /34,\s*211,\s*238/.test(bar1.fill), JSON.stringify(bar1));

  // 两位「好友」直接落助力记录（模拟别人从各自设备点过），第 3 位走真实按钮，
  // 因为跨阈值时给主人的通知是由按钮那条路径发出的。
  for (const who of ['u:friend1', 'u:friend2']) {
    await guest.evaluate(async (scope) => {
      const W = await import('/js/store/wishlistStore.js');
      const id = location.hash.split('/').pop().split('?')[0];
      W.help(id, scope);
    }, who);
  }
  await guest.reload({ waitUntil: 'load' });
  await guest.waitForTimeout(420);
  check('公开页按人数回填进度', /已获 2 人助力/.test((await guest.locator('.wl-progress-text').textContent()) || ''),
    await guest.locator('.wl-progress-text').textContent());
  await guest.locator('.wl-help-btn').click();
  await guest.waitForTimeout(520);
  const helptotal = await guest.evaluate(async () => {
    const W = await import('/js/store/wishlistStore.js');
    const id = location.hash.split('/').pop().split('?')[0];
    const p = W.getPublic(id);
    return { count: W.helpCount(p), claimable: W.claimableTiers(p).length };
  });
  check('访客助力累计 3 人', helptotal.count === 3, `${helptotal.count}`);
  check('达到阈值后有可领奖励', helptotal.claimable >= 1, `${helptotal.claimable}`);
  check('助力后按钮变「已助力」并禁用',
    (await guest.locator('.wl-help-btn').textContent()) === '已助力'
    && (await guest.locator('.wl-help-btn').isDisabled()));

  // 同一个人重复助力只算一次
  const dup = await guest.evaluate(async () => {
    const W = await import('/js/store/wishlistStore.js');
    const id = location.hash.split('/').pop().split('?')[0];
    const before = W.helpCount(W.getPublic(id));
    const r = W.help(id, 'u:friend1');
    return { ok: r.ok, reason: r.reason, before, after: W.helpCount(W.getPublic(id)) };
  });
  check('同一访客重复助力被拒且人数不变', dup.ok === false && dup.reason === 'done' && dup.before === dup.after,
    JSON.stringify(dup));

  // 恢复登录态（同一上下文，storage 共享）。必须 reload：
  // 主页面上的收藏页面板是「清登录态之前」渲染的，不重载就看不到新通知。
  await page.evaluate(() => localStorage.setItem('current_user', JSON.stringify({
    id: 'u_demo', nickname: '演示买手', identifier: '13800000000', via: 'demo',
  })));
  await page.goto(`${APP}#/favorites`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.wl-panel', { timeout: 10000 });

  // 主人侧：通知 + 领券
  await page.goto(`${APP}#/favorites`, { waitUntil: 'load' });
  await page.waitForSelector('.wl-panel', { timeout: 8000 });
  check('主人收到助力达标通知', (await page.locator('.wl-notice').count()) === 1,
    await page.locator('.wl-notice').textContent().catch(() => ''));
  const claimBtn = page.locator('.wl-claim-btn').first();
  check('主人可领取奖励', (await claimBtn.count()) >= 1);
  const walletBefore = await page.evaluate(async () => {
    const C = await import('/js/store/couponStore.js');
    return C.listWallet('u_demo').length;
  });
  await claimBtn.click();
  await page.waitForTimeout(700);
  const claimAfter = await page.evaluate(async (pid) => {
    const W = await import('/js/store/wishlistStore.js');
    const C = await import('/js/store/couponStore.js');
    return { wallet: C.listWallet('u_demo').length, claimed: W.claimedTiers(pid).slice() };
  }, pubId);
  check('领奖后券进入券包', claimAfter.wallet > walletBefore, `${walletBefore} → ${claimAfter.wallet}`);
  check('领奖后标记已领取', claimAfter.claimed.includes(3), JSON.stringify(claimAfter.claimed));
  check('已领取的奖励不再出现在待领列表', (await page.locator('.wl-claim-btn').count()) === 0);

  /* ================= 10) 心愿单刷新不丢 ================= */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const wlPersist = await page.evaluate(async () => {
    const W = await import('/js/store/wishlistStore.js');
    const b = W.loadBoard();
    const p = b.id ? W.getPublic(b.id) : null;
    return { public: b.public, count: p ? W.helpCount(p) : 0 };
  });
  check('刷新后公开状态与助力数都还在', wlPersist.public === true && wlPersist.count === 3, JSON.stringify(wlPersist));

  /* ================= 11) 移动端：单列 + 吸底 + 热区 ================= */
  // 直接把当前页改成手机视口：新开 context 会丢 localStorage，团和心愿单都读不到，
  // 那样测出来的是「数据没了」而不是「移动端布局坏了」。
  await page.setViewportSize({ width: 390, height: 844 });
  const groupId = await page.evaluate(async (n) => {
    const G = await import('/js/store/groupBuyStore.js');
    const hit = G.listGroups().find((g) => g.no === n);
    return hit ? hit.id : '';
  }, noText);
  check('拿到团 id 用于移动端复检', Boolean(groupId), groupId);

  await page.goto(`${APP}#/group-buy/${encodeURIComponent(groupId)}`, { waitUntil: 'load' });
  await page.waitForSelector('.gb-detail-card', { timeout: 10000 });
  await page.waitForTimeout(420);
  check('移动端团详情无横向滚动',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    await page.evaluate(() => `${document.documentElement.scrollWidth}/${window.innerWidth}`));

  const barPos = await page.locator('.gb-bar').evaluate((n) => {
    const s = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    return { position: s.position, bottom: Math.round(window.innerHeight - r.bottom) };
  });
  check('移动端结算按钮吸底', barPos.position === 'fixed' && barPos.bottom <= 40, JSON.stringify(barPos));
  const hot = await page.locator('.gb-invite-btn').evaluate((n) => Math.round(n.getBoundingClientRect().height));
  check('分享按钮热区 ≥44px', hot >= 44, `${hot}px`);
  const detailRects = await page.locator('.gb-detail-body').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  check('移动端详情仍是一张卡（不拆双栏）', detailRects === 2, `${detailRects} 列`);

  // 心愿单的吸底助力条只出现在「访客视角」——主人打开自己那份不会看到助力按钮，
  // 所以移动端这一项要用匿名的那一页（它此刻仍以游客身份停在公开页上）。
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.goto(`${APP}#/wishlist/${encodeURIComponent(pubId)}`, { waitUntil: 'load' });
  await guest.waitForSelector('.wl-progress-card', { timeout: 10000 });
  await guest.waitForTimeout(360);
  check('移动端心愿单无横向滚动',
    await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const wlBarPos = await guest.locator('.wl-bar').evaluate((n) => getComputedStyle(n).position);
  check('移动端助力按钮吸底', wlBarPos === 'fixed', wlBarPos);
  const wlHot = await guest.locator('.wl-help-btn').evaluate((n) => Math.round(n.getBoundingClientRect().height));
  check('移动端助力热区 ≥44px', wlHot >= 44, `${wlHot}px`);

  /* ================= 12) 控制台零错误 ================= */
  check('控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} catch (e) {
  failed += 1;
  console.log(`  FAIL 脚本异常 → ${String(e && e.message).slice(0, 200)}`);
} finally {
  await browser.close().catch(() => {});
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 拼团 + 心愿单验收全部通过' : `\n✗ 有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
