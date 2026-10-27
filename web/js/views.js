// 商店前台视图：首页 / 商品列表 / 智能搜索 / 商品详情 / 购物车抽屉。
import { api, ApiError } from './api.js';
import {
  el, fmtPrice, discountText, starText, fmtSales,
  loading, banner, productCard, productThumb, openModal, openDrawer, closeDrawer, toast, updateCartBadge, isRealPic,
  revealCards, emptyEditorial,
} from './ui.js';
import { addToCart, setQty, removeFromCart, clearCart, getUserId, getCart } from './state.js';
import { askGuide, askProductQA } from './assistant.js';
import { navigate } from './router.js';
import { demoProducts } from './demo-data.js';
import { setDemoMode, isDemoMode } from './demo.js';
import { trackEvent, fetchProductStats } from './track.js';

// 真实开放数据商品（scripts/ingest-real-data.mjs 生成，体量可达数 MB）改为「按需懒加载」：
// 仅当网关不可达、回退演示模式时才动态 import，正常连网关时不会下载这份大文件，保证首屏速度。
let realDemoCache = null;
async function loadRealDemo() {
  if (realDemoCache) return realDemoCache;
  try {
    const m = await import('./demo-real-data.js');
    realDemoCache = Array.isArray(m.demoRealProducts) ? m.demoRealProducts : [];
  } catch {
    realDemoCache = [];
  }
  return realDemoCache;
}
const ALL_DEMO = async () => demoProducts.concat(await loadRealDemo());

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
      productsCache = await ALL_DEMO();
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
    return await demoSearch(query, topK);
  }
}

async function demoSearch(query, topK) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  const items = await ALL_DEMO();
  return items
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
// 编辑首屏的固定选品：优先呈现有真实图片、气质与主题一致的单品；
// 若后端目录中没有这些 ID，再从当前商品库补齐，保证首页永远有内容。
const EDITORIAL_PICKS = [
  'obf_8005610295015',
  'fe_29',
  'p017',
  'ol_OL498556W',
  'off_7622210578464',
  'p033',
  'obf_3614273955546',
  'p097',
];

function cleanDisplayName(name = '') {
  return String(name).replace(/\s+-\s+.*$/, '').replace(/\s{2,}/g, ' ').trim();
}

function pickEditorial(products, count = 8) {
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const picked = [];
  const used = new Set();
  EDITORIAL_PICKS.forEach((id) => {
    const p = byId.get(id);
    if (p && !used.has(String(p.id))) {
      picked.push(p);
      used.add(String(p.id));
    }
  });

  // 补齐时优先照顾未出现的类目，让首页保持编辑式的内容节奏，而不是同类商品堆叠。
  const categories = new Set(picked.map((p) => p.categoryId));
  const rest = products.filter((p) => !used.has(String(p.id)));
  rest.forEach((p) => {
    if (picked.length >= count) return;
    if (!categories.has(p.categoryId) && (p.pic || p.categoryId)) {
      picked.push(p);
      categories.add(p.categoryId);
      used.add(String(p.id));
    }
  });
  rest.forEach((p) => {
    if (picked.length >= count) return;
    if (!used.has(String(p.id))) {
      picked.push(p);
      used.add(String(p.id));
    }
  });
  return picked.slice(0, count);
}

function bentoClass(index) {
  if (index === 0) return 'pcard--hero';
  if (index === 7) return 'pcard--wide';
  return 'pcard--small';
}

function editorialTile() {
  return el('a', { class: 'editorial-tile', href: '#/products' }, [
    el('span', { class: 'eyebrow' }, 'THE FULL EDIT'),
    el('h3', {}, ['仍在寻找？', el('br'), '让 AI 听见你的生活。']),
    el('p', {}, '从万千物件中，留下真正属于你的那一件。'),
    el('span', { class: 'tile-arrow', 'aria-hidden': 'true' }, '↗'),
    el('span', { class: 'tile-mark', 'aria-hidden': 'true' }, 'M'),
  ]);
}

function curatorNote() {
  return el('aside', { class: 'bento-note' }, [
    el('span', { class: 'eyebrow' }, 'A NOTE FROM THE EDITOR'),
    el('p', { class: 'bento-note-quote' }, ['“真正的奢侈，', el('br'), '是每天都在用的那一件。”']),
    el('span', { class: 'bento-note-credit' }, 'MAISON AI · CURATED EDIT'),
  ]);
}

