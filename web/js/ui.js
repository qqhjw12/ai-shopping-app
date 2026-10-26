// 通用 UI 助手：DOM 构建、价格格式化、加载/错误态、商品卡片、弹窗、抽屉、toast。
import { cartCount } from './state.js';

/** 轻量 DOM 构建器 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return node;
}

export const fmtPrice = (p) => (p == null ? '' : `¥${Number(p).toLocaleString()}`);

/** 错误/提示 banner（清空父容器后渲染） */
export function banner(parent, msg, kind = 'err') {
  parent.innerHTML = '';
  parent.appendChild(el('div', { class: `banner ${kind}` }, msg));
}

/** 加载态 */
export function loading(parent, text = '加载中…') {
  parent.innerHTML = '';
  parent.appendChild(el('div', { class: 'loading' }, [el('span', { class: 'spinner' }), text]));
}

/** 商品缩略图：无 pic 时用类目 emoji 占位 */
const CATEGORY_EMOJI = {
  手机: '📱', 耳机: '🎧', 笔记本: '💻', 家具: '🪑',
  服装: '👕', 食品: '☕', 小家电: '🔌', 图书: '📚', 美妆: '💄',
};
export function productThumb(p) {
  if (p && p.pic) return el('img', { src: p.pic, alt: p.name || '', style: 'width:100%;height:100%;object-fit:cover' });
  return document.createTextNode((p && CATEGORY_EMOJI[p.category]) || '🛒');
}

/**
 * 复用型商品卡片
 * @param {object} p 商品
 * @param {{onDetail?:Function, onAddCart?:Function, extra?:Function}} handlers
 */
export function productCard(p, { onDetail, onAddCart, extra } = {}) {
  return el('div', { class: 'pcard' }, [
    el('div', { class: 'thumb' }, productThumb(p)),
    el('div', { class: 'body' }, [
      el('div', { class: 'name' }, p.name),
      el('div', { class: 'meta' }, `${p.brand || ''} ${p.category || ''}`.trim()),
      el('div', { class: 'price' }, fmtPrice(p.price)),
      p.tags && p.tags.length
        ? el('div', { class: 'tags' }, p.tags.slice(0, 3).map((t) => el('span', { class: 'tag' }, t)))
        : null,
      el('div', { class: 'actions' }, [
        el('button', { class: 'ghost', onclick: () => onDetail && onDetail(p) }, '详情'),
        el('button', { onclick: () => onAddCart && onAddCart(p) }, '加购'),
      ]),
      extra ? extra(p) : null,
    ]),
  ]);
}

/** 打开弹窗：buildContent(modal, close) 自行填充内容；overlay 点击 / Esc 关闭 */
export function openModal(buildContent) {
  const root = document.getElementById('modal-root');
  const overlay = document.getElementById('overlay');
  const close = () => {
    root.innerHTML = '';
    overlay.classList.add('hidden');
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  overlay.classList.remove('hidden');
  overlay.onclick = close;
  const modal = el('div', { class: 'modal' });
  buildContent(modal, close);
  root.innerHTML = '';
  root.appendChild(modal);
  document.addEventListener('keydown', onKey);
  return close;
}

/** 轻提示 */
export function toast(msg, kind = 'ok') {
  const t = el(
    'div',
    { class: `banner ${kind}`, style: 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:80;box-shadow:var(--shadow-lg)' },
    msg,
  );
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

/** 刷新顶栏购物车角标 */
export function updateCartBadge() {
  const badge = document.getElementById('cart-count');
  if (!badge) return;
  const n = (typeof cartCount === 'function' ? cartCount() : 0);
  badge.textContent = String(n);
  badge.style.display = n > 0 ? '' : 'none';
}

/** 打开购物车抽屉（内容由调用方渲染） */
export function openDrawer(node) {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('overlay');
  drawer.innerHTML = '';
  drawer.appendChild(node);
  drawer.classList.remove('hidden');
  overlay.classList.remove('hidden');
  overlay.onclick = () => closeDrawer();
}

export function closeDrawer() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('overlay');
  drawer.classList.add('hidden');
  // 若弹窗未开则隐藏遮罩
  if (!document.querySelector('#modal-root .modal')) overlay.classList.add('hidden');
}
