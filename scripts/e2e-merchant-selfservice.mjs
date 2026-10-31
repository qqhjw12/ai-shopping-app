#!/usr/bin/env node
/**
 * 商家自助 / 通知模板 / 批量导出验收（playwright-core + 本机 Edge + 独立网关 + 临时库 + 本地 webhook）。
 *
 * 这一轮验的是三件「商家和运营各自会真的用」的事：
 *
 *   A. 商家自助（#/merchant/apply?id&key）
 *      1) 审核中能只改一两个字段：不要求重填银行卡（完整卡号本来就回读不出来），
 *         打码字段留空 = 不修改——把打码串当新卡号存回去，是最容易犯的错；
 *      2) 改动写进审核轨迹，并且 revision_count 跟着涨（运营能看到「改过几次」）；
 *      3) 终止态不给改也撤回：审核完成后改资料 = 改一份已审过的证据（409）；
 *      4) 撤回不是删除：状态置 withdrawn、留痕、给商家一条回执通知。
 *
 *   B. 通知模板（#/admin/notice-templates）
 *      5) 默认模板开箱可用；改完只影响此后新排队的通知；
 *      6) 变量白名单：写错变量名直接 400（否则全体商家收到「{{conpany}} 已通过」）；
 *      7) 关通道 = 不再排队，而不是整条通知停掉。
 *
 *   C. 批量导出（GET /api/merchant/applications/export）
 *      8) 需要管理密钥；带 BOM（Excel 中文不乱码）；公式注入被转义；
 *      9) 完整银行卡号永远不出现在导出里（库里也没有）；单次有上限且如实告知。
 *
 * 用法：node scripts/e2e-merchant-selfservice.mjs [--port 4344] [--gw 8104] [--hook 8197] [--headed]
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
const PORT = Number(argOf('--port', '4344'));
const GW_PORT = Number(argOf('--gw', '8104'));
const HOOK_PORT = Number(argOf('--hook', '8197'));
const HEADED = args.includes('--headed');
const BASE = `http://127.0.0.1:${PORT}`;
const GW = `http://127.0.0.1:${GW_PORT}`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const ADMIN_KEY = 'e2e-merchant-self-91c3';
const ACTOR = '林复核';

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
    try { hookInbox.push(JSON.parse(b || '{}')); } catch { /* 坏 payload 忽略 */ }
    res.writeHead(200);
    res.end('ok');
  });
});

/* ---------------- 进程 ---------------- */

const DB = join(ROOT, 'ai-gateway', 'data', '_e2e-mself.db');
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
      // 手动 flush，别让后台 worker 抢跑（否则 queued 断言会漂）
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

const adminHeaders = { 'X-Admin-Key': ADMIN_KEY, 'X-Admin-Actor': encodeURIComponent(ACTOR) };
const revise = (id, key, patch) => req('POST', `/api/merchant/applications/${encodeURIComponent(id)}/revise?key=${encodeURIComponent(key)}`, patch);
const withdraw = (id, key, body = {}) => req('POST', `/api/merchant/applications/${encodeURIComponent(id)}/withdraw?key=${encodeURIComponent(key)}`, body);
const publicApp = (id, key) => req('GET', `/api/merchant/applications/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`);
const reviewApp = (id, body) => req('PATCH', `/api/merchant/applications/${encodeURIComponent(id)}`, body, adminHeaders);
const listApps = (qs = '') => req('GET', `/api/merchant/applications${qs ? `?${qs}` : ''}`, null, adminHeaders);
const templates = () => req('GET', '/api/merchant/notice-templates', null, adminHeaders);
const putTemplate = (id, body) => req('PUT', `/api/merchant/notice-templates/${encodeURIComponent(id)}`, body, adminHeaders);
const previewTemplate = (id, body) => req('POST', `/api/merchant/notice-templates/${encodeURIComponent(id)}/preview`, body, adminHeaders);
const resetTemplate = (id) => req('POST', `/api/merchant/notice-templates/${encodeURIComponent(id)}/reset`, null, adminHeaders);
const flush = () => req('POST', '/api/merchant/notices/flush', null, adminHeaders);

const BANK_NO = '6225880123456789';