export async function renderHome(view) {
  view.innerHTML = '';

  /* ---- 编辑式首屏 ---- */
  const heroInput = el('input', {
    placeholder: '描述你的需求，例如：通勤礼物',
    'aria-label': '告诉 AI 你的购物需求',
    autocomplete: 'off',
  });
  const heroForm = el('form', {
    class: 'hero-form',
    onsubmit: (e) => {
      e.preventDefault();
      const text = heroInput.value.trim();
      if (text) askGuide(text);
      else heroInput.focus();
    },
  }, [
    el('span', { class: 'hero-form-icon', 'aria-hidden': 'true' }, '✦'),
    heroInput,
    el('button', { type: 'submit', class: 'btn-primary' }, ['让 AI 甄选', el('span', { 'aria-hidden': 'true' }, '→')]),
  ]);

  const heroImage = el('div', { class: 'hero-image is-loading' }, [
    el('span', { class: 'media-placeholder' }, 'CURATING'),
  ]);
  const heroProduct = el('a', { class: 'hero-product', href: '#/products', 'aria-label': '查看编辑甄选' }, [
    el('span', { class: 'hero-product-kicker' }, 'AI 甄选'),
    el('span', { class: 'hero-product-name' }, '正在为你挑选…'),
    el('span', { class: 'hero-product-meta' }, 'MAISON AI EDIT'),
  ]);

  const hero = el('section', { class: 'hero' }, [
    el('div', { class: 'hero-copy' }, [
      el('span', { class: 'eyebrow hero-eyebrow' }, [
        el('span', { class: 'eyebrow-rule', 'aria-hidden': 'true' }),
        'AI EDITORIAL · VOL. 07',
      ]),
      el('h1', {}, ['少一点喧嚣，', el('br'), '多一件', el('span', { class: 'hero-word' }, '值得。')]),
      el('p', { class: 'hero-lede' }, '让 AI 读懂你的生活，再从万千好物中，留下恰到好处的那一件。'),
      heroForm,
      el('div', { class: 'hero-prompts' }, [
        el('span', { class: 'hero-prompts-label' }, '试试'),
        el('button', { type: 'button', onclick: () => askGuide('预算 1000 元以内，有质感的通勤礼物') }, '1000 元以内的礼物'),
        el('button', { type: 'button', onclick: () => askGuide('帮我挑一件能提升居家氛围的单品') }, '居家氛围'),
        el('button', { type: 'button', onclick: () => askGuide('推荐一款适合长时间办公的降噪耳机') }, '办公降噪'),
      ]),
    ]),
    el('div', { class: 'hero-visual' }, [
      el('div', { class: 'hero-frame' }, [
        heroImage,
        el('span', { class: 'hero-edition' }, 'AI PICK · 01'),
        el('span', { class: 'hero-vertical' }, 'CURATED BY INTELLIGENCE'),
      ]),
      heroProduct,
    ]),
  ]);
  view.appendChild(hero);

  /* ---- AI 工坊条带 ---- */
  const aiStrip = el('section', { class: 'ai-strip' }, [
    el('div', { class: 'ai-strip-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE INTELLIGENCE DESK'),
      el('h2', {}, [ 'AI 工坊', el('span', { class: 'ai-star', 'aria-hidden': 'true' }, '✦') ]),
      el('p', {}, '把品味交给对话，把繁琐交给算法。'),
    ]),
    el('div', { class: 'ai-actions' }, [
      el('button', {
        type: 'button',
        class: 'ai-action ai-action--primary',
        onclick: () => askGuide(''),
      }, [el('span', { 'aria-hidden': 'true' }, '✦'), '私人买手']),
      el('button', {
        type: 'button',
        class: 'ai-action',
        onclick: () => navigate('#/tools'),
      }, ['生成商品文案', el('span', { class: 'action-arrow', 'aria-hidden': 'true' }, '↗')]),
      el('button', {
        type: 'button',
        class: 'ai-action',
        onclick: () => navigate('#/tools'),
      }, ['订单与售后', el('span', { class: 'action-arrow', 'aria-hidden': 'true' }, '↗')]),
    ]),
  ]);
  view.appendChild(aiStrip);
  view.appendChild(el('div', { class: 'gold-divider', 'aria-hidden': 'true' }));

  /* ---- 编辑选品 ---- */
  const catRail = el('div', { class: 'cat-tabs', role: 'tablist', 'aria-label': '按分类浏览' });
  const bento = el('div', { class: 'bento-grid' });
  const collection = el('section', { class: 'edit-section' }, [
    el('div', { class: 'section-heading' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'THE CURATED EDIT'),
        el('h2', {}, '本季甄选'),
      ]),
      el('a', { class: 'text-link', href: '#/products' }, ['浏览全部', el('span', { 'aria-hidden': 'true' }, '→')]),
    ]),
    catRail,
    bento,
  ]);
  view.appendChild(collection);

  let products = [];
  try {
    products = await getProducts();
    ensureDemoBanner(view);
  } catch (err) {
    bento.appendChild(bannerCell(friendly(err)));
    catRail.remove();
    return;
  }

  if (!products.length) {
    bento.appendChild(emptyEditorial({
      title: '藏品正在整理中',
      text: '稍后再来，或让 AI 私人买手为你留意心仪之物。',
      primaryLabel: '和 AI 聊聊',
      onPrimary: () => askGuide(''),
    }));
    return;
  }

  // 首屏的编辑之选与网格首卡不重复，让一次浏览看到更多不同的物件。
  const editorialPicks = pickEditorial(products, 9);
  const heroPick = editorialPicks[0] || products[0];
  const initialPicks = editorialPicks.slice(1);
  fillHeroProduct(heroImage, heroProduct, heroPick);

  const tree = await loadCategoryTree().catch(() => deriveCategoryTree(products));
  const tabs = [{ id: 'all', name: '全部' }, ...tree];
  const cardsCache = new Map();

  const renderBento = (categoryId) => {
    let picks;
    if (categoryId === 'all') {
      picks = cardsCache.get('all') || initialPicks;
      cardsCache.set('all', picks);
    } else {
      if (!cardsCache.has(categoryId)) {
        const bucket = products.filter((p) => p.categoryId === categoryId);
        const withoutHero = bucket.filter((p) => String(p.id) !== String(heroPick.id));
        cardsCache.set(categoryId, pickEditorial(withoutHero.length >= 4 ? withoutHero : bucket, 8));
      }
      picks = cardsCache.get(categoryId);
    }

    bento.innerHTML = '';
    if (!picks.length) {
      bento.appendChild(emptyEditorial({
        title: '这一类，暂时留白',
        text: '换个分类看看，或者让 AI 为你找到相近气质的物件。',
        primaryLabel: '与 AI 聊聊',
        onPrimary: () => askGuide(''),
      }));
      return;
    }
    const cards = picks.map((p, i) => productCard(p, {
      className: bentoClass(i),
      aiPick: i === 0,
      onDetail: (product) => openProductDetail(product, 'home'),
      onAddCart: (product) => doAdd(product, 'home'),
    }));

    // 首行：大 Hero + 右侧双卡 + 编辑手记，保证信息密度与留白处于同一节奏。
    const top = el('div', { class: 'bento-top' }, [cards[0]]);
    if (cards.length > 1) {
      top.appendChild(el('div', { class: 'bento-side' }, [
        el('div', { class: 'bento-side-cards' }, cards.slice(1, 3)),
        curatorNote(),
      ]));
    }
    bento.appendChild(top);
    cards.slice(3).forEach((card) => bento.appendChild(card));
    bento.appendChild(editorialTile());
    revealCards(bento);
  };

  tabs.forEach((c, i) => {
    const tab = el('button', {
      type: 'button',
      role: 'tab',
      class: 'cat-tab' + (i === 0 ? ' is-active' : ''),
      'aria-selected': i === 0 ? 'true' : 'false',
      onclick: () => {
        catRail.querySelectorAll('.cat-tab').forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('is-active');
        tab.setAttribute('aria-selected', 'true');
        renderBento(c.id);
      },
    }, [
      el('span', {}, c.name || '未命名分类'),
      i === 0 ? el('span', { class: 'tab-count' }, String(products.length)) : null,
    ]);
    catRail.appendChild(tab);
  });

  renderBento('all');
}

