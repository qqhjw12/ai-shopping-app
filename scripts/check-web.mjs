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
    ];
    const bad = cases.filter(([, ok]) => !ok).map(([label]) => label);
    console.log(`  ${bad.length === 0 ? 'ok  ' : 'FAIL'} 有用投票 / 写评价${bad.length ? ` → 缺失: ${bad.join('、')}` : ''}`);
    if (bad.length) failed++;
  } catch (e) {
    failed++;
    console.log(`  FAIL 交互断言异常: ${String(e.message).split('\n')[0]}`);
  }
}

console.log(failed === 0 ? '\n✓ 前端自检通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
