// 商店前台视图：首页 / 商品列表 / 智能搜索 / 商品详情 / 购物车抽屉。
import { api, ApiError } from './api.js';
import { el, fmtPrice, loading, banner, productCard, productThumb, openDrawer, closeDrawer, toast, updateCartBadge } from './ui.js';
import { addToCart, setQty, removeFromCart, clearCart, cartTotal } from './state.js';
import { askGuide, askProductQA } from './assistant.js';
import { navigate } from './router.js';

// 商品缓存（列表/详情复用，避免重复请求）
let productsCache = null;
export async function getProducts() {
  if (!productsCache) {
    const d = await api('/api/products');
    productsCache = d.products || [];
  }
  return productsCache;
}
export function resetProductsCache() {
  productsCache = null;
}

function categories(products) {
  const set = new Set();
  products.forEach((p) => p.category && set.add(p.category));
  return ['全部', ...[...set]];
}

/* ---------------- 首页 ---------------- */
export async function renderHome(view) {
  view.innerHTML = '';

  // Hero：AI 导购快捷入口
  const heroInput = el('input', { placeholder: '一句话描述需求，例如：预算 1000 的办公耳机', id: 'hero-input' });
  const hero = el('section', { class: 'hero' }, [
    el('h1', {}, '🤖 AI 帮你挑好物'),
    el('p', {}, '用自然语言说出需求，AI 导购即时推荐并给出理由；右下角还有客服、问答随时待命。'),
    el('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const text = heroInput.value.trim();
        if (text) askGuide(text);
      },
    }, [heroInput, el('button', { type: 'submit' }, '帮我挑')]),
  ]);
  view.appendChild(hero);

  // 商品网格
  const gridWrap = el('section', {}, [
    el('div', { class: 'section-title' }, [
      el('h2', {}, '🔥 精选好物'),
      el('a', { href: '#/products' }, '查看全部 →'),
    ]),
    loading(el('div', {})),
  ]);
  view.appendChild(gridWrap);
  const grid = gridWrap.lastChild;

  try {
    const products = await getProducts();
    const featured = products.slice(0, 8);
    const gridEl = el('div', { class: 'grid' },
      featured.map((p) => productCard(p, { onDetail: (p) => openProductDetail(p, 'home'), onAddCart: (p) => doAdd(p) })),
    );
    grid.replaceWith(gridEl);
  } catch (err) {
    banner(grid, friendly(err), 'err');
  }
}

function doAdd(p) {
  addToCart(p, 1);
  updateCartBadge();
  toast(`已加入购物车：${p.name}`, 'ok');
}

/* ---------------- 商品列表 ---------------- */
export async function renderProducts(view, { category } = {}) {
  view.innerHTML = '';
  const active = category || '全部';
  const chips = el('div', { class: 'chips' });
  const grid = el('div', { class: 'grid' });
  view.appendChild(el('div', { class: 'section-title' }, [el('h2', {}, '🛒 全部商品')]));
  view.appendChild(chips);
  view.appendChild(grid);
  loading(grid, '加载商品中…');

  try {
    const products = await getProducts();
    const cats = categories(products);
    cats.forEach((c) => {
      chips.appendChild(el('button', {
        class: 'chip' + (c === active ? ' active' : ''),
        onclick: () => { if (c !== active) navigate(`#/products?cat=${encodeURIComponent(c)}`); },
      }, c));
    });
    const list = active === '全部' ? products : products.filter((p) => p.category === active);
    grid.innerHTML = '';
    if (!list.length) grid.appendChild(el('div', { class: 'cart-empty' }, '该分类暂无商品'));
    list.forEach((p) => grid.appendChild(productCard(p, { onDetail: (p) => openProductDetail(p, 'list'), onAddCart: doAdd })));
  } catch (err) {
    banner(grid, friendly(err), 'err');
  }
}