function fillHeroProduct(imageSlot, productLink, p) {
  if (!p) return;
  imageSlot.classList.remove('is-loading');
  imageSlot.innerHTML = '';
  imageSlot.appendChild(productThumb(p));
  productLink.href = `#/product/${encodeURIComponent(p.id)}?from=home`;
  productLink.innerHTML = '';
  [
    el('span', { class: 'hero-product-kicker' }, ['AI 甄选', el('span', { 'aria-hidden': 'true' }, '✦')]),
    el('span', { class: 'hero-product-name' }, cleanDisplayName(p.name)),
    el('span', { class: 'hero-product-foot' }, [
      el('span', { class: 'hero-product-meta' }, p.brand || p.highlight || p.category || '编辑精选'),
      el('span', { class: 'hero-product-price' }, fmtPrice(p.price)),
    ]),
  ].forEach((node) => productLink.appendChild(node));
}

function bannerCell(message) {
  return el('div', { class: 'grid-empty-cell' }, [
    el('div', { class: 'banner err' }, message),
  ]);
}

function doAdd(p, source, skuId) {
  // 加购埋点（含来源渠道归因）
  trackEvent({ event: 'add_to_cart', source: source || 'unknown', productId: p.id });
  addToCart(p, 1, skuId || null);
  updateCartBadge();
  toast(`已加入购物车：${p.name}${p.spec ? `（${p.spec}）` : ''}`, 'ok');
}

/* ---------------- 商品列表 ---------------- */
// 排序 / 价格档位定义（侧边栏与排序下拉共用）
export const SORT_OPTIONS = [
  { id: 'default', label: '综合排序' },
  { id: 'sales', label: '销量优先' },
  { id: 'price_asc', label: '价格从低到高' },
  { id: 'price_desc', label: '价格从高到低' },
  { id: 'rating', label: '评分优先' },
  { id: 'new', label: '最新上架' },
];
export const PRICE_RANGES = [
  { id: 'all', label: '全部价格', min: null, max: null },
  { id: 'p100', label: '100 元以下', min: null, max: 100 },
  { id: 'p100_500', label: '100 - 500 元', min: 100, max: 500 },
  { id: 'p500_1000', label: '500 - 1000 元', min: 500, max: 1000 },
  { id: 'p1000_3000', label: '1000 - 3000 元', min: 1000, max: 3000 },
  { id: 'p3000', label: '3000 元以上', min: 3000, max: null },
];

// 演示模式（网关不可达）下，类目树从本地商品派生，与网关的 tree 契约保持一致
export function deriveCategoryTree(products) {
  const map = new Map();
  for (const p of products) {
    const topId = p.categoryId || 'misc';
    if (!map.has(topId)) {
      map.set(topId, { id: topId, name: p.category || '未分类', count: 0, children: new Map() });
    }
    const top = map.get(topId);
    top.count += 1;
    if (p.subCategoryId) {
      const cur = top.children.get(p.subCategoryId) || { id: p.subCategoryId, name: p.subCategory || p.subCategoryId, count: 0 };
      cur.count += 1;
      top.children.set(p.subCategoryId, cur);
    }
  }
  return [...map.values()].map((t) => ({ ...t, children: [...t.children.values()] }));
}

/** 本地过滤 + 排序（演示模式 / 网关不可用时的降级，逻辑与 SQL 侧保持一致） */
function localFilterProducts(all, f) {
  let list = all.filter((p) => {
    if (f.category && p.categoryId !== f.category) return false;
    if (f.sub && p.subCategoryId !== f.sub) return false;
    if (f.brand && p.brand !== f.brand) return false;
    if (Number.isFinite(f.minPrice) && !(p.price >= f.minPrice)) return false;
    if (Number.isFinite(f.maxPrice) && !(p.price <= f.maxPrice)) return false;
    return true;
  });
  const by = {
    sales: (a, b) => (b.sales || 0) - (a.sales || 0),
    price_asc: (a, b) => a.price - b.price,
    price_desc: (a, b) => b.price - a.price,
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    new: (a, b) => String(b.id).localeCompare(String(a.id)),
    default: (a, b) => (b.sales || 0) - (a.sales || 0),
  }[f.sort || 'default'];
  return [...list].sort(by);
}

