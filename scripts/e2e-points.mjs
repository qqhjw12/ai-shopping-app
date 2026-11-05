#!/usr/bin/env node
/**
 * 积分 / 每日签到 / 任务中心验收（playwright-core + 本机 Edge，纯静态站即可）。
 *
 * 覆盖：签到可签 / 连续 3、7 天加成 / 断签重置 / 同日重复拦截 /
 *       真实行为驱动进度（浏览·收藏·分享走 UI，其余走事件层直调）/ 领取入账写流水 /
 *       等级进度 / 刷新持久化 / 按用户隔离 / 个人中心入口 / 移动端 /
 *       深空令牌样式 / 无弹窗 / 无无限循环动画 / 控制台零错误。
 *
 * 用法：node scripts/e2e-points.mjs [--port 4411] [--headed]
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
const PORT = Number(argOf('--port', '4411'));
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
await page.addInitScript(() => {
  window.__ptDialogs = 0;
  const a = window.alert;
  const c = window.confirm;
  window.alert = (...x) => { window.__ptDialogs += 1; return a ? a.apply(window, x) : undefined; };
  window.confirm = (...x) => { window.__ptDialogs += 1; return c ? c.apply(window, x) : false; };
});

const state = () => page.evaluate(async () => {
  const S = await import('/js/store/pointsStore.js');
  return S.getSnapshot();
});

/** 只改账户字段并重载，用于构造连续签到 / 断签 / 等级场景（日期由数据层纯函数算出） */
async function patchAccount(patch) {
  await page.evaluate(async (p) => {
    const S = await import('/js/store/pointsStore.js');
    const st = S.getSnapshot();
    Object.assign(st.account, p);
    localStorage.setItem(S.storageKey(), JSON.stringify(st));
  }, patch);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(450);
}

async function openPoints() {
  await page.goto(`${APP}#/points`, { waitUntil: 'load' });
  await page.waitForTimeout(500);
}

