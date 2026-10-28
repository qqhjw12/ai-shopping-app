#!/usr/bin/env node
/**
 * 前端自检：真实加载每个 ES Module。
 *
 * 为什么需要它：`node --check` 只做语法解析，抓不到这些会在浏览器里直接白屏的错误——
 *   - 重复 import 同名绑定（Identifier 'x' has already been declared）
 *   - 导入了目标模块并不存在的具名导出（does not provide an export named）
 *   - 顶层执行期异常（访问未定义的全局、读取未初始化的配置）
 *
 * 用法：
 *   node scripts/check-web.mjs               # 检查本地 web/js
 *   node scripts/check-web.mjs <dir>         # 检查指定目录（例如线上站点下载下来的 js）
 * 退出码：0 全部通过 / 1 有模块加载失败
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..', 'web', 'js');

/* ---------------- 极简 DOM 垫片（够前端模块顶层代码跑起来） ---------------- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this._text = null;
    this.className = '';
    this.id = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    const self = this;
    this.classList = {
      add: (c) => { if (!self._cls().includes(c)) self.className = (self.className + ' ' + c).trim(); },
      remove: (c) => { self.className = self._cls().filter((x) => x !== c).join(' '); },
      toggle: (c, on) => (on ? self.classList.add(c) : self.classList.remove(c)),
      contains: (c) => self._cls().includes(c),
    };
  }
  _cls() { return String(this.className || '').split(/\s+/).filter(Boolean); }
  appendChild(c) { if (c && c.tagName) c.parent = this; this.children.push(c); return c; }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  replaceWith(n) {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children[i] = n;
    }
    if (n && n.tagName) n.parent = this.parent;
    return n;
  }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { this.listeners[ev] = fn; }
  removeEventListener() {}
  focus() {}
  blur() {}
  scrollIntoView() {}
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  set innerHTML(v) { this.children = []; this._text = v === '' ? null : String(v); }
  get innerHTML() { return ''; }
  get textContent() { return (this._text || '') + this.children.map((c) => (c && c.textContent) || '').join(''); }
  set textContent(v) { this.children = []; this._text = v == null ? null : String(v); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const parts = sel.split(',').map((s) => s.trim());
    const out = [];
    const walk = (n) => {
      for (const p of parts) {
        let ok = false;
        if (p.startsWith('.')) ok = n._cls && n._cls().includes(p.slice(1));
        else if (p.startsWith('#')) ok = n.id === p.slice(1);
        else ok = n.tagName === p.toUpperCase();
        if (ok) { out.push(n); break; }
      }
      (n.children || []).forEach(walk);
    };
    this.children.forEach(walk);
    return out;
  }
}

const view = new El('main');
view.id = 'view';
globalThis.document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ _t: String(t), textContent: String(t) }),
  getElementById: (id) => (id === 'view' ? view : new El('div')),
  querySelector: () => new El('div'),
  querySelectorAll: () => [],
  addEventListener() {},
  body: new El('body'),
};
globalThis.location = { search: '', origin: 'http://localhost', pathname: '/', hash: '', href: 'http://localhost/' };
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
globalThis.history = { replaceState() {}, pushState() {} };
const mkStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
};
globalThis.localStorage = mkStore();
globalThis.sessionStorage = mkStore();
try {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'node' }, configurable: true });
} catch {
  /* Node 自带只读 navigator */
}
// 默认无后端：模拟静态托管对 /api/* 一律 404，顺带验证「演示模式」不会在加载期抛错。
// 用 404 而不是 status 0：真实浏览器里 fetch 不会返回 status 0（除非 opaque 响应），
// 静态托管的真实表现就是 404。而 status 0 会把「没有后端」和「网络不确定」混成一件事，
// 结算页的防双单逻辑恰好依赖这两条路径分开——前者降级本地单，后者带幂等键重放。
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  headers: { get: () => 'application/json' },
  json: async () => ({ error: 'not found' }),
  text: async () => '{"error":"not found"}',
});

