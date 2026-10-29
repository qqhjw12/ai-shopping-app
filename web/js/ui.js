// 通用 UI 助手：DOM 构建、价格格式化、加载/错误态、商品卡片、弹窗、抽屉、toast。
import { cartCount } from './state.js';
import { productArt } from './art.js';
import { isFavorite, toggleFavorite } from './store/favoriteStore.js';

/** 轻量 DOM 构建器 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (v == null || v === false) return;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    // 布尔属性要同时回写到 DOM 属性上：只 setAttribute 的话，
    // 读 node.disabled / node.checked 仍是初始值，禁用态在代码层面就"看不见"
    else if (k === 'disabled' || k === 'checked') { node.setAttribute(k, v); node[k] = Boolean(v); }
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

/** 是否为真实图片（外链 http(s) 图床 URL，区别于程序化生成的封面） */
export function isRealPic(p) {
  return !!(p && p.pic && /^https?:\/\//.test(p.pic));
}

/**
 * 商品缩略图：
 * - 无图商品：直接程序化 SVG 封面
 * - 真实图片：程序化封面垫底，图片加载完成后淡入覆盖；
 *   图床不可达（离线 / 404 / 慢）时移除 img，露出垫底封面——任何时刻都不空白
 */
export function productThumb(p, { fade = true } = {}) {
  if (isRealPic(p)) {
    const img = el('img', {
      src: p.pic,
      alt: p.name || '',
      loading: 'lazy',
      class: 'real-img',
    });
    if (fade) {
      img.style.opacity = '0';
      img.style.transition = 'opacity .25s ease';
      img.addEventListener('load', () => { img.style.opacity = '1'; });
    }
    img.addEventListener('error', () => img.remove());
    const wrap = productArt(p);
    wrap.appendChild(img);
    return wrap;
  }
  return productArt(p);
}

/* 首次进入时的商品卡编排：延迟 40ms 递增，整体在 400ms 内完成；后续切页不再重复。 */
let cardsRevealed = false;
export function revealCards(container) {
  if (!container || cardsRevealed) return;
  cardsRevealed = true;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  [...container.querySelectorAll('.pcard')].forEach((node, i) => {
    node.classList.add('is-revealing');
    if (node.style && typeof node.style.setProperty === 'function') {
      node.style.setProperty('--reveal-delay', `${Math.min(i * 40, 250)}ms`);
    }
  });
}

/** 商品品牌 / 类目小标签 */
function productMeta(p) {
  return [p.brand || p.category, p.brand && p.category].filter(Boolean).join(' · ');
}

/** 心形图标（收藏按钮复用：商品卡 / 详情页 / 抽屉） */
export function heartIcon(className = '') {
  const wrap = el('span', { class: `heart-icon ${className}`.trim(), 'aria-hidden': 'true' });
  wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 20.2 4.6 13a4.8 4.8 0 0 1 6.8-6.8l.6.6.6-.6A4.8 4.8 0 0 1 19.4 13L12 20.2Z"/></svg>';
  return wrap;
}

/**
 * 商品卡上的收藏按钮。
 * 细线描边 + 未选中透明，选中态只上金色描边与金色心形——不抢商品图的视觉。
 * 状态直接读 favoriteStore，组件自己不持有状态，避免卡片复用时状态打架。
 */
function cardFavorite(p, onFavorite) {
  const btn = el('button', {
    type: 'button',
    class: 'card-fav',
    title: '收藏',
    'aria-label': `收藏 ${p.name || '该商品'}`,
  }, [heartIcon('card-heart')]);
  const sync = (active) => {
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
    btn.setAttribute('aria-label', `${active ? '取消收藏' : '收藏'} ${p.name || '该商品'}`);
    btn.title = active ? '取消收藏' : '收藏';
  };
  sync(isFavorite(p.id));
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // 别把点击冒泡给缩略图（会跳详情）
    const active = toggleFavorite(p);
    sync(active);
    toast(active ? '已加入收藏' : '已取消收藏', active ? 'ok' : 'warn');
    if (typeof onFavorite === 'function') onFavorite(active, p);
  });
  return btn;
}

/**
 * 复用型商品卡片
 * @param {object} p 商品
 * @param {{onDetail?:Function, onAddCart?:Function, onFavorite?:Function, extra?:Function, className?:string, aiPick?:boolean}} handlers
 */