/**
 * 按筛选条件取商品：优先走网关（SQL 侧筛选），不可达时回退本地过滤。
 */
async function queryProducts(f) {
  if (!isDemoMode()) {
    try {
      const qs = new URLSearchParams();
      if (f.category) qs.set('category', f.category);
      if (f.sub) qs.set('sub', f.sub);
      if (f.brand) qs.set('brand', f.brand);
      if (Number.isFinite(f.minPrice)) qs.set('minPrice', f.minPrice);
      if (Number.isFinite(f.maxPrice)) qs.set('maxPrice', f.maxPrice);
      if (f.sort) qs.set('sort', f.sort);
      const d = await api(`/api/products?${qs.toString()}`, { retries: 0 });
      return d.products || [];
    } catch {
      /* 落到本地过滤 */
    }
  }
  return localFilterProducts(await getProducts(), f);
}

/** 商品列表页：左侧两级类目筛选 + 右侧瀑布网格，全参数走深链可分享 */
export async function renderProducts(view, opts = {}) {
  const f = {
    category: opts.category || '',
    sub: opts.sub || '',
    brand: opts.brand || '',
    sort: opts.sort || 'default',
    minPrice: Number.isFinite(opts.minPrice) ? opts.minPrice : null,
    maxPrice: Number.isFinite(opts.maxPrice) ? opts.maxPrice : null,
  };
  // 档位精确匹配才高亮；自定义区间（仅 URL 传入）时不高亮任何档位
  const priceId =
    PRICE_RANGES.find((r) => r.min === f.minPrice && r.max === f.maxPrice)?.id
    || (f.minPrice === null && f.maxPrice === null ? 'all' : null);

  view.innerHTML = '';
  const introTitle = el('h1', { class: 'page-display' }, '全部甄选');
  const introCount = el('span', { class: 'intro-count' }, '正在整理藏品');
  const intro = el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE COLLECTION'),
      introTitle,
      el('p', {}, '由 AI 与编辑共同筛选，克制地呈现值得拥有的物件。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      introCount,
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]);
  const layout = el('div', { class: 'shop-layout' });
  const aside = el('aside', { class: 'shop-filter' });
  const main = el('div', { class: 'shop-main' });
  const head = el('div', { class: 'shop-head' });
  const grid = el('div', { class: 'grid' });
  main.appendChild(head);
  main.appendChild(grid);
  layout.appendChild(aside);
  layout.appendChild(main);
  view.appendChild(intro);
  view.appendChild(layout);
  loading(grid, '加载商品中…');

  let products = [];
  let tree = [];
  try {
    [products, tree] = await Promise.all([
      queryProducts(f),
      loadCategoryTree(),
    ]);
    ensureDemoBanner(view);
    introCount.textContent = `${products.length} 件藏品`;
    const treeCat = tree.find((c) => c.id === f.category);
    if (treeCat) introTitle.textContent = treeCat.name;
  } catch (err) {
    grid.innerHTML = '';
    banner(grid, friendly(err), 'err');
    return;
  }

  /* ---------- 侧边栏 ---------- */
  const buildAside = () => {
    aside.innerHTML = '';
    aside.appendChild(el('div', { class: 'filter-title' }, '分类筛选'));

    // 一级类目（含「全部」）
    const catList = el('div', { class: 'filter-group' });
    catList.appendChild(
      el('button', {
        class: 'filter-item' + (f.category ? '' : ' active'),
        onclick: () => navigate(`#/products${f.sort !== 'default' ? `?sort=${f.sort}` : ''}`),
      }, `全部商品（${tree.reduce((n, c) => n + c.count, 0)}）`),
    );
    tree.forEach((c) => {
      const isOpen = c.id === f.category;
      catList.appendChild(
        el('button', {
          class: 'filter-item' + (isOpen ? ' active' : ''),
          onclick: () => navigate(`#/products?cat=${encodeURIComponent(c.id)}`),
        }, [
          el('span', {}, c.name),
          el('span', { class: 'cnt' }, String(c.count)),
        ]),
      );
      // 展开当前类目下的二级
      if (isOpen && c.children.length) {
        const subWrap = el('div', { class: 'filter-subs' }, [
          el('button', {
            class: 'sub-item' + (f.sub ? '' : ' active'),
            onclick: () => navigate(`#/products?cat=${encodeURIComponent(c.id)}`),
          }, '全部'),
          ...c.children.map((s) =>
            el('button', {
              class: 'sub-item' + (f.sub === s.id ? ' active' : ''),
              onclick: () => navigate(`#/products?cat=${encodeURIComponent(c.id)}&sub=${encodeURIComponent(s.id)}`),
            }, [
              el('span', {}, s.name),
              el('span', { class: 'cnt' }, String(s.count)),
            ]),
          ),
        ]);
        catList.appendChild(subWrap);
      }
    });
    aside.appendChild(catList);

    // 价格区间
    const priceWrap = el('div', { class: 'filter-group' }, [el('div', { class: 'filter-label' }, '价格区间')]);
    PRICE_RANGES.forEach((r) => {
      priceWrap.appendChild(
        el('button', {
          class: 'chip small' + (r.id === priceId ? ' active' : ''),
          onclick: () => navigate(
            `#/products${qs({ cat: f.category, sub: f.sub, sort: f.sort, min: r.min, max: r.max })}`,
          ),
        }, r.label),
      );
    });
    aside.appendChild(priceWrap);

    // 品牌（仅当前类目下有的品牌）
    const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
    if (brands.length > 1) {
      const brandWrap = el('div', { class: 'filter-group' }, [el('div', { class: 'filter-label' }, '品牌')]);
      brandWrap.appendChild(
        el('button', {
          class: 'chip small' + (f.brand ? '' : ' active'),
          onclick: () => navigate(`#/products${qs({ cat: f.category, sub: f.sub, sort: f.sort })}`),
        }, '不限'),
      );
      brands.slice(0, 8).forEach((b) => {
        brandWrap.appendChild(
          el('button', {
            class: 'chip small' + (f.brand === b ? ' active' : ''),
            onclick: () => navigate(
              `#/products${qs({ cat: f.category, sub: f.sub, sort: f.sort, brand: b })}`,
            ),
          }, b),
        );
      });
      aside.appendChild(brandWrap);
    }

    if (f.category || f.sub || f.brand || priceId !== 'all') {
      aside.appendChild(
        el('button', {
          class: 'filter-reset',
          onclick: () => navigate('#/products'),
        }, '✕ 清空筛选条件'),
      );
    }
  };

  // 只保留非空参数，保持 URL 干净可分享
  function qs(parts) {
    const p = new URLSearchParams();
    if (parts.cat) p.set('cat', parts.cat);
    if (parts.sub) p.set('sub', parts.sub);
    if (parts.sort && parts.sort !== 'default') p.set('sort', parts.sort);
    if (parts.brand) p.set('brand', parts.brand);
    if (Number.isFinite(parts.min)) p.set('min', parts.min);
    if (Number.isFinite(parts.max)) p.set('max', parts.max);
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  buildAside();

  /* ---------- 顶部：结果数 + 排序 ---------- */
  head.innerHTML = '';
  const activeCat = tree.find((c) => c.id === f.category);
  const activeSub = activeCat?.children.find((s) => s.id === f.sub);
  head.appendChild(
    el('div', { class: 'shop-crumb' }, [
      el('span', { class: 'crumb', onclick: () => navigate('#/products') }, '全部商品'),
      activeCat ? el('span', { class: 'sep' }, '/') : null,
      activeCat
        ? el(
            'span',
            { class: 'crumb' + (f.sub ? '' : ' current'), onclick: () => navigate(`#/products?cat=${encodeURIComponent(activeCat.id)}`) },
            activeCat.name,
          )
        : null,
      activeSub ? el('span', { class: 'sep' }, '/') : null,
      activeSub ? el('span', { class: 'crumb current' }, activeSub.name) : null,
      f.brand ? el('span', { class: 'tag-chip' }, `品牌：${f.brand}`) : null,
    ]),
  );
  head.appendChild(
    el('div', { class: 'shop-bar' }, [
      el('span', { class: 'result-count' }, `共 ${products.length} 件商品`),
      el('div', { class: 'sorts' }, SORT_OPTIONS.map((o) =>
        el('button', {
          class: 'chip small' + (o.id === f.sort ? ' active' : ''),
          onclick: () => navigate(`#/products${qs({ cat: f.category, sub: f.sub, sort: o.id, brand: f.brand, min: f.minPrice, max: f.maxPrice })}`),
        }, o.label),
      )),
    ]),
  );

  /* ---------- 网格 ---------- */
  grid.innerHTML = '';
  if (!products.length) {
    grid.appendChild(emptyEditorial({
      title: '这一栏，暂时留白',
      text: '当前条件还没有合适单品。放宽筛选，或让 AI 寻找相近气质的物件。',
      primaryLabel: '让 AI 寻找',
      onPrimary: () => askGuide(f.category ? `帮我推荐${activeCat ? activeCat.name : ''}类的好物` : '帮我挑一件有质感的好物'),
      secondaryLabel: '清空筛选',
      onSecondary: () => navigate('#/products'),
    }));
    return;
  }
  // 大型目录分批呈现，避免一次性把所有商品塞进 DOM，也保留编辑式的长页节奏。
  const PAGE_SIZE = 24;
  let shown = 0;
  const loadMoreRow = el('div', { class: 'load-more-row' });
  main.appendChild(loadMoreRow);
  const paintBatch = (first = false) => {
    const batch = products.slice(shown, shown + PAGE_SIZE);
    batch.forEach((p) => grid.appendChild(productCard(p, {
      onDetail: (item) => openProductDetail(item, 'list'),
      onAddCart: (item) => doAdd(item, 'list'),
    })));
    shown += batch.length;
    if (first) revealCards(grid);
    loadMoreRow.innerHTML = '';
    if (shown < products.length) {
      loadMoreRow.appendChild(el('span', { class: 'load-more-count' }, `${shown} / ${products.length}`));
      loadMoreRow.appendChild(el('button', {
        type: 'button',
        class: 'load-more-btn',
        onclick: () => paintBatch(false),
      }, ['继续浏览', el('span', { 'aria-hidden': 'true' }, '↓')]));
    } else if (products.length > PAGE_SIZE) {
      loadMoreRow.appendChild(el('span', { class: 'load-more-count' }, `已呈现全部 ${products.length} 件藏品`));
    }
  };
  paintBatch(true);
}

