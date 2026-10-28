#!/usr/bin/env node
/**
 * 售后审核闭环验收（playwright-core + 本机 Edge + 真网关 + 静态站）。
 *
 * 上一轮售后只能提交，approved / rejected 只是两个词——页面显示得出来，
 * 但没有任何东西会真的搬动订单。这一轮要验的是**状态真的被搬了，且搬得对**：
 *   1) 同意退款 → 订单入终态 refunded，退款金额落库且不超过实付；
 *   2) 同意换货 → 订单回到 shipped，新运单号、新时间戳，旧物流不擦掉；
 *   3) 驳回 → 订单退回**申请那一刻**的状态（shipped / completed），不是退回「猜的那个」；
 *   4) 审核接口必须鉴权：没钥匙、错钥匙都要被挡住，工单里有地址、电话和用户原话；
 *   5) 重复审核、非法动作、驳回不写理由都要 4xx，而不是静默成功。
 *
 * 订单推进走 API 而不是点演示按钮：这里要验的是审核，履约那条路上轮已经验过。
 *
 * 用法：node scripts/e2e-aftersale-review.mjs [--port 4341] [--gw 8101] [--headed]
 * 退出码：0 全通过 / 1 有失败
 */
import { spawn } from 'node:child_process';
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
const PORT = Number(argOf('--port', '4341'));
const GW_PORT = Number(argOf('--gw', '8101'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const APP = `${BASE}/index.html?api=${GW}`;
const ADMIN_KEY = 'e2e-admin-key-4c1f';

// 独立临时库：审核会把订单改成 refunded，跑开发库会污染真实订单
const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-asreview.db');

const PHONE = `137${String(Date.now()).slice(-8)}`;
const CODE = '123456';

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
  try {
    d = await r.json();
  } catch { /* 空响应 */ }
  return { status: r.status, d };
}

const adminHeaders = (key = ADMIN_KEY) => (key ? { 'X-Admin-Key': key, 'X-Admin-Actor': 'e2e-ops' } : {});

const listTickets = (qs = '', key = ADMIN_KEY) => req('GET', `/api/aftersales${qs ? `?${qs}` : ''}`, null, adminHeaders(key));
const review = (id, body, key = ADMIN_KEY) => req('PATCH', `/api/aftersales/${encodeURIComponent(id)}`, body, adminHeaders(key));
const createOrder = (userId) => req('POST', '/api/orders', {
  userId,
  items: [{ productId: 'p244', skuId: 'p244-s1', qty: 1 }],
});
const advance = (id, userId, step) => req('POST', `/api/orders/${encodeURIComponent(id)}/${step}?userId=${encodeURIComponent(userId)}`);
const applyAftersale = (id, userId, type) => req('POST', `/api/orders/${encodeURIComponent(id)}/aftersale`, {
  userId, type, reason: 'damaged', note: '外箱破损', evidence: [{ name: 'proof-1.png', size: 28 }],
});

async function serverOrder(userId, orderId) {
  const { d } = await req('GET', `/api/orders/${encodeURIComponent(orderId)}?userId=${encodeURIComponent(userId)}`);
  return d.order || null;
}

let browser;
try {
  if (!EDGE) throw new Error('没找到 Edge，无法做真实浏览器验收');
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // 下面有意制造的 401/403/409 都会带一条资源加载失败
    if (/Failed to load resource/i.test(m.text())) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  console.log('\n售后审核闭环 e2e（同意退款 / 同意换货 / 驳回 + 鉴权守卫，真网关持久化）');

  /* 0) 登录拿 uid */
  await page.goto(`${APP}#/login`, { waitUntil: 'load' });
  await page.waitForSelector('.auth-id');
  await page.locator('.auth-id').fill(PHONE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(300);
  await page.locator('.auth-code').fill(CODE);
  await page.locator('.auth-submit').click();
  await page.waitForTimeout(900);
  const uid = await page.evaluate(() => JSON.parse(localStorage.getItem('current_user') || '{}').id || '');
  check('登录成功', Boolean(uid), uid);

  /* 1) 铺四笔「已签收」订单，各提一条售后（四笔才能同时验四种落点） */
  const orders = [];
  for (const type of ['return', 'exchange', 'refund', 'refund']) {
    const { d: od } = await createOrder(uid);
    const id = od.order && od.order.orderId;
    await advance(id, uid, 'pay');
    await advance(id, uid, 'ship');
    await advance(id, uid, 'complete');
    const { d: ad } = await applyAftersale(id, uid, type);
    orders.push({ id, type, asId: ad.aftersale && ad.aftersale.id, total: ad.aftersale ? null : null });
  }
  check('四笔订单各提交一条售后', orders.length === 4 && orders.every((o) => o.asId),
    orders.map((o) => `${o.id}/${o.type}`).join(' '));
  const [o1, o2, o3, o4] = orders;

  const before = await serverOrder(uid, o1.id);
  check('提交售后后订单进入「售后中」', Boolean(before) && before.status === 'refunding',
    before ? before.status : '');
  const paid = before ? Number(before.payAmount || 0) : 0;
  check('订单实付金额可读（退款上限以它为准）', paid > 0, String(paid));

  /* 2) 鉴权：工单里有地址、电话和用户原话，匿名可读等于公开 */
  const noKey = await listTickets('', '');
  check('不带管理密钥访问工单列表被拒（401）', noKey.status === 401, `HTTP ${noKey.status}`);
  const wrongKey = await listTickets('', 'not-the-key');
  check('错误的密钥被拒（401）', wrongKey.status === 401, `HTTP ${wrongKey.status}`);
  const noKeyReview = await review(o1.asId, { action: 'approve' }, '');
  check('不带密钥审核被拒（401）', noKeyReview.status === 401, `HTTP ${noKeyReview.status}`);

  /* 3) 列表：待处理排前面 + 筛选 + 分页 */
  const all = await listTickets();
  check('带正确密钥可读取工单列表', all.status === 200 && all.d.total === 4,
    `HTTP ${all.status} total=${all.d.total}`);
  check('列表带订单金额与商品摘要（不做额外 N+1 也能显示）',
    Boolean(all.d.items && all.d.items[0] && all.d.items[0].orderTotal > 0
      && (all.d.items[0].items || []).length > 0));
  const reviewing = await listTickets('status=reviewing');
  check('按「待处理」筛选得到 4 条', reviewing.status === 200 && reviewing.d.items.length === 4,
    String((reviewing.d.items || []).length));
  const approved0 = await listTickets('status=approved');
  check('按「已同意」筛选当前为空', (approved0.d.items || []).length === 0);
  const page1 = await listTickets('size=1&page=2');
  check('分页可用（size=1 时第 2 页返回 1 条）', (page1.d.items || []).length === 1,
    `${(page1.d.items || []).length}`);

  /* 4) 非法输入 */
  const badAction = await review(o1.asId, { action: 'whatever' });
  check('非法审核动作被拒（400）', badAction.status === 400, `HTTP ${badAction.status} ${badAction.d.error || ''}`);
  const emptyReject = await review(o1.asId, { action: 'reject', note: '' });
  check('驳回不写理由被拒（400）', emptyReject.status === 400,
    `HTTP ${emptyReject.status} ${emptyReject.d.error || ''}`);

  /* 5) 同意换货：订单回到已发货，新运单号，旧物流不擦 */
  const beforeEx = await serverOrder(uid, o2.id);
  const exApprove = await review(o2.asId, { action: 'approve', note: '已安排换新' });
  const afterEx = await serverOrder(uid, o2.id);
  check('同意换货：工单状态 approved', exApprove.d.aftersale && exApprove.d.aftersale.status === 'approved',
    exApprove.d.aftersale ? exApprove.d.aftersale.status : `HTTP ${exApprove.status}`);
  check('同意换货：订单回到 shipped', Boolean(afterEx) && afterEx.status === 'shipped',
    afterEx ? afterEx.status : '');
  check('同意换货：换了新运单号',
    Boolean(afterEx) && afterEx.logistics.trackingNo !== beforeEx.logistics.trackingNo
      && /^(SF|JD|ZT)\d{10,}$/.test(afterEx.logistics.trackingNo || ''),
    afterEx ? `${beforeEx.logistics.trackingNo} → ${afterEx.logistics.trackingNo}` : '');
  check('同意换货：新签收时间已清空（新货还没送到）',
    Boolean(afterEx) && !afterEx.completedAt,
    afterEx ? String(afterEx.completedAt) : '');
  check('同意换货：旧物流事件保留并追加新的（4 → 6 条）',
    Boolean(afterEx) && afterEx.logistics.events.length === 6,
    afterEx ? String(afterEx.logistics.events.length) : '');
  check('同意换货：不产生退款金额（换的是货不是钱）',
    exApprove.d.aftersale && exApprove.d.aftersale.refundAmount === null,
    exApprove.d.aftersale ? String(exApprove.d.aftersale.refundAmount) : '');

  /* 6) 驳回：退回申请那一刻的状态（已完成） */
  const rej = await review(o3.asId, { action: 'reject', note: '凭证不足以判定运输破损' });
  const afterRej = await serverOrder(uid, o3.id);
  check('驳回：工单状态 rejected', rej.d.aftersale && rej.d.aftersale.status === 'rejected',
    rej.d.aftersale ? rej.d.aftersale.status : `HTTP ${rej.status}`);
  check('驳回：订单退回「已完成」', Boolean(afterRej) && afterRej.status === 'completed',
    afterRej ? afterRej.status : '');
  check('驳回：理由落库且会展示给用户',
    rej.d.aftersale && rej.d.aftersale.reviewNote === '凭证不足以判定运输破损',
    rej.d.aftersale ? rej.d.aftersale.reviewNote : '');
  check('驳回：处理说明里带上了理由',
    rej.d.aftersale && /凭证不足以判定运输破损/.test(rej.d.aftersale.handleNote || ''));

  /* 7) 退款金额上限：手滑多打两个 0 不能真退那么多 */
  const clamp = await review(o4.asId, { action: 'approve', note: '同意退款', refundAmount: 99999 });
  const afterClamp = await serverOrder(uid, o4.id);
  check('超额退款被夹到订单实付',
    clamp.d.aftersale && Math.abs(clamp.d.aftersale.refundAmount - paid) < 0.011,
    clamp.d.aftersale ? `${clamp.d.aftersale.refundAmount} vs 实付 ${paid}` : `HTTP ${clamp.status}`);
  check('同意退款：订单入终态 refunded', Boolean(afterClamp) && afterClamp.status === 'refunded',
    afterClamp ? afterClamp.status : '');

  /* 8) 重复审核 */
  const again = await review(o4.asId, { action: 'approve' });
  check('重复审核被拒（409）', again.status === 409, `HTTP ${again.status} ${again.d.error || ''}`);

  /* 9) 审核台页面：钥匙门 → 默认停在待处理 */
  await page.goto(`${APP}#/admin/aftersales`, { waitUntil: 'load' });
  await page.waitForSelector('.adm-key-form');
  check('未持钥匙时先看到钥匙门，而不是空列表',
    (await page.locator('.adm-card').count()) === 0);
  await page.locator('.adm-key-input').fill(ADMIN_KEY);
  await page.locator('.adm-btn', { hasText: '进入' }).click();
  await page.waitForSelector('.adm-card', { timeout: 8000 });
  check('默认停在「待处理」，只剩接口还没动的那条',
    (await page.locator('.adm-card').count()) === 1,
    String(await page.locator('.adm-card').count()));

  await page.locator('.adm-filter', { hasText: '全部' }).click();
  await page.waitForTimeout(1200);
  const allText = (await page.locator('.adm-page').textContent()) || '';
  check('切到「全部」能看到四条工单', (await page.locator('.adm-card').count()) === 4,
    String(await page.locator('.adm-card').count()));
  check('全部里能看到接口处理过的结论', /已同意/.test(allText) && /已驳回/.test(allText));

  /* 10) 在页面上同意：金额默认带出实付，提交后真的改了订单 */
  await page.locator('.adm-filter', { hasText: '待处理' }).click();
  await page.waitForTimeout(1000);
  await page.locator('.adm-btn', { hasText: '同意' }).click();
  await page.waitForSelector('.as-form');
  check('退款类同意会要求填退款金额，且默认带出订单实付',
    (await page.locator('.as-amount').count()) === 1
      && Math.abs(Number(await page.locator('.as-amount').inputValue()) - paid) < 0.011,
    await page.locator('.as-amount').inputValue().catch(() => ''));
  await page.locator('.as-note').fill('已核实破损，同意退款');
  await page.locator('.as-submit').click();
  await page.waitForTimeout(1800);
  check('处理完之后待处理队列清空并给空态',
    (await page.locator('.adm-card').count()) === 0
      && (await page.locator('.adm-empty').count()) === 1);

  const afterUi = await serverOrder(uid, o1.id);
  check('页面操作真的改了服务端订单（refunded）',
    Boolean(afterUi) && afterUi.status === 'refunded', afterUi ? afterUi.status : '');

  /* 11) 筛选结果与刷新不丢 */
  await page.locator('.adm-filter', { hasText: '已同意' }).click();
  await page.waitForTimeout(1300);
  const approvedText = (await page.locator('.adm-page').textContent()) || '';
  check('「已同意」里是三条（两条退款 + 一条换货）',
    (await page.locator('.adm-card').count()) === 3,
    String(await page.locator('.adm-card').count()));
  check('卡片上显示退款金额与审核意见',
    /退款 ¥/.test(approvedText) && /意见：已核实破损/.test(approvedText));

  await page.locator('.adm-filter', { hasText: '已驳回' }).click();
  await page.waitForTimeout(1300);
  check('「已驳回」里是那一条',
    (await page.locator('.adm-card').count()) === 1
      && /已驳回/.test((await page.locator('.adm-card').first().textContent()) || ''));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.adm-card', { timeout: 8000 });
  check('刷新后仍停在「已驳回」筛选（筛选走路由而不是内存）',
    (await page.locator('.adm-card').count()) === 1);

  /* 12) 用户侧详情页：结论、金额都要看得见 */
  await page.goto(`${APP}#/account/order/${encodeURIComponent(o1.id)}`, { waitUntil: 'load' });
  await page.waitForSelector('.od-card');
  await page.waitForTimeout(700);
  const detail = (await page.locator('.od-card').textContent()) || '';
  check('详情页订单状态是「已退款」',
    ((await page.locator('.od-pill').textContent()) || '').trim() === '已退款');
  check('详情页售后记录显示审核结果', /审核结果/.test(detail) && /已同意/.test(detail));
  check('详情页显示退款金额', /退款 ¥/.test(detail));
  check('详情页显示审核意见', /审核意见：已核实破损/.test(detail));
  check('已退款的订单不再显示申请入口',
    (await page.locator('.od-line-btn', { hasText: '申请退款' }).count()) === 0);

  /* 13) 驳回后的订单可以再次申请（工单不是一次性消耗品） */
  const reapply = await applyAftersale(o3.id, uid, 'refund');
  check('驳回后可以重新提交售后', reapply.status === 201,
    `HTTP ${reapply.status} ${reapply.d.error || ''}`);

  check('控制台无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  if (HEADED) await page.waitForTimeout(1200);
} catch (e) {
  failed += 1;
  console.log(`  FAIL 脚本异常: ${e.message}`);
} finally {
  try { await browser?.close(); } catch { /* 已关闭 */ }
  for (const p of [staticServer, gateway]) {
    try { p.kill(); } catch { /* 已退出 */ }
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { rmSync(f, { force: true }); } catch { /* 没生成就算了 */ }
  }
}

console.log(failed === 0 ? '\n✓ 售后审核闭环 e2e 全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
