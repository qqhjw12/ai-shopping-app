#!/usr/bin/env node
/**
 * 商家入驻审核闭环验收（playwright-core + 本机 Edge + 独立网关 + 临时库 + 本地 webhook）。
 *
 * 前两步入驻申请只能「交上来」，approved / rejected 只是两个词。这一轮要验的是
 * **审核真的闭环了**：
 *   1) 审核接口必须鉴权：没钥匙、错钥匙都挡住；列表同样；
 *   2) 驳回必填理由、非法动作 4xx、终态不可再审（409 而不是覆盖别人的结论）；
 *   3) 审核通过/驳回后：状态、审核人、轨迹、通知队列全部落库；
 *   4) 通知真的投递出去（本地 webhook 收到，且收件人是打码的）；
 *   5) 商家凭编号 + 凭证能看到结果与通知状态，但看不到任何明文手机号/邮箱；
 *   6) UI 全链路：钥匙门 → 列表 → 驳回空理由被拦 → 通过弹层 → 卡片与计数联动；
 *   7) 两个运营台共用凭据（源码锁死同一组槽位）。
 *
 * 用法：node scripts/e2e-merchant-review.mjs [--port 4343] [--gw 8103] [--hook 8198] [--headed]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = Number(argOf('--port', '4343'));
const GW_PORT = Number(argOf('--gw', '8103'));
const HOOK_PORT = Number(argOf('--hook', '8198'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const ADMIN_KEY = 'e2e-merchant-review-77a1';
// 接口侧与页面侧用不同的中文名：两个名字不同才能证明页面真的把自报的
// 操作人发了出去，而不是服务端兜底成同一个值
const API_ACTOR = '钱复审';
const UI_ACTOR = '张小满';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

let failed = 0;
function check(label, ok, extra = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ` → ${extra}` : ''}`);
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------- 本地 webhook 接收器 ---------------- */

const hookInbox = [];
const hook = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    if (req.url === '/_dump') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(hookInbox));
      return;
    }
    if (req.url === '/_reset') {
      hookInbox.length = 0;
      res.writeHead(200);
      res.end('ok');
      return;
    }
    try { hookInbox.push(JSON.parse(b || '{}')); } catch { /* 坏 payload 也记一笔长度 */ }
    res.writeHead(200);
    res.end('ok');
  });
});

/* ---------------- 进程 ---------------- */

const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-mreview.db');
try { rmSync(DB, { force: true }); } catch { /* 首次运行不存在 */ }

const staticServer = spawn(
  process.execPath,
  [join(__dirname, 'static-server.mjs'), '--port', String(PORT), '--root', join(ROOT, 'web')],
  { stdio: 'ignore' },
);
const gateway = spawn(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', join(ROOT, 'ai-gateway', 'src', 'server.js')],
  {
    stdio: 'ignore',
    cwd: join(ROOT, 'ai-gateway'),
    env: {
      ...process.env,
      PORT: String(GW_PORT),
      DB_FILE: DB,
      CORS_ORIGINS: BASE,
      RATE_LIMIT_PER_MIN: '0',
      ADMIN_API_KEY: ADMIN_KEY,
      NOTIFY_WEBHOOK_URL: `${HOOK}/hook`,
      // 测试里手动 flush，不要后台 worker 抢跑（否则 queued 状态断言会漂）
      NOTIFY_FLUSH_INTERVAL_SEC: '0',
      NOTIFY_TIMEOUT_MS: '2500',
    },
  },
);

/* ---------------- API 助手 ---------------- */

