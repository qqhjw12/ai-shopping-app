// 本地演示模式验收（**不需要网关**）：静态站上把入驻流程完整走一遍。
//
// 这一套存在的理由：分享出去的演示链接没有后端，而「招商页 → 填表 → 提交 → 看状态
// → 进工作台」这条链路正是别人第一眼看的东西。它必须能走完，而且不能靠假装成功——
// 记录要真实存在于本机、要标「本地演示数据」、刷新不丢、能模拟审核、能进工作台。
//
// 断言分四组：
//   1) 表单五步 + 材料清单（含「用示例数据」这条演示捷径）
//   2) 无网关提交 → 明确提示 + 显式降级按钮（不自动跳成功页）
//   3) 本地记录的持久化与模拟审核（通过 / 驳回 / 刷新不丢）
//   4) 商家工作台的入口与内容，以及移动端不横向滚动
//
// 用法：node scripts/e2e-merchant-demo.mjs [--port 5511] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5511;
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

const browser = await chromium.launch({ executablePath: EDGE, headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text() || '';
  if (/Failed to load resource/.test(t)) return; // 无网关时 /api 404 是预期
  consoleErrors.push(t.slice(0, 160));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

const base = `http://127.0.0.1:${PORT}/index.html`;
const go = async (h, wait = 1200) => {
  await page.goto(`${base}#${h}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};
const fill = (name, value) => page.locator(`[data-field="${name}"] input`).first().fill(value);
const next = async () => {
  await page.locator('.mzf-nav button.mz-btn--gold:visible').click();
  await page.waitForTimeout(350);
};
const stepName = () => page.locator('.mzf-prog.is-current .mzf-prog-t').innerText();

const APPLICANT = {
  company: '苏州素白工作室',
  creditCode: '91320500MA1XK9LP2B',
  contact: '沈素',
  phone: '13900139000',
  email: 'shen@subai.studio',
  brand: '素白 SUBAI',
};

try {
  await page.goto(`${base}#/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.removeItem('maison_merchant_draft_v1');
    localStorage.removeItem('maison_merchant_last_application_v1');
    localStorage.removeItem('maison_merchant_local_v1');
  });

  console.log('\n— 表单五步（静态站，无网关） —');
  await go('/merchant/apply');
  check('打开申请页停在第 1 步', (await stepName()).includes('主体资质'));
  check('进度条是五步', (await page.locator('.mzf-prog').count()) === 5, String(await page.locator('.mzf-prog').count()));

  await page.locator('.mzf-choice', { hasText: '设计师工作室' }).click();
  await fill('company', APPLICANT.company);
  await fill('creditCode', APPLICANT.creditCode);
  await fill('contact', APPLICANT.contact);
  await fill('phone', APPLICANT.phone);
  await fill('email', APPLICANT.email);
  await next();
  check('第 1 步 → 第 2 步', (await stepName()).includes('品牌商品'));

  await fill('brand', APPLICANT.brand);
  await page.locator('.mzf-seg-item', { hasText: '自有品牌' }).click();
  await page.locator('.mzf-chip', { hasText: '家居家具' }).click();
  await page.locator('.mzf-seg-item', { hasText: '50–200' }).click();
  await page.locator('.mzf-seg-item', { hasText: '100–500 元' }).click();
  await next();
  check('第 2 步 → 第 3 步（资质材料）', (await stepName()).includes('资质材料'));

  await next();
  check('没有营业执照被拦住', (await page.locator('.mzf-field[data-field="materials"].has-error').count()) === 1);
  // 演示捷径：不选真文件也能把流程走完（填的是文件名，不假装解析内容）
  await page.locator('.mzu-demo').click();
  await page.waitForTimeout(250);
  check('「用示例数据」补出 2 份材料', (await page.locator('.mzu-item').count()) === 2, String(await page.locator('.mzu-item').count()));
  await page.screenshot({ path: '.shots/mzd-step3-materials.png', fullPage: true });
  await next();
  check('第 3 步 → 第 4 步（结算售后）', (await stepName()).includes('结算售后'));

  await fill('bankAccount', APPLICANT.company);
  await fill('bankNo', '6225880199887766');
  await page.locator('.mzf-seg-item', { hasText: '7 天无理由' }).click();
  await page.locator('.mzf-seg-item', { hasText: '48 小时内' }).click();
  await next();
  check('第 4 步 → 确认页', (await stepName()).includes('确认提交'));
  check('确认页 7 行摘要', (await page.locator('.mzf-sum-row').count()) === 7);
  check('摘要里卡号已打码', !(await page.locator('.mzf-summary').innerText()).includes('6225880199887766'));

  console.log('\n— 无网关提交：不假装成功 —');
  await page.locator('#mzf-agree-1').check();
  await page.locator('#mzf-agree-2').check();
  await page.locator('.mzf-submit').click();
  await page.waitForTimeout(1500);
  const alertText = await page.locator('.mzf-alert').innerText().catch(() => '');
  check('提示「未连接网关，申请没有提交」', alertText.includes('未连接网关') && alertText.includes('没有提交'), alertText.slice(0, 60));
  check('没有自动跳到成功页（不冒充提交）', !page.url().includes('id=ML'), page.url());
  check('给出显式的本地演示入口', alertText.includes('只存在本机'), alertText.slice(0, 80));
  await page.screenshot({ path: '.shots/mzd-offline-fallback.png', fullPage: true });

  console.log('\n— 本地演示记录 —');
  await page.locator('.mzf-alert-actions button').click();
  await page.waitForTimeout(1200);
  const url = page.url();
  const appId = (url.match(/id=(ML\d+)/) || [])[1] || '';
  check('本地记录生成 ML 前缀编号并跳到状态页', Boolean(appId), url);
  check('状态页显示「审核中」', (await page.locator('.mzf-status').innerText()).includes('审核中'));
  check('状态标签旁标「本地演示数据」', (await page.locator('.mzf-local-tag').innerText()).includes('本地演示数据'));
  const lede = await page.locator('.mzf-result-lede').innerText();
  check('正文说明「没有提交给平台」', lede.includes('没有提交给平台'), lede.slice(0, 60));
  check('摘要显示材料份数', (await page.locator('.mzf-summary').innerText()).includes('2 份'));
  check('页脚说明存储位置（localStorage）', (await page.locator('.mzf-foot').innerText()).includes('localStorage'));

  const stored = await page.evaluate(() => localStorage.getItem('maison_merchant_local_v1'));
  check('记录真存进 localStorage', Boolean(stored) && stored.includes('ML'), String(stored).slice(0, 40));
  check('本机不存完整卡号', !String(stored).includes('6225880199887766'));
  await page.screenshot({ path: '.shots/mzd-status-reviewing.png', fullPage: true });

  // 刷新不丢：验收里明写的一条
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  check('刷新后仍是同一份记录（不丢）', (await page.locator('.mzf-id').innerText()) === appId);
  check('刷新后状态仍是审核中', (await page.locator('.mzf-status').innerText()).includes('审核中'));
  check('审核中不给「改资料/撤回」（本地没有服务端可改）', (await page.locator('.mzf-result-actions').innerText()).includes('复制查询链接'));

  console.log('\n— 模拟审核与工作台 —');
  check('演示区提供模拟入口', (await page.locator('.mzf-demo').innerText()).includes('模拟审核通过'));
  await page.locator('.mzf-demo-btn', { hasText: '模拟审核通过' }).click();
  await page.waitForTimeout(900);
  check('模拟通过后状态变「已通过」', (await page.locator('.mzf-status').innerText()).includes('已通过'));
  check('出现「进入商家工作台」主按钮', (await page.locator('.mzf-result-actions').innerText()).includes('进入商家工作台'));
  await page.screenshot({ path: '.shots/mzd-status-approved.png', fullPage: true });

  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  check('刷新后审核结论还在', (await page.locator('.mzf-status').innerText()).includes('已通过'));

  await page.locator('.mzf-result-actions a', { hasText: '进入商家工作台' }).click();
  await page.waitForTimeout(1400);
  check('工作台页打开（hash 路由）', page.url().includes('#/merchant/workspace'), page.url());
  check('工作台显示品牌名', (await page.locator('.mzw-title').innerText()).includes(APPLICANT.brand));
  check('工作台标「已通过审核」', (await page.locator('.mzw-badge').innerText()).includes('已通过'));
  check('工作台概览 4 张卡', (await page.locator('.mzw-stat').count()) === 4, String(await page.locator('.mzw-stat').count()));
  check('工作台待办 3 条', (await page.locator('.mzw-todo-row').count()) === 3);
  check('未开放的模块如实标注', (await page.locator('.mzw-todo').innerText()).includes('未开放'));
  check('工作台列出材料清单', (await page.locator('.mzw-mats li').count()) === 2);
  check('工作台说明这是本地演示数据', (await page.locator('.mzw-local').innerText()).includes('本地演示数据'));
  await page.screenshot({ path: '.shots/mzd-workspace.png', fullPage: true });

  // 驳回路径：回到状态页再走一次
  await go(`/merchant/apply?id=${appId}&key=${encodeURIComponent((url.match(/key=([^&]+)/) || [])[1] || '')}`);
  await page.locator('.mzf-demo-btn', { hasText: '模拟驳回' }).click();
  await page.waitForTimeout(900);
  const rejectedText = await page.locator('.mzf-result').innerText();
  check('模拟驳回后状态变「未通过」', (await page.locator('.mzf-status').innerText()).includes('未通过'));
  check('驳回显示 mock 原因', rejectedText.includes('驳回理由') && rejectedText.includes('不一致'), rejectedText.slice(0, 80));
  check('驳回后不再给工作台入口', !(await page.locator('.mzf-result-actions').innerText()).includes('进入商家工作台'));
  await page.screenshot({ path: '.shots/mzd-status-rejected.png', fullPage: true });

  // 移动端段要看的是「真工作台」，把演示记录恢复成已通过
  await page.locator('.mzf-demo-btn', { hasText: '重置为审核中' }).click();
  await page.waitForTimeout(600);
  await page.locator('.mzf-demo-btn', { hasText: '模拟审核通过' }).click();
  await page.waitForTimeout(600);

  console.log('\n— 移动端与稳定性 —');
  // 注意：Playwright 的两个 Page 各自独立 localStorage——桌面页写入的演示记录
  // 移动页看不到。想量「真工作台」的移动端，必须先把本机记录搬过去。
  const localRaw = await page.evaluate(() => localStorage.getItem('maison_merchant_local_v1'));
  const m = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const mErrors = [];
  m.on('pageerror', (e) => mErrors.push(String(e).slice(0, 120)));
  await m.goto(`${base}#/`, { waitUntil: 'load' });
  await m.evaluate((v) => localStorage.setItem('maison_merchant_local_v1', v), localRaw);
  await m.goto(`${base}#/merchant/apply`, { waitUntil: 'load' });
  await m.waitForTimeout(1200);
  const hScrollApply = await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('移动端申请页无横向滚动', hScrollApply);
  await m.evaluate(() => { location.hash = '#/merchant/workspace'; });
  await m.waitForTimeout(1200);
  const hScrollWs = await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('移动端工作台无横向滚动', hScrollWs);
  check('移动端工作台显示真实店铺（不是空态）', (await m.locator('.mzw-title').innerText().catch(() => '')).includes(APPLICANT.brand));
  await m.screenshot({ path: '.shots/mzd-workspace-mobile.png', fullPage: true });
  check('移动端无 JS 错误', mErrors.length === 0, mErrors.join(' | '));
  await m.close();

  check('桌面端无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  if (srv) srv.kill();
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length === 0 ? 0 : 1);