try {
  /* ---------------- 0) 干净起点 ---------------- */
  await openPoints();
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);

  /* ---------------- 1) 页面结构与深空令牌样式 ---------------- */
  const structure = await page.evaluate(() => {
    const card = document.querySelector('.pt-card');
    const value = document.querySelector('.pt-points-value');
    const track = document.querySelector('.pt-level-track');
    const btn = document.querySelector('.pt-signin-btn');
    const cs = (n) => getComputedStyle(n);
    return {
      page: Boolean(document.querySelector('.pt-page')),
      signin: Boolean(document.querySelector('.pt-signin-card')),
      tasks: document.querySelectorAll('.pt-task').length,
      cal: document.querySelectorAll('.pt-cal .pt-day').length,
      ledger: Boolean(document.querySelector('.pt-ledger-card')),
      bg: card && cs(card).backgroundColor,
      border: card && cs(card).borderTopWidth,
      radius: card && cs(card).borderRadius,
      color: value && cs(value).color,
      mono: value && /mono|Menlo|Consolas/i.test(cs(value).fontFamily),
      trackH: track && cs(track).height,
      btnH: btn && cs(btn).minHeight,
    };
  });
  check('积分页渲染（签到卡 / 任务卡 / 等级条 / 流水卡）',
    structure.page && structure.signin && structure.ledger && structure.tasks === 6 && structure.cal === 7,
    JSON.stringify(structure));
  check('面板 --color-surface-1 + 1px 细线 + 16px 圆角',
    structure.bg === 'rgb(15, 20, 28)' && structure.border === '1px' && structure.radius === '16px',
    `${structure.bg} / ${structure.border} / ${structure.radius}`);
  check('积分数字等宽 + 青色，等级进度条 1px，按钮热区 ≥44px',
    structure.color === 'rgb(34, 211, 238)' && structure.mono && structure.trackH === '1px'
    && parseFloat(structure.btnH) >= 44,
    `${structure.color} / mono=${structure.mono} / ${structure.trackH} / ${structure.btnH}`);

  /* ---------------- 2) 每日签到 + 反馈纪律 ---------------- */
  const before = await state();
  check('初始积分 0 / 日历 7 天全未签',
    before.account.points === 0
    && (await page.locator('.pt-dot[data-signed="1"]').count()) === 0);
  await page.click('#pt-signin-btn');
  await page.waitForTimeout(120);
  const after = await state();
  check('签到 +10 积分并写入签到流水',
    after.account.points === 10 && after.account.totalEarned === 10
    && after.ledger.length === 1 && after.ledger[0].type === '签到' && after.ledger[0].amount === 10,
    JSON.stringify(after.ledger[0]));
  check('积分流水字段齐全（id/userId/type/amount/description/createdAt）',
    ['id', 'userId', 'type', 'amount', 'description', 'createdAt']
      .every((k) => k in after.ledger[0]));
  check('签到日历当天亮青色点、按钮变「今日已签到」',
    (await page.locator('.pt-day.is-today .pt-dot[data-signed="1"]').count()) === 1
    && (await page.locator('#pt-signin-btn').isDisabled()));
  const feedback = await page.evaluate(() => {
    const bump = document.querySelector('.pt-points-value.is-bump');
    const toast = document.querySelector('.pt-toast');
    const infinite = [...document.querySelectorAll('.pt-page *')]
      .flatMap((n) => (n.getAnimations ? n.getAnimations() : []))
      .filter((a) => a.effect && a.effect.getTiming().iterations === Infinity).length;
    return {
      bump: Boolean(bump),
      duration: bump ? getComputedStyle(bump).animationDuration : '',
      toast: Boolean(toast),
      pointerEvents: toast ? getComputedStyle(toast).pointerEvents : '',
      dialogs: window.__ptDialogs || 0,
      openDialogs: document.querySelectorAll('dialog[open], .modal:not(.hidden)').length,
      infinite,
    };
  });
  check('积分数字 300ms 一次性上浮（非无限循环）',
    feedback.bump && feedback.duration === '0.3s' && feedback.infinite === 0,
    JSON.stringify(feedback));
  check('轻量 toast 不遮挡操作、无弹窗打断主流程',
    feedback.toast && feedback.pointerEvents === 'none'
    && feedback.dialogs === 0 && feedback.openDialogs === 0,
    JSON.stringify(feedback));
  const dup = await page.evaluate(async () => {
    const S = await import('/js/store/pointsStore.js');
    return S.doSignIn();
  });
  check('同日重复签到不重复加分', dup.ok === false && (await state()).account.points === 10);

  /* ---------------- 3) 连签加成 / 断签重置 ---------------- */
  await patchAccount({
    lastSignInDate: await page.evaluate(async () => {
      const S = await import('/js/store/pointsStore.js');
      return S.offsetDateKey(S.dateKey(), -1);
    }),
    signInStreak: 2, points: 100, totalEarned: 100,
  });
  let pre = (await state()).account.points;
  await page.click('#pt-signin-btn');
  let post = (await state()).account;
  check('连续 3 天：+10 基础 +20 加成 = +30，连续天数 3',
    post.points - pre === 30 && post.signInStreak === 3, `${pre} → ${post.points} / ${post.signInStreak}`);
  check('加成写入流水描述', (await state()).ledger.some((x) => x.description.includes('连续 3 天')));

  await patchAccount({
    lastSignInDate: await page.evaluate(async () => {
      const S = await import('/js/store/pointsStore.js');
      return S.offsetDateKey(S.dateKey(), -1);
    }),
    signInStreak: 6, points: 200, totalEarned: 200,
  });
  pre = (await state()).account.points;
  await page.click('#pt-signin-btn');
  post = (await state()).account;
  check('连续 7 天：+10 基础 +50 加成 = +60，连续天数 7',
    post.points - pre === 60 && post.signInStreak === 7, `${pre} → ${post.points} / ${post.signInStreak}`);

  await patchAccount({
    lastSignInDate: await page.evaluate(async () => {
      const S = await import('/js/store/pointsStore.js');
      return S.offsetDateKey(S.dateKey(), -3);
    }),
    signInStreak: 5, points: 300, totalEarned: 300,
  });
  pre = (await state()).account.points;
  await page.click('#pt-signin-btn');
  post = (await state()).account;
  check('断签（间隔 3 天）重置为第 1 天，仅 +10 无加成',
    post.points - pre === 10 && post.signInStreak === 1, `${pre} → ${post.points} / ${post.signInStreak}`);

  /* ---------------- 4) 等级进度随积分变化 ---------------- */
  await patchAccount({ totalEarned: 500, points: 500 });
  const lv2 = await page.evaluate(() => ({
    text: document.querySelector('.pt-level-card').textContent,
    width: document.querySelector('.pt-level-fill').style.width,
    track: getComputedStyle(document.querySelector('.pt-level-track')).height,
  }));
  check('累计 500 → Lv2 探索者，进度 50%，距 Lv3 还差 300 分',
    lv2.text.includes('Lv2 探索者') && lv2.text.includes('还差 300 分')
    && parseFloat(lv2.width) === 50 && lv2.track === '1px', JSON.stringify(lv2));
  await patchAccount({ totalEarned: 5000, points: 5000 });
  const lv5 = await page.locator('.pt-level-card').textContent();
  check('累计 5000 → Lv5 收藏家满进度', lv5.includes('Lv5 收藏家') && lv5.includes('已达最高等级'));

  /* ---------------- 5) 刷新持久化 ---------------- */
  const beforeReload = await state();
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(500);
  const afterReload = await state();
  check('刷新后积分 / 签到 / 等级 / 任务状态不丢',
    afterReload.account.points === beforeReload.account.points
    && afterReload.account.lastSignInDate === beforeReload.account.lastSignInDate
    && afterReload.account.level === beforeReload.account.level
    && afterReload.tasks.browse3.progress === beforeReload.tasks.browse3.progress);

  /* ---------------- 6) 真实行为驱动任务进度 ---------------- */
  for (const id of ['p017', 'p033', 'p097']) {
    await page.goto(`${APP}#/product/${id}`, { waitUntil: 'load' });
    await page.waitForTimeout(750);
  }
  await openPoints();
  let s = await state();
  check('真实浏览 3 款不同商品 → 浏览任务 3/3 可领取',
    s.tasks.browse3.progress === 3 && s.tasks.browse3.status === '可领取',
    JSON.stringify(s.tasks.browse3));
  await page.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  await openPoints();
  s = await state();
  check('同一商品重复浏览按当日去重（进度不虚增）', s.tasks.browse3.progress === 3);

  await page.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await page.waitForTimeout(750);
  await page.locator('.pdp-fav').first().click();
  await page.waitForTimeout(350);
  await openPoints();
  s = await state();
  check('真实收藏行为 → 收藏任务可领取', s.tasks.fav1.status === '可领取', JSON.stringify(s.tasks.fav1));

  await page.goto(`${APP}#/product/p017`, { waitUntil: 'load' });
  await page.waitForTimeout(750);
  await page.locator('.pdp-secondary-actions button', { hasText: '复制分享' }).click();
  await page.waitForTimeout(350);
  await openPoints();
  s = await state();
  check('真实分享行为 → 分享任务可领取', s.tasks.share1.status === '可领取', JSON.stringify(s.tasks.share1));

  // 其余三条链路（AI 对话 / 下单成功 / 评价）需登录态、网关或表单提交，
  // 本步用数据层事件入口直调验证累加与领取；真实触发点由 check-web 源码断言覆盖。
  await page.evaluate(async () => {
    const S = await import('/js/store/pointsStore.js');
    S.recordBehavior('ai_chat');
    S.recordBehavior('order_success');
    S.recordBehavior('review');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(450);
  s = await state();
  check('AI 对话 / 下单 / 评价事件累加进度并转为可领取',
    s.tasks.ai1.status === '可领取' && s.tasks.order1.status === '可领取'
    && s.tasks.review1.status === '可领取',
    JSON.stringify([s.tasks.ai1, s.tasks.order1, s.tasks.review1]));

  /* ---------------- 7) 领取入账与流水 ---------------- */
  const claimBefore = await state();
  await page.locator('[data-claim="browse3"]').click();
  await page.waitForTimeout(250);
  const claimAfter = await state();
  check('领取浏览任务 +5 入账并写「任务」流水',
    claimAfter.account.points - claimBefore.account.points === 5
    && claimAfter.ledger[0].type === '任务' && claimAfter.ledger[0].amount === 5
    && claimAfter.ledger[0].description.includes('浏览 3 个商品'),
    JSON.stringify(claimAfter.ledger[0]));
  check('领取后按钮变「已领取」且禁用，状态已完成',
    (await page.locator('.pt-task[data-task="browse3"] .pt-btn--done').count()) === 1
    && (await page.locator('.pt-task[data-task="browse3"] .pt-badge').textContent()) === '已完成');
  const reClaim = await page.evaluate(async () => {
    const S = await import('/js/store/pointsStore.js');
    return S.doClaim('browse3');
  });
  check('重复领取被拦截，积分不重复入账',
    reClaim.ok === false && (await state()).account.points === claimAfter.account.points);

  /* ---------------- 8) 按用户隔离 ---------------- */
  const ownPoints = (await state()).account.points;
  await page.evaluate(() => {
    localStorage.setItem('current_user', JSON.stringify({ id: 'u_points_other' }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(450);
  const other = await state();
  check('切换到另一用户：积分归零、签到可再签、任务重置',
    other.account.points === 0 && other.account.lastSignInDate === ''
    && other.tasks.browse3.status === '进行中' && other.userId !== claimAfter.userId,
    JSON.stringify({ points: other.account.points, uid: other.userId }));
  await page.evaluate(() => localStorage.removeItem('current_user'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(450);
  check('切回原用户：积分与任务状态恢复', (await state()).account.points === ownPoints);

  /* ---------------- 9) 个人中心入口 + 移动端 ---------------- */
  await page.evaluate(() => {
    localStorage.setItem('current_user', JSON.stringify({ id: 'u_points_demo' }));
  });
  await page.goto(`${APP}#/account`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  check('个人中心渲染精简签到卡入口', (await page.locator('.pt-entry-card').count()) === 1);
  await page.evaluate(() => localStorage.removeItem('current_user'));

  const mobile = await browser.newPage({
    viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true,
  });
  attachErrors(mobile);
  await mobile.goto(`${APP}#/points`, { waitUntil: 'load' });
  await mobile.waitForTimeout(600);
  const m = await mobile.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('.pt-grid')).gridTemplateColumns,
    btn: parseFloat(getComputedStyle(document.querySelector('.pt-signin-btn')).minHeight),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    signin: Boolean(document.querySelector('#pt-signin-btn')),
  }));
  check('移动端单列、签到按钮 ≥44px、无横向滚动',
    m.cols.split(' ').length === 1 && m.btn >= 44 && m.overflow <= 1 && m.signin,
    JSON.stringify(m));
  check('控制台零 JS 错误（过滤外部图与 /api 噪音）', consoleErrors.length === 0, consoleErrors.join(' | '));
  await mobile.close();
} catch (e) {
  failed += 1;
  console.log(`  FAIL 套件异常: ${String(e.message).split('\n')[0]}`);
} finally {
  await browser.close();
  staticServer.kill();
}

console.log(failed === 0 ? '\n✓ 积分 / 签到 / 任务中心验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