async function req(method, path, body = null, headers = {}) {
  const r = await fetch(`${GW}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, d };
}

const adminHeaders = (key = ADMIN_KEY, actor = API_ACTOR) => ({
  'X-Admin-Key': key,
  'X-Admin-Actor': actor ? encodeURIComponent(actor) : '',
});

const listApps = (qs = '', key = ADMIN_KEY) => req('GET', `/api/merchant/applications${qs ? `?${qs}` : ''}`, null, key ? adminHeaders(key) : {});
const reviewApp = (id, bodyData, key = ADMIN_KEY) => req('PATCH', `/api/merchant/applications/${encodeURIComponent(id)}`, bodyData, adminHeaders(key));
const detailApp = (id) => req('GET', `/api/merchant/applications/${encodeURIComponent(id)}`, null, adminHeaders());
const publicApp = (id, key) => req('GET', `/api/merchant/applications/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`);
const flush = () => req('POST', '/api/merchant/notices/flush', null, adminHeaders());

function appPayload(submitKey, withEmail = true) {
  return {
    entityKind: 'studio',
    company: '杭州砚白设计有限公司',
    creditCode: '91330100MA2H1XYG4K',
    contact: '周砚',
    phone: '13800138000',
    email: withEmail ? 'zhou@yanbai.design' : '',
    brand: '砚白 YANBAI',
    brandSource: 'owned',
    categories: ['home', 'stationery'],
    skuRange: '50-200',
    priceRange: '100-500',
    bankAccount: '杭州砚白设计有限公司',
    bankBranch: '招商银行杭州分行',
    bankNo: '6225880123456789',
    returnPolicy: '7days',
    shipWithin: '48h',
    submitKey,
  };
}

let browser;
try {
  hook.listen(HOOK_PORT, '127.0.0.1');
  await new Promise((r) => hook.once('listening', r));
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  /* ============ 1) 鉴权 ============ */
  console.log('\n— 鉴权 —');
  const probe = await req('POST', '/api/merchant/applications', appPayload('auth-probe-0001'));
  check('提交申请（匿名即可，商家注册前就要能交资料）', probe.status === 201, String(probe.status));
  const appId = probe.d.application.id;

  check('无钥匙审核被拒 401', (await reviewApp(appId, { action: 'approve' }, '')).status === 401);
  check('错钥匙审核被拒 401', (await reviewApp(appId, { action: 'approve' }, 'wrong-key')).status === 401);
  check('无钥匙列表被拒 401', (await listApps('', '')).status === 401);

  /* ============ 2) 校验 ============ */
  console.log('\n— 校验 —');
  check('非法动作 400', (await reviewApp(appId, { action: 'delete' })).status === 400);
  check('驳回不写理由 400', (await reviewApp(appId, { action: 'reject', note: '   ' })).status === 400);
  check('意见超长 400', (await reviewApp(appId, { action: 'approve', note: 'x'.repeat(201) })).status === 400);

  /* ============ 3) 通过 ============ */
  console.log('\n— 通过 —');
  const ok = await reviewApp(appId, { action: 'approve', note: '资质齐全，品牌调性契合' });
  check('通过返回 200', ok.status === 200, String(ok.status));
  check('状态 approved + 中文标签', ok.d.application.status === 'approved' && ok.d.application.statusLabel === '已通过');
  check('审核人落库', ok.d.application.reviewedBy === API_ACTOR, ok.d.application.reviewedBy);
  check('轨迹两行（提交 + 审核）', ok.d.events.length === 2
    && ok.d.events[0].action === 'submitted' && ok.d.events[1].action === 'approved');
  check('通知排了队列（短信 + 邮件）', ok.d.notices.length === 2
    && ok.d.notices.every((n) => n.status === 'queued'), ok.d.notices.map((n) => n.channel).join(','));
  check('收件人打码', ok.d.notices.every((n) => !n.targetMasked.includes('13800138000') && !n.targetMasked.includes('zhou@')));
  check('重复审核 409（不覆盖别人的结论）', (await reviewApp(appId, { action: 'reject', note: '改主意' })).status === 409);

  /* ============ 4) 驳回 + 公开查询 ============ */
  console.log('\n— 驳回与商家自查 —');
  const sub2 = await req('POST', '/api/merchant/applications', appPayload('review-e2e-002'));
  const id2 = sub2.d.application.id;
  const rej = await reviewApp(id2, { action: 'reject', note: '缺少实体经营证明，补充后可重新提交' });
  check('驳回返回 200，理由进入通知正文', rej.status === 200 && rej.d.notices[0].body.includes('缺少实体经营证明'));

  const pub = await publicApp(id2, sub2.d.queryKey);
  check('商家凭编号 + 凭证看到未通过 + 理由', pub.status === 200
    && pub.d.application.status === 'rejected'
    && pub.d.application.reviewNote.includes('缺少实体经营证明'));
  check('公开视图带通知状态', pub.d.application.notices.length === 2);
  check('公开视图不含明文手机号/邮箱', !JSON.stringify(pub.d).includes('13800138000') && !JSON.stringify(pub.d).includes('zhou@yanbai.design'));
  check('错凭证查不到（统一 404，不给枚举留口子）', (await publicApp(id2, 'wrong-key-123')).status === 404);
  check('带管理钥匙的详情含轨迹与队列', (await detailApp(id2)).d.events.length === 2);

  /* ============ 5) 通知投递（webhook）============ */
  console.log('\n— 通知投递 —');
  const f1 = await flush();
  check('手动投递一轮', f1.status === 200 && f1.d.sent >= 3, JSON.stringify(f1.d));
  const dump = await fetch(`${HOOK}/_dump`).then((r) => r.json());
  check('webhook 收到全部通知', dump.length >= 3, String(dump.length));
  check('每条通知带申请编号与打码收件人', dump.every((n) => n.applicationId && n.targetMasked
    && !n.targetMasked.includes('13800138000') && !n.targetMasked.includes('zhou@')));
  check('驳回的正文原样送达', dump.some((n) => n.applicationId === id2 && n.body.includes('缺少实体经营证明')));
  const stats = await req('GET', '/api/merchant/notices/stats', null, adminHeaders());
  check('队列统计：无 queued 残留', stats.d.queued === 0 && stats.d.sent >= 3, JSON.stringify(stats.d));
  check('通知统计带通道状态', stats.d.channel && stats.d.channel.ready === true);

  /* ============ 6) UI 全链路 ============ */
  console.log('\n— 运营台 UI —');
  // 前面两条已经是终态；UI 要审的是「待审核」，而且要两条——
  // 一条走驳回、一条走通过，审完待审核列表就空了
  const sub3 = await req('POST', '/api/merchant/applications', appPayload('review-e2e-003'));
  const sub4 = await req('POST', '/api/merchant/applications', appPayload('review-e2e-004'));
  check('UI 前准备两条待审核申请', sub3.status === 201 && sub4.status === 201);

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`); });
  await page.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/admin/merchants`, { waitUntil: 'load' });
  await page.waitForTimeout(1000);

  check('钥匙门：密钥 + 操作人两个输入框', (await page.locator('.adm-key-input').count()) === 2);
  check('钥匙门带运营台切换标签', (await page.locator('.adm-tab').count()) === 3);

  // 先只输钥匙：操作人必填，半截身份不给进
  await page.locator('.adm-key-input').nth(0).fill(ADMIN_KEY);
  await page.locator('.adm-key-form button[type=submit]').click();
  await page.waitForTimeout(400);
  check('只有钥匙被拦（操作人必填）', (await page.locator('.adm-error').innerText()).includes('操作人'));
  await page.locator('.adm-key-input').nth(1).fill(UI_ACTOR);
  await page.locator('.adm-key-form button[type=submit]').click();
  await page.waitForTimeout(1500);

  check('列表出现申请卡片', (await page.locator('.adm-card').count()) >= 1);
  const summaryText = (await page.locator('.adm-summary').innerText()).replace(/\n/g, ' ');
  check('总览含状态计数与通道状态', summaryText.includes('待审核') && summaryText.includes('通知通道已接入'), summaryText);

  // 驳回弹层：空理由被客户端拦下
  await page.locator('.adm-card').first().locator('button.adm-line-btn').click();
  await page.waitForTimeout(400);
  await page.locator('.as-submit').click();
  await page.waitForTimeout(300);
  check('驳回空理由被拦在弹层里', (await page.locator('.as-error').innerText()).includes('理由'));
  await page.locator('.as-note').fill('主体信息与信用代码不一致');
  await page.locator('.as-submit').click();
  await page.waitForTimeout(1800);

  // 通过弹层：备注选填
  await page.locator('.adm-card').first().locator('button.adm-btn').click();
  await page.waitForTimeout(400);
  await page.locator('.as-note').fill('复核通过');
  await page.locator('.as-submit').click();
  await page.waitForTimeout(1800);

  // 切到已通过：卡片应有处理人 + 通知状态
  await page.locator('.adm-filter[data-filter="approved"]').click();
  await page.waitForTimeout(1500);
  check('URL 带筛选参数（刷新不丢视角）', page.url().includes('status=approved'));
  const approvedCard = page.locator('.adm-card').first();
  const verdict = (await approvedCard.locator('.adm-verdict').innerText().catch(() => '')).replace(/\n/g, ' ');
  check('已处理卡片显示审核人与时间', verdict.includes('处理人') && verdict.includes(UI_ACTOR), verdict);
  check('卡片带通知状态胶囊', (await approvedCard.locator('.mzr-notice').count()) >= 1);

  // 手动投递按钮
  await page.locator('button', { hasText: '立即投递通知' }).first().click();
  await page.waitForTimeout(1500);
  check('手动投递后有 toast 反馈', (await page.locator('.toast, [class*="toast"]').count()) >= 0);

  // 切换标签到售后台：凭据复用，不再出现钥匙门
  await page.locator('.adm-tab', { hasText: '售后审核' }).click();
  await page.waitForTimeout(1500);
  check('切到售后台不重输钥匙（共用凭据）', (await page.locator('.adm-key-input').count()) === 0
    && (await page.locator('.adm-actor').innerText()).includes(UI_ACTOR));

  check('桌面端无 JS 错误', errs.length === 0, errs.join(' | '));

  /* ============ 7) 移动端 ============ */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await mp.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/admin/merchants?status=all`, { waitUntil: 'load' });
  await mp.waitForTimeout(900);
  await mp.locator('.adm-key-input').nth(0).fill(ADMIN_KEY);
  await mp.locator('.adm-key-input').nth(1).fill(UI_ACTOR);
  await mp.locator('.adm-key-form button[type=submit]').click();
  await mp.waitForTimeout(1500);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('移动端无横向滚动', overflow <= 0, String(overflow));
  const cardBox = await mp.locator('.adm-card').first().boundingBox();
  check('卡片不出屏', cardBox && cardBox.x >= -1, cardBox ? String(Math.round(cardBox.x)) : 'no card');
  await mp.screenshot({ path: '.shots/mzr-mobile.png' });
  check('移动端无 JS 错误', errs.length === 0, errs.join(' | '));

  await mctx.close();
  await ctx.close();
} catch (e) {
  failed += 1;
  console.error('E2E 异常:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e);
} finally {
  if (browser) await browser.close();
  staticServer.kill();
  gateway.kill();
  hook.close();
}

console.log(failed === 0 ? '\n✓ 商家入驻审核闭环验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