export function productCard(p, { onDetail, onAddCart, onFavorite, extra, className = '', aiPick = false } = {}) {
  const off = discountText(p);
  const hasRating = Number(p.rating) > 0;
  return el('article', { class: `pcard ${className}`.trim() }, [
    el('div', { class: 'thumb', onclick: () => onDetail && onDetail(p) }, [
      productThumb(p),
      el('span', { class: 'thumb-shade', 'aria-hidden': 'true' }),
      el('div', { class: 'card-badges' }, [
        aiPick ? el('span', { class: 'badge-ai' }, '✦ AI 推荐') : null,
        off ? el('span', { class: 'badge-off' }, off) : null,
        Number(p.totalStock) === 0 ? el('span', { class: 'badge-out' }, '暂时缺货') : null,
      ]),
      cardFavorite(p, onFavorite),
      el('button', {
        type: 'button',
        class: 'thumb-add',
        'aria-label': `将 ${p.name} 加入购物袋`,
        title: '加入购物袋',
        onclick: (e) => { e.stopPropagation(); onAddCart && onAddCart(p); },
      }, [
        el('span', { 'aria-hidden': 'true' }, '+'),
      ]),
    ]),
    el('div', { class: 'body' }, [
      el('div', { class: 'card-meta' }, [
        el('span', {}, productMeta(p) || 'MAISON 精选'),
        hasRating ? el('span', { class: 'card-rating' }, `★ ${Number(p.rating).toFixed(1)}`) : null,
      ]),
      el('h3', { class: 'name', onclick: () => onDetail && onDetail(p) }, p.name),
      p.highlight ? el('p', { class: 'hl' }, p.highlight) : null,
      el('div', { class: 'card-foot' }, [
        el('div', { class: 'price-row' }, [
          el('span', { class: 'price' }, fmtPrice(p.price)),
          p.originalPrice && p.originalPrice > p.price
            ? el('del', { class: 'price-old' }, fmtPrice(p.originalPrice))
            : null,
        ]),
        el('div', { class: 'actions' }, [
          el('button', { type: 'button', class: 'ghost', onclick: () => onDetail && onDetail(p) }, '查看'),
          el('button', { type: 'button', onclick: () => onAddCart && onAddCart(p) }, '加入购物袋'),
        ]),
      ]),
      extra ? extra(p) : null,
    ]),
  ]);
}

/** 编辑式空状态：金色细线器物插画 + 安静的衬线文案 */
export function emptyEditorial({ title = '这里暂时留白', text = '', primaryLabel = '', onPrimary, secondaryLabel = '', onSecondary } = {}) {
  const art = el('div', { class: 'empty-art', 'aria-hidden': 'true' });
  art.innerHTML = `
    <svg viewBox="0 0 220 150" fill="none">
      <path d="M73 45h54l-5 77a14 14 0 0 1-14 13H92a14 14 0 0 1-14-13L73 45Z" stroke="currentColor" stroke-width="1.2"/>
      <path d="M86 45V31a11 11 0 0 1 11-11h6a11 11 0 0 1 11 11v14" stroke="currentColor" stroke-width="1.2"/>
      <path d="M91 68h18M88 84h24M90 100h20" stroke="currentColor" stroke-width="1" opacity=".55"/>
      <path d="M142 88h37v34a14 14 0 0 1-14 14h-9a14 14 0 0 1-14-14V88Z" stroke="currentColor" stroke-width="1.2" opacity=".6"/>
      <path d="M151 88V76a9.5 9.5 0 0 1 19 0v12" stroke="currentColor" stroke-width="1.2" opacity=".6"/>
      <path d="M42 119h136" stroke="currentColor" stroke-width="1" opacity=".4"/>
      <circle cx="173" cy="44" r="15" stroke="currentColor" stroke-width="1" opacity=".55"/>
      <path d="M166 44h14M173 37v14" stroke="currentColor" stroke-width="1" opacity=".55"/>
    </svg>`;
  return el('div', { class: 'empty-editorial' }, [
    art,
    el('span', { class: 'eyebrow' }, 'A QUIET INTERLUDE'),
    el('h2', { class: 'empty-title' }, title),
    text ? el('p', { class: 'empty-text' }, text) : null,
    el('div', { class: 'empty-actions' }, [
      primaryLabel ? el('button', { class: 'btn-primary', type: 'button', onclick: onPrimary }, primaryLabel) : null,
      secondaryLabel ? el('button', { class: 'ghost', type: 'button', onclick: onSecondary }, secondaryLabel) : null,
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
    { class: `toast banner ${kind}`, role: 'status' },
    msg,
  );
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('is-leaving'), 1900);
  setTimeout(() => t.remove(), 2200);
}

/** 刷新顶栏购物袋角标 */
export function updateCartBadge() {
  const badge = document.getElementById('cart-count');
  if (!badge) return;
  const n = (typeof cartCount === 'function' ? cartCount() : 0);
  badge.textContent = String(n);
  badge.style.display = n > 0 ? '' : 'none';
}

/** 打开购物袋抽屉（内容由调用方渲染） */
export function openDrawer(node) {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('overlay');
  drawer.innerHTML = '';
  drawer.appendChild(node);
  drawer.classList.remove('hidden');
  overlay.classList.remove('hidden');
  overlay.onclick = () => closeDrawer();
  document.body.classList.add('no-scroll');
}

export function closeDrawer() {
  const drawer = document.getElementById('cart-drawer');
  const overlay = document.getElementById('overlay');
  drawer.classList.add('hidden');
  document.body.classList.remove('no-scroll');
  // 若弹窗未开则隐藏遮罩
  if (!document.querySelector('#modal-root .modal')) overlay.classList.add('hidden');
}
