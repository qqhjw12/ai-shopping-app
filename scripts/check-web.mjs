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
import { readdirSync } from 'node:fs';
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
// 默认无后端：这样能顺带验证「演示模式」不会在加载期抛错
globalThis.fetch = async () => ({ ok: false, status: 0, headers: { get: () => '' }, json: async () => ({}), text: async () => '' });

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
        ['评价 筛选+排序', n('.pdp-review-filter') === 4 && n('.pdp-review-sort') === 2],
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
    const { renderOrderDetail } = await import(dir('accountCenter.js'));
    const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
    const click = (node) => node && node.listeners && node.listeners.click && node.listeners.click();

    localStorage.clear();
    userMod.clearCurrentUser();
    userMod.setCurrentUser({ ...userMod.DEMO_ACCOUNT });
    const uid = userMod.getCurrentUser().id;
    state.clearCart();
    state.addToCart({ id: 'co_x', name: '结算测试羊毛衫', price: 320, spec: '米白 / M', stock: 5 }, 2);
    state.addToCart({ id: 'co_y', name: '结算测试托特包', price: 180, spec: '牛皮 / 大号', stock: 3 }, 1);

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
    const couponZero = /优惠券抵扣/.test(v1.textContent) && /- ¥0/.test(v1.textContent);
    const totalBefore = (q('.co2-sum-money')[0] || {}).textContent || '';
    const remarkBox = q('.co2-remark').length === 1;

    /* 5) 切加急配送 → 运费与应付联动；切货到付款 → 选中态跟随 */
    click(q('.co2-pick')[1]);
    await tick(0);
    const totalAfterShip = (q('.co2-sum-money')[0] || {}).textContent || '';
    const expressOn = q('.co2-pick')[1].classList.contains('is-on');
    const feeShown = /¥18/.test(v1.textContent);
    click(q('.co2-pick')[3]);
    await tick(0);
    const codOn = q('.co2-pick')[3].classList.contains('is-on') && !q('.co2-pick')[2].classList.contains('is-on');

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
      && order.amounts.couponDiscount === 0 && order.amounts.productAmount === 820
      && order.amounts.shippingFee === 18 && order.amounts.payAmount === 838
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
    const showsAmount = /838/.test(v2.textContent || '');
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
      && /¥838/.test(v3.textContent || '')
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
      ['金额四行（总额/运费/券/应付）', sumRows && couponZero],
      ['备注输入框存在', remarkBox],
      ['切加急后应付金额变化', Boolean(totalBefore) && totalBefore !== totalAfterShip && /838/.test(totalAfterShip)],
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
    const { renderAccount, renderOrderDetail } = await import(dir('accountCenter.js'));
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

console.log(failed === 0 ? '\n✓ 前端自检通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