/** 类目树：网关优先，失败则从本地商品派生 */
async function loadCategoryTree() {
  if (!isDemoMode()) {
    try {
      const d = await api('/api/categories?tree=1', { retries: 0 });
      if (d && Array.isArray(d.categories) && d.categories.length) return d.categories;
    } catch {
      /* 落到本地派生 */
    }
  }
  return deriveCategoryTree(await getProducts());
}

/* ---------------- 智能搜索 ---------------- */
export async function renderSearch(view, query) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro search-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'INTELLIGENT SEARCH'),
      el('h1', { class: 'page-display' }, query ? `关于「${query}」` : '搜索你的灵感'),
      el('p', {}, 'AI 不只是匹配关键词，也在理解你对质感、场景与预算的期待。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]));
  const grid = el('div', { class: 'grid' });
  view.appendChild(grid);
  if (!query) {
    grid.appendChild(emptyEditorial({
      title: '从一个念头开始',
      text: '在顶部输入关键词或一句完整的需求，例如「降噪耳机」或「预算 1000 的礼物」。',
      primaryLabel: '让 AI 私人买手试试',
      onPrimary: () => askGuide(''),
    }));
    return;
  }
  loading(grid, 'AI 正在理解你的需求…');
  try {
    const results = await searchProducts(query, 12);
    ensureDemoBanner(view);
    // 搜索埋点（含查询词与命中数）
    trackEvent({ event: 'search', source: 'search', meta: { query, count: results.length } });
    grid.innerHTML = '';
    if (!results.length) {
      grid.appendChild(emptyEditorial({
        title: '没有正好的那一件',
        text: '换个说法，或放宽一点条件。也可以交给 AI，让它理解你真正想要的感觉。',
        primaryLabel: '让 AI 再找找',
        onPrimary: () => askGuide(query),
        secondaryLabel: '浏览全部',
        onSecondary: () => navigate('#/products'),
      }));
      return;
    }
    results.forEach((p) => {
      const card = productCard(p, { onDetail: (p) => openProductDetail(p, 'search'), onAddCart: (p) => doAdd(p, 'search') });
      // 在卡片底部附加 AI 相关度说明
      card.querySelector('.body').appendChild(
        el('div', { class: 'reason' }, `AI 匹配度 ${Math.round((Number(p.score) || 0) * 100)}%`),
      );
      grid.appendChild(card);
    });
    revealCards(grid);
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
  home:  { label: '首页精选',     color: '#8C7C64' },
  list:  { label: '商品列表',     color: '#737973' },
  search:{ label: '智能搜索',     color: '#A3875B' },
  guide: { label: 'AI 导购推荐',  color: '#91776A' },
  rec:   { label: '相关推荐',     color: '#787F76' },
  qa:    { label: 'AI 问答推荐',  color: '#867A68' },
  fav:   { label: '收藏夹',       color: '#987D78' },
  detail:{ label: '商品详情',     color: '#6D7474' },
  analytics: { label: '分析看板', color: '#5F6663' },
};
export const SOURCE_LABELS = Object.fromEntries(
  Object.entries(SOURCE_META).map(([k, v]) => [k, v.label]),
);

// 商品详情：优先走网关详情端点（一次拿到 SKU / 评价 / 相关推荐）；
// 演示模式下由本地商品库组装等价结构，保证离线也能完整浏览。
export async function fetchProductDetail(id) {
  try {
    const d = await api('/api/products/' + encodeURIComponent(id), { retries: 0 });
    if (d && d.product) return { product: d.product, related: d.related || [] };
  } catch {
    /* 演示模式：回落到本地商品库 */
  }
  const list = await getProducts();
  const p = list.find((x) => x.id === id) || null;
  if (!p) return { product: null, related: [] };
  return {
    product: p,
    related: list.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 4),
  };
}