/* ---------------- 智能搜索 ---------------- */
export async function renderSearch(view, query) {
  view.innerHTML = '';
  view.appendChild(el('div', { class: 'section-title' }, [el('h2', {}, `🔍 智能搜索：${query || ''}`)]));
  const grid = el('div', { class: 'grid' });
  view.appendChild(grid);
  if (!query) {
    grid.appendChild(el('div', { class: 'cart-empty' }, '在顶部搜索框输入关键词试试，例如「降噪耳机」「预算 1000 的礼物」'));
    return;
  }
  loading(grid, 'AI 正在理解你的需求…');
  try {
    const d = await api('/api/search', { body: { query, topK: 12 } });
    const results = d.results || [];
    grid.innerHTML = '';
    if (!results.length) grid.appendChild(el('div', { class: 'cart-empty' }, '没有找到相关商品，换个说法或放宽条件试试？'));
    results.forEach((p) => {
      const card = productCard(p, { onDetail: (p) => openProductDetail(p, 'search'), onAddCart: doAdd });
      // 在卡片底部附加 AI 相关度说明
      card.querySelector('.body').appendChild(
        el('div', { class: 'reason' }, `AI 智能匹配度 ${(Number(p.score) * 100).toFixed(0)}%`),
      );
      grid.appendChild(card);
    });
  } catch (err) {
    banner(grid, friendly(err), 'err');
  }
}

/* ---------------- 商品详情（路由页，支持深链 #/product/:id?from=） ---------------- */
// 卡片「详情」与助手推荐卡点击统一跳转真实路由，并携带来源埋点（from），
// 便于深链分享时回带来源（首页/列表/搜索/AI 导购/相关推荐）。
export function openProductDetail(p, source) {
  navigate(`#/product/${p.id}` + (source ? `?from=${encodeURIComponent(source)}` : ''));
}

// 来源埋点文案映射（用于详情页来源提示与分享链接归因）
const SOURCE_LABELS = {
  home: '首页精选',
  list: '商品列表',
  search: '智能搜索',
  guide: 'AI 导购推荐',
  rec: '相关推荐',
};

// 按 ID 取商品：先查列表缓存，未命中再走网关详情端点（深链直达也支持）。
export async function getProductById(id) {
  const cached = (await getProducts()).find((p) => p.id === id);
  if (cached) return cached;
  try {
    const d = await api('/api/products/' + encodeURIComponent(id));
    return d.product || null;
  } catch {
    return null;
  }
}

export async function renderProductDetail(view, id, from) {
  view.innerHTML = '';
  view.appendChild(el('a', { class: 'back-link', href: '#/products' }, '← 返回商品列表'));
  const container = el('div', { class: 'detail-page' });
  view.appendChild(container);
  loading(container, '加载商品中…');

  let p;
  try {
    p = await getProductById(id);
  } catch (err) {
    banner(container, friendly(err), 'err');
    return;
  }
  if (!p) {
    container.innerHTML = '';
    container.appendChild(el('div', { class: 'cart-empty' }, '未找到该商品，可能已下架或链接有误。'));
    return;
  }
  container.innerHTML = '';
  container.appendChild(buildDetailPage(p, from));
}

