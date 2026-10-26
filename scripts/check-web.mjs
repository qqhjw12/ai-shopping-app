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

console.log(failed === 0 ? '\n✓ 前端自检通过' : `\n✗ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