// 按 ID 取商品：仅返回商品本体（列表缓存优先，给助手推荐卡等轻量场景用）
export async function getProductById(id) {
  const cached = (await getProducts()).find((p) => p.id === id);
  if (cached) return cached;
  const { product } = await fetchProductDetail(id);
  return product;
}

export async function renderProductDetail(view, id, from) {
  view.innerHTML = '';
  view.appendChild(el('a', { class: 'back-link', href: '#/products' }, '← 返回商品列表'));
  const container = el('div', { class: 'detail-page' });
  view.appendChild(container);
  loading(container, '加载商品中…');

  let p;
  let related = [];
  try {
    const bundle = await fetchProductDetail(id);
    p = bundle.product;
    related = bundle.related || [];
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
  container.appendChild(buildDetailPage(p, from, related));
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

/** 点击商品大图查看放大图（真实图出原图，程序化封面出 SVG） */
function openLightbox(p) {
  openModal((modal, close) => {
    const box = el('div', { class: 'lightbox', onclick: close }, [
      isRealPic(p)
        ? el('img', { src: p.pic, alt: p.name || '', class: 'lightbox-img', onclick: (e) => e.stopPropagation() })
        : productThumb(p),
      el('div', { class: 'lightbox-cap' }, p.name || ''),
    ]);
    modal.appendChild(box);
  });
}

function buildDetailPage(p, from, presetRelated = []) {
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

  /* ---- SKU 选择：切换规格时联动价格与库存 ---- */
  const skus = p.skus || [];
  let selected = skus[0] || null;

  const priceLine = el('div', { class: 'detail-price' });
  const stockLine = el('div', { class: 'detail-stock' });

  function syncPrice() {
    const unit = selected ? selected.price : p.price;
    priceLine.innerHTML = '';
    priceLine.appendChild(el('span', { class: 'price' }, fmtPrice(unit)));
    const off = discountText({ price: unit, originalPrice: p.originalPrice });
    if (p.originalPrice && p.originalPrice > unit) {
      priceLine.appendChild(el('del', { class: 'price-old' }, fmtPrice(p.originalPrice)));
    }
    if (off) priceLine.appendChild(el('span', { class: 'badge-off' }, off));
    const st = selected ? selected.stock : (p.totalStock ?? null);
    stockLine.className = `detail-stock${st != null && st > 0 ? '' : ' out'}`;
    stockLine.textContent =
      st == null ? '' : st > 0 ? `现货 ${st} 件 · 付款后 48 小时内发出` : '该规格暂时缺货，可看看其它规格';
  }
  syncPrice();

  const skuRow = el('div', { class: 'sku-row' }, [el('span', { class: 'sku-label' }, '选择规格')]);
  skus.forEach((s) => {
    skuRow.appendChild(el('button', {
      class: 'sku' + (selected && s.id === selected.id ? ' active' : ''),
      onclick: (e) => {
        selected = s;
        [...skuRow.querySelectorAll('.sku')].forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        syncPrice();
      },
    }, `${s.spec} · ${fmtPrice(s.price)}`));
  });

  children.push(
    el('div', { class: 'detail-head' }, [
      el('div', { class: 'thumb-lg', title: '点击查看大图', onclick: (e) => {
        if (e.target.closest('button')) return;
        openLightbox(p);
      } }, [
        productThumb(p),
        discountText(p) ? el('span', { class: 'badge-off lg' }, discountText(p)) : null,
        isRealPic(p) ? el('span', { class: 'badge-real' }, '实拍') : null,
      ]),
      el('div', { class: 'info' }, [
        el('span', { class: 'eyebrow' }, 'THE OBJECT · MAISON AI'),
        el('a', { class: 'crumb', href: `#/products?cat=${encodeURIComponent(p.category || '')}` },
          `${p.brand || '编辑精选'} · ${p.category || '全部商品'}`),
        el('h1', { class: 'name' }, p.name),
        p.highlight ? el('div', { class: 'hl-lg' }, p.highlight) : null,
        el('div', { class: 'rating-line' }, [
          el('span', { class: 'stars' }, [el('b', {}, starText(p.rating)), el('span', {}, ` ${Number(p.rating || 0).toFixed(1)}`)]),
          p.reviewsCount ? el('span', { class: 'cnt' }, `${fmtSales(p.reviewsCount)} 条评价`) : null,
          p.sales ? el('span', { class: 'cnt' }, `已售 ${fmtSales(p.sales)}`) : null,
        ]),
        priceLine,
        stockLine,
        skus.length > 1 ? skuRow : null,
        p.highlights && p.highlights.length
          ? el('div', { class: 'promises' }, p.highlights.map((t) => el('span', { class: 'promise' }, `✓ ${t}`)))
          : null,
        p.tags && p.tags.filter((t) => !String(t).includes(':')).length
          ? el('div', { class: 'tags' }, p.tags.filter((t) => !String(t).includes(':')).slice(0, 4).map((t) => el('span', { class: 'tag' }, t)))
          : null,
        el('div', { class: 'actions' }, [
          el('button', {
            class: 'buy',
            onclick: () => doAdd({ ...p, price: selected ? selected.price : p.price, spec: selected ? selected.spec : '' }, from || 'detail', selected && selected.id),
          }, '加入购物袋'),
          el('button', { class: 'btn-ink', onclick: () => buyNow(p, selected, from) }, '立即购买'),
          el('button', { class: 'ghost', onclick: () => toggleFavorite(p) }, '收藏'),
          el('button', { class: 'ghost', onclick: () => askProductQA(p) }, '问我这件商品'),
          el('button', { class: 'ghost', onclick: () => askGuide(`介绍一下「${p.name}」，适合什么人群和场景？`) }, 'AI 导购推荐'),
          el('button', { class: 'ghost', onclick: () => copyShareLink(p, from) }, '复制分享'),
        ]),
      ]),
    ]),
  );

  const page = el('div', {}, children);

  /* ---- 详情主体：参数 + 评价 ---- */
  const body = el('section', { class: 'detail-body' });
  body.appendChild(el('div', { class: 'panel' }, [
    el('h3', {}, '商品介绍'),
    el('p', { class: 'desc-block' }, p.description || '暂无详细描述'),
    skus.length
      ? el('table', { class: 'sku-table' }, [
          el('tbody', {}, [
            el('tr', {}, [el('th', {}, '规格'), el('td', {}, skus.map((s) => s.spec).join(' / '))]),
            el('tr', {}, [el('th', {}, '价格区间'), el('td', {}, `${fmtPrice(Math.min(...skus.map((s) => s.price)))} ~ ${fmtPrice(Math.max(...skus.map((s) => s.price)))}`)]),
            el('tr', {}, [el('th', {}, '可售总量'), el('td', {}, `${skus.reduce((n, s) => n + s.stock, 0)} 件`)]),
          ]),
        ])
      : null,
  ]));

  const revWrap = el('div', { class: 'panel' }, [el('h3', {}, `用户评价${p.reviewsCount ? `（${fmtSales(p.reviewsCount)}）` : ''}`)]);
  const reviews = p.reviews || [];
  if (reviews.length) {
    reviews.forEach((r) => revWrap.appendChild(reviewCard(r)));
  } else {
    revWrap.appendChild(el('div', { class: 'cart-empty' }, '还没有评价，等你来写第一条。'));
  }
  body.appendChild(revWrap);
  page.appendChild(body);

  /* ---- 相关推荐：优先用详情接口返回的同osm相似款，缺失时再走搜索 ---- */
  const relatedWrap = el('section', { class: 'related' }, [
    el('div', { class: 'section-heading compact' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'YOU MAY ALSO LIKE'),
        el('h2', {}, '相近气质'),
      ]),
      el('a', { class: 'text-link', href: '#/products' }, ['浏览更多', el('span', { 'aria-hidden': 'true' }, '→')]),
    ]),
  ]);
  const relGrid = el('div', { class: 'grid' });
  relatedWrap.appendChild(relGrid);
  page.appendChild(relatedWrap);

  const paintRelated = (list) => {
    relGrid.innerHTML = '';
    if (!list.length) {
      relGrid.appendChild(el('div', { class: 'cart-empty' }, '暂无相似商品'));
      return;
    }
    list.forEach((r) =>
      relGrid.appendChild(productCard(r, { onDetail: (r) => openProductDetail(r, 'rec'), onAddCart: (r) => doAdd(r, 'rec') })),
    );
  };

  if (presetRelated.length) {
    paintRelated(presetRelated);
  } else {
    loading(relGrid, 'AI 正在找相似好物…');
    searchProducts(p.name, 6)
      .then((list) => paintRelated(list.filter((r) => r.id !== p.id).slice(0, 4)))
      .catch((err) => banner(relGrid, friendly(err), 'err'));
  }

  return page;
}

