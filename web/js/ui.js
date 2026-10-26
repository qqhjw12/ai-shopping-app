// 通用 UI 助手：DOM 构建、价格格式化、加载/错误态、商品卡片、弹窗、抽屉、toast。
import { cartCount } from './state.js';
import { productArt } from './art.js';

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

/** 星级文本（★★★★☆），商品卡与评价列表共用 */
export function starText(rating) {
  const r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

/** 销量人性化：过万显示「1.2万」 */
export function fmtSales(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(v);
}

/** 折扣：原价与现价有差时返回「8.9 折」字样，否则 null */
export function discountText(p) {
  const o = Number(p && p.originalPrice);
  const c = Number(p && p.price);
  if (!o || !c || o <= c) return null;
  return `${((c / o) * 10).toFixed(1).replace(/\.0$/, '')}折`;
}

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

/** 商品缩略图：优先真实图片，否则用程序化生成的 SVG 封面 */
export function productThumb(p) {
  if (p && p.pic) return el('img', { src: p.pic, alt: p.name || '', loading: 'lazy', style: 'width:100%;height:100%;object-fit:cover' });
  return productArt(p);
}

/**
 * 复用型商品卡片
 * @param {object} p 商品
 * @param {{onDetail?:Function, onAddCart?:Function, extra?:Function}} handlers
 */
export function productCard(p, { onDetail, onAddCart, extra } = {}) {
  const off = discountText(p);
  const hasRating = Number(p.rating) > 0;
  return el('div', { class: 'pcard' }, [
    el('div', { class: 'thumb', onclick: () => onDetail && onDetail(p) }, [
      productThumb(p),
      off ? el('span', { class: 'badge-off' }, off) : null,
      Number(p.totalStock) === 0 ? el('span', { class: 'badge-out' }, '暂时缺货') : null,
    ]),
    el('div', { class: 'body' }, [
      el('div', { class: 'name', onclick: () => onDetail && onDetail(p) }, p.name),
      p.highlight ? el('div', { class: 'hl' }, p.highlight) : el('div', { class: 'meta' }, `${p.brand || ''} · ${p.category || ''}`.trim()),
      el('div', { class: 'price-row' }, [
        el('span', { class: 'price' }, fmtPrice(p.price)),
        p.originalPrice && p.originalPrice > p.price
          ? el('del', { class: 'price-old' }, fmtPrice(p.originalPrice))
          : null,
      ]),
      hasRating || p.sales
        ? el('div', { class: 'stat' }, [
            hasRating
              ? el('span', { class: 'stars' }, [
                  el('b', {}, starText(p.rating)),
                  el('span', {}, ` ${Number(p.rating).toFixed(1)}`),
                ])
              : null,
            p.reviewsCount ? el('span', { class: 'cnt' }, `${fmtSales(p.reviewsCount)} 条评价`) : null,
            p.sales ? el('span', { class: 'cnt' }, `已售 ${fmtSales(p.sales)}`) : null,
          ])
        : null,
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
