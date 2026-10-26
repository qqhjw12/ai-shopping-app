// 商店前台视图：首页 / 商品列表 / 智能搜索 / 商品详情 / 购物车抽屉。
import { api, ApiError } from './api.js';
import { el, fmtPrice, loading, banner, productCard, productThumb, openDrawer, closeDrawer, toast, updateCartBadge } from './ui.js';
import { addToCart, setQty, removeFromCart, clearCart, cartTotal } from './state.js';
import { askGuide, askProductQA } from './assistant.js';
import { navigate } from './router.js';
import { demoProducts } from './demo-data.js';
import { setDemoMode, isDemoMode } from './demo.js';
import { trackEvent, fetchProductStats } from './track.js';

// 商品缓存（列表/详情复用，避免重复请求）
let productsCache = null;
export async function getProducts() {
  if (!productsCache) {
    try {
      const d = await api('/api/products');
      productsCache = d.products || [];
    } catch (e) {
      // 网关不可达（如 GitHub Pages 静态站点未连接后端）→ 回退内置演示商品库
      setDemoMode(true);
      productsCache = demoProducts.slice();
    }
  }
  return productsCache;
}

// 演示模式提示条：仅在未连接网关时展示，说明当前为内置示例数据
function demoBanner() {
  return el('div', { class: 'demo-banner' }, [
    el('b', {}, '演示模式'),
    el('span', {}, '未连接 AI 网关，展示内置示例商品；AI 导购 / 客服 / 问答等交互需本地启动网关后体验（详见 README）。'),
  ]);
}
function ensureDemoBanner(view) {
  if (isDemoMode() && view && view.querySelector && !view.querySelector('.demo-banner')) {
    view.insertBefore(demoBanner(), view.firstChild);
  }
}

// 商品检索：优先走网关「向量 + 关键词混合检索」；网关不可达时本地对演示商品库做轻量匹配，
// 保证搜索与相关推荐在纯静态演示站点也能工作。
export async function searchProducts(query, topK = 12) {
  try {
    const d = await api('/api/search', { body: { query, topK } });
    return d.results || [];
  } catch (e) {
    setDemoMode(true);
    return demoSearch(query, topK);
  }
}

function demoSearch(query, topK) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  return demoProducts
    .map((p) => {
      const hay = [p.name, p.brand, p.category, (p.tags || []).join(' '), p.description].join(' ').toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 1;
      (p.tags || []).forEach((t) => { if (q.includes(t.toLowerCase())) score += 0.5; });
      if (p.name.toLowerCase().includes(q)) score += 0.5;
      return { ...p, score: Math.min(1, score) };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
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
    ensureDemoBanner(view);
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
    ensureDemoBanner(view);
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
    const results = await searchProducts(query, 12);
    ensureDemoBanner(view);
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

// 来源渠道元信息：文案 + 主题色（详情页色条、分享归因、埋点均复用）
export const SOURCE_META = {
  home:  { label: '首页精选',     color: '#2e7d32' },
  list:  { label: '商品列表',     color: '#1565c0' },
  search:{ label: '智能搜索',     color: '#ef6c00' },
  guide: { label: 'AI 导购推荐',  color: '#6a1b9a' },
  rec:   { label: '相关推荐',     color: '#00838f' },
};
const SOURCE_LABELS = Object.fromEntries(
  Object.entries(SOURCE_META).map(([k, v]) => [k, v.label]),
);

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
  ensureDemoBanner(view);
  container.innerHTML = '';
  container.appendChild(buildDetailPage(p, from));
  // 上报「查看商品」埋点（含来源渠道），best-effort
  trackEvent({ event: 'view_product', source: from || 'direct', productId: p.id });
  // 拉取本商品渠道分析，best-effort 展示（演示站点未连网关时静默）
  fetchProductStats(p.id).then((stats) => {
    if (!stats || !stats.total) return;
    const line = container.querySelector('.source-stats');
    if (!line) return;
    const top = Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])[0];
    const topLabel = top && SOURCE_LABELS[top[0]] ? SOURCE_LABELS[top[0]] : top && top[0];
    line.textContent = topLabel
      ? `🔢 共 ${stats.total} 次浏览，最多来自「${topLabel}」`
      : `🔢 共 ${stats.total} 次浏览`;
  });
}

function buildDetailPage(p, from) {
  const children = [];
  // 来源渠道色条：深链带 ?from= 时回显渠道，颜色按渠道区分（视觉引导 + 分享归因）
  if (from && SOURCE_META[from]) {
    const meta = SOURCE_META[from];
    children.push(
      el('div', {
        class: 'source-bar',
        style: `--src-color:${meta.color}`,
      }, [
        el('span', { class: 'dot' }),
        el('span', {}, `来自：${meta.label}`),
      ]),
    );
    // 渠道分析提示行（异步填充）
    children.push(el('div', { class: 'source-stats' }, ''));
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
      const list = (await searchProducts(p.name, 6)).filter((r) => r.id !== p.id).slice(0, 4);
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