/** 用户评价卡片 */
function reviewCard(r) {
  return el('div', { class: 'review' }, [
    el('div', { class: 'rv-head' }, [
      el('span', { class: 'avatar' }, (r.author || '匿')[0]),
      el('div', {}, [
        el('div', { class: 'rv-name' }, r.author || '匿名用户'),
        el('div', { class: 'stars sm' }, starText(r.rating)),
      ]),
      r.created_at ? el('span', { class: 'rv-date' }, String(r.created_at).slice(0, 10)) : null,
    ]),
    el('div', { class: 'rv-content' }, r.content),
  ]);
}

/** 立即购买：单品直连结算页 */
function buyNow(p, sku, from) {
  addToCart({ ...p, price: sku ? sku.price : p.price, spec: sku ? sku.spec : '' }, 1, sku ? sku.id : null);
  updateCartBadge();
  navigate('#/checkout' + (from ? `?from=${encodeURIComponent(from)}` : ''));
}

/** 收藏切换（演示模式下仅本地提示，网关可用时同步服务端） */
async function toggleFavorite(p) {
  trackEvent({ event: 'favorite', source: 'detail', productId: p.id });
  try {
    const d = await api('/api/favorites', { method: 'POST', body: { userId: getUserId(), productId: p.id }, retries: 0 });
    toast(d && d.favorited ? '已加入已收藏' : '已取消收藏', 'ok');
  } catch {
    toast(isDemoMode() ? '演示模式暂不支持收藏同步' : '收藏失败，请稍后重试', 'warn');
  }
}