function buildDetailPage(p, from) {
  const children = [];
  // 来源埋点提示：深链带 ?from= 时回显渠道，便于分享归因
  if (from && SOURCE_LABELS[from]) {
    children.push(el('div', { class: 'source-hint' }, `📍 来自：${SOURCE_LABELS[from]}`));
  }
  children.push(
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'thumb-lg' }, productThumb(p)),
      el('div', { class: 'info' }, [
        el('h1', { class: 'name' }, p.name),
        el('div', { class: 'price' }, fmtPrice(p.price)),
        el('div', { class: 'meta' }, `${p.brand || '品牌未知'} · ${p.category || '未分类'}`),
        p.tags && p.tags.length ? el('div', { class: 'tags' }, p.tags.map((t) => el('span', { class: 'tag' }, t))) : null,
        el('p', { class: 'desc' }, p.description || '暂无描述'),
        el('div', { class: 'actions' }, [
          el('button', { onclick: () => { addToCart(p, 1); updateCartBadge(); toast(`已加入购物车：${p.name}`, 'ok'); } }, '加入购物车'),
          el('button', { class: 'ghost', onclick: () => askProductQA(p) }, '问我这件商品'),
          el('button', { class: 'ghost', onclick: () => askGuide(`介绍一下「${p.name}」，适合什么人群和场景？`) }, 'AI 导购推荐'),
          el('button', { class: 'ghost', onclick: () => copyShareLink(p, from) }, '🔗 复制分享链接'),
        ]),
      ]),
    ]),
  );
  const page = el('div', {}, children);

  // 相关推荐：用商品名做智能搜索（排除自身）
  const relatedWrap = el('section', { class: 'related' }, [
    el('div', { class: 'section-title' }, [el('h2', {}, '🤝 相关推荐')]),
    loading(el('div', { class: 'grid' }), 'AI 正在找相似好物…'),
  ]);
  page.appendChild(relatedWrap);
  const relGrid = relatedWrap.lastChild;

  (async () => {
    try {
      const d = await api('/api/search', { body: { query: p.name, topK: 6 } });
      const list = (d.results || []).filter((r) => r.id !== p.id).slice(0, 4);
      relGrid.innerHTML = '';
      if (!list.length) {
        relGrid.appendChild(el('div', { class: 'cart-empty' }, '暂无相似商品'));
      } else {
        list.forEach((r) =>
          relGrid.appendChild(productCard(r, { onDetail: (r) => openProductDetail(r, 'rec'), onAddCart: doAdd })),
        );
      }
    } catch (err) {
      banner(relGrid, friendly(err), 'err');
    }
  })();

  return page;
}

function copyShareLink(p, from) {
  const url = `${location.origin}${location.pathname}#/product/${p.id}` + (from ? `?from=${encodeURIComponent(from)}` : '');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      () => toast('已复制商品链接，可分享给好友 🔗', 'ok'),
      () => toast('复制失败，请手动复制地址栏链接', 'warn'),
    );
  } else {
    toast('当前环境不支持自动复制，请手动复制地址栏链接', 'warn');
  }
}

/* ---------------- 购物车抽屉 ---------------- */
export function renderCartDrawer() {
  const cart = JSON.parse(localStorage.getItem('shop_cart') || '[]');
  const node = el('div', {}, [
    el('div', { class: 'modal-head' }, [
      el('h3', {}, `🛒 购物车（${cart.reduce((n, i) => n + i.qty, 0)}）`),
    ]),
    cart.length
      ? el('div', {}, cart.map((it) => el('div', { class: 'cart-item' }, [
          el('div', { class: 'thumb' }, productThumb(it)),
          el('div', { class: 'info' }, [
            el('div', { class: 'nm' }, it.name),
            el('div', { class: 'pr' }, fmtPrice(it.price)),
            el('div', { class: 'qty' }, [
              el('button', { onclick: () => { setQty(it.id, it.qty - 1); renderCartDrawer(); updateCartBadge(); } }, '−'),
              el('span', {}, String(it.qty)),
              el('button', { onclick: () => { setQty(it.id, it.qty + 1); renderCartDrawer(); updateCartBadge(); } }, '+'),
              el('button', { class: 'ghost', onclick: () => { removeFromCart(it.id); renderCartDrawer(); updateCartBadge(); } }, '删除'),
            ]),
          ]),
        ])))
      : el('div', { class: 'cart-empty' }, '购物车还是空的，去挑点好物吧 🛍️'),
    el('div', { class: 'cart-foot' }, [
      cart.length ? el('div', { class: 'cart-total' }, [el('span', {}, '合计'), el('span', {}, fmtPrice(cartTotal()))]) : null,
      cart.length ? el('button', {
        style: 'width:100%',
        onclick: () => {
          clearCart();
          updateCartBadge();
          closeDrawer();
          toast('下单成功（演示，无真实支付）🎉', 'ok');
        },
      }, '结算') : null,
    ]),
  ]);
  openDrawer(node);
}

/* ---------------- 错误映射 ---------------- */
function friendly(err) {
  if (err instanceof ApiError) return err.message;
  return '出错了，请稍后重试';
}