/* ---------------- 逐个真实加载 ---------------- */
const files = readdirSync(WEB_DIR).filter((f) => f.endsWith('.js')).sort();
let failed = 0;
console.log(`检查 ${files.length} 个前端模块（真实 import，非仅语法解析）\n`);
for (const f of files) {
  try {
    await import(pathToFileURL(join(WEB_DIR, f)).href);
    console.log(`  ok   ${f}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${f}\n       ${e.name}: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 应用入口断言：能启动 + 404 兜底可用 ---------------- */
if (failed === 0) {
  console.log('\n应用入口断言');
  const app = await import(pathToFileURL(join(WEB_DIR, 'app.js')).href);
  await new Promise((r) => setTimeout(r, 150));
  const booted = view.children.length > 0;
  console.log(`  ${booted ? 'ok  ' : 'FAIL'} 首屏已渲染（非白屏）: ${view.children.length} 个节点`);
  if (!booted) failed++;

  const box = new El('main');
  app.renderNotFound(box);
  const t = box.textContent;
  const ok404 = t.includes('404') && box.querySelectorAll('.nf-btn').length === 4;
  console.log(`  ${ok404 ? 'ok  ' : 'FAIL'} 404 兜底页: 标题=${t.includes('这个页面走丢了')} 入口=${box.querySelectorAll('.nf-btn').length}`);
  if (!ok404) failed++;
}

/* ---------------- 商品详情（PDP）结构断言 ---------------- */
// 步骤 1 交付物：在 DOM 垫片里真实渲染一次详情页，逐个核对必须存在的信息模块。
// 垫片不支持后代选择器，故统一用单类名 + 文案断言。
if (failed === 0) {
  console.log('\n商品详情 PDP 断言（3 个可点进详情的商品）');
  try {
    const { renderProductDetail } = await import(pathToFileURL(join(WEB_DIR, 'views.js')).href);
    for (const pid of ['p017', 'p033', 'p097']) {
      const pdp = new El('main');
      await renderProductDetail(pdp, pid, 'list');
      await new Promise((r) => setTimeout(r, 0)); // 让 AI 摘要的异步填充先跑完
      const text = pdp.textContent;
      const n = (cls) => pdp.querySelectorAll(cls).length;
      const cases = [
        ['面包屑', n('.pdp-breadcrumb') === 1 && n('.pdp-crumb-current') === 1],
        ['画廊 主图+缩略图', n('.pdp-main-image') === 1 && n('.pdp-thumb') >= 2],
        ['价格+原价划线', n('.pdp-price') >= 1 && text.includes('¥') && n('.price-old') >= 1],
        ['SKU 规格', n('.pdp-sku') >= 2],
        ['库存/数量/配送退换卡', n('.pdp-stock') >= 1 && n('.pdp-stepper') === 1 && n('.pdp-service-card') === 1],
        ['星级入口', n('.pdp-rating-link') === 1],
        ['加购/立即购买/收藏', text.includes('加入购物袋') && text.includes('立即购买') && text.includes('收藏')],
        ['移动端吸底条', n('.pdp-mobile-actions') === 1],
        // 本步骤新增：AI 评价摘要 + 真实评价列表
        ['AI 摘要 好评率+结论', n('.pdp-ai-rate') === 1 && n('.pdp-ai-verdict') === 1],
        ['AI 摘要 要点/顾虑条目', n('.pdp-ai-point') >= 3 && text.includes('人提及')],
        ['评价区 分布条(5档)', n('.pdp-reviews') === 1 && n('.pdp-dist-row') === 5],
        ['评价列表 条目', n('.review') >= 3],
        ['评价 筛选+排序', n('.pdp-review-filter') === 5 && n('.pdp-review-sort') === 2],
        // 本步骤新增：写评价表单 + 有用投票
        ['写评价 入口+表单', n('.pdp-write-review') === 1 && n('.pdp-review-form') === 1],
        ['写评价 星级5+文本域+提交', n('.pdp-form-star') === 5 && n('.pdp-form-textarea') === 1 && n('.pdp-form-submit') === 1],
        ['每条评价都有用按钮', n('.pdp-vote') >= 3],
      ];
      const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
      console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} #/product/${pid}${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
      if (bad.length) failed++;
    }
  } catch (e) {
    failed++;
    console.log(`  FAIL PDP 渲染异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- PDP 交互闭环：有用投票 + 写评价 ---------------- */
// 结构断言只能证明「渲染出来了」，这里进一步触发真实点击事件，
// 验证计数联动、表单折叠、列表插入与 localStorage 持久化链路。
if (failed === 0) {
  console.log('\nPDP 交互断言（有用投票 / 写评价）');
  try {
    const { renderProductDetail } = await import(pathToFileURL(join(WEB_DIR, 'views.js')).href);
    const store = await import(pathToFileURL(join(WEB_DIR, 'store', 'productDetailStore.js')).href);
    const pdp = new El('main');
    await renderProductDetail(pdp, 'p017', 'list');
    await new Promise((r) => setTimeout(r, 0));

    const cnt = (node) => Number((node.querySelectorAll('.pdp-vote-count')[0] || {}).textContent || 0);
    const voteBtn = pdp.querySelectorAll('.pdp-vote')[0];
    const base = cnt(voteBtn);
    voteBtn.listeners.click();                       // 点赞
    const voted = cnt(voteBtn);
    const votedState = voteBtn.classList.contains('is-active') && /已赞同/.test(voteBtn.textContent);
    voteBtn.listeners.click();                       // 再点一次 → 取消赞，计数回退
    const cancelled = cnt(voteBtn);

    const form = pdp.querySelectorAll('.pdp-review-form')[0];
    const writeBtn = pdp.querySelectorAll('.pdp-write-review')[0];
    const allFilter = pdp.querySelectorAll('.pdp-review-filter')[0];
    // 「全部」标签上的计数就是真实评价总数，用它校验新增（列表默认只渲染一页）。
    const num = (node) => Number(String((node || {}).textContent || '').replace(/[^\d]/g, ''));
    const total = num(allFilter);
    const closedBefore = form.getAttribute('hidden') != null;
    writeBtn.listeners.click();                      // 展开表单
    const opened = form.getAttribute('hidden') == null;

    const stars = pdp.querySelectorAll('.pdp-form-star');
    stars[4].listeners.click();                      // 选 5 星
    const litStars = stars.filter((s) => s.classList.contains('is-on')).length;

    const textarea = pdp.querySelectorAll('.pdp-form-textarea')[0];
    textarea.value = '这是我写的自动化测试评价，用于验证发布链路是否通畅。';
    if (textarea.listeners.input) textarea.listeners.input();
    if (form.listeners.submit) form.listeners.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));

    // 列表默认只渲染一页（6 条），点「展开更多」后才能看到完整增量。
    const moreBtn = pdp.querySelectorAll('.pdp-review-more')[0];
    if (moreBtn && moreBtn.listeners.click) moreBtn.listeners.click();

    const listAfter = pdp.querySelectorAll('.review');
    const mine = listAfter[0];
    const totalText = (pdp.querySelectorAll('.pdp-review-total')[0] || {}).textContent || '';
    const persisted = store.readUserReviews('p017').length;

    // 买家秀：写评价表单要有文件选择入口与缩略图容器（真实选文件依赖浏览器，此处只验结构）
    const fileInputs = pdp.querySelectorAll('.pdp-file-input').length;
    const thumbBoxes = pdp.querySelectorAll('.pdp-form-thumbs').length;

    // 追评闭环：过短内容应被拦下（不产生追评块），补足字数后应发布成功
    let followUpGate = false;
    let followUpDone = false;
    const fuToggle = pdp.querySelectorAll('.pdp-followup-toggle')[0];
    if (fuToggle && fuToggle.listeners.click) {
      fuToggle.listeners.click();
      const fuForm = pdp.querySelectorAll('.pdp-followup-form')[0];
      const fuArea = pdp.querySelectorAll('.pdp-followup-textarea')[0];
      if (fuArea && fuForm) {
        fuArea.value = '太短';
        if (fuArea.listeners.input) fuArea.listeners.input();
        if (fuForm.listeners.submit) fuForm.listeners.submit({ preventDefault() {} });
        await new Promise((r) => setTimeout(r, 0));
        followUpGate = pdp.querySelectorAll('.pdp-followup-content').length === 0;

        fuArea.value = '这是追评内容，用于验证追评链路可正常落库并展示。';
        if (fuArea.listeners.input) fuArea.listeners.input();
        if (fuForm.listeners.submit) fuForm.listeners.submit({ preventDefault() {} });
        await new Promise((r) => setTimeout(r, 0));
        followUpDone = pdp.querySelectorAll('.pdp-followup-content').length >= 1;
      }
    }

    // 只看有图：切到 withPic 后列表只含带图评价；切换器文案带计数
    const withPicBtn = pdp.querySelectorAll('.pdp-review-filter').find((b) => b.getAttribute('data-filter') === 'withPic');
    withPicBtn.listeners.click();
    const picRows = pdp.querySelectorAll('.review');
    const withPicOk = /有图/.test(withPicBtn.textContent)
      && picRows.length >= 1
      && picRows.every((c) => c.querySelectorAll('.pdp-review-thumb').length >= 1);
    // 恢复「全部」
    pdp.querySelectorAll('.pdp-review-filter')[0].listeners.click();

    // 问答：面板 + 内置问答 + mock 提问（自动商家回复）+ localStorage 持久化
    const qaPanel = pdp.querySelectorAll('.pdp-qa')[0];
    const qaItemsBefore = pdp.querySelectorAll('.pdp-qa-item').length;
    const qaBuiltIn = qaItemsBefore >= 3 && /下单后多久能发货/.test(qaPanel.textContent || '');
    const qaAsk = pdp.querySelectorAll('.pdp-qa-ask')[0];
    qaAsk.listeners.click();
    const qaForm = pdp.querySelectorAll('.pdp-qa-form')[0];
    const qaArea = pdp.querySelectorAll('.pdp-qa-input')[0];
    qaArea.value = '这个尺码偏大还是偏小？';
    if (qaArea.listeners.input) qaArea.listeners.input();
    if (qaForm.listeners.submit) qaForm.listeners.submit({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 900)); // mock 商家回复延迟 600ms
    const qaItemsAfter = pdp.querySelectorAll('.pdp-qa-item').length;
    const firstQa = pdp.querySelectorAll('.pdp-qa-item')[0] || {};
    const qaOk = qaItemsBefore >= 3 && qaItemsAfter === qaItemsBefore + 1
      && /我的提问/.test(firstQa.textContent || '')
      && /官方客服/.test(firstQa.textContent || '')
      && (() => { try { const all = JSON.parse(localStorage.getItem('maison_pdp_qa_v1') || '{}'); return (all.p017 || []).length >= 1; } catch { return false; } })();

    // AI 摘要卡口径标注
    const aiFoot = pdp.querySelectorAll('.pdp-ai-foot')[0];
    const aiNoteOk = Boolean(aiFoot) && /AI 生成，仅供参考/.test(aiFoot.textContent || '');

    // 空态插画：某个筛选条件下无结果时出现金色细线插画 + 衬线文案
    let emptyArtOk = false;
    for (const b of pdp.querySelectorAll('.pdp-review-filter')) {
      b.listeners.click();
      if (pdp.querySelectorAll('.pdp-empty-art').length >= 1) {
        emptyArtOk = /还没有评价|还没有/.test(pdp.querySelectorAll('.pdp-review-empty-text')[0].textContent || '');
        break;
      }
    }
    // 恢复「全部」并把分页展开回去（切筛选会重置 visible，别影响后续删除断言）
    pdp.querySelectorAll('.pdp-review-filter')[0].listeners.click();
    const moreRestore = pdp.querySelectorAll('.pdp-review-more')[0];
    if (moreRestore && moreRestore.listeners.click && moreRestore.getAttribute('hidden') == null) moreRestore.listeners.click();

    // 删除本人评价闭环：mine 卡片带删除按钮，行内二次确认后从列表移除并回滚计数
    const cases = [
      ['投票计数 +1', voted === base + 1],
      ['投票选中态与文案', votedState],
      ['再点取消赞计数回退', cancelled === base && !voteBtn.classList.contains('is-active')],
      ['表单默认收起→点击展开', closedBefore && opened],
      ['星级点亮 5 颗', litStars === 5],
      ['评价总数 +1', num(allFilter) === total + 1],
      ['展开全部后列表含新评价', listAfter.length === total + 1],
      ['我的评价置顶且带标记', /我的评价/.test(mine.textContent || '') && /自动化测试/.test(mine.textContent || '')],
      ['概览总数同步更新', /条评价/.test(totalText)],
      ['写入 localStorage 可回读', persisted >= 1],
      ['买家秀选择入口 + 预览容器', fileInputs >= 1 && thumbBoxes >= 1],
      ['「只看有图」筛选生效', withPicOk],
      ['问答面板与内置问答', qaBuiltIn],
      ['提问后自动回复并持久化', qaOk],
      ['AI 摘要卡标注「仅供参考」', aiNoteOk],
      ['空态金色细线插画 + 衬线文案', emptyArtOk],
      ['我的评价带追评入口', Boolean(fuToggle)],
      ['追评内容过短被拦截', followUpGate],
      ['追评发布后出现在卡片内', followUpDone],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 有用投票 / 写评价${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;

    // 删除本人评价：在主断言之后再做，避免改动列表影响前面的计数断言。
    // 刚发布的「我的评价」是本地草稿（ur- 开头），走本地删除路径。
    let confirming = false;
    const delBtnBefore = pdp.querySelectorAll('.pdp-review-del').length;
    // 垫片不支持复合选择器 .review.is-mine，改用 classList 精确判定
    const mineCard = [...pdp.querySelectorAll('.review')].find((n) => n.classList.contains('is-mine'));
    const mineHadText = mineCard ? /自动化测试/.test(mineCard.textContent || '') : false;
    const delBtn = pdp.querySelectorAll('.pdp-review-del')[0];
    if (delBtn && delBtn.listeners.click) {
      delBtn.listeners.click(); // 第一次：进入二次确认态
      confirming = delBtn.textContent === '确认删除?' && delBtn.classList.contains('is-confirm');
      delBtn.listeners.click(); // 第二次：确认删除
      await new Promise((r) => setTimeout(r, 0));
    }
    const afterDelete = pdp.querySelectorAll('.review').length;
    const delBtnAfter = pdp.querySelectorAll('.pdp-review-del').length;
    const totalAfterDel = num(pdp.querySelectorAll('.pdp-review-filter')[0]);
    const delCases = [
      ['mine 评价带删除按钮', delBtnBefore >= 1 && mineHadText],
      ['删除进入二次确认态', confirming],
      ['删除后列表 −1', afterDelete === total],
      ['删除后计数回滚', totalAfterDel === total],
      ['删除后移除删除按钮', delBtnAfter < delBtnBefore],
    ];
    const delBad = delCases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${delBad.length === 0 ? 'ok  ' : 'FAIL'} 删除本人评价${delBad.length ? ` → 缺失: ${delBad.join('、')}` : ''}`);
    if (delBad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 交互断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 购物袋抽屉断言 ---------------- */
// 抽屉改造的核心承诺：数量受库存夹逼、删除可撤销、底部给出金额明细与包邮差额。
if (failed === 0) {
  console.log('\n购物袋抽屉断言（数量夹逼 / 撤销删除 / 金额明细）');
  try {
    const state = await import(pathToFileURL(join(WEB_DIR, 'state.js')).href);
    const { buildCartPanel } = await import(pathToFileURL(join(WEB_DIR, 'views.js')).href);
    state.clearCart();
    // 故意让两件商品的小计（80）低于包邮门槛（99），用于验证「再买 ¥19 包邮」提示
    state.addToCart({ id: 'cart_probe_a', name: '测试商品A', price: 50, pic: '', spec: '规格A', stock: 2 }, 1);
    state.addToCart({ id: 'cart_probe_b', name: '测试商品B', price: 30, pic: '', spec: '规格B' }, 1);

    const panel = buildCartPanel();
    const q = (cls) => panel.querySelectorAll(cls);
    const click = (node) => node && node.listeners && node.listeners.click && node.listeners.click();
    const text = () => panel.textContent;

    // 行结构
    const rows = q('.cart-item').length;
    const sumRows = q('.cart-sum-row').length;
    const hasTotalRow = q('.cart-sum-total').length === 1;
    // 运费与券改由结算页按配送方式决定，抽屉里只声明「结算页计算」，避免两处数字打架
    const shippingDeferred = /结算页计算/.test(text());

    // 数量步进：每件商品有一组「− / +」
    const steps = q('.cart-step');
    const minusA = steps[0];
    const plusA = steps[1];
    const minusDisabledAtOne = minusA.disabled === true;
    click(plusA);
    const qtyAfterPlus = state.getCart().find((i) => i.productId === 'cart_probe_a').qty;
    // 库存上限 2：再点一次应被夹逼住，且按钮置灰
    const panel2 = buildCartPanel();
    const plusA2 = panel2.querySelectorAll('.cart-step')[1];
    click(plusA2);
    const qtyClamped = state.getCart().find((i) => i.productId === 'cart_probe_a').qty;
    const plusDisabledAtMax = panel2.querySelectorAll('.cart-step')[1].disabled === true;

    // 达到 130 元 → 合计跟随商品金额（运费不在抽屉里算）
    const panel3 = buildCartPanel();
    const totalVal = ((panel3.querySelectorAll('.cart-sum-val')[2] || {}).textContent) || '';
    const totalFollows = /130/.test(totalVal);

    // 删除 → 撤销
    const panel4 = buildCartPanel();
    const delBtns = panel4.querySelectorAll('.cart-del');
    click(delBtns[0]);
    const afterDeleteRows = panel4.querySelectorAll('.cart-item').length;
    const undoVisible = panel4.querySelectorAll('.cart-undo')[0].getAttribute('hidden') == null;
    const undoBtn = panel4.querySelectorAll('.cart-undo-btn')[0];
    click(undoBtn);
    const restoredRows = panel4.querySelectorAll('.cart-item').length;

    // 清空需二次确认：第一次点只改文案不清空
    const panel5 = buildCartPanel();
    const clearBtn = panel5.querySelectorAll('.cart-clear-btn')[0];
    click(clearBtn);
    const afterFirstClickRows = panel5.querySelectorAll('.cart-item').length;
    const confirmLabel = /再点一次/.test(panel5.querySelectorAll('.cart-clear-btn')[0].textContent || '');
    click(panel5.querySelectorAll('.cart-clear-btn')[0]);
    const clearedEmpty = panel5.querySelectorAll('.cart-item').length === 0 && panel5.querySelectorAll('.cart-empty').length >= 1;

    const cases = [
      ['商品行数 = 2', rows === 2],
      ['金额明细（小计/运费/合计）', sumRows >= 3 && hasTotalRow],
      ['运费交由结算页计算', shippingDeferred],
      ['数量为 1 时「−」禁用', minusDisabledAtOne],
      ['点击「+」数量增加', qtyAfterPlus === 2],
      ['数量夹逼在库存上限', qtyClamped === 2],
      ['到上限后「+」禁用', plusDisabledAtMax],
      ['满额后合计跟随金额', totalFollows],
      ['删除后行数 -1', afterDeleteRows === 1],
      ['删除后撤销条可见', undoVisible],
      ['撤销后恢复原行数', restoredRows === 2],
      ['清空需二次确认（首点不清空）', afterFirstClickRows === 2 && confirmLabel],
      ['二次确认后真正清空', clearedEmpty],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 购物袋抽屉${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 购物袋断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 交易闭环断言（结算 → 下单 → 成功页 → 订单详情） ---------------- */
// 这一层守的是「钱与归属」：地址门禁没拦住会下出无法配送的单；
// 下单不清购物袋会让用户以为没成功又下一单；订单不按用户隔离则换号能看到别人的订单。
if (failed === 0) {
  console.log('\n交易闭环断言（两栏结算 / 地址门禁 / 下单 / 成功页 / 订单详情）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const state = await import(dir('state.js'));
    const userMod = await import(dir('user.js'));
    const orders = await import(dir('store/orderStore.js'));
    const { renderCheckout } = await import(dir('checkout.js'));
    const { renderCart } = await import(dir('cart.js'));
    const { renderOrderSuccess } = await import(dir('orderSuccess.js'));
    const { renderOrderDetail } = await import(dir('orderDetail.js'));
    const cp = await import(dir('store/couponStore.js'));
    const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    const click = (node) => node && node.listeners && node.listeners.click && node.listeners.click();
    const fmt = (n) => `¥${Number(n).toLocaleString()}`;

    localStorage.clear();
    userMod.clearCurrentUser();
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });
    const uid = userMod.getCurrentUser().id;
    state.clearCart();
    state.addToCart({ id: 'co_x', name: '结算测试羊毛衫', price: 320, spec: '米白 / M', stock: 5 }, 2);
    state.addToCart({ id: 'co_y', name: '结算测试托特包', price: 180, spec: '牛皮 / 大号', stock: 3 }, 1);

    /* 券包前置：券必须先领才能用（结算页只认「我的券包」，不再是目录临时拼的） */
    for (const c of cp.COUPON_CATALOG) await cp.claimCoupon(uid, c.id);
    const walletPrimed = cp.walletStats(uid).unused === cp.COUPON_CATALOG.length;

    /* 0) 购物袋整页：清单 + 去结算入口 */
    const bag = new El('main');
    renderCart(bag);
    const bagRows = bag.querySelectorAll('.bag-row').length === 2;
    const bagSum = bag.querySelectorAll('.bag-sum-row').length >= 2;
    const goCheckoutBtn = bag.querySelectorAll('.bag-checkout')[0];
    const goCheckoutLabel = (goCheckoutBtn || {}).textContent === '去结算';
    click(goCheckoutBtn);
    const goCheckoutNav = location.hash === '#/checkout';
    location.hash = '';

    /* 1) 未登录点结算 → 跳登录并带 redirect */
    userMod.clearCurrentUser();
    const vGuest = new El('main');
    await renderCheckout(vGuest);
    await tick();
    const guestRedirect = location.hash === '#/login?redirect=%2Fcheckout';
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });
    location.hash = '';

    /* 2) 无地址：提交按钮必须禁用 + 给出提示 */
    const v0 = new El('main');
    await renderCheckout(v0);
    await tick();
    const submit0 = v0.querySelectorAll('.co2-submit')[0];
    const blockedNoAddr = Boolean(submit0) && submit0.disabled === true;
    const hintNoAddr = /请先选择或新增收货地址/.test(v0.textContent);

    /* 3) 新增地址：空表单被拦下 → 补全后落库并自动选中 */
    click(v0.querySelectorAll('.co2-addr-add')[0]);
    const form = v0.querySelectorAll('.co2-addr-form')[0];
    const formShown = Boolean(form);
    form.listeners.submit({ preventDefault() {} });
    await tick();
    const invalidBlocked = /姓名/.test((v0.querySelectorAll('.co2-form-err')[0] || {}).textContent || '')
      && v0.querySelectorAll('.co2-addr').length === 0;
    v0.querySelectorAll('.f-receiver')[0].value = '张三';
    v0.querySelectorAll('.f-phone')[0].value = '13800001234';
    v0.querySelectorAll('.f-region')[0].value = '上海市 浦东新区';
    v0.querySelectorAll('.f-detail')[0].value = '世纪大道 100 号 8 楼';
    form.listeners.submit({ preventDefault() {} });
    await tick();
    const addrAdded = v0.querySelectorAll('.co2-addr').length === 1;
    const autoSelected = (v0.querySelectorAll('.co2-addr')[0] || {}).classList.contains('is-on');
    const unlocked = (v0.querySelectorAll('.co2-submit')[0] || {}).disabled === false;

    /* 4) 两栏结构 + 五个区块 + 金额汇总 */
    const v1 = new El('main');
    await renderCheckout(v1);
    await tick();
    const q = (c) => v1.querySelectorAll(c);
    const twoCol = q('.co2-grid').length === 1 && q('.co2-main').length === 1 && q('.co2-side').length === 1;
    const addrSelected = (q('.co2-addr')[0] || {}).classList.contains('is-on');
    const pickTitles = q('.co2-pick-title').map((n) => n.textContent);
    const hasShipping = pickTitles.includes('标准配送') && pickTitles.includes('加急配送');
    const hasPayment = pickTitles.includes('在线支付') && pickTitles.includes('货到付款');
    const etaShown = /预计 3–5 个工作日送达/.test(v1.textContent) && /预计次日/.test(v1.textContent);
    const itemCount = q('.co2-item').length;
    const itemDetail = q('.co2-item-thumb').length === 2 && q('.co2-item-sku').length === 2
      && /SKU：米白 \/ M/.test(v1.textContent);
    const backToBag = (q('.co2-item-edit')[0] || {}).getAttribute('href') === '#/cart';
    const sumRows = q('.co2-sum-row').length === 4;
    // 演示券自动选最优：总额 820 → 9 折券省 floor(820*10/100)=82（多于满 599 减 80）
    const EXP_WORTH = Math.floor(820 * 10 / 100);
    const onCount = () => [...q('.co2-cp')].filter((n) => n.classList.contains('is-on')).length; // 垫片不支持复合选择器
    const couponAutoOn = /已自动为你选中最优/.test(v1.textContent)
      && onCount() === 1
      && new RegExp(`已抵扣 ¥${EXP_WORTH}`).test(v1.textContent);
    const couponTitleShown = /优惠券（尊享 9 折 · 满 199 可用）/.test(v1.textContent);
    const totalBefore = (q('.co2-sum-money')[0] || {}).textContent || '';
    const remarkBox = q('.co2-remark').length === 1;

    /* 4.2) 券纯函数：worth 公式 / 最优选择 / 门槛差额 */
    const worthOk = cp.worthOf(cp.DEMO_COUPONS[2], 820) === 82 // 9 折
      && cp.worthOf(cp.DEMO_COUPONS[1], 640) === 80 // 满 599 减 80
      && cp.worthOf(cp.DEMO_COUPONS[0], 50) === 0; // 未达门槛
    const bestOk = cp.bestCouponId(cp.decorate(cp.DEMO_COUPONS, 820)) === 'demo-c90' // 82 > 80
      && cp.bestCouponId(cp.decorate(cp.DEMO_COUPONS, 640)) === 'demo-c80' // 80 > 64，满减反超折扣
      && cp.bestCouponId(cp.decorate(cp.DEMO_COUPONS, 50)) === null; // 全不可用
    const gapOk = cp.gapToThreshold(cp.DEMO_COUPONS[0], 50) === 49;

    /* 4.5) 券可切换 / 可取消；清单步进器：数量、库存夹逼、金额联动 */
    // 可用券按「省得多」排前，所以第一张是当前已选中的 9 折券；
    // 要切到满减券必须按标题找，不能靠下标（排序规则一变下标就失效）。
    const cpByTitle = (re) => [...v1.querySelectorAll('.co2-cp')]
      .find((n) => re.test(n.textContent || ''));
    click(cpByTitle(/满 99 减 30/));
    await tick(0);
    const switchCouponTotal = (v1.querySelectorAll('.co2-sum-money')[0] || {}).textContent || '';
    const switchOk = switchCouponTotal === fmt(820 - 30); // 790
    click(cpByTitle(/满 99 减 30/)); // 再点一次 = 取消使用
    await tick(0);
    const couponOffTotal = (v1.querySelectorAll('.co2-sum-money')[0] || {}).textContent || '';
    const couponOffOk = couponOffTotal === fmt(820) && onCount() === 0;
    // 恢复自动最优券
    const bestBtn = [...v1.querySelectorAll('.co2-cp')].find((n) => /9 折/.test((n.querySelectorAll('.co2-cp-worth')[0] || {}).textContent || ''));
    click(bestBtn);
    await tick(0);
    const restoredBest = (v1.querySelectorAll('.co2-sum-money')[0] || {}).textContent === fmt(820 - EXP_WORTH);

    const stepPlus = () => {
      const row = v1.querySelectorAll('.co2-item')[0];
      return (row && row.querySelectorAll('.co2-step')[1]) || null;
    };
    const qtyText = () => {
      const row = v1.querySelectorAll('.co2-item')[0];
      return ((row && row.querySelectorAll('.co2-qty-n')[0]) || {}).textContent || '';
    };
    click(stepPlus()); // 2 → 3
    await tick(0);
    const qtyAfterInc = qtyText() === '3';
    const totalMovedWithQty = (v1.querySelectorAll('.co2-sum-money')[0] || {}).textContent !== totalBefore;
    // 库存夹逼：co_x stock=5，从 3 连点 + 到 5，按钮应禁用（4 次点击里最后一次无效）
    for (let i = 0; i < 4; i++) { click(stepPlus()); await tick(0); }
    const clampedAtStock = qtyText() === '5' && stepPlus().disabled === true;
    // 恢复 2
    for (let i = 0; i < 3; i++) {
      const row = v1.querySelectorAll('.co2-item')[0];
      click(row && row.querySelectorAll('.co2-step')[0]); // −
      await tick(0);
    }
    const qtyRestored = qtyText() === '2';

    /* 5) 切加急配送 → 运费与应付联动；切货到付款 → 选中态跟随 */
    click(q('.co2-pick')[1]);
    await tick(0);
    const totalAfterShip = (q('.co2-sum-money')[0] || {}).textContent || '';
    const expressOn = q('.co2-pick')[1].classList.contains('is-on');
    const feeShown = /¥18/.test(v1.textContent);
    click(q('.co2-pick')[3]);
    await tick(0);
    const codOn = q('.co2-pick')[3].classList.contains('is-on') && !q('.co2-pick')[2].classList.contains('is-on');

    /* 5.6) 清单删除：新视图里删掉第二件 → 清单 1 行、金额联动；随后恢复购物袋 */
    const v1b = new El('main');
    await renderCheckout(v1b);
    await tick(20);
    const rowsBeforeDel = v1b.querySelectorAll('.co2-item').length;
    const delBtn = (() => {
      const row = v1b.querySelectorAll('.co2-item')[1];
      return (row && row.querySelectorAll('.co2-item-del')[0]) || null;
    })();
    click(delBtn);
    await tick(0);
    const afterDelRows = v1b.querySelectorAll('.co2-item').length;
    const afterDelTotal = (v1b.querySelectorAll('.co2-sum-money')[0] || {}).textContent || '';
    const delOk = rowsBeforeDel === 2 && afterDelRows === 1 && afterDelTotal === fmt(640 - 80);
    // 恢复 co_y（结算页删除没有撤销，直接补回购物袋）
    state.addToCart({ id: 'co_y', name: '结算测试托特包', price: 180, spec: '牛皮 / 大号', stock: 3 }, 1);

    /* 6) 备注 + 提交 */
    const remark = q('.co2-remark')[0];
    remark.value = '工作日送达，放前台';
    if (remark.listeners.input) remark.listeners.input();
    click(q('.co2-submit')[0]);
    await tick(40);

    const list = orders.listOrders(uid);
    const order = list[0] || null;
    const created = list.length === 1 && Boolean(order) && order.status === 'pending';
    const cartCleared = state.getCart().length === 0;
    const navigated = String(location.hash).startsWith('#/order-success/');
    const shapeOk = Boolean(order) && order.userId === uid && order.items.length === 2
      && order.address && order.address.receiver === '张三'
      && order.shippingMethod.id === 'express' && order.shippingMethod.fee === 18
      && order.paymentMethod.id === 'cod'
      && order.remark === '工作日送达，放前台'
      && order.amounts.couponDiscount === 82 && order.amounts.productAmount === 820
      && order.amounts.shippingFee === 18 && order.amounts.payAmount === 756
      && order.amounts.couponTitle === "尊享 9 折 · 满 199 可用"
      && order.amounts.couponId === 'demo-c90'
      && Boolean(order.createdAt);
    const idPattern = Boolean(order) && /^MS\d{8}\d{4}$/.test(order.id);
    const isolatedOrders = orders.listOrders('u_someone_else').length === 0;
    const persistedOrder = Boolean(order)
      && (JSON.parse(localStorage.getItem(`maison_orders::${uid}`) || '[]') || []).length === 1;

    /* 7) 成功页：订单号 / 应付金额 / 查看订单 + 继续购物 */
    const v2 = new El('main');
    renderOrderSuccess(v2, order ? order.id : 'missing');
    const osBtns = v2.querySelectorAll('.os-btn');
    const showsId = Boolean(order) && new RegExp(order.id).test(v2.textContent || '');
    const showsAmount = /756/.test(v2.textContent || '');
    const pendingShown = /待付款/.test(v2.textContent || '');
    const detailHref = osBtns[0] && osBtns[0].getAttribute('href') === `#/account/order/${order.id}`;
    const shopHref = osBtns[1] && osBtns[1].getAttribute('href') === '#/products';

    /* 8) 订单详情：本地订单能还原商品 / 地址 / 配送 / 金额 */
    const v3 = new El('main');
    await renderOrderDetail(v3, order ? order.id : 'missing');
    await tick(30);
    const detailOk = v3.querySelectorAll('.od-card').length === 1
      && new RegExp(order.id).test(v3.textContent || '')
      && /结算测试羊毛衫/.test(v3.textContent || '')
      && /¥756/.test(v3.textContent || '')
      && /加急配送/.test(v3.textContent || '')
      && /工作日送达，放前台/.test(v3.textContent || '');

    const cases = [
      ['购物袋整页渲染 2 行', bagRows],
      ['购物袋有金额小计', bagSum],
      ['购物袋有「去结算」', goCheckoutLabel],
      ['点去结算进入 #/checkout', goCheckoutNav],
      ['未登录去结算跳登录（带 redirect）', guestRedirect],
      ['无地址时提交按钮禁用', blockedNoAddr],
      ['无地址时给出提示文案', hintNoAddr],
      ['新增地址表单可展开', formShown],
      ['空地址被拦下（不落库）', invalidBlocked],
      ['补全后地址新增成功', addrAdded],
      ['新地址自动选中', autoSelected],
      ['有地址后提交按钮可用', unlocked],
      ['结算页两栏布局', twoCol],
      ['默认地址预选', addrSelected],
      ['配送方式两项（标准/加急）', hasShipping],
      ['支付方式两项（在线/货到付款）', hasPayment],
      ['配送时效与运费可见', etaShown],
      ['商品清单 2 行', itemCount === 2 && itemDetail],
      ['清单可返回购物袋修改', backToBag],
      ['券纯函数（worth 公式）', worthOk],
      ['券纯函数（自动选最优可切换满减）', bestOk],
      ['券纯函数（门槛差额）', gapOk],
      ['券卡自动选中最优（9 折省 82）', couponAutoOn],
      ['券包前置：目录券全部领取', walletPrimed],
      ['金额行显示券名', couponTitleShown],
      ['券可切换为满减券', switchOk],
      ['券可取消（取消后无抵扣）', couponOffOk],
      ['券可恢复最优', restoredBest],
      ['清单行数量可加（2→3）', qtyAfterInc],
      ['数量联动金额与券', totalMovedWithQty],
      ['数量受库存夹逼（5 封顶）', clampedAtStock],
      ['数量可减回', qtyRestored],
      ['清单可删除且金额/券联动', delOk],
      ['金额四行（总额/运费/券/应付）', sumRows],
      ['备注输入框存在', remarkBox],
      ['切加急后应付金额变化（含券抵扣）', Boolean(totalBefore) && totalBefore !== totalAfterShip && /756/.test(totalAfterShip)],
      ['加急选中态 + 运费展示', expressOn && feeShown],
      ['支付方式切换生效', codOn],
      ['提交后生成 1 笔待付款订单', created],
      ['提交后清空购物袋', cartCleared],
      ['提交后跳订单成功页', navigated],
      ['订单结构完整（items/address/金额/备注）', shapeOk],
      ['订单号格式 MS+日期+序号', idPattern],
      ['订单按用户隔离', isolatedOrders],
      ['订单写入 localStorage 可回读', persistedOrder],
      ['成功页显示订单号', showsId],
      ['成功页显示应付金额', showsAmount],
      ['成功页显示待付款', pendingShown],
      ['成功页可跳订单详情', Boolean(detailHref)],
      ['成功页可继续购物', Boolean(shopHref)],
      ['订单详情可还原订单内容', detailOk],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 交易闭环${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
    state.clearCart();
  } catch (e) {
    failed++;
    console.log(`  FAIL 交易闭环断言异常: ${String(e.message).split('\n')[0]}`);
    // 断言脚本里的异常几乎都是「某步操作没产生预期 DOM」导致后续链式取值炸掉，
    // 只打 message 定位不到是哪一步，把调用栈打出来能省一次重跑。
    console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}

/* ---------------- 优惠券断言（券中心 / 券包分栏 / 结算抵扣 / 核销 / 取消返还） ---------------- */
// 这一层守的是「券的三条边界」：
//   1) 没领就不能用——否则券中心的领取动作是装饰品；
//   2) 状态要自洽——用过/过期不能再被结算页选中，取消订单要退回；
//   3) 金额不为负——券面额再大也不能抵过商品总额，运费也不能被抵掉。
if (failed === 0) {
  console.log('\n优惠券断言（领取 / 券包分栏 / 结算抵扣 / 核销 / 取消返还 / 防负数）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const cp = await import(dir('store/couponStore.js'));
    const addr = await import(dir('store/addressStore.js'));
    const orders = await import(dir('store/orderStore.js'));
    const state = await import(dir('state.js'));
    const userMod = await import(dir('user.js'));
    const { renderCoupons } = await import(dir('coupons.js'));
    const { renderAccount } = await import(dir('accountCenter.js'));
    const { renderOrderDetail } = await import(dir('orderDetail.js'));
    const { renderCheckout } = await import(dir('checkout.js'));
    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
    const click = (n) => n && n.listeners && n.listeners.click && n.listeners.click();
    const fmt = (n) => `¥${Number(n).toLocaleString()}`;

    localStorage.clear();
    userMod.clearCurrentUser();
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });
    const uid = userMod.getCurrentUser().id;
    state.clearCart();
    const CID = cp.COUPON_CATALOG[0].id; // 券中心第一张（门槛最低，列表按门槛升序）
    const GAPID = 'cp-home50'; // 门槛 399，用来验「还差多少钱」的不可用原因

    /* 1) 券中心：目录全量、字段齐全、领取生效、按钮置灰、重复领取被拒 */
    // 未登录也能看券（券是公开信息），但领取要先登录——先验访客视图再验登录视图
    userMod.clearCurrentUser();
    const vGuest2 = new El('main');
    renderCoupons(vGuest2);
    const guestHint = /登录后领取/.test(vGuest2.textContent || '')
      && vGuest2.querySelectorAll('.cp-ticket').length === cp.COUPON_CATALOG.length;
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });

    const vc = new El('main');
    renderCoupons(vc);
    const catalogShown = vc.querySelectorAll('.cp-ticket').length === cp.COUPON_CATALOG.length;
    const metaShown = /有效期/.test(vc.textContent || '')
      && /适用范围/.test(vc.textContent || '')
      && /满 ¥99 可用/.test(vc.textContent || '');
    click(vc.querySelectorAll('.cp-claim')[0]);
    await tick(40);
    await cp.claimCoupon(uid, GAPID); // 再领一张高门槛券，用于验「还差多少钱」
    const twoClaimed = cp.walletStats(uid).unused === 2;
    const claimedBtnOff = vc.querySelectorAll('.cp-claim').filter((n) => n.disabled === true).length === 2;
    const heldLine = /已领取 · \d{4}\.\d{2}\.\d{2} 到期/.test(vc.textContent || '');
    const dup = await cp.claimCoupon(uid, CID);
    const dupRejected = dup.ok === false && /已在卡包/.test(dup.error || '');

    /* 2) 我的券包：三 Tab + 计数 + 未使用有「去使用」 */
    const va = new El('main');
    renderAccount(va, { tab: 'coupons' });
    const tabs3 = va.querySelectorAll('.mycp-tab').length === 3;
    const tabText = va.querySelectorAll('.mycp-tab').map((n) => n.textContent).join('|');
    const tabsLabeled = /未使用/.test(tabText) && /已使用/.test(tabText) && /已过期/.test(tabText);
    const mineCard = va.querySelectorAll('.mycp').length === 2
      && va.querySelectorAll('.mycp-act').length === 2;
    const statsLine = /2 张可用/.test(va.textContent || '');
    click(va.querySelectorAll('.mycp-tab')[1]); // 已使用
    await tick(0);
    const usedEmpty = va.querySelectorAll('.acct-empty').length === 1
      && /还没有用过优惠券/.test(va.textContent || '');
    click(va.querySelectorAll('.mycp-tab')[2]); // 已过期
    await tick(0);
    const expiredEmpty = /没有过期的券/.test(va.textContent || '');
    click(va.querySelectorAll('.mycp-tab')[0]); // 回到未使用

    /* 3) 结算页：只认已领取的券；未达门槛的给出原因；选中即抵扣 */
    state.addToCart({ id: 'cp_x', name: '券测试香薰', price: 300, spec: '雪松 / 200ml', stock: 9 }, 1);
    await addr.saveAddress(uid, {
      receiver: '券测试', phone: '13700007777', province: '浙江省', city: '杭州市',
      detail: '文二西路 66 号', isDefault: true,
    });
    const vco = new El('main');
    await renderCheckout(vco);
    await tick(40);
    // 300 元：满 99 减 30 与 9 折都省 30，平手取门槛更高的一张（9 折）
    const autoCoupon = /已自动为你选中最优/.test(vco.textContent || '');
    const pickedTitle = cp.listWallet(uid).length > 0
      && /已抵扣 ¥30/.test(vco.textContent || '');
    const gapReason = /满 ¥399 可用 · 还差 ¥99/.test(vco.textContent || '');
    const totalAfterCoupon = (vco.querySelectorAll('.co2-sum-money')[0] || {}).textContent === fmt(270);

    /* 4) 提交 → 券核销为已使用（挂订单号） */
    click(vco.querySelectorAll('.co2-submit')[0]);
    await tick(80);
    const order = orders.listOrders(uid)[0] || null;
    const orderCoupon = Boolean(order) && order.amounts.couponDiscount === 30
      && order.amounts.couponId === CID && order.amounts.payAmount === 270;
    const usedNow = cp.listWallet(uid).find((w) => w.couponId === CID).state === 'used';
    const usedOrderId = cp.listWallet(uid).find((w) => w.couponId === CID).orderId === (order && order.id);
    const walletAfter = cp.walletStats(uid).used === 1;

    /* 5) 券包 Tab 跟随：已使用里出现这张券，并带订单号 */
    const va2 = new El('main');
    renderAccount(va2, { tab: 'coupons' });
    click(va2.querySelectorAll('.mycp-tab')[1]);
    await tick(0);
    const usedCard = va2.querySelectorAll('.mycp').length === 1
      && new RegExp(order.id).test(va2.textContent || '');

    /* 6) 取消订单 → 状态关闭 + 券退回券包 */
    const vd = new El('main');
    await renderOrderDetail(vd, order.id);
    await tick(30);
    const cancelBtn = vd.querySelectorAll('.od-cancel')[0];
    click(cancelBtn); // 第一下进入确认态
    const needConfirm = /确认取消/.test((cancelBtn || {}).textContent || '');
    click(vd.querySelectorAll('.od-cancel')[0]); // 第二下真正取消
    await tick(40);
    const closedOk = orders.getOrder(uid, order.id).status === 'closed';
    const refunded = cp.listWallet(uid).find((w) => w.couponId === CID).state === 'unused';
    const refundCleared = cp.listWallet(uid).find((w) => w.couponId === CID).orderId === null;

    /* 7) 过期由时间推导（不落盘）：把到期时间改到昨天，状态立刻是已过期 */
    const rawKey = `maison_coupons::${uid}`;
    const raw = JSON.parse(localStorage.getItem(rawKey) || '[]');
    const expiredIdx = raw.findIndex((w) => w.couponId === CID);
    raw[expiredIdx].expiresAt = Date.now() - 86400000;
    localStorage.setItem(rawKey, JSON.stringify(raw));
    const expiredDerived = cp.listWallet(uid).find((w) => w.couponId === CID).state === 'expired';
    const expiredCounted = cp.walletStats(uid).expired === 1;
    const expiredNotUsable = cp.decorateMine(cp.listWallet(uid), 999).find((c) => c.couponId === CID).usable === false;

    /* 8) 金额防负数：抵扣不超过商品总额，运费不被抵掉 */
    const overDiscount = orders.computeAmounts({ productAmount: 50, shippingFee: 0, couponDiscount: 1000 });
    const floorZero = overDiscount.payAmount === 0 && overDiscount.couponDiscount === 50;
    const shipKept = orders.computeAmounts({ productAmount: 50, shippingFee: 18, couponDiscount: 1000 }).payAmount === 18;
    const noWorthBelowThreshold = cp.worthOf({ kind: 'discount', amount: 10, threshold: 200 }, 199) === 0;
    const badInput = orders.computeAmounts({ productAmount: -100, shippingFee: -5, couponDiscount: -20 });
    const sanitized = badInput.payAmount === 0 && badInput.productAmount === 0;

    /* 9) 券包按用户隔离 */
    const isolatedWallet = cp.walletStats('u_coupon_other').total === 0
      && cp.listWallet('u_coupon_other').length === 0;

    /* 10) 跨设备合并（纯函数）：服务端已核销覆盖本地、本地已核销补推、服务端独有补入 */
    const nowM = Date.now();
    const D = 86400000;
    const mres = cp.mergeWallet(
      [
        { id: 'l1', couponId: 'ma-demo', status: 'unused', expiresAt: nowM + 10 * D },
        { id: 'l2', couponId: 'mb-demo', status: 'used', orderId: 'MS_LOCAL', expiresAt: nowM + 5 * D },
      ],
      [
        { id: 91, couponId: 'ma-demo', state: 'used', orderId: 'MS_REMOTE', expiresAt: nowM + 3 * D },
        { id: 92, couponId: 'mc-demo', state: 'unused', expiresAt: nowM + 8 * D, title: '服务端新券' },
      ],
      nowM,
      // 发件箱里还躺着一张没送达的核销 → 该补推，不能当成「服务端已返还」
      [{ type: 'use', couponId: 'mb-demo', orderId: 'MS_LOCAL' }],
    );
    const mA = mres.list.find((c) => c.couponId === 'ma-demo');
    // 另一台设备用掉的券，本机必须跟着变已使用；到期时间也以服务端为准
    const remoteUsedWins = mA.status === 'used' && mA.orderId === 'MS_REMOTE' && mA.expiresAt === nowM + 3 * D;
    // 本地已核销、服务端还没 → 补推核销（离线下单不能白多用一张券）
    const localUsedPushed = mres.toUse.some((o) => o.couponId === 'mb-demo' && o.orderId === 'MS_LOCAL');
    // 服务端有、本地没有 → 补进来（另一台设备领的）
    const remoteOnlyAdded = mres.list.some((c) => c.couponId === 'mc-demo' && c.title === '服务端新券');
    // 合并结果按 couponId 唯一，不会因为重复同步长出重复券
    const noDupAfterMerge = new Set(mres.list.map((c) => c.couponId)).size === mres.list.length;
    const m2 = cp.mergeWallet([{ id: 'l3', couponId: 'md-demo', status: 'unused', expiresAt: nowM + D }], [], nowM);
    const localOnlyPushed = m2.toPush.includes('md-demo');
    // 发件箱是空的、服务端却说未使用 → 只能是因为订单取消返还了，本地必须跟着退回
    const mReturn = cp.mergeWallet(
      [{ id: 'l4', couponId: 'me-demo', status: 'used', orderId: 'MS_RETURNED', expiresAt: nowM + D }],
      [{ id: 93, couponId: 'me-demo', state: 'unused', expiresAt: nowM + 8 * D }],
      nowM,
      [],
    );
    const localFollowsRefund = mReturn.list.find((c) => c.couponId === 'me-demo').status === 'unused'
      && mReturn.toUse.length === 0;

    /* 11) 返还顺延：从 max(原到期, 现在) 起算 + 配置天数，每券最多顺延配置次数 */
    const rulesNow = cp.refundRules();
    const graceFromNow = cp.refundExpiry(nowM - D, 0, nowM).expiresAt === nowM + rulesNow.refundGraceDays * D;
    const graceOnRemain = cp.refundExpiry(nowM + 2 * D, 0, nowM).expiresAt === nowM + (2 + rulesNow.refundGraceDays) * D;
    const graceCapped = cp.refundExpiry(nowM + D, rulesNow.maxExtensions, nowM).extended === false;

    /* 11b) 规则是运营可配的：显式传不同规则必须算不同结果（证明不是写死的 7 天 / 3 次） */
    const ruleA = { refundGraceDays: 15, maxExtensions: 1 };
    const configDrivesGrace = cp.refundExpiry(nowM - D, 0, nowM, ruleA).expiresAt === nowM + 15 * D;
    const configDrivesCap = cp.refundExpiry(nowM - D, 1, nowM, ruleA).extended === false;
    const zeroGrace = cp.refundExpiry(nowM, 0, nowM, { refundGraceDays: 0, maxExtensions: 9 }).extended === false;

    const uidR = 'u_coupon_grace';
    const seedRaw = (row) => localStorage.setItem(`maison_coupons::${uidR}`, JSON.stringify([row]));
    seedRaw({
      id: 'g1', couponId: 'demo-c80', title: '会员日 · 满 599 减 80', kind: 'cash',
      threshold: 599, amount: 80, status: 'used', orderId: 'MS_GRACE',
      claimedAt: new Date(nowM - D).toISOString(), expiresAt: nowM + 2 * D, extensionCount: 0,
    });
    const rf = cp.refundCouponsByOrder(uidR, 'MS_GRACE');
    const wG = cp.listWallet(uidR).find((c) => c.couponId === 'demo-c80');
    const refundExtended = rf.restored === 1 && rf.extended === 1
      && wG.state === 'unused' && wG.extensionCount === 1
      && wG.expiresAt === nowM + (2 + rulesNow.refundGraceDays) * D;
    // 已在订单占用期间过期的券，返还后立刻恢复可用（从 now 起算而不是原到期日）
    seedRaw({
      id: 'g2', couponId: 'demo-c80', title: '会员日 · 满 599 减 80', kind: 'cash',
      threshold: 599, amount: 80, status: 'used', orderId: 'MS_GRACE2',
      claimedAt: new Date(nowM - 40 * D).toISOString(), expiresAt: nowM - 3 * D, extensionCount: 0,
    });
    cp.refundCouponsByOrder(uidR, 'MS_GRACE2');
    const wG2 = cp.listWallet(uidR).find((c) => c.couponId === 'demo-c80');
    const expiredRefundRevived = wG2.state === 'unused' && wG2.expiresAt > nowM;

    const cases = [
      ['券中心列出目录全部券', catalogShown],
      ['券卡显示门槛/有效期/适用范围', metaShown],
      ['未登录可浏览、按钮为「登录后领取」', guestHint],
      ['领取后进入券包', twoClaimed],
      ['已领取按钮置灰', claimedBtnOff],
      ['已领取显示到期日', heldLine],
      ['重复领取被拒（该券已在卡包中）', dupRejected],
      ['我的券包三个 Tab', tabs3 && tabsLabeled],
      ['未使用 Tab 有券卡与「去使用」', mineCard],
      ['面板统计与券包一致', statsLine],
      ['已使用 Tab 空态', usedEmpty],
      ['已过期 Tab 空态', expiredEmpty],
      ['结算页自动选中最优券', autoCoupon && pickedTitle],
      ['未达门槛的券写明差额', gapReason],
      ['抵扣后应付 = 总额 − 抵扣', totalAfterCoupon],
      ['下单后券核销（金额快照含 couponId）', orderCoupon],
      ['下单后券变已使用', usedNow && walletAfter],
      ['核销记录订单号', usedOrderId],
      ['券包已使用 Tab 显示订单号', usedCard],
      ['取消订单需二次确认', needConfirm],
      ['取消后订单关闭', closedOk],
      ['取消后券退回未使用', refunded && refundCleared],
      ['过期由时间推导（不落盘）', expiredDerived && expiredCounted],
      ['过期券不可在结算页使用', expiredNotUsable],
      ['抵扣不超过商品总额（不为负）', floorZero],
      ['顺延规则取自运营配置（非写死 7 天/3 次）', configDrivesGrace && configDrivesCap],
      ['顺延天数配 0 时不再延长', zeroGrace],
      ['运费不被券抵扣', shipKept],
      ['未达门槛 worth 为 0', noWorthBelowThreshold],
      ['负数输入被夹到 0', sanitized],
      ['券包按用户隔离', isolatedWallet],
      ['跨设备：服务端已核销覆盖本地', remoteUsedWins],
      ['跨设备：本地核销补推', localUsedPushed],
      ['跨设备：服务端返还后本地跟着退回', localFollowsRefund],
      ['跨设备：服务端独有券补入', remoteOnlyAdded],
      ['跨设备：本地独有券补推领取', localOnlyPushed],
      ['跨设备：合并后无重复券', noDupAfterMerge],
      ['返还顺延从「现在」起算', graceFromNow],
      ['返还顺延叠加剩余天数', graceOnRemain],
      ['顺延次数达上限后不再延长', graceCapped],
      ['取消订单返还并顺延 7 天', refundExtended],
      ['过期券返还后恢复可用', expiredRefundRevived],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 优惠券${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
    state.clearCart();
  } catch (e) {
    failed++;
    console.log(`  FAIL 优惠券断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 运行时配置断言（运营可配参数） ---------------- */
// 运费与券返还规则从「编译期常量」改成「服务端配置」之后，最怕两种坏法：
//   1) 配置缺字段/类型不对时算出 NaN 或负运费（配置错了不该让结算页算不出钱）；
//   2) 页面读的其实是本地常量，运营改了也不生效（等于换了个地方写死）。
// 这两件事都在这里用纯函数兜住：归一化、运费公式、注入后生效。
if (failed === 0) {
  console.log('\n运行时配置断言（归一化 / 运费公式 / 券规则可配）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const cfg = await import(dir('store/config.js'));

    /* 1) 默认值完整：至少两种配送方式 + 券顺延规则有值 */
    const defaultsOk = cfg.DEFAULT_CONFIG.shipping.methods.length >= 2
      && cfg.DEFAULT_CONFIG.coupon.refundGraceDays > 0
      && cfg.DEFAULT_CONFIG.coupon.maxExtensions >= 0;

    /* 2) 空配置 → 完全回落到内置默认（离线首屏不能没有运费） */
    const emptySafe = cfg.normalizeConfig({}).shipping.methods.length
      === cfg.DEFAULT_CONFIG.shipping.methods.length;

    /* 3) 脏配置 → 逐项夹住，不产生 NaN / 负运费 */
    const dirty = cfg.normalizeConfig({
      shipping: { methods: [{ id: 'x', name: '', fee: 'abc' }] },
      coupon: { refundGraceDays: 'abc', maxExtensions: 999 },
    });
    const dirtySafe = Number.isFinite(dirty.shipping.methods[0].fee)
      && dirty.shipping.methods[0].fee === 0
      && Number.isFinite(dirty.coupon.refundGraceDays)
      && dirty.coupon.maxExtensions <= 10;

    /* 4) 运费公式：标价 / 满额包邮门槛按「券后金额」判 / 负数夹到 0 */
    const feeFormula = cfg.shippingFeeOf({ fee: 18, freeOver: 199 }, 100) === 18
      && cfg.shippingFeeOf({ fee: 18, freeOver: 199 }, 199) === 0
      && cfg.shippingFeeOf({ fee: 0, freeOver: null }, 0) === 0;
    const feeFloor = cfg.shippingFeeOf({ fee: -20, freeOver: null }, 500) === 0;

    /* 5) 未知配送 id 回落到 fallback，不会返回 undefined 让页面崩 */
    const fallbackOk = Boolean(cfg.findShipping('no-such-id')) === true
      && cfg.findShipping('no-such-id').id === cfg.getConfig().shipping.fallbackId;

    /* 6) 注入新配置后立刻生效——证明读的是运行时值，不是写死的常量 */
    cfg.__setRuntimeConfigForTest({
      shipping: { methods: [{ id: 'only', name: '唯一', fee: 8, eta: '当天送达' }], fallbackId: 'only' },
      payment: { methods: [{ id: 'wallet', name: '余额支付', note: '演示' }], fallbackId: 'wallet' },
      coupon: { refundGraceDays: 11, maxExtensions: 5 },
    });
    const injected = cfg.refundRules().refundGraceDays === 11
      && cfg.refundRules().maxExtensions === 5
      && cfg.shippingMethods().length === 1
      && cfg.shippingMethods()[0].fee === 8;

    /* 7) 支付方式也是配置：注入后立刻生效，未知 id 回落 fallback，缺段回落内置默认 */
    const paymentInjected = cfg.paymentMethods().length === 1
      && cfg.paymentMethods()[0].id === 'wallet'
      && cfg.findPayment('no-such-id').id === 'wallet';
    cfg.__setRuntimeConfigForTest(cfg.DEFAULT_CONFIG); // 还原，别影响后面的块
    const paymentDefaults = cfg.paymentMethods().length === cfg.DEFAULT_CONFIG.payment.methods.length
      && cfg.paymentMethods().some((m) => m.id === 'cod')
      && cfg.findPayment(null).id === cfg.getConfig().payment.fallbackId;
    // 脏支付配置：重复 id 只留一个、空列表回落默认、字段缺失不会出现 undefined 名称
    const paymentDirty = cfg.normalizeConfig({
      payment: { methods: [{ id: 'a', name: '' }, { id: 'a', name: '重复' }, { name: '没有 id' }] },
    }).payment;
    const paymentSafe = paymentDirty.methods.length === 1
      && paymentDirty.methods[0].name === 'a'
      && cfg.normalizeConfig({ payment: { methods: [] } }).payment.methods.length
        === cfg.DEFAULT_CONFIG.payment.methods.length;

    /* 8) 下单幂等键：格式合法（服务端 ^[A-Za-z0-9_-]{8,64}$）+ 每次不同 */
    const co = await import(dir('checkout.js'));
    const idemA = co.newIdempotencyKey();
    const idemB = co.newIdempotencyKey();
    const idemOk = /^[A-Za-z0-9_-]{8,64}$/.test(idemA)
      && /^[A-Za-z0-9_-]{8,64}$/.test(idemB)
      && idemA !== idemB;

    const cases = [
      ['内置默认配置完整（配送 ≥2 种、券规则有值）', defaultsOk],
      ['空配置回落到默认', emptySafe],
      ['脏配置被夹住（不出 NaN / 超界）', dirtySafe],
      ['运费按配置计算，满额包邮看券后金额', feeFormula],
      ['负运费夹到 0', feeFloor],
      ['未知配送方式回落到 fallback', fallbackOk],
      ['注入配置后立即生效（非本地写死）', injected],
      ['支付方式同样来自配置（注入即生效）', paymentInjected],
      ['支付方式兜底完整（缺段回落默认 / 未知 id 用 fallback）', paymentDefaults],
      ['脏支付配置被清洗（去重 / 补名 / 空列表回落）', paymentSafe],
      ['下单幂等键格式合法且每次不同', idemOk],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'}  运行时配置${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 运行时配置断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 账户体系断言（登录 / 守卫 / 个人中心 / 地址簿） ---------------- */
// 这一层检查的是「归属」与「拦截」这两件容易悄悄坏掉的事：
// 如果守卫只写在 app.js 里，谁都测不到；如果地址没按用户隔离，换个账号就串数据。
if (failed === 0) {
  console.log('\n账户体系断言（登录校验 / 路由守卫 / 地址簿隔离）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const userMod = await import(dir('user.js'));
    const guard = await import(dir('guard.js'));
    const { renderLogin } = await import(dir('login.js'));
    const { renderAccount } = await import(dir('accountCenter.js'));
    const { renderOrderDetail } = await import(dir('orderDetail.js'));
    const addr = await import(dir('store/addressStore.js'));
    const state = await import(dir('state.js'));

    /* 1) 守卫规则：哪些页面要登录、回流地址怎么拼 */
    const guardCases = [
      ['#/account 需登录', guard.isProtectedPath('/account')],
      ['#/account/order/x 需登录', guard.isProtectedPath('/account/order/o_1')],
      ['#/checkout 需登录', guard.isProtectedPath('/checkout')],
      ['#/order-success 需登录', guard.isProtectedPath('/order-success/MS202610280001')],
      ['#/products 不需登录', !guard.isProtectedPath('/products')],
      ['redirect 带原始查询串', guard.loginTarget('/checkout?x=1') === '#/login?redirect=%2Fcheckout%3Fx%3D1'],
      ['拒绝协议相对跳转', guard.sanitizeRedirect('//evil.com') === '#/account'],
      ['登录页不自跳回登录页', guard.sanitizeRedirect('/login') === '#/account'],
      ['登录后原路返回', guard.sanitizeRedirect('/checkout') === '#/checkout'],
    ];
    const gBad = guardCases.filter(([, ok]) => !ok).map(([l]) => l);
    console.log(`  ${gBad.length === 0 ? 'ok  ' : 'FAIL'} 路由守卫规则${gBad.length ? ` → 缺失: ${gBad.join('、')}` : ''}`);
    if (gBad.length) failed++;

    /* 2) 登录页：空提交 / 非法账号 / 验证码错 / 验证码对 */
    localStorage.clear();
    const lv = new El('main');
    renderLogin(lv, {});
    const lq = (c) => lv.querySelectorAll(c);
    const lform = lq('.auth-form')[0];
    const errText = () => (lq('.auth-error')[0] || {}).textContent || '';
    const submitLogin = async () => {
      lform.listeners.submit({ preventDefault() {} });
      await new Promise((r) => setTimeout(r, 30)); // 登录会先建会话再跳转
    };

    await submitLogin();
    const errEmpty = /手机号|邮箱/.test(errText());
    lq('.auth-id')[0].value = '12345';
    await submitLogin();
    const errBadId = /手机号|邮箱/.test(errText());
    lq('.auth-id')[0].value = '13800001234';
    lq('.auth-code')[0].value = '000000';
    await submitLogin();
    const errBadCode = /验证码/.test(errText()) && !userMod.isLoggedIn();

    lq('.auth-code')[0].value = userMod.DEMO_CODE;
    await submitLogin();
    const loggedIn = userMod.isLoggedIn();
    const me = userMod.getCurrentUser();
    const persisted = JSON.parse(localStorage.getItem('current_user') || 'null');
    const backToAccount = location.hash === '#/account';
    const noTokenInStorage = localStorage.getItem('accessToken') === null
      && localStorage.getItem('refreshToken') === null
      && !JSON.stringify(persisted || {}).includes('Token');
    const stateFollowsUser = state.getUserId() === me.id;

    /* 3) 演示账号一键登录 + redirect 回流 */
    localStorage.clear();
    userMod.clearCurrentUser();
    const lv2 = new El('main');
    renderLogin(lv2, { redirect: '/checkout' });
    lv2.querySelectorAll('.auth-demo')[0].listeners.click();
    await new Promise((r) => setTimeout(r, 30));
    const demoId = (userMod.getCurrentUser() || {}).id;
    const redirectWorks = location.hash === '#/checkout';

    /* 4) 未登录访问个人中心 → 跳登录并带 redirect */
    userMod.clearCurrentUser();
    const av0 = new El('main');
    renderAccount(av0, { tab: 'orders' });
    const guardedHash = location.hash;

    /* 5) 登录后渲染：Bento 网格 + 三个 Tab */
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });
    const av = new El('main');
    renderAccount(av, { tab: 'address' });
    await new Promise((r) => setTimeout(r, 0));
    const bentoOk = av.querySelectorAll('.acct-hero').length === 1
      && av.querySelectorAll('.acct-glow').length === 1
      && av.querySelectorAll('.acct-stat').length === 3;
    const tabCount = av.querySelectorAll('.acct-tab').length;
    const tabActive = av.querySelectorAll('.acct-tab')[1].classList.contains('is-on');

    /* 6) 地址簿：空 → 校验拦截 → 新增 → 第二条 → 设默认 → 删除 */
    const emptyFirst = av.querySelectorAll('.acct-empty').length >= 1;
    av.querySelectorAll('.acct-add')[0].listeners.click();
    const form1 = av.querySelectorAll('.acct-addr-form')[0];
    const formShown = Boolean(form1);
    const field = (cls) => av.querySelectorAll(cls)[0];
    form1.listeners.submit({ preventDefault() {} });
    const invalidBlocked = av.querySelectorAll('.acct-addr').length === 0
      && /姓名/.test((av.querySelectorAll('.acct-form-err')[0] || {}).textContent || '');

    const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

    field('.f-receiver').value = '张三';
    field('.f-phone').value = '13800001234';
    field('.f-province').value = '上海市';
    field('.f-city').value = '浦东新区';
    field('.f-detail').value = '世纪大道 100 号 8 楼';
    field('.f-postal').value = '200120';
    form1.listeners.submit({ preventDefault() {} });
    await tick();
    const oneCard = av.querySelectorAll('.acct-addr').length === 1;
    const autoDefault = /默认/.test((av.querySelectorAll('.acct-addr')[0] || {}).textContent || '');

    av.querySelectorAll('.acct-add')[0].listeners.click();
    const form2 = av.querySelectorAll('.acct-addr-form')[0];
    field('.f-receiver').value = '李四';
    field('.f-phone').value = '13900002222';
    field('.f-province').value = '浙江省';
    field('.f-city').value = '杭州市 西湖区';
    field('.f-detail').value = '文三路 200 号 A 座 5 层';
    form2.listeners.submit({ preventDefault() {} });
    await tick();
    const twoCards = av.querySelectorAll('.acct-addr').length === 2;
    // 面板计数与顶部数据块都要跟着地址数走（不能停在渲染时的快照 0）
    const panelCountSynced = (av.querySelectorAll('.acct-panel-sub')[0] || {}).textContent === '2 个 · 跨设备同步'
      && (av.querySelectorAll('.acct-stat-value')[0] || {}).textContent === '2'
      && /默认收货：张三/.test((av.querySelectorAll('.acct-hero-note')[0] || {}).textContent || '');

    const setDefaultBtn = av.querySelectorAll('.acct-addr-act')
      .find((b) => b.textContent === '设为默认' && b.listeners && b.listeners.click);
    if (setDefaultBtn) setDefaultBtn.listeners.click();
    await tick();
    const listAfterDefault = addr.listAddresses(userMod.DEMO_ACCOUNT.id);
    const defaultMoved = listAfterDefault[0] && listAfterDefault[0].receiver === '李四'
      && listAfterDefault.filter((a) => a.isDefault).length === 1;

    // 按用户隔离：另一个账户看到的必须是空的
    const otherEmpty = addr.listAddresses('u_someone_else').length === 0;
    await addr.saveAddress('u_someone_else', { receiver: '王五', phone: '13700003333', province: '北京市', city: '朝阳区', detail: '建国路 1 号院 3 号楼' });
    const isolated = addr.listAddresses(userMod.DEMO_ACCOUNT.id).length === 2
      && addr.listAddresses('u_someone_else').length === 1;

    const delBtn = av.querySelectorAll('.acct-addr-act').find((b) => b.classList.contains('del'));
    delBtn.listeners.click();
    const confirming = delBtn.textContent === '确认删除?' && delBtn.classList.contains('is-confirm');
    delBtn.listeners.click();
    await tick();
    const afterDelete = av.querySelectorAll('.acct-addr').length === 1;

    const badPostal = await addr.saveAddress(userMod.DEMO_ACCOUNT.id, {
      receiver: '赵六', phone: '13600004444', province: '广东省', city: '深圳市', detail: '科技园南路 8 号', postal: '123',
    });

    /* 6b) 跨设备契约：服务端为准 + 离线降级可辨认 */
    // 离线写入（自检环境无后端，api 必然失败）应保留本地并标记 pending，而不是丢数据
    const offlineSave = await addr.saveAddress(userMod.DEMO_ACCOUNT.id, {
      receiver: '离线甲', phone: '13500005555', province: '四川省', city: '成都市', detail: '天府大道 1 号',
    });
    const offlineKept = offlineSave.ok === true && offlineSave.online === false
      && addr.listAddresses(userMod.DEMO_ACCOUNT.id).some((a) => a.receiver === '离线甲' && a.pending);
    const hydrateIsFn = typeof addr.hydrateAddresses === 'function';
    // 服务端返回项要能补齐 province/city（老数据只有 region 时不能把地区写丢）
    const hydrated = await addr.hydrateAddresses(userMod.DEMO_ACCOUNT.id);
    const hydrateKeepsLocal = hydrated.online === false
      && hydrated.addresses.some((a) => a.receiver === '离线甲');

    /* 7) 优惠券占位 + 订单 Tab + 订单详情占位 */
    const av2 = new El('main');
    renderAccount(av2, { tab: 'coupons' });
    const couponEmpty = av2.querySelectorAll('.acct-empty').length >= 1
      && /优惠券/.test(av2.textContent || '');

    const av3 = new El('main');
    renderAccount(av3, { tab: 'orders' });
    await new Promise((r) => setTimeout(r, 10));
    const ordersFallback = av3.querySelectorAll('.acct-empty').length >= 1;

    const av4 = new El('main');
    await renderOrderDetail(av4, 'o_demo_999');
    await new Promise((r) => setTimeout(r, 20));
    const detailMissing = /o_demo_999/.test(av4.textContent || '')
      && /没有找到这笔订单/.test(av4.textContent || '');

    const cases = [
      ['空表单提交被拦下', errEmpty],
      ['非法账号被拦下', errBadId],
      ['验证码错误被拦下', errBadCode],
      ['正确验证码登录成功', loggedIn],
      ['currentUser 写入 localStorage', persisted && persisted.id === me.id && persisted.nickname === '用户1234'],
      ['登录后跳回 #/account', backToAccount],
      ['localStorage 不存令牌', noTokenInStorage],
      ['getUserId 跟随登录用户', stateFollowsUser],
      ['演示账号一键登录', demoId === 'u_demo'],
      ['登录后回到 redirect 目标', redirectWorks],
      ['未登录进个人中心被拦到登录页', guardedHash === '#/login?redirect=%2Faccount'],
      ['Bento 头部（玻璃卡+微光+3 数据块）', bentoOk],
      ['三个 Tab 胶囊', tabCount === 3],
      ['当前 Tab 选中态', tabActive],
      ['地址簿初始为空', emptyFirst],
      ['新增地址表单可展开', formShown],
      ['必填缺失不落库', invalidBlocked],
      ['新增后出现 1 张地址卡', oneCard],
      ['首条地址自动为默认', autoDefault],
      ['可新增第二条', twoCards],
      ['面板计数/数据块/默认提示同步', panelCountSynced],
      ['设为默认生效且唯一', defaultMoved],
      ['新账户地址簿为空', otherEmpty],
      ['地址按用户隔离', isolated],
      ['删除需二次确认', confirming],
      ['确认后删除生效', afterDelete],
      ['邮编格式校验', badPostal.ok === false && /邮编/.test(badPostal.error || '')],
      ['离线写入保留本地并标记待同步', offlineKept],
      ['导出服务端校准接口', hydrateIsFn],
      ['离线校准不丢未同步地址', hydrateKeepsLocal],
      ['优惠券占位空状态', couponEmpty],
      ['订单取不回时给兜底提示', ordersFallback],
      ['订单详情查不到时给出口', detailMissing],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 登录 / 守卫 / 地址簿${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 账户体系断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 检索与筛选断言（关键词 / 多维筛选 / 排序 / URL 往返） ---------------- */
// 这一层只碰纯函数与渲染结果，不依赖浏览器：
//   - URL 往返（写出去的条件必须能原样读回来）——刷新/分享保持状态的根基
//   - 多选语义（同维度 OR、跨维度 AND）、价格档位不重不漏、属性与库存
//   - 排序单调性：价格升/降、销量、上新
//   - 三个渲染面：搜索结果 / 空关键词热门词 / 无结果空态 / 列表页已选标签
if (failed === 0) {
  console.log('\n检索与筛选断言（关键词 / 多维筛选 / 排序 / URL 往返）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const cat = await import(dir('store/catalog.js'));
    const { renderProducts, renderSearch } = await import(dir('views.js'));
    const { demoProducts: demoList } = await import(dir('demo-data.js'));
    const E = cat.EMPTY_FILTERS;
    const all = demoList;

    /* 1) URL 编解码往返 */
    const f1 = {
      ...E, q: '降噪 耳机', cats: ['phone', 'audio'], subs: ['audio_tws'], brands: ['极光'],
      price: ['p100_500', 'p3000'], colors: ['黑'], sizes: ['标准版'],
      stock: true, sort: 'price_asc', min: 88, max: null,
    };
    const back = cat.parseFilters(Object.fromEntries(new URLSearchParams(cat.buildQuery(f1).slice(1))));
    const roundTrip = JSON.stringify(back) === JSON.stringify(f1);
    const cleanUrl = cat.buildQuery(E) === '' && cat.buildQuery({ ...E, sort: 'default' }) === '';
    const badBand = cat.parseFilters({ price: 'p100,zzz' }).price.join(',') === 'p100';

    /* 2) 关键词：全字段命中、AND 语义、无命中 */
    const kwList = cat.filterOnly(all, { ...E, q: '耳机' });
    const kwFieldOk = kwList.length > 0 && kwList.every((p) => [p.name, p.description, (p.tags || []).join(' '), p.brand, p.category, p.subCategory]
      .join(' ').includes('耳机'));
    const kwAndOk = cat.filterOnly(all, { ...E, q: '耳机 降噪' }).length <= kwList.length;
    const kwMissOk = cat.filterOnly(all, { ...E, q: '绝不存在的商品关键词' }).length === 0;

    /* 3) 多选 OR / 跨维 AND / 价格档位不重不漏 */
    const phoneN = cat.filterOnly(all, { ...E, cats: ['phone'] }).length;
    const audioN = cat.filterOnly(all, { ...E, cats: ['audio'] }).length;
    const multiOk = cat.filterOnly(all, { ...E, cats: ['phone', 'audio'] }).length === phoneN + audioN;
    const crossOk = cat.filterOnly(all, { ...E, cats: ['phone'], price: ['p1000_3000'] }).length < phoneN;
    const brandN = cat.filterOnly(all, { ...E, brands: ['极光'] }).length;
    const brandAndCat = cat.filterOnly(all, { ...E, brands: ['极光'], cats: ['phone'] }).length;
    const andOk = brandAndCat > 0 && brandAndCat <= Math.min(brandN, phoneN);
    const bandSum = cat.PRICE_BANDS.reduce((n, b) => n + cat.filterOnly(all, { ...E, price: [b.id] }).length, 0);
    const bandOk = bandSum === all.length;

    /* 4) 属性（颜色/规格）与库存 */
    const black = cat.filterOnly(all, { ...E, colors: ['黑'] });
    const colorOk = black.length > 0 && black.every((p) => cat.skuTraits(p).colors.includes('黑'));
    const apparelSizes = [...new Set(cat.filterOnly(all, { ...E, cats: ['apparel'] }).flatMap((p) => cat.skuTraits(p).sizes))];
    const sizeOk = apparelSizes.includes('M') && apparelSizes.includes('L');
    const inStock = cat.filterOnly(all, { ...E, stock: true });
    // 演示库全部有货，用一条构造出来的缺货商品验证「仅看有货」确实会把它挡掉
    const ghost = { ...all[0], id: '__ghost_out__', totalStock: 0, skus: [] };
    const stocked = cat.filterOnly([...all, ghost], { ...E, stock: true });
    const stockOk = inStock.length === all.length
      && stocked.length === all.length
      && !stocked.some((p) => p.id === '__ghost_out__')
      && cat.filterOnly([...all, ghost], { ...E }).length === all.length + 1;

    /* 5) 排序单调性 */
    const asc = cat.applyFilters(all, { ...E, sort: 'price_asc' });
    const desc = cat.applyFilters(all, { ...E, sort: 'price_desc' });
    const sales = cat.applyFilters(all, { ...E, sort: 'sales' });
    const newest = cat.applyFilters(all, { ...E, sort: 'new' });
    const mono = (arr, cmp) => arr.every((p, i) => i === 0 || cmp(arr[i - 1], p));
    const sortOk = mono(asc, (a, b) => a.price <= b.price)
      && mono(desc, (a, b) => a.price >= b.price)
      && mono(sales, (a, b) => (a.sales || 0) >= (b.sales || 0))
      && mono(newest, (a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }) >= 0);

    /* 6) 分面计数：排除自身维度，选价格不影响品类条数 */
    const bandOnly = cat.filterOnly(all, { ...E, price: ['p1000_3000'] });
    const fc = cat.facetCounts(all, { ...E, price: ['p1000_3000'] });
    const fcOk = fc.cats.get('phone') === bandOnly.filter((p) => p.categoryId === 'phone').length
      && [...fc.price.values()].reduce((n, v) => n + v, 0) === all.length
      && fc.inStock === bandOnly.filter((p) => cat.stockOf(p) > 0).length;

    /* 7) 热门搜索词：每个词都能搜到东西 */
    const hot = cat.hotSearches(all, 6);
    const hotOk = hot.length === 6 && hot.every((w) => cat.filterOnly(all, { ...E, q: w.value }).length > 0);

    /* 8) 渲染：搜索结果页 */
    const sv = new El('main');
    await renderSearch(sv, { q: '耳机' });
    const svText = sv.textContent;
    const svCount = /共 (\d+) 件商品/.exec(svText);
    const searchRenderOk = svCount && Number(svCount[1]) > 0
      && sv.querySelectorAll('.pcard').length > 0
      && sv.querySelectorAll('.sort-select').length === 1
      && sv.querySelectorAll('option').length === cat.SORTS.length
      && sv.querySelectorAll('.flt-chip').length > 10;

    /* 9) 空关键词：热门搜索占位，不铺商品 */
    const hv = new El('main');
    await renderSearch(hv, {});
    const hotPlaceholderOk = hv.querySelectorAll('.hot-word').length >= 6
      && hv.querySelectorAll('.pcard').length === 0
      && /热门搜索/.test(hv.textContent);

    /* 10) 无结果：安静空态 + 可清空 */
    const ev = new El('main');
    await renderSearch(ev, { q: '压根不存在的关键词' });
    const emptyOk = /共 0 件商品/.test(ev.textContent)
      && ev.querySelectorAll('.empty-editorial').length === 1
      && /换个关键词|清空筛选/.test(ev.textContent);

    /* 11) 列表页：多选 + 已选标签 + 排序下拉 */
    // 垫片只支持单类名选择器（不认 .a.b），命中态一律按 className 统计
    const activeChips = (root) => root.querySelectorAll('.flt-chip').filter((n) => n.classList.contains('active')).length;
    const lv = new El('main');
    await renderProducts(lv, { cat: 'phone,audio', color: '黑', stock: '1', sort: 'price_desc', price: 'p1000_3000' });
    const lvTags = lv.querySelectorAll('.flt-tag').length;
    const lvActive = activeChips(lv);
    const listUiOk = lvTags === 5 && lvActive === 5 && lv.querySelectorAll('.flt-clear-all').length === 1;

    /* 12) 清空筛选保留关键词与排序 */
    const cleared = cat.clearedFilters({ ...f1 });
    const clearOk = cleared.q === f1.q && cleared.sort === f1.sort
      && cat.countActive(cleared) === 0 && cat.countActive(f1) === 10;

    /* 13) 分类页：价格区间 + 排序作用于类目目录 */
    const { renderCategories } = await import(dir('categories.js'));
    const cv = new El('main');
    await renderCategories(cv, { price: 'p1000_3000', sort: 'count' });
    const catPageOk = cv.querySelectorAll('.cat-tools').length === 1
      && cv.querySelectorAll('.flt-chip').length === cat.PRICE_BANDS.length + 1
      && cv.querySelectorAll('.cat-card').length > 0
      && activeChips(cv) === 1
      && /个类目/.test(cv.textContent);

    const cases = [
      ['URL 往返（筛选状态可分享/刷新保持）', roundTrip],
      ['默认条件不写进 URL', cleanUrl],
      ['非法价格档位被丢弃', badBand],
      ['关键词命中商品名/描述/标签', kwFieldOk],
      ['多词 AND 语义', kwAndOk],
      ['无关词零命中', kwMissOk],
      ['同维度多选 OR', multiOk],
      ['跨维度 AND', andOk && crossOk],
      ['价格档位不重不漏', bandOk],
      ['颜色属性筛选', colorOk],
      ['尺码属性（M/L）', sizeOk],
      ['仅看有货', stockOk],
      ['排序单调（价格升/降/销量/上新）', sortOk],
      ['分面计数排除自身维度', fcOk],
      ['热门搜索词都有结果', hotOk],
      ['搜索页：结果数/卡片/排序/筛选面板', Boolean(searchRenderOk)],
      ['空关键词显示热门词占位', hotPlaceholderOk],
      ['无结果空态可清空', emptyOk],
      ['列表页：多选已选标签与清空', listUiOk],
      ['清空筛选保留关键词与排序', clearOk],
      ['分类页：价格区间 + 排序', catPageOk],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 检索与筛选${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 检索断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

/* ---------------- 履约与售后断言（状态流转 / 物流时间线 / 售后记录） ---------------- */
// 这一层守的是「订单页说的和真发生的一致」：
//   1) 阶段由时间戳推导、status 只负责胶囊——售后中的订单不能因此丢掉进度（否则整条流转条消失）；
//   2) 物流没事件行时要能回退合成，不能出现「已发货但时间线空白」；
//   3) 售后必须真的改订单状态并留下记录，否则那颗按钮只是装饰。
if (failed === 0) {
  console.log('\n履约与售后断言（状态流转 / 物流时间线 / 售后申请与记录）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const orders = await import(dir('store/orderStore.js'));
    const logi = await import(dir('store/logistics.js'));
    const as = await import(dir('store/aftersaleStore.js'));
    const userMod = await import(dir('user.js'));
    const { renderOrderDetail } = await import(dir('orderDetail.js'));
    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
    const hasCls = (node, c) => Boolean(node && node.classList && node.classList.contains(c));

    localStorage.clear();
    userMod.clearCurrentUser();
    const uid = 'u_fulfil_test';
    userMod.setCurrentUser({ id: uid, nickname: '履约测试', phone: '13800001234' });

    /* 1) 状态词表：说人话（待发货 / 已取消），不要说系统内部叫法 */
    const texts = ['paid', 'closed', 'refunding', 'pending', 'shipped', 'completed'].map((s) => orders.statusText(s));
    const textOk = texts[0] === '待发货' && texts[1] === '已取消' && texts[2] === '售后中'
      && texts[3] === '待付款' && texts[4] === '已发货' && texts[5] === '已完成';

    /* 2) 阶段推导：只看时间戳，不看 status */
    const stPending = orders.orderStage({ status: 'pending', createdAt: '2026-10-27 10:00:00' });
    const stPaid = orders.orderStage({ status: 'paid', paidAt: '2026-10-27 10:01:00' });
    const stRefunding = orders.orderStage({
      status: 'refunding', paidAt: '2026-10-27 10:01:00', shippedAt: '2026-10-27 18:00:00', completedAt: '2026-10-28 09:00:00',
    });
    const stClosed = orders.orderStage({ status: 'closed', createdAt: '2026-10-27 10:00:00' });
    const stageOk = stPending.steps.length === 4 && stPending.index === 0
      && stPaid.index === 1 && !stPaid.steps[2].done
      && stRefunding.index === 3 && stRefunding.refunding && !stRefunding.cancelled
      && stClosed.cancelled;

    /* 3) 造一笔待发货订单 */
    const oid = 'MS202610280001';
    const base = {
      id: oid,
      userId: uid,
      items: [{ productId: 'p244', name: '履约测试签字笔', spec: '0.5mm / 灰', price: 29, qty: 2, subtotal: 58 }],
      address: { receiver: '履约', phone: '13800001234', region: '浙江省 杭州市', detail: '文三路 88 号' },
      shippingMethod: { id: 'standard', name: '标准配送', fee: 0, eta: '3-5 天' },
      paymentMethod: { id: 'online', name: '在线支付' },
      amounts: { productAmount: 58, shippingFee: 0, couponDiscount: 0, payAmount: 58 },
      status: 'paid',
      createdAt: '2026-10-27 10:00:00',
      paidAt: '2026-10-27 10:01:00',
    };
    orders.upsertOrder(uid, base);

    /* 4) 未发货：物流块显示「待发货」而不是空时间线 */
    const vPaid = new El('main');
    await renderOrderDetail(vPaid, oid);
    await tick();
    const paidEmpty = vPaid.querySelectorAll('.od-track').length === 0
      && (vPaid.querySelectorAll('.od-sec-tag')[0] || {}).textContent === '待发货'
      // 待发货的文案分两种（未付款 / 已付款待打包），这里只认「会在这里更新」这个共同承诺
      && /物流信息会在这里更新/.test(vPaid.textContent || '');
    const demoShipLabel = (vPaid.querySelectorAll('.od-demo-btn')[0] || {}).textContent;

    /* 5) 本地模拟发货：状态 + 运单号 + 两条事件 */
    const shippedOrder = orders.applyShipment(uid, oid);
    const logiAfterShip = logi.logisticsOf(shippedOrder);
    const shipOk = shippedOrder.status === 'shipped'
      && /^(SF|JD|ZT)\d{10,}/.test(shippedOrder.logistics.trackingNo)
      && logiAfterShip.stages.filter((s) => s.done).length === 2
      && logiAfterShip.stages[3].done === false;

    /* 6) 页面：四段节点全画出来，未到达的灰显 */
    const vShip = new El('main');
    await renderOrderDetail(vShip, oid);
    await tick();
    const steps = vShip.querySelectorAll('.od-step');
    const trackItems = vShip.querySelectorAll('.od-track-item');
    const shipPageOk = steps.length === 4 && trackItems.length === 4
      && trackItems.filter((n) => hasCls(n, 'is-done')).length === 2
      && /待更新/.test(vShip.textContent || '')
      && new RegExp(shippedOrder.logistics.trackingNo).test(vShip.textContent || '');
    const aftersaleBtn = vShip.querySelectorAll('.od-line-btn').filter((n) => /申请退款/.test(n.textContent));
    const demoCompleteLabel = (vShip.querySelectorAll('.od-demo-btn')[0] || {}).textContent;

    /* 7) 本地模拟签收：四段全绿 + 已完成 */
    const doneOrder = orders.applyDelivery(uid, oid);
    const logiDone = logi.logisticsOf(doneOrder);
    const completeOk = doneOrder.status === 'completed'
      && logiDone.events.length === 4
      && logiDone.stages.every((s) => s.done)
      && Boolean(doneOrder.completedAt);

    /* 8) 回退合成：老订单没有事件行时按时间戳补，不留空白时间线 */
    const legacy = logi.logisticsOf({ status: 'shipped', shippedAt: '2026-10-27 12:00:00' });
    const legacyOk = legacy.shipped && legacy.events.length === 2
      && legacy.stages[0].done && !legacy.stages[2].done;
    const noShip = logi.logisticsOf({ status: 'paid' });
    const noShipOk = noShip.shipped === false && noShip.stages.length === 4
      && noShip.stages.every((s) => !s.done);

    /* 9) 售后：可申请条件 + 表单校验 */
    const canShipped = as.canApply({ status: 'shipped' }).ok;
    const canPending = as.canApply({ status: 'pending' }).ok;
    const canRefunding = as.canApply({ status: 'refunding' }).ok;
    const badType = as.validateAftersale({ type: 'magic', reason: 'quality' });
    const badReason = as.validateAftersale({ type: 'refund', reason: 'whatever' });
    const longNote = as.validateAftersale({ type: 'refund', reason: 'quality', note: 'x'.repeat(201) });
    const okForm = as.validateAftersale({ type: 'return', reason: 'damaged', note: '外箱破损' });
    const guardOk = canShipped && !canPending && !canRefunding
      && Boolean(badType) && Boolean(badReason) && Boolean(longNote) && okForm === null;

    /* 10) 落记录 + 订单转售后中 + 详情页显示记录与处理说明 */
    const rec = as.saveAftersale(uid, {
      orderId: oid,
      type: 'return',
      reason: 'damaged',
      note: '外箱破损，内件有划痕',
      evidence: [{ name: 'proof-1.jpg', size: 2048 }],
      handleNote: '已收到申请，客服会在 24 小时内联系你确认处理方式',
    });
    orders.markRefunding(uid, oid, as.listByOrder(uid, oid));
    const recOk = /^AS\d{8}\d{4}$/.test(rec.id)
      && as.listByOrder(uid, oid).length === 1
      && as.listByOrder('u_other_user', oid).length === 0;

    const vAs = new El('main');
    await renderOrderDetail(vAs, oid);
    await tick();
    const asPageOk = vAs.querySelectorAll('.od-as-item').length === 1
      && /售后中/.test(vAs.textContent || '')
      && /运输破损/.test(vAs.textContent || '')
      && /外箱破损/.test(vAs.textContent || '')
      && /处理说明/.test(vAs.textContent || '')
      && /proof-1\.jpg/.test(vAs.textContent || '')
      // 售后中不再显示申请入口（否则用户能对同一笔订单反复提交）
      && vAs.querySelectorAll('.od-line-btn').filter((n) => /申请退款/.test(n.textContent)).length === 0;
    // 售后中仍然要看得到自己走到了哪一步（阶段靠时间戳，不靠 status）
    const asStepsOk = vAs.querySelectorAll('.od-step').filter((n) => hasCls(n, 'is-done')).length === 4;

    /* 11) 已取消：不画进度条，只留一行说明 */
    const cancelOrder = orders.upsertOrder(uid, { ...base, id: 'MS202610280002', status: 'closed', paidAt: null });
    const vCancel = new El('main');
    await renderOrderDetail(vCancel, cancelOrder.id);
    await tick();
    const cancelPageOk = vCancel.querySelectorAll('.od-flow').length === 1
      && vCancel.querySelectorAll('.od-steps').length === 0
      && /订单已取消/.test(vCancel.textContent || '');

    /* 12) 同一订单重复 upsert 不产生第二条 */
    orders.upsertOrder(uid, { ...base, status: 'completed' });
    const noDup = orders.listOrders(uid).filter((o) => o.id === oid).length === 1;

    /* 13) 本地单（无网关）点演示按钮也要真的推进状态：
       纯静态站点没有服务端可以改状态，这条路径如果不通，
       演示按钮就是一颗点了没反应的死按钮——而它恰恰是离线演示的主要入口。 */
    const localId = 'MS202610280003';
    orders.upsertOrder(uid, { ...base, id: localId, status: 'paid' });
    const vLocal = new El('main');
    await renderOrderDetail(vLocal, localId);
    await tick();
    const localDemoBtn = vLocal.querySelectorAll('.od-demo-btn')[0];
    // 垫片不带事件对象，这里按浏览器的最小契约补一个 currentTarget
    if (localDemoBtn && localDemoBtn.listeners.click) await localDemoBtn.listeners.click({ currentTarget: localDemoBtn });
    await tick(60);
    const localShipOk = orders.getOrder(uid, localId).status === 'shipped'
      && ((vLocal.querySelectorAll('.od-pill')[0] || {}).textContent || '').trim() === '已发货';
    const localCompleteBtn = vLocal.querySelectorAll('.od-demo-btn')[0];
    if (localCompleteBtn && localCompleteBtn.listeners.click) await localCompleteBtn.listeners.click({ currentTarget: localCompleteBtn });
    await tick(60);
    // 垫片不认复合选择器（.a.b 会当成单个类名），命中态一律按 classList 统计
    const localDoneOk = orders.getOrder(uid, localId).status === 'completed'
      && vLocal.querySelectorAll('.od-track-item').filter((n) => hasCls(n, 'is-done')).length === 4;

    const cases = [
      ['状态词表（待发货 / 已取消 / 售后中）', textOk],
      ['阶段由时间戳推导（售后中不丢进度）', stageOk],
      ['未发货显示「待发货」占位', paidEmpty],
      ['待发货显示「模拟发货」', demoShipLabel === '模拟发货'],
      ['模拟发货生成运单号与两条事件', shipOk],
      ['详情页四段节点 + 未达节点灰显', shipPageOk],
      ['已发货出现售后入口', aftersaleBtn.length === 1],
      ['已发货显示「模拟签收」', demoCompleteLabel === '模拟签收'],
      ['模拟签收补齐四段并置已完成', completeOk],
      ['老订单无事件时按时间戳合成', legacyOk],
      ['未发货时间线不假装已发货', noShipOk],
      ['售后可申请条件（已发货可 / 待发货与售后中不可）', guardOk],
      ['售后记录落库并按用户隔离', recOk],
      ['详情页显示售后状态/说明/凭证', asPageOk],
      ['售后中仍显示履约进度', asStepsOk],
      ['已取消不画进度条', cancelPageOk],
      ['同一订单重复写入不产生两条', noDup],
      ['本地单点「模拟发货」真的推进状态', localShipOk],
      ['本地单点「模拟签收」补齐四段', localDoneOk],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 履约与售后${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 履约与售后断言异常: ${String(e.message).split('\n')[0]}`);
    console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}

/* ---------------- 售后审核断言（结论展示 / 三种落点 / 运营台门禁） ---------------- */
// 服务端的事务与守卫由 e2e-aftersale-review 用真库验；这里守的是前端这一半：
//   1) 三种结论都要显示得出来，且**换货不能出现退款金额**（换的是货不是钱）；
//   2) 驳回后订单要回到能用的状态，用户能再申请——工单不是一次性消耗品；
//   3) 服务端返回的空串不能把本地刚拿到的结论冲掉（merge 的坑踩过一次）；
//   4) 运营台在没钥匙 / 网关不可达时都要有话说，不能白屏。
if (failed === 0) {
  console.log('\n售后审核断言（结论展示 / 三种落点 / 运营台门禁）');
  try {
    const dir = (f) => pathToFileURL(join(WEB_DIR, f)).href;
    const orders = await import(dir('store/orderStore.js'));
    const as = await import(dir('store/aftersaleStore.js'));
    const userMod = await import(dir('user.js'));
    const { renderOrderDetail } = await import(dir('orderDetail.js'));
    const { renderAdminAftersales } = await import(dir('adminAftersales.js'));
    const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
    const hasCls = (node, c) => Boolean(node && node.classList && node.classList.contains(c));

    localStorage.clear();
    sessionStorage.clear();
    const uid = 'u_asreview_test';
    userMod.setCurrentUser({ id: uid, nickname: '审核测试', phone: '13800005678' });

    const base = {
      userId: uid,
      items: [{ productId: 'p244', name: '审核测试签字笔', spec: '0.5mm / 灰', price: 29, qty: 2, subtotal: 58 }],
      address: { receiver: '审核', phone: '13800005678', region: '浙江省 杭州市', detail: '文三路 88 号' },
      shippingMethod: { id: 'standard', name: '标准配送', fee: 0, eta: '3-5 天' },
      paymentMethod: { id: 'online', name: '在线支付' },
      amounts: { productAmount: 58, shippingFee: 0, couponDiscount: 0, payAmount: 58 },
      createdAt: '2026-10-27 10:00:00',
      paidAt: '2026-10-27 10:01:00',
      shippedAt: '2026-10-27 18:00:00',
      completedAt: '2026-10-28 09:00:00',
    };

    /* 1) 词表：三种类型、退款类、已退款终态 */
    const typeCodes = as.AFTERSALE_TYPES.map((t) => t.code).join(',');
    const wordOk = typeCodes === 'refund,return,exchange'
      && as.AFTERSALE_STATUS_TEXT.rejected === '已驳回'
      && as.REFUNDABLE_TYPES.join(',') === 'refund,return'
      && orders.statusText('refunded') === '已退款';

    /* 2) 三笔订单，三种结论 */
    const put = (id, status, record) => {
      orders.upsertOrder(uid, { ...base, id, status });
      as.saveAftersale(uid, { ...record, orderId: id });
    };
    put('MS202610280011', 'refunded', {
      id: 'AS00000001', type: 'return', reason: 'damaged', note: '外箱破损',
      evidence: [{ name: 'proof-1.jpg', size: 2048 }],
      status: 'approved', refundAmount: 58, reviewNote: '破损属实',
      reviewedAt: '2026-10-28 15:00:00',
      handleNote: '已同意退货退款，退款 ¥58.00 将在 3 个工作日内退回原支付账户',
    });
    // 换货通过后订单回到「已发货」：新货要重新发一趟，收货流程从头再走
    put('MS202610280012', 'shipped', {
      id: 'AS00000002', type: 'exchange', reason: 'quality', note: '笔尖分叉',
      status: 'approved', refundAmount: null, reviewNote: '',
      reviewedAt: '2026-10-28 15:10:00',
      handleNote: '已同意换货，新商品已通过顺丰速运发出（SF1234567890），请注意查收',
    });
    put('MS202610280013', 'completed', {
      id: 'AS00000003', type: 'refund', reason: 'not_fit', note: '颜色不合适',
      status: 'rejected', refundAmount: null, reviewNote: '凭证不足以判定问题',
      reviewedAt: '2026-10-28 16:00:00',
      handleNote: '很抱歉，您的仅退款申请未通过：凭证不足以判定问题',
    });

    const vRefund = new El('main');
    await renderOrderDetail(vRefund, 'MS202610280011');
    await tick();
    const refundText = vRefund.textContent || '';
    const refundOk = ((vRefund.querySelectorAll('.od-pill')[0] || {}).textContent || '').trim() === '已退款'
      && /审核结果/.test(refundText) && /已同意/.test(refundText)
      && /退款 ¥58/.test(refundText)
      && /审核意见：破损属实/.test(refundText)
      && /3 个工作日内退回/.test(refundText)
      // 退款入终态后不能再申请：钱已经退回去了，那颗按钮没有意义
      && vRefund.querySelectorAll('.od-line-btn').filter((n) => /申请退款/.test(n.textContent)).length === 0
      // 终态仍要能看到履约进度：流程走完了，不是凭空变成已退款
      && vRefund.querySelectorAll('.od-step').filter((n) => hasCls(n, 'is-done')).length === 4;

    const vExchange = new El('main');
    await renderOrderDetail(vExchange, 'MS202610280012');
    await tick();
    const exText = vExchange.textContent || '';
    const exchangeOk = ((vExchange.querySelectorAll('.od-pill')[0] || {}).textContent || '').trim() === '已发货'
      && /已同意/.test(exText)
      // 换货显示不出「退款 ¥」：这一行只给真的退了钱的工单
      && !/退款 ¥/.test(exText)
      && /顺丰速运/.test(exText) && /SF1234567890/.test(exText)
      && vExchange.querySelectorAll('.od-track-item').filter((n) => hasCls(n, 'is-done')).length === 2;

    const vReject = new El('main');
    await renderOrderDetail(vReject, 'MS202610280013');
    await tick();
    const rejText = vReject.textContent || '';
    const rejectOk = ((vReject.querySelectorAll('.od-pill')[0] || {}).textContent || '').trim() === '已完成'
      && /已驳回/.test(rejText)
      && /审核意见：凭证不足以判定问题/.test(rejText)
      && /很抱歉/.test(rejText)
      // 驳回后订单回到「已完成」，入口要能再用——工单不是一次性消耗品
      && vReject.querySelectorAll('.od-line-btn').filter((n) => /申请退款/.test(n.textContent)).length === 1;

    /* 3) 可申请条件：终态不可，驳回退回的「已完成」可以 */
    const guardOk = !as.canApply({ status: 'refunded' }).ok
      && as.canApply({ status: 'completed' }).ok
      && as.canApply({ status: 'shipped' }).ok
      && !as.canApply({ status: 'refunding' }).ok
      && /已退款/.test(as.canApply({ status: 'refunded' }).reason || '');

    /* 4) 与服务端合并：空串不冲掉本地已有结论 */
    const localRec = { id: 'AS00000009', orderId: 'MS_M1', status: 'approved', refundAmount: 58, reviewNote: '破损属实', reviewedAt: '2026-10-28 15:00:00', handleNote: '已同意' };
    const remoteRec = { id: 'AS00000009', orderId: 'MS_M1', status: 'approved', refundAmount: null, reviewNote: '', reviewedAt: '', handleNote: '' };
    const merged = as.mergeAftersales([localRec], [remoteRec])[0];
    const mergeOk = merged.refundAmount === 58 && merged.reviewNote === '破损属实'
      && merged.reviewedAt === '2026-10-28 15:00:00';
    const mergedTwo = as.mergeAftersales([localRec], [{ ...remoteRec, id: 'AS00000010' }]);
    const mergeLenOk = mergedTwo.length === 2;

    /* 5) 运营台：没钥匙看到的只能是钥匙门，不是空列表 */
    const vGate = new El('main');
    await renderAdminAftersales(vGate, {});
    await tick();
    const gateOk = vGate.querySelectorAll('.adm-key-form').length === 1
      && vGate.querySelectorAll('.adm-card').length === 0
      && /ADMIN_API_KEY/.test((vGate.querySelectorAll('.adm-key-input')[0] || {}).attrs?.placeholder || '')
      && /当前标签页/.test(vGate.textContent || '');

    /* 6) 身份齐全但网关不可达（静态部署）：给空态和重试，不是白屏也不是抛异常 */
    sessionStorage.setItem('maison_admin_key', 'k');
    sessionStorage.setItem('maison_admin_actor', '张三');
    const vDown = new El('main');
    await renderAdminAftersales(vDown, {});
    await tick(60);
    const downText = vDown.textContent || '';
    const downOk = vDown.querySelectorAll('.adm-filters').length === 1
      && vDown.querySelectorAll('.adm-empty').length === 1
      && /没有取到工单/.test(downText)
      && vDown.querySelectorAll('.adm-line-btn').filter((n) => /重试/.test(n.textContent)).length === 1;

    /* 7) 半截身份不给进：只有钥匙没有操作人时回钥匙门补齐 */
    sessionStorage.clear();
    sessionStorage.setItem('maison_admin_key', 'k');
    const vHalf = new El('main');
    await renderAdminAftersales(vHalf, {});
    await tick();
    const halfOk = vHalf.querySelectorAll('.adm-key-form').length === 1
      && vHalf.querySelectorAll('.adm-filters').length === 0;

    /* 8) 两样齐全：头部署名常驻，筛选器多出「处理记录」 */
    sessionStorage.setItem('maison_admin_actor', '张三');
    const vFull = new El('main');
    await renderAdminAftersales(vFull, {});
    await tick(60);
    const filterLabels = (vFull.querySelectorAll('.adm-filter') || [])
      .map((n) => n.textContent || '').join(',');
    const actorOk = /操作人 张三/.test(vFull.textContent || '')
      && /处理记录/.test(filterLabels)
      && (vFull.querySelectorAll('.adm-filter') || []).length === 5;

    /* 9) 钥匙门收两样，并如实告诉运营这个名字是自报的 */
    sessionStorage.clear();
    const vGate2 = new El('main');
    await renderAdminAftersales(vGate2, {});
    await tick();
    const gate2Ok = (vGate2.querySelectorAll('.adm-key-input') || []).length === 2
      && /操作人/.test(vGate2.textContent || '')
      && /自报的/.test(vGate2.textContent || '');

    /* 10) 操作人必须编码后才进 HTTP 头。
       中文名直接当头值会让 fetch 在构造 Request 时就抛错，连请求都发不出去——
       用 ASCII 名字测试发现不了，所以在这里用源码锁住，防止后来被当成多余的代码删掉 */
    const asSrc = readFileSync(join(WEB_DIR, 'adminAftersales.js'), 'utf8');
    const gwSrc = readFileSync(join(WEB_DIR, '..', '..', 'ai-gateway', 'src', 'server.js'), 'utf8');
    const encOk = /X-Admin-Actor/.test(asSrc)
      && /encodeURIComponent\(\s*actor\s*\)/.test(asSrc)
      && /decodeURIComponent/.test(gwSrc);

    const cases = [
      ['只有钥匙没有操作人时回钥匙门（半截身份不给进）', halfOk],
      ['头部常驻署名 + 筛选器含处理记录', actorOk],
      ['钥匙门同时收密钥与操作人', gate2Ok],
      ['操作人编码进 HTTP 头（中文名会把请求打挂）', encOk],
      ['词表（三种售后类型 / 退款类 / 已退款终态）', wordOk],
      ['同意退款：已退款 + 结论 + 金额 + 意见', refundOk],
      ['同意换货：回到已发货且不带退款金额', exchangeOk],
      ['驳回：回到已完成 + 意见 + 可再次申请', rejectOk],
      ['可申请条件（终态不可 / 驳回后可再申请）', guardOk],
      ['合并时服务端空值不冲掉本地结论', mergeOk],
      ['合并保留本地独有的工单', mergeLenOk],
      ['无钥匙时显示钥匙门', gateOk],
      ['网关不可达时给空态与重试（不白屏）', downOk],
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 售后审核${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 售后审核断言异常: ${String(e.message).split('\n')[0]}`);
    console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}

console.log(failed === 0 ? '\n✓ 前端自检通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