function copyShareLink(p, from) {
  // 分享埋点（带来源渠道，便于归因「经哪个渠道被分享出去」）
  trackEvent({ event: 'share', source: from || 'direct', productId: p.id });
  const url = `${location.origin}${location.pathname}#/product/${p.id}` + (from ? `?from=${encodeURIComponent(from)}` : '');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(
      () => toast('商品链接已复制，可分享给好友', 'ok'),
      () => toast('复制失败，请手动复制地址栏链接', 'warn'),
    );
  } else {
    toast('当前环境不支持自动复制，请手动复制地址栏链接', 'warn');
  }
}

/* ---------------- 购物车抽屉 ---------------- */
export function renderCartDrawer() {
  const cart = getCart();
  const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
  const rows = cart.map((it) =>
    el('div', { class: 'cart-item' }, [
      el('div', { class: 'thumb' }, productThumb(it)),
      el('div', { class: 'info' }, [
        el('div', { class: 'nm' }, it.name),
        it.spec ? el('div', { class: 'spec' }, it.spec) : null,
        el('div', { class: 'pr' }, fmtPrice(it.price * it.qty)),
        it.insufficient ? el('div', { class: 'warn-line' }, `库存不足，仅剩 ${it.stock} 件`) : null,
        el('div', { class: 'qty' }, [
          el('button', { onclick: () => { setQty(it.__key || it.id, it.qty - 1); renderCartDrawer(); updateCartBadge(); } }, '−'),
          el('span', {}, String(it.qty)),
          el('button', { onclick: () => { setQty(it.__key || it.id, it.qty + 1); renderCartDrawer(); updateCartBadge(); } }, '+'),
          el('button', { class: 'ghost', onclick: () => { removeFromCart(it.__key || it.id); renderCartDrawer(); updateCartBadge(); } }, '删除'),
        ]),
      ]),
    ]),
  );

  const node = el('div', {}, [
    el('div', { class: 'drawer-heading' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'YOUR SELECTION'),
        el('div', { class: 'drawer-title' }, [
          el('h2', {}, '购物袋'),
          el('span', { class: 'drawer-count' }, `${cart.reduce((n, i) => n + i.qty, 0)} 件`),
        ]),
      ]),
      el('button', { class: 'drawer-close', 'aria-label': '关闭购物袋', onclick: () => closeDrawer() }, '×'),
    ]),
    cart.length ? el('div', { class: 'cart-list' }, rows) : el('div', { class: 'cart-empty' }, '购物袋还是空的。去挑一件值得的物件吧。'),
    el('div', { class: 'cart-foot' }, [
      cart.length ? el('div', { class: 'cart-total' }, [el('span', {}, '合计'), el('span', { class: 'money' }, fmtPrice(total))]) : null,
      cart.length
        ? el('button', {
            class: 'checkout',
            onclick: () => { closeDrawer(); navigate('#/checkout'); },
          }, '去结算')
        : el('button', { class: 'ghost', onclick: () => { closeDrawer(); navigate('#/products'); } }, '去逛逛'),
    ]),
  ]);
  openDrawer(node);
}

/* ---------------- 错误映射 ---------------- */
function friendly(err) {
  if (err instanceof ApiError) return err.message;
  return '出错了，请稍后重试';
}