function payload(submitKey, extra = {}) {
  return {
    entityKind: 'studio',
    company: '杭州砚白设计有限公司',
    creditCode: '91330100MA2H1XYG4K',
    contact: '周砚',
    phone: '13800138000',
    email: 'zhou@yanbai.design',
    brand: '砚白 YANBAI',
    brandSource: 'owned',
    categories: ['home'],
    skuRange: '50-200',
    priceRange: '100-500',
    bankAccount: '杭州砚白设计有限公司',
    bankBranch: '招商银行杭州分行',
    bankNo: BANK_NO,
    returnPolicy: '7days',
    shipWithin: '48h',
    submitKey,
    ...extra,
  };
}

/* ============================================================
   主流程
   ============================================================ */

let browser;
try {
  hook.listen(HOOK_PORT, '127.0.0.1');
  await new Promise((r) => hook.once('listening', r));
  if (!(await waitFor(`${BASE}/index.html`))) throw new Error('静态服务器没起来');
  if (!(await waitFor(`${GW}/health`))) throw new Error('网关没起来');

  /* ============ A. 商家自助：改资料 ============ */
  console.log('\n— 商家自助：修改资料 —');
  const s1 = await req('POST', '/api/merchant/applications', payload('self-0001'));
  check('提交申请', s1.status === 201, String(s1.status));
  const id1 = s1.d.application.id;
  const key1 = s1.d.queryKey;

  const r1 = await revise(id1, key1, { phone: '13900139000', categories: ['home', 'pet'] });
  check('只改两个字段即成功', r1.status === 200, String(r1.status));
  check('返回变更摘要（人话）', (r1.d.changesLabel || []).join('、') === '手机号、主营类目', (r1.d.changesLabel || []).join('、'));
  check('修改次数 +1', r1.d.application.revisionCount === 1, String(r1.d.application.revisionCount));
  check('轨迹追加 revised', r1.d.events.map((e) => e.action).join(',') === 'submitted,revised',
    r1.d.events.map((e) => e.action).join(','));

  const pr1 = await publicApp(id1, key1);
  check('商家自查看到新手机号（打码）与类目', pr1.d.application.phoneMasked.endsWith('9000')
    && pr1.d.application.categories.includes('pet'), `${pr1.d.application.phoneMasked} / ${pr1.d.application.categories}`);
  check('自查页不含明文手机号', !JSON.stringify(pr1.d).includes('13900139000'));
  check('银行卡号仍是打码串（未被覆盖成星号串）', pr1.d.application.bankNoMasked === '6225********6789', pr1.d.application.bankNoMasked);

  check('同一份内容再提交 = 400（值没变不算变更）', (await revise(id1, key1, { phone: '13900139000' })).status === 400);
  check('未知字段被拒 400（不静默忽略）', (await revise(id1, key1, { hacker: 1 })).status === 400);
  check('空 patch 400', (await revise(id1, key1, {})).status === 400);
  check('错凭证 404（不给枚举留口子）', (await revise(id1, 'wrong-key-xxx', { phone: '13900139001' })).status === 404);
  check('非法手机号 400 且带字段错误', await (async () => {
    const r = await revise(id1, key1, { phone: '123' });
    return r.status === 400 && Boolean(r.d.fields && r.d.fields.phone);
  })());
  check('重新输完整卡号才算改结算账号', await (async () => {
    const r = await revise(id1, key1, { bankNo: '6217000011112222' });
    return r.status === 200 && r.d.application.bankNoMasked === '6217********2222';
  })(), '打码串不可回填');

  /* ============ B. 通知模板 ============ */
  console.log('\n— 通知模板 —');
  const t0 = await templates();
  check('默认模板 6 条（3 结果 × 2 通道）', t0.d.items.length === 6, String(t0.d.items.length));
  check('变量白名单 6 个', (t0.d.variables || []).length === 6, (t0.d.variables || []).join(','));
  check('默认模板未自定义', t0.d.items.every((t) => !t.customized));

  const custom = '【MAISON】{{company}}（{{id}}）入驻通过，{{note}} —— 招商组 {{brand}}';
  const put1 = await putTemplate('approved:sms', { body: custom, enabled: true });
  check('保存自定义短信模板', put1.status === 200 && put1.d.template.customized === true);
  check('保存后立即生效（读回是新文案）', (await templates()).d.items.find((t) => t.id === 'approved:sms').body === custom);

  const pv = await previewTemplate('approved:sms', { applicationId: id1, note: '资质齐全' });
  check('预览用真实申请填充变量', pv.status === 200 && pv.d.body.includes('杭州砚白设计有限公司')
    && pv.d.body.includes('资质齐全') && !pv.d.body.includes('{{'), pv.d.body);

  const pvEdit = await previewTemplate('approved:sms', { body: '草稿：{{contact}} 你好', note: '' });
  check('预览可用编辑框里的未保存内容', pvEdit.d.body === '草稿：周砚 你好', pvEdit.d.body);

  const badVar = await putTemplate('approved:sms', { body: '{{conpany}} 已通过' });
  check('未知变量被拒 400', badVar.status === 400 && String(badVar.d.error).includes('conpany'), badVar.d.error);
  check('未知变量给出可用变量提示', Boolean(badVar.d.fields && badVar.d.fields.body));
  check('空正文被拒 400', (await putTemplate('approved:sms', { body: '   ' })).status === 400);
  check('邮件主题为空被拒 400', (await putTemplate('approved:email', { subject: '' })).status === 400);

  const putOff = await putTemplate('approved:email', { enabled: false });
  check('关闭邮件通道', putOff.status === 200 && putOff.d.template.enabled === false);

  /* ============ C. 审核：模板生效 + 终态守卫 ============ */
  console.log('\n— 审核后：模板生效 / 终态不可改 —');
  const rv = await reviewApp(id1, { action: 'approve', note: '资质齐全，欢迎入驻' });
  check('通过审核', rv.status === 200 && rv.d.application.status === 'approved');
  check('邮件通道关闭后只排短信', rv.d.notices.length === 1 && rv.d.notices[0].channel === 'sms',
    rv.d.notices.map((n) => n.channel).join(','));
  check('通知用了自定义模板', rv.d.notices[0].body.includes('招商组 砚白 YANBAI'), rv.d.notices[0].body);
  check('收件人仍打码', !rv.d.notices[0].targetMasked.includes('13900139000'), rv.d.notices[0].targetMasked);
  check('审核后改资料 409', (await revise(id1, key1, { phone: '13900139002' })).status === 409);
  check('审核后撤回 409', (await withdraw(id1, key1, { reason: '反悔' })).status === 409);

  /* ============ D. 撤回 ============ */
  console.log('\n— 商家撤回 —');
  // 公司名以 = 开头：同时用来验 CSV 公式注入防护
  const s2 = await req('POST', '/api/merchant/applications', payload('self-0002', {
    company: '=HYPERLINK("http://example.com","点我领券")',
    email: '',
  }));
  const id2 = s2.d.application.id;
  const key2 = s2.d.queryKey;

  const wd = await withdraw(id2, key2, { reason: '暂缓入驻，年底再谈' });
  check('撤回成功 200', wd.status === 200, String(wd.status));
  check('状态 withdrawn + 中文标签', wd.d.application.status === 'withdrawn' && wd.d.application.statusLabel === '已撤回');
  check('撤回时间落库', Boolean(wd.d.application.withdrawnAt));
  check('撤回排了回执通知', wd.d.notices.length === 1 && wd.d.notices[0].channel === 'sms'
    && wd.d.notices[0].status === 'queued', JSON.stringify(wd.d.notices.map((n) => `${n.channel}:${n.status}`)));
  check('回执正文带撤回原因', wd.d.notices[0].body.includes('暂缓入驻'), wd.d.notices[0].body);
  check('重复撤回 409', (await withdraw(id2, key2, {})).status === 409);
  check('撤回后改资料 409', (await revise(id2, key2, { phone: '13900139003' })).status === 409);

  const pr2 = await publicApp(id2, key2);
  check('商家自查看到已撤回', pr2.d.application.status === 'withdrawn' && pr2.d.application.statusLabel === '已撤回');
  check('公开视图含撤回回执状态', pr2.d.application.notices.length === 1);

  const detail2 = await req('GET', `/api/merchant/applications/${encodeURIComponent(id2)}`, null, adminHeaders);
  check('运营详情轨迹：提交 → 撤回', detail2.d.events.map((e) => e.action).join(',') === 'submitted,withdrawn',
    detail2.d.events.map((e) => e.action).join(','));
  check('撤回不是删除（列表里还在）', (await listApps('status=withdrawn')).d.items.some((x) => x.id === id2));

  // 通知真的投递出去
  const f1 = await flush();
  check('投递一轮', f1.status === 200 && f1.d.sent >= 2, JSON.stringify(f1.d));
  const dump = await fetch(`${HOOK}/_dump`).then((r) => r.json());
  check('webhook 收到通过短信与撤回回执', dump.length >= 2, String(dump.length));
  check('撤回回执原样送达', dump.some((n) => n.applicationId === id2 && n.body.includes('暂缓入驻')));
  check('投递内容不含明文手机号', dump.every((n) => !JSON.stringify(n).includes('13900139000')));

  /* ============ E. 批量导出 ============ */
  console.log('\n— 批量导出 CSV —');
  check('无管理密钥 401', (await fetch(`${GW}/api/merchant/applications/export`)).status === 401);
  check('错管理密钥 401', (await fetch(`${GW}/api/merchant/applications/export`, {
    headers: { 'X-Admin-Key': 'wrong' },
  })).status === 401);

  const exResp = await fetch(`${GW}/api/merchant/applications/export?status=withdrawn`, { headers: adminHeaders });
  // 注意：fetch().text() 会按 UTF-8 解码并**吃掉 BOM**（TextDecoder 默认忽略 BOM），
  // 所以 BOM 必须按字节验，不能用 charCodeAt(0) 去猜
  const csvBytes = new Uint8Array(await exResp.clone().arrayBuffer());
  const hasBom = csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf;
  const csv = await exResp.text();
  check('导出 200 + text/csv', exResp.status === 200 && (exResp.headers.get('content-type') || '').includes('text/csv'));
  check('带 UTF-8 BOM（Excel 不乱码）', hasBom, [...csvBytes.slice(0, 3)].map((b) => b.toString(16)).join(' '));
  check('响应头告知导出条数', exResp.headers.get('x-export-count') === '1'
    && exResp.headers.get('x-export-total') === '1', `${exResp.headers.get('x-export-count')}/${exResp.headers.get('x-export-total')}`);
  check('表头中文化', csv.includes('申请编号') && csv.includes('结算账号（打码）') && csv.includes('撤回时间'));
  check('导出内容含已撤回那条', csv.includes('已撤回') && csv.includes(id2));
  check('公式注入被转义（=HYPERLINK → 前置单引号）', csv.includes("'=HYPERLINK"), csv.split('\r\n')[1]?.slice(0, 60));
  check('完整银行卡号不在导出里', !csv.includes(BANK_NO));
  check('导出时间按本地时区（不是 UTC 原样）', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(csv) && !csv.includes(' 00:00:00'));

  const exAll = await fetch(`${GW}/api/merchant/applications/export`, { headers: adminHeaders });
  const csvAll = await exAll.text();
  check('不筛状态 = 全量', Number(exAll.headers.get('x-export-count')) === 2, exAll.headers.get('x-export-count'));
  check('全量导出含通过那条', csvAll.includes(id1) && csvAll.includes('已通过'));

  /* ============ F. 商家状态页 UI ============ */
  console.log('\n— 商家状态页 UI —');
  const s3 = await req('POST', '/api/merchant/applications', payload('self-0003'));
  const id3 = s3.d.application.id;
  const key3 = s3.d.queryKey;

  browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`); });

  await page.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/merchant/apply?id=${encodeURIComponent(id3)}&key=${encodeURIComponent(key3)}`, { waitUntil: 'load' });
  await page.waitForSelector('.mzf-result', { timeout: 15000 });

  const actionText = (await page.locator('.mzf-result-actions').innerText()).replace(/\n/g, ' ');
  check('审核中给出「修改资料 / 撤回申请」', actionText.includes('修改资料') && actionText.includes('撤回申请'), actionText);
  // append(null) 会把 null 当成文本插进页面——这类脏字眼只能靠断言兜住
  const statusText = await page.locator('.mzf-result').innerText();
  check('状态页没有 null 文本（可选区块用 filter 而不是 append）', !/\bnull\b/.test(statusText));

  await page.locator('.mzf-result-actions button', { hasText: '修改资料' }).click();
  await page.waitForSelector('.mze-form');
  check('修改弹层字段齐全（含结算账号）', (await page.locator('.mze-form input[name="phone"]').count()) === 1
    && (await page.locator('.mze-form input[name="bankNo"]').count()) === 1);
  check('打码字段默认留空（不做假回填）', (await page.locator('.mze-form input[name="bankNo"]').inputValue()) === ''
    && (await page.locator('.mze-form input[name="phone"]').getAttribute('placeholder')).includes('不修改请留空'));
  check('类目以多选胶囊呈现', (await page.locator('.mze-chip').count()) >= 10);

  // 什么都不改直接保存 → 拦在客户端
  await page.locator('.mze-form button[type=submit]').click();
  await page.waitForTimeout(300);
  check('未改动时保存被拦（不发空请求）', (await page.locator('.mze-error').innerText()).includes('没有改动'));

  await page.locator('.mze-form input[name="phone"]').fill('13700137000');
  await page.locator('.mze-form button[type=submit]').click();
  await page.waitForSelector('.mzf-revised', { timeout: 15000 });
  check('保存后回到状态页并显示修改次数', (await page.locator('.mzf-revised').innerText()).includes('修改过 1 次'),
    await page.locator('.mzf-revised').innerText());
  check('状态页手机号跟着变（打码后四位）', (await page.locator('.mzf-summary').innerText()).includes('7000'));
  await page.screenshot({ path: '.shots/mzs-revised.png', fullPage: true });

  // 撤回：二次确认
  await page.locator('.mzf-result-actions button', { hasText: '撤回申请' }).click();
  await page.waitForSelector('.mze-form');
  check('撤回需要二次确认（不是一键移除）', (await page.locator('.mze-title').innerText()).includes('撤回'));
  await page.locator('.mze-textarea').fill('计划有变，先撤回');
  await page.locator('.mze-form button[type=submit]').click();
  await page.waitForSelector('.mzf-status.is-withdrawn', { timeout: 15000 });
  check('撤回后状态页显示已撤回', (await page.locator('.mzf-status').innerText()).includes('已撤回'));
  check('撤回后不再提供修改/撤回按钮', (await page.locator('.mzf-result-actions button', { hasText: '修改资料' }).count()) === 0);
  check('时间线把这一步标成「停下」', (await page.locator('.mzf-tl.is-stopped').count()) === 1);
  await page.screenshot({ path: '.shots/mzs-withdrawn.png', fullPage: true });

  check('商家端无 JS 错误', errs.length === 0, errs.join(' | '));

  /* ============ G. 运营台 UI：导出 / 撤回筛选 ============ */
  console.log('\n— 运营台 UI —');
  // 前三单都已终态，待审核列表会是空的——先补一条，否则「卡片」类断言必然超时
  await req('POST', '/api/merchant/applications', payload('self-0005'));
  await req('POST', '/api/merchant/applications', payload('self-0006', { company: '苏州素白工作室' }));
  await page.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/admin/merchants?status=reviewing`, { waitUntil: 'load' });
  await page.waitForSelector('.adm-key-input');
  await page.locator('.adm-key-input').nth(0).fill(ADMIN_KEY);
  await page.locator('.adm-key-input').nth(1).fill(ACTOR);
  await page.locator('.adm-key-form button[type=submit]').click();
  await page.waitForSelector('.adm-card', { timeout: 15000 });

  check('运营台三个标签（售后 / 入驻 / 模板）', (await page.locator('.adm-tab').count()) === 3);
  check('头部有导出按钮', (await page.locator('[data-role="export"]').count()) === 1);

  const dl = page.waitForEvent('download', { timeout: 20000 });
  await page.locator('[data-role="export"]').click();
  const download = await dl;
  check('点击导出真的下载到文件', (download.suggestedFilename() || '').endsWith('.csv'), download.suggestedFilename());

  await page.locator('.adm-filter[data-filter="withdrawn"]').click();
  await page.waitForTimeout(1500);
  check('已撤回筛选可用', page.url().includes('status=withdrawn'));
  const wdCard = (await page.locator('.adm-card').first().innerText()).replace(/\n/g, ' ');
  check('撤回卡片说明是商家自己停的', wdCard.includes('商家撤回'), wdCard.slice(0, 80));
  check('总览含已撤回转数徽标', (await page.locator('.adm-summary').innerText()).includes('已撤回'));

  // 修改过的申请：卡片上要看得到「改过几次」
  await page.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/admin/merchants?status=all`, { waitUntil: 'load' });
  await page.waitForSelector('.adm-card', { timeout: 15000 });
  check('卡片提示「商家修改过 N 次」', (await page.locator('.mzr-revised-badge').count()) >= 1);

  /* ============ H. 模板页 UI ============ */
  console.log('\n— 通知模板 UI —');
  await page.locator('.adm-tab', { hasText: '通知模板' }).click();
  await page.waitForSelector('.mzt-card', { timeout: 15000 });
  check('模板页 6 张卡', (await page.locator('.mzt-card').count()) === 6, String(await page.locator('.mzt-card').count()));
  check('邮件卡有主题输入框', (await page.locator('.mzt-card').first().locator('input.mzt-input').count()) === 0
    ? (await page.locator('.mzt-card').nth(1).locator('input.mzt-input').count()) === 1
    : true);
  check('变量胶囊可点', (await page.locator('.mzt-var').count()) >= 6);

  const firstCard = page.locator('.mzt-card').first();
  await firstCard.locator('.mzt-body').fill('【MAISON】{{company}} 已通过，{{note}}');
  await firstCard.locator('.mzt-var', { hasText: '{{contact}}' }).click();
  check('点变量插入到正文', (await firstCard.locator('.mzt-body').inputValue()).includes('{{contact}}'));
  await firstCard.locator('button', { hasText: '预览效果' }).click();
  await page.waitForSelector('.mzt-preview:not([hidden])', { timeout: 10000 });
  const previewText = await firstCard.locator('.mzt-preview').innerText();
  check('预览渲染出商家名（未保存也能看）', previewText.includes('杭州砚白设计有限公司'), previewText.replace(/\n/g, ' ').slice(0, 70));
  check('预览区没有 null 文本', !/\bnull\b/.test(previewText), previewText.replace(/\n/g, ' ').slice(0, 60));

  await firstCard.locator('button[type=submit]').click();
  await page.waitForTimeout(1500);
  check('保存后标记为「已自定义」', (await page.locator('.mzt-card').first().locator('.mzt-state').innerText()).includes('已自定义'));

  await page.locator('.mzt-card').first().locator('button', { hasText: '恢复默认' }).click();
  await page.waitForTimeout(1500);
  check('恢复默认后回到「使用默认」', (await page.locator('.mzt-card').first().locator('.mzt-state').innerText()).includes('使用默认'));
  await page.screenshot({ path: '.shots/mzt-templates.png', fullPage: true });
  check('模板页无 JS 错误', errs.length === 0, errs.join(' | '));

  /* ============ I. 移动端 ============ */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const mp = await mctx.newPage();
  const mErrs = [];
  mp.on('pageerror', (e) => mErrs.push(String(e).slice(0, 160)));
  await mp.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/admin/notice-templates`, { waitUntil: 'load' });
  await mp.waitForSelector('.adm-key-input');
  await mp.locator('.adm-key-input').nth(0).fill(ADMIN_KEY);
  await mp.locator('.adm-key-input').nth(1).fill(ACTOR);
  await mp.locator('.adm-key-form button[type=submit]').click();
  await mp.waitForSelector('.mzt-card', { timeout: 15000 });
  let overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('模板页移动端无横向滚动', overflow <= 0, String(overflow));
  await mp.screenshot({ path: '.shots/mzt-mobile.png', fullPage: true });

  const s4 = await req('POST', '/api/merchant/applications', payload('self-0004'));
  await mp.goto(`${BASE}/index.html?api=${encodeURIComponent(GW)}#/merchant/apply?id=${encodeURIComponent(s4.d.application.id)}&key=${encodeURIComponent(s4.d.queryKey)}`, { waitUntil: 'load' });
  await mp.waitForSelector('.mzf-result', { timeout: 15000 });
  await mp.locator('.mzf-result-actions button', { hasText: '修改资料' }).click();
  await mp.waitForSelector('.mze-form');
  overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('修改弹层移动端无横向滚动', overflow <= 0, String(overflow));
  const gridCols = await mp.evaluate(() => getComputedStyle(document.querySelector('.mze-grid')).gridTemplateColumns.split(' ').length);
  check('移动端修改表单单列', gridCols === 1, String(gridCols));
  await mp.screenshot({ path: '.shots/mzs-edit-mobile.png', fullPage: true });
  check('移动端无 JS 错误', mErrs.length === 0, mErrs.join(' | '));

  await mctx.close();
  await ctx.close();
} catch (e) {
  failed += 1;
  console.error('E2E 异常:', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e);
} finally {
  if (browser) await browser.close();
  staticServer.kill();
  gateway.kill();
  hook.close();
}

console.log(failed === 0 ? '\n✓ 商家自助 / 通知模板 / 批量导出验收全部通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
