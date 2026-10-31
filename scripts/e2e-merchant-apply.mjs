// 入驻申请表单真机验收（需要有网关在跑，因为要验证「真落库 + 幂等 + 回看」）。
//
// 静态断言（check-web）只能证明代码里写了这些字，证明不了三件事：
//   1) 分步校验真的拦得住（空表单点下一步不会跳步）；
//   2) 提交真的写进库了（响应里的编号能再查回来，刷新页面还在）；
//   3) 草稿真的存在本机（填一半刷新，内容还在）。
// 这三条只能开浏览器点出来。
//
// 用法：node scripts/e2e-merchant-apply.mjs [--api http://127.0.0.1:8080] [--port 5500] [--headed]
//
// 为什么默认跑在 5500：网关的 CORS 是显式来源白名单（生产禁用 '*'），
// 默认只认 http://127.0.0.1:5500。测试服务器换个端口就等于跨域被拦，
// 症状是「提交按钮点了没反应」——排查半天才发现是 CORS，不值当。
// 5500 已被本地开发服务器占用时直接复用它，测完也不会误杀别人的进程。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--port') + 1]) || 5500;
const API = (args[args.indexOf('--api') + 1] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const HEADED = args.includes('--headed');
const results = [];
const check = (label, ok, extra = '') => {
  results.push([label, ok]);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` → ${extra}`}`);
};

// 网关没起就别假装跑过：这一套的全部价值都在「真后端」上
try {
  const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`health ${res.status}`);
} catch (e) {
  console.error(`网关不可达（${API}）：${e.message}\n先启动网关：cd ai-gateway && node --env-file=.env src/server.js`);
  process.exit(2);
}

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
  if (/Failed to load resource/.test(t)) return;
  consoleErrors.push(t.slice(0, 160));
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

const base = `http://127.0.0.1:${PORT}/index.html?api=${encodeURIComponent(API)}`;
const go = async (h, wait = 1200) => {
  await page.goto(`${base}#${h}`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
};

const STAMP = Date.now().toString().slice(-6);
const APPLICANT = {
  company: `杭州砚白设计有限公司${STAMP}`,
  creditCode: '91330100MA2H1XYG4K',
  contact: '周砚',
  phone: '13800138000',
  email: 'zhou@yanbai.design',
  brand: `砚白 YANBAI ${STAMP}`,
};

const fill = async (name, value) => {
  await page.locator(`[data-field="${name}"] input`).first().fill(value);
};
const next = async () => {
  await page.locator('.mzf-nav button.mz-btn--gold:visible').click();
  await page.waitForTimeout(350);
};

try {
  // 每轮从干净草稿开始：必须先落地一次页面再清 localStorage——用 addInitScript 会在
  // 每次 reload 时都跑一遍，把「刷新后恢复草稿」这条断言要验证的东西自己擦掉。
  await page.goto(`${base}#/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.removeItem('maison_merchant_draft_v1');
    localStorage.removeItem('maison_merchant_last_application_v1');
  });
  await go('/merchant/apply');
  check('申请页打开默认在第 1 步', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('主体资质'));
  await next();
  check('空表单点下一步被拦住', (await page.locator('.mzf-alert').isVisible()) && (await page.locator('.mzf-panel[hidden]').count()) === 4);
  check('错误定位到字段（≥3 处标红）', (await page.locator('.mzf-field.has-error').count()) >= 3, String(await page.locator('.mzf-field.has-error').count()));
  await page.screenshot({ path: '.shots/mzf-step1-errors.png', fullPage: true });

  /* 2) 逐字段填，错误随填随清 */
  await page.locator('.mzf-choice', { hasText: '设计师工作室' }).click();
  await fill('company', APPLICANT.company);
  await fill('creditCode', APPLICANT.creditCode);
  await fill('contact', APPLICANT.contact);
  await fill('phone', APPLICANT.phone);
  await fill('email', APPLICANT.email);
  check('填写后字段错误被清空', (await page.locator('.mzf-field.has-error').count()) === 0);
  // 格式错误也要拦：手机号少一位
  await fill('phone', '1380013800');
  await next();
  check('手机号位数不对被拦下', (await page.locator('.mzf-field[data-field="phone"].has-error').count()) === 1);
  await fill('phone', APPLICANT.phone);
  await next();
  check('第 1 步通过后进入第 2 步', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('品牌商品'));

  /* 3) 第二步：品牌与类目 */
  await fill('brand', APPLICANT.brand);
  await page.locator('.mzf-seg-item', { hasText: '自有品牌' }).click();
  await page.locator('.mzf-chip', { hasText: '家居家具' }).click();
  await page.locator('.mzf-chip', { hasText: '办公文具' }).click();
  await page.locator('.mzf-seg-item', { hasText: '50–200' }).click();
  await page.locator('.mzf-seg-item', { hasText: '100–500 元' }).click();
  check('类目 chip 选中 2 个', (await page.locator('.mzf-chip input:checked').count()) === 2);
  // 上限 3 个：点第 4 个应被拒绝并提示
  await page.locator('.mzf-chip', { hasText: '家居家具' }).click(); // 取消
  await page.locator('.mzf-chip', { hasText: '手机数码' }).click();
  await page.locator('.mzf-chip', { hasText: '电脑办公' }).click();
  check('类目上限 3 个', (await page.locator('.mzf-chip input:checked').count()) === 3, String(await page.locator('.mzf-chip input:checked').count()));
  await page.locator('.mzf-chip', { hasText: '电脑办公' }).click();
  await page.locator('.mzf-chip', { hasText: '家居家具' }).click();
  await next();
  check('第 2 步通过后进入第 3 步', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('资质材料'));

  /* 4) 第三步：资质材料（mock 上传：只登记清单，不上传文件本体） */
  check('材料清单初始为空并提示营业执照必填', (await page.locator('.mzu-empty').innerText()).includes('营业执照'));
  await next();
  check('没有营业执照进不了下一步', (await page.locator('.mzf-field[data-field="materials"].has-error').count()) === 1);
  await page.locator('[data-field="materials"] input.mzu-file').first().setInputFiles({
    name: '营业执照-砚白.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not-a-real-image'),
  });
  await page.waitForTimeout(250);
  check('选完文件后列表出现一条材料', (await page.locator('.mzu-item').count()) === 1, String(await page.locator('.mzu-item').count()));
  const matText = await page.locator('.mzu-item').first().innerText();
  check('列表显示材料类型与文件名', matText.includes('营业执照') && matText.includes('营业执照-砚白.jpg'), matText.replace(/\n/g, ' '));
  check('错误随选文件清空', (await page.locator('.mzf-field[data-field="materials"].has-error').count()) === 0);
  await page.locator('[data-field="materials"] input.mzu-file').nth(1).setInputFiles({
    name: '品牌授权.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake'),
  });
  await page.waitForTimeout(250);
  check('可以再加一份材料', (await page.locator('.mzu-item').count()) === 2);
  await page.locator('.mzu-item').nth(1).locator('.mzu-del').click();
  check('移除按钮能删材料', (await page.locator('.mzu-item').count()) === 1);
  await page.screenshot({ path: '.shots/mzf-step3-materials.png', fullPage: true });
  await next();
  check('第 3 步通过后进入第 4 步', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('结算售后'));

  /* 5) 草稿：填一半刷新还在 */
  await fill('bankAccount', APPLICANT.company);
  await fill('bankBranch', '招商银行杭州分行营业部');
  await page.waitForTimeout(700); // 草稿是防抖写入（400ms）
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1400);
  const restored = await page.locator('[data-field="bankAccount"] input').inputValue();
  check('刷新后草稿被恢复（含当前步）', restored === APPLICANT.company && (await page.locator('.mzf-draft').isVisible()));
  check('恢复后仍停在第 4 步', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('结算售后'));
  check('刷新后材料清单也还在（草稿含材料）', (await page.locator('.mzu-item').count()) === 1);

  /* 6) 第四步：结算与售后 */
  await fill('bankNo', '6225880123456789');
  await page.locator('.mzf-seg-item', { hasText: '7 天无理由' }).click();
  await page.locator('.mzf-seg-item', { hasText: '48 小时内' }).click();
  await next();
  check('第 4 步通过后进入确认页', (await page.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('确认提交'));

  /* 6) 确认页：摘要 + 承诺 + 提交 */
  check('确认页摘要 7 行（含资质材料）', (await page.locator('.mzf-sum-row').count()) === 7, String(await page.locator('.mzf-sum-row').count()));
  const summaryText = await page.locator('.mzf-summary').innerText();
  check('摘要里卡号是打码的', summaryText.includes('****') && !summaryText.includes('6225880123456789'));
  check('摘要里能看到材料份数', summaryText.includes('1 份') && summaryText.includes('营业执照'), summaryText.replace(/\n/g, ' ').slice(0, 90));
  await page.screenshot({ path: '.shots/mzf-step4-confirm.png', fullPage: true });

  await page.locator('.mzf-submit').click();
  await page.waitForTimeout(500);
  check('未勾承诺不能提交', (await page.locator('.mzf-alert').isVisible()) && page.url().includes('/merchant/apply'));
  await page.locator('#mzf-agree-1').check();
  await page.locator('#mzf-agree-2').check();
  await page.locator('.mzf-submit').click();
  await page.waitForTimeout(2000);

  const url = page.url();
  check('提交成功跳到状态页（带编号与凭证）', /#\/merchant\/apply\?id=MA\d+&key=/.test(url), url);
  const appId = (url.match(/id=(MA\d+)/) || [])[1] || '';
  const statusText = await page.locator('.mzf-status').innerText();
  check('状态页显示「审核中」与编号', statusText.includes('审核中') && (await page.locator('.mzf-id').innerText()) === appId, `${statusText}/${appId}`);
  await page.screenshot({ path: '.shots/mzf-status.png', fullPage: true });

  /* 7) 刷新仍在状态页（说明是真查库，不是本地渲染完就完了） */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1600);
  check('刷新后仍能看到同一份申请', (await page.locator('.mzf-id').innerText().catch(() => '')) === appId);
  check('状态页联系人是打码的', (await page.locator('.mzf-summary').innerText()).includes('138****8000'));

  /* 8) 提交后草稿被清空 */
  const draftLeft = await page.evaluate(() => localStorage.getItem('maison_merchant_draft_v1'));
  check('提交成功后清空本机草稿', draftLeft === null);

  /* 9) 服务端真伪核验：页面说的「已提交」，用 Node 侧 fetch 再确认一遍 */
  const verify = await fetch(`${API}/api/merchant/applications/${appId}?key=${(url.match(/key=([^&]+)/) || [])[1]}`).then((r) => r.json());
  check('库里确有此单且品牌一致（Node 侧复核）', verify?.application?.brand === APPLICANT.brand, JSON.stringify(verify).slice(0, 120));
  check('材料清单真落库（Node 侧复核）', Array.isArray(verify?.application?.materials)
    && verify.application.materials.length === 1
    && verify.application.materials[0].kind === 'license', JSON.stringify(verify?.application?.materials));
  const noKey = await fetch(`${API}/api/merchant/applications/${appId}`).then((r) => r.status);
  check('无凭证查不到（404）', noKey === 404, String(noKey));

  /* 10) 移动端：无横向滚动、热区达标 */
  const m = await browser.newPage({ viewport: { width: 390, height: 780 } });
  const mErrors = [];
  m.on('pageerror', (e) => mErrors.push(String(e).slice(0, 120)));
  await m.goto(`${base}#/merchant/apply`, { waitUntil: 'load' });
  await m.waitForTimeout(1500);
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('移动端表单无横向滚动', overflow <= 1, `超出 ${overflow}px`);
  // 移动端默认停在第 1 步：量第 1 步里真实可见的选项卡与输入框（chip 在第 2 步，隐藏着量不到）
  const chipBox = await m.locator('.mzf-choice').first().boundingBox();
  check('移动端选项热区 ≥44px 高', Boolean(chipBox) && chipBox.height >= 44, chipBox ? String(Math.round(chipBox.height)) : 'no box');
  const inputBox = await m.locator('[data-field="company"] input').boundingBox();
  check('移动端输入框 ≥44px 高', Boolean(inputBox) && inputBox.height >= 44, inputBox ? String(Math.round(inputBox.height)) : 'no box');
  await m.screenshot({ path: '.shots/mzf-mobile.png', fullPage: true });
  check('移动端控制台无 JS 错误', mErrors.length === 0, mErrors.join(' | '));
  await m.close();

  check('桌面端控制台无 JS 错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  /* 11) 静态演示站（没有网关）不能假装成功 —— 这是分享出去的演示链接，最容易骗到自己 */
  const demo = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await demo.goto(`http://127.0.0.1:${PORT}/index.html#/merchant/apply`, { waitUntil: 'load' });
  await demo.evaluate((payload) => {
    // 直接种一份「已填到确认页」的草稿，省掉重复填表；这一步测的是提交失败时的表现
    localStorage.setItem('maison_merchant_draft_v1', JSON.stringify({ data: payload, step: 5, savedAt: Date.now() }));
  }, {
    entityKind: 'studio', company: APPLICANT.company, creditCode: APPLICANT.creditCode, contact: '周砚',
    phone: '13800138000', email: 'zhou@yanbai.design', brand: APPLICANT.brand, brandSource: 'owned',
    categories: ['home'], skuRange: '50-200', priceRange: '100-500',
    bankAccount: APPLICANT.company, bankNo: '6225880123456789', returnPolicy: '7days', shipWithin: '48h',
    materials: [{ kind: 'license', name: '营业执照.jpg', size: 1024 }],
  });
  await demo.reload({ waitUntil: 'load' });
  await demo.waitForTimeout(1200);
  check('演示站打开草稿直接落在确认页', (await demo.locator('.mzf-prog.is-current .mzf-prog-t').innerText()).includes('确认提交'));
  await demo.locator('#mzf-agree-1').check();
  await demo.locator('#mzf-agree-2').check();
  await demo.locator('.mzf-submit').click();
  await demo.waitForTimeout(1800);
  const demoAlert = await demo.locator('.mzf-alert').innerText().catch(() => '');
  check('演示站提交后如实说「未连接网关」', demoAlert.includes('未连接网关'), demoAlert.slice(0, 80));
  check('演示站提交后不跳成功页（没有假成功）', !demo.url().includes('id=MA') && (await demo.locator('.mzf-status').count()) === 0);
  check('演示站提交失败后草稿仍在', (await demo.evaluate(() => Boolean(localStorage.getItem('maison_merchant_draft_v1')))));
  await demo.screenshot({ path: '.shots/mzf-demo-offline.png', fullPage: true });
  await demo.close();
} finally {
  await browser.close();
  if (srv) srv.kill(); // 复用别人起在 5500 的服务器时不要动它
}

const bad = results.filter(([, ok]) => !ok);
console.log(`\n${bad.length === 0 ? '✓' : '✗'} ${results.length - bad.length}/${results.length} 项通过`);
process.exit(bad.length === 0 ? 0 : 1);
