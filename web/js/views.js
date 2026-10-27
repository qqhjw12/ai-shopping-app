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
import {
  normalizeProductDetail,
  createMockProductDetail,
  readCachedProductDetail,
  cacheProductDetail,
  isFavoriteProduct,
  toggleFavoriteProduct,
  buildReviewSummary,
  requestAiReviewSummary,
  readReviewVotes,
  toggleReviewVote,
  readUserReviews,
  mergeReviews,
  // 评价服务：网关优先，失败自动降级 localStorage（别名避免与本地表单函数同名）
  fetchProductReviews,
  submitReview as publishReviewApi,
  submitFollowUp as publishFollowUpApi,
  voteReview as voteReviewApi,
  uploadReviewImage,
  MAX_REVIEW_IMAGES,
} from './store/productDetailStore.js';

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

function doAdd(p, source, skuId, qty = 1) {
  // 加购埋点（含来源渠道归因）
  trackEvent({ event: 'add_to_cart', source: source || 'unknown', productId: p.id });
  addToCart(p, qty, skuId || null);
  updateCartBadge();
  toast(`已加入购物袋：${p.name}${p.spec ? `（${p.spec}）` : ''}${qty > 1 ? ` × ${qty}` : ''}`, 'ok');
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
// 演示模式下依次回落到 localStorage 缓存 → 本地商品库 → 3 个 PDP mock。
// ProductDetail 模型和 localStorage 细节统一封装在 store/productDetailStore.js。
export async function fetchProductDetail(id) {
  // 当前步骤以 mock 数据为主：三个示例 PDP 不依赖网关，直接走 store，后续替换 API 时删除此分支即可。
  const mock = createMockProductDetail(id);
  if (mock) {
    cacheProductDetail(mock);
    return {
      product: mock,
      related: demoProducts.filter((x) => x.category === mock.category && String(x.id) !== String(mock.id)).slice(0, 4),
      source: 'mock',
    };
  }

  try {
    const d = await api('/api/products/' + encodeURIComponent(id), { retries: 0 });
    if (d && d.product) {
      const product = normalizeProductDetail(d.product);
      cacheProductDetail(product);
      return { product, related: d.related || [], source: 'remote' };
    }
  } catch {
    /* 演示模式：继续走本地数据层 */
  }

  const cached = readCachedProductDetail(id);
  if (cached) return { product: cached, related: [], source: 'cache' };

  let list = [];
  try {
    list = await getProducts();
  } catch {
    /* getProducts 本身不可用时，仍可尝试独立 mock。 */
  }
  const base = list.find((x) => String(x.id) === String(id)) || null;
  if (base) {
    const product = normalizeProductDetail(base);
    cacheProductDetail(product);
    return {
      product,
      related: list.filter((x) => x.category === base.category && x.id !== base.id).slice(0, 4),
      source: 'local',
    };
  }
  return { product: null, related: [] };
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
  const container = el('div', { class: 'detail-page pdp-page' });
  view.appendChild(container);
  loading(container, '加载商品中…');

  let p;
  let related = [];
  let detailSource = '';
  try {
    const bundle = await fetchProductDetail(id);
    p = bundle.product;
    related = bundle.related || [];
    detailSource = bundle.source || '';
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
  // mock PDP 不依赖网关；真实来源仍上报浏览与拉取渠道统计。
  if (detailSource !== 'mock') {
    trackEvent({ event: 'view_product', source: from || 'direct', productId: p.id });
    fetchProductStats(p.id).then((stats) => {
      if (!stats || !stats.total) return;
      const line = container.querySelector('.source-stats');
      if (!line) return;
      const top = Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])[0];
      const topLabel = top && SOURCE_LABELS[top[0]] ? SOURCE_LABELS[top[0]] : top && top[0];
      line.textContent = topLabel
        ? `共 ${stats.total} 次浏览，最多来自「${topLabel}」`
        : `共 ${stats.total} 次浏览`;
    });
  }
}

/** 点击商品大图查看放大图；图片失败时回落到程序化封面。 */
function openLightbox(p, image = null) {
  openModal((modal, close) => {
    const src = image?.src || p.pic;
    const fallback = image?.fallbackSrc || p.fallbackImage;
    let media;
    if (src && (/^https?:\/\//.test(src) || /^data:image\//.test(src))) {
      media = el('img', {
        src,
        alt: image?.alt || p.name || '',
        class: 'lightbox-img',
        onclick: (e) => e.stopPropagation(),
      });
      if (fallback) {
        media.addEventListener('error', () => {
          if (media.src !== fallback) media.src = fallback;
        }, { once: true });
      }
    } else {
      media = productThumb(p);
    }
    const box = el('div', { class: 'lightbox', onclick: close }, [
      media,
      el('div', { class: 'lightbox-cap' }, [p.name || '', image?.label ? ` · ${image.label}` : ''].join('')),
    ]);
    modal.appendChild(box);
  });
}

function pdpBreadcrumb(p) {
  return el('nav', { class: 'pdp-breadcrumb', 'aria-label': '面包屑导航' }, [
    el('a', { href: '#/' }, '首页'),
    el('span', { class: 'pdp-crumb-sep', 'aria-hidden': 'true' }, '/'),
    el('a', { href: '#/categories' }, '分类'),
    el('span', { class: 'pdp-crumb-sep', 'aria-hidden': 'true' }, '/'),
    el('span', { class: 'pdp-crumb-current', title: p.name || '', 'aria-current': 'page' }, p.name || '商品详情'),
  ]);
}

function heartIcon() {
  const wrap = el('span', { class: 'pdp-heart-icon', 'aria-hidden': 'true' });
  wrap.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 20.2 4.6 13a4.8 4.8 0 0 1 6.8-6.8l.6.6.6-.6A4.8 4.8 0 0 1 19.4 13L12 20.2Z"/></svg>';
  return wrap;
}

function buildDetailPage(p, from, presetRelated = []) {
  const page = el('div', { class: 'pdp-shell' });

  // 面包屑：首页 / 分类 / 商品名（hash 路由内保持可回退）。
  page.appendChild(pdpBreadcrumb(p));

  if (from && SOURCE_META[from]) {
    const meta = SOURCE_META[from];
    page.appendChild(
      el('div', { class: 'source-bar', style: `--src-color:${meta.color}` }, [
        el('span', { class: 'dot' }),
        el('span', {}, `来自：${meta.label}`),
      ]),
    );
    page.appendChild(el('div', { class: 'source-stats' }, ''));
  }

  const galleryImages = Array.isArray(p.images) && p.images.length
    ? p.images.slice(0, 6)
    : [{
        src: p.pic,
        alt: p.name || '商品',
        label: '正面',
        focus: '50% 50%',
        fallbackSrc: p.fallbackImage || p.pic || '',
      }];
  const skus = Array.isArray(p.skus) ? p.skus : [];
  const reviewCount = Number(p.reviewCount ?? p.reviewsCount ?? 0) || 0;
  const rating = Number(p.rating) || 0;

  let selected = skus.find((sku) => Number(sku.stock) > 0) || skus[0] || null;
  let quantity = 1;
  let galleryIndex = 0;
  let favorited = isFavoriteProduct(p.id);

  const priceLine = el('div', { class: 'detail-price pdp-price' });
  const stockLine = el('div', { class: 'detail-stock pdp-stock' });
  const qtyValue = el('span', { class: 'pdp-qty-value', 'aria-live': 'polite' }, '1');
  const selectedSpec = el('span', { class: 'pdp-selected-spec' }, selected ? selected.spec : '标准款');
  const skuButtons = [];

  const addLabel = el('span', { class: 'pdp-add-label' }, '加入购物袋');
  const mobileAddLabel = el('span', { class: 'pdp-add-label' }, '加入购物袋');
  const addBtn = el('button', { type: 'button', class: 'buy pdp-add-btn', onclick: addCurrent }, [addLabel]);
  const buyBtn = el('button', { type: 'button', class: 'btn-ink pdp-buy-btn', onclick: buyCurrent }, '立即购买');
  const favoriteBtn = el('button', {
    type: 'button',
    class: 'ghost pdp-fav',
    'aria-pressed': String(favorited),
    onclick: handleFavorite,
  }, [heartIcon(), el('span', { class: 'pdp-fav-label' }, favorited ? '已收藏' : '收藏')]);

  const mobileFav = el('button', {
    type: 'button',
    class: 'ghost pdp-mobile-fav',
    'aria-pressed': String(favorited),
    onclick: handleFavorite,
  }, [heartIcon(), el('span', { class: 'pdp-fav-label' }, favorited ? '已收藏' : '收藏')]);
  const mobileAdd = el('button', { type: 'button', class: 'buy pdp-mobile-add', onclick: addCurrent }, [mobileAddLabel]);
  const mobileBuy = el('button', { type: 'button', class: 'btn-ink pdp-mobile-buy', onclick: buyCurrent }, '立即购买');

  const qtyMinus = el('button', {
    type: 'button',
    class: 'pdp-qty-btn',
    'aria-label': '减少数量',
    onclick: () => setQuantity(quantity - 1),
  }, '−');
  const qtyPlus = el('button', {
    type: 'button',
    class: 'pdp-qty-btn',
    'aria-label': '增加数量',
    onclick: () => setQuantity(quantity + 1),
  }, '+');

  function currentStock() {
    return Math.max(0, Number(selected ? selected.stock : p.stock) || 0);
  }

  function unitPrice() {
    return Number(selected ? selected.price : p.price) || 0;
  }

  // 价格：--serif + --gold-deep，数字使用 tabular-nums（见 .pdp-price .price）。
  function renderPrice() {
    const unit = unitPrice();
    priceLine.innerHTML = '';
    priceLine.appendChild(el('span', { class: 'price' }, fmtPrice(unit)));
    const original = Number(p.originalPrice) || 0;
    if (original > unit) {
      priceLine.appendChild(el('del', { class: 'price-old' }, fmtPrice(original)));
      const off = discountText({ price: unit, originalPrice: original });
      if (off) priceLine.appendChild(el('span', { class: 'badge-off' }, off));
    } else {
      priceLine.appendChild(el('span', { class: 'pdp-price-note' }, '当前规格暂无折扣'));
    }
  }

  function updateQtyUI() {
    const available = currentStock();
    if (available <= 0) {
      qtyValue.textContent = '0';
      qtyMinus.disabled = true;
      qtyPlus.disabled = true;
      return;
    }
    quantity = Math.max(1, Math.min(quantity, available));
    qtyValue.textContent = String(quantity);
    qtyMinus.disabled = quantity <= 1;
    qtyPlus.disabled = quantity >= available;
  }

  function updateActions() {
    const unavailable = currentStock() <= 0;
    [addBtn, buyBtn, mobileAdd, mobileBuy].forEach((btn) => { btn.disabled = unavailable; });
    addLabel.textContent = unavailable ? '暂时缺货' : '加入购物袋';
    mobileAddLabel.textContent = unavailable ? '暂时缺货' : '加入购物袋';
  }

  function syncSelection() {
    renderPrice();
    const available = currentStock();
    stockLine.className = `detail-stock pdp-stock${available > 0 ? '' : ' out'}`;
    stockLine.innerHTML = '';
    stockLine.appendChild(el('span', { class: 'pdp-stock-dot', 'aria-hidden': 'true' }));
    stockLine.appendChild(document.createTextNode(
      available > 0
        ? available <= 8 ? `仅余 ${available} 件 · 售完即止` : `现货 ${available} 件 · 48 小时内发出`
        : '该规格暂时缺货，可切换其它规格',
    ));
    selectedSpec.textContent = selected ? selected.spec : '标准款';
    skuButtons.forEach((btn, index) => {
      const active = selected && skus[index] && skus[index].id === selected.id;
      btn.classList.toggle('is-active', Boolean(active));
      btn.setAttribute('aria-pressed', String(Boolean(active)));
    });
    updateQtyUI();
    updateActions();
  }

  function setQuantity(next) {
    if (currentStock() <= 0) return;
    quantity = Math.max(1, Math.min(next, currentStock()));
    updateQtyUI();
  }

  function syncFavorite() {
    [favoriteBtn, mobileFav].forEach((btn) => {
      btn.classList.toggle('is-active', favorited);
      btn.setAttribute('aria-pressed', String(favorited));
      const label = btn.querySelector('.pdp-fav-label');
      if (label) label.textContent = favorited ? '已收藏' : '收藏';
    });
  }

  async function handleFavorite() {
    favorited = toggleFavoriteProduct(p.id);
    syncFavorite();
    trackEvent({ event: 'favorite', source: 'detail', productId: p.id });
    toast(favorited ? '已加入收藏' : '已取消收藏', 'ok');
    // localStorage 是当前阶段的收藏真相源；有网关时再 best-effort 同步服务端。
    try {
      await api('/api/favorites', {
        method: 'POST',
        body: { userId: getUserId(), productId: p.id },
        retries: 0,
      });
    } catch {
      /* 本地收藏已生效，不阻塞交互 */
    }
  }

  function addCurrent() {
    if (currentStock() <= 0) return;
    doAdd({
      ...p,
      price: unitPrice(),
      spec: selected ? selected.spec : '',
    }, from || 'detail', selected ? selected.id : null, quantity);
  }

  function buyCurrent() {
    if (currentStock() <= 0) return;
    buyNow(p, selected, from, quantity);
  }

  function scrollToReviews() {
    const target = document.getElementById('pdp-reviews');
    if (!target) return;
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => target.focus({ preventScroll: true }), reduced ? 0 : 360);
  }

  /* ---- 画廊：主图 + 缩略图，统一 4/5 比例、object-fit: cover ---- */
  const mainImage = el('img', {
    class: 'pdp-main-img',
    src: galleryImages[0].src || '',
    alt: galleryImages[0].alt || p.name || '',
    loading: 'eager',
  });
  mainImage.style.objectPosition = galleryImages[0].focus || '50% 50%';
  mainImage.addEventListener('error', () => {
    const fallback = galleryImages[galleryIndex]?.fallbackSrc;
    if (fallback && mainImage.getAttribute('src') !== fallback) mainImage.src = fallback;
  });

  const galleryCounter = el('span', { class: 'pdp-gallery-counter', 'aria-live': 'polite' }, `01 / ${String(galleryImages.length).padStart(2, '0')} · ${galleryImages[0].label || '正面'}`);
  const mainButton = el('button', {
    type: 'button',
    class: 'pdp-main-image',
    'aria-label': '查看商品大图',
    onclick: () => openLightbox(p, galleryImages[galleryIndex]),
  }, [
    mainImage,
    el('span', { class: 'pdp-gallery-zoom', 'aria-hidden': 'true' }, 'VIEW'),
    el('span', { class: 'pdp-gallery-shade', 'aria-hidden': 'true' }),
    galleryCounter,
  ]);

  const thumbs = el('div', { class: 'pdp-thumbs', role: 'group', 'aria-label': '商品图片缩略图' });
  const thumbButtons = galleryImages.map((image, index) => {
    const thumbImg = el('img', {
      src: image.src || '',
      alt: '',
      loading: 'lazy',
      class: 'pdp-thumb-img',
    });
    thumbImg.style.objectPosition = image.focus || '50% 50%';
    thumbImg.addEventListener('error', () => {
      if (image.fallbackSrc && thumbImg.getAttribute('src') !== image.fallbackSrc) thumbImg.src = image.fallbackSrc;
    }, { once: true });
    const button = el('button', {
      type: 'button',
      class: 'pdp-thumb' + (index === 0 ? ' is-active' : ''),
      'aria-label': `查看图片 ${index + 1}：${image.label || image.alt || ''}`,
      'aria-pressed': String(index === 0),
      onclick: () => setGalleryIndex(index),
    }, [
      thumbImg,
      el('span', { class: 'pdp-thumb-label' }, image.label || `0${index + 1}`),
    ]);
    thumbs.appendChild(button);
    return button;
  });

  function setGalleryIndex(index) {
    galleryIndex = index;
    const image = galleryImages[index];
    if (!image) return;
    mainImage.src = image.src || '';
    mainImage.alt = image.alt || p.name || '';
    mainImage.style.objectPosition = image.focus || '50% 50%';
    galleryCounter.textContent = `${String(index + 1).padStart(2, '0')} / ${String(galleryImages.length).padStart(2, '0')} · ${image.label || '正面'}`;
    thumbButtons.forEach((btn, i) => {
      btn.classList.toggle('is-active', i === index);
      btn.setAttribute('aria-pressed', String(i === index));
    });
  }

  // 规格按钮：切换即联动价格、库存、数量上限。
  skus.forEach((sku) => {
    const btn = el('button', {
      type: 'button',
      class: 'sku pdp-sku',
      'aria-pressed': 'false',
      onclick: () => {
        selected = sku;
        quantity = 1;
        syncSelection();
      },
    }, sku.spec);
    skuButtons.push(btn);
  });

  const ratingButton = el('button', {
    type: 'button',
    class: 'pdp-rating-link',
    onclick: scrollToReviews,
  }, [
    el('span', { class: 'stars pdp-stars' }, starText(rating)),
    el('b', {}, rating ? rating.toFixed(1) : '—'),
    el('span', { class: 'pdp-review-count' }, reviewCount ? `${fmtSales(reviewCount)} 条评价` : '暂无评价'),
    el('span', { class: 'pdp-rating-arrow', 'aria-hidden': 'true' }, '↓'),
  ]);

  const skuBlock = skus.length
    ? el('div', { class: 'pdp-option-group' }, [
        el('div', { class: 'pdp-option-head' }, [
          el('span', { class: 'pdp-field-label' }, p.skuGroupLabel || '选择规格'),
          selectedSpec,
        ]),
        el('div', { class: 'pdp-sku-row' }, skuButtons),
      ])
    : null;

  const qtyRow = el('div', { class: 'pdp-quantity-row' }, [
    el('span', { class: 'pdp-field-label' }, '数量'),
    el('div', { class: 'pdp-stepper' }, [qtyMinus, qtyValue, qtyPlus]),
  ]);

  const serviceCard = el('section', { class: 'pdp-service-card', 'aria-label': '配送与退换说明' }, [
    el('div', { class: 'pdp-service-row' }, [
      el('span', { class: 'pdp-service-label' }, '配送'),
      el('p', { class: 'pdp-service-copy' }, p.shippingNote || '顺丰包邮 · 48 小时内发出'),
    ]),
    el('div', { class: 'pdp-service-row' }, [
      el('span', { class: 'pdp-service-label' }, '退换'),
      el('p', { class: 'pdp-service-copy' }, p.returnNote || '7 天无理由退换 · 支持上门取件'),
    ]),
  ]);

  // 评价数据（AI 摘要与评价区共用）：p.reviews 由 store 归一化，内置 mock 自带极性侧写。
  const reviews = Array.isArray(p.reviews) ? p.reviews : [];

  // AI 评价摘要：占位卡升级为真实摘要。数据来自 store 的 service 层，
  // 首次生成后写入 localStorage 缓存；后续接真实 LLM 接口时 UI 无需改动。
  const aiSummaryBody = el('div', { class: 'pdp-ai-body' }, [
    el('div', { class: 'pdp-ai-skeleton', 'aria-hidden': 'true' }, [el('span'), el('span'), el('span')]),
  ]);
  const aiSummary = el('aside', { class: 'pdp-ai-summary', 'aria-label': 'AI 评价摘要' }, [
    el('div', { class: 'pdp-ai-head' }, [
      el('span', { class: 'pdp-ai-mark', 'aria-hidden': 'true' }, 'AI'),
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'REVIEW INTELLIGENCE'),
        el('h3', {}, 'AI 评价摘要'),
      ]),
    ]),
    aiSummaryBody,
  ]);

  function paintAiSummary(summary) {
    aiSummaryBody.innerHTML = '';
    if (!summary || !summary.sampleSize) {
      aiSummaryBody.appendChild(
        el('p', { class: 'pdp-ai-empty' }, '暂无足够评价供 AI 摘要，可先看下方的真实买家反馈。'),
      );
      return;
    }
    // 好评率：衬线 + --gold-deep，数字 tabular-nums（见 .pdp-ai-rate）。
    aiSummaryBody.appendChild(
      el('div', { class: 'pdp-ai-score' }, [
        el('span', { class: 'pdp-ai-rate' }, `${summary.positiveRate}%`),
        el('div', { class: 'pdp-ai-meta' }, [
          el('span', { class: 'pdp-ai-rate-label' }, '好评率'),
          el('span', { class: 'pdp-ai-verdict' }, summary.verdict),
        ]),
      ]),
    );
    if (summary.highlights.length) {
      aiSummaryBody.appendChild(
        el('div', { class: 'pdp-ai-group' }, [
          el('span', { class: 'pdp-ai-label' }, '被提及最多的优点'),
          el('ul', { class: 'pdp-ai-points' }, summary.highlights.map((h) =>
            el('li', { class: 'pdp-ai-point pos' }, [
              el('span', { class: 'pdp-ai-point-text' }, h.text),
              el('span', { class: 'pdp-ai-point-count' }, `${h.count} 人提及`),
            ]),
          )),
        ]),
      );
    }
    if (summary.watchouts.length) {
      aiSummaryBody.appendChild(
        el('div', { class: 'pdp-ai-group' }, [
          el('span', { class: 'pdp-ai-label' }, '需要注意的地方'),
          el('ul', { class: 'pdp-ai-points' }, summary.watchouts.map((w) =>
            el('li', { class: 'pdp-ai-point neg' }, [
              el('span', { class: 'pdp-ai-point-text' }, w.text),
              el('span', { class: 'pdp-ai-point-count' }, `${w.count} 人提及`),
            ]),
          )),
        ]),
      );
    }
    // 口径透明化：标注样本量与抽取方式，避免被误读为官方结论。
    aiSummaryBody.appendChild(
      el('p', { class: 'pdp-ai-foot' },
        `AI 基于 ${summary.sampleSize} 条评价抽取 · ${summary.mode === 'aspect' ? '买家侧写标注' : '正文关键词匹配'}`),
    );
  }

  requestAiReviewSummary(p).then(paintAiSummary).catch(() => paintAiSummary(null));

  const info = el('div', { class: 'info pdp-info' }, [
    el('span', { class: 'eyebrow' }, 'THE OBJECT · MAISON AI'),
    el('div', { class: 'pdp-origin' }, [
      el('span', {}, p.brand || 'MAISON AI'),
      el('span', { class: 'pdp-origin-dot', 'aria-hidden': 'true' }),
      el('span', {}, p.category || '编辑甄选'),
    ]),
    el('h1', { class: 'name' }, p.name),
    p.highlight ? el('div', { class: 'hl-lg' }, p.highlight) : null,
    ratingButton,
    priceLine,
    skuBlock,
    stockLine,
    qtyRow,
    el('div', { class: 'actions pdp-primary-actions' }, [addBtn, buyBtn, favoriteBtn]),
    serviceCard,
    aiSummary,
    el('div', { class: 'pdp-secondary-actions' }, [
      el('button', { type: 'button', class: 'ghost', onclick: () => askProductQA(p) }, '问我这件商品'),
      el('button', { type: 'button', class: 'ghost', onclick: () => askGuide(`介绍一下「${p.name}」，适合什么人群和场景？`) }, 'AI 导购推荐'),
      el('button', { type: 'button', class: 'ghost', onclick: () => copyShareLink(p, from) }, '复制分享'),
    ]),
  ]);

  const gallery = el('section', { class: 'pdp-gallery', 'aria-label': '商品图片画廊' }, [mainButton, thumbs]);
  const detailHead = el('div', { class: 'detail-head pdp-head' }, [gallery, info]);
  page.appendChild(detailHead);

  /* ---- 详情主体：介绍 + 评价 ---- */
  const body = el('section', { class: 'detail-body pdp-detail-body' });
  const descriptionPanel = el('div', { class: 'panel pdp-description' }, [
    el('h3', {}, '商品介绍'),
    el('p', { class: 'desc-block' }, p.description || '暂无详细描述'),
    skus.length
      ? el('table', { class: 'sku-table' }, [
          el('tbody', {}, [
            el('tr', {}, [el('th', {}, '规格'), el('td', {}, skus.map((s) => s.spec).join(' / '))]),
            el('tr', {}, [el('th', {}, '价格区间'), el('td', {}, `${fmtPrice(Math.min(...skus.map((s) => s.price)))} ~ ${fmtPrice(Math.max(...skus.map((s) => s.price)))}`)]),
            el('tr', {}, [el('th', {}, '可售总量'), el('td', {}, `${skus.reduce((n, s) => n + (Number(s.stock) || 0), 0)} 件`)]),
          ]),
        ])
      : null,
  ]);
  body.appendChild(descriptionPanel);

  /* ---- 评价区：写评价 + 有用投票 + 评分概览 + 筛选排序 + 列表分页 ---- */
  const REVIEW_PAGE = 6;
  const listState = { filter: 'all', sort: 'latest', visible: REVIEW_PAGE };
  // 先渲染本地可见数据（自带评价 + 我写的评价 + 本地票），随后异步拉取服务端列表覆盖。
  // 这样首屏不空转变成加载态，联网时又能拿到服务端持久化后的真实评价。
  const votes = readReviewVotes();
  const userReviews = readUserReviews(p.id);
  let allReviews = mergeReviews(reviews, userReviews, votes);
  let reviewSource = 'local';
  let reviewSummary = buildReviewSummary(allReviews);

  // 分布条保留节点引用：新增评价后只改宽度与数字，避免整块重绘打断用户阅读位置。
  const distNodes = new Map();
  const distRows = [5, 4, 3, 2, 1].map((star) => {
    const fill = el('span', { class: 'pdp-dist-fill' });
    const count = el('span', { class: 'pdp-dist-count' }, '0');
    distNodes.set(star, { fill, count });
    return el('div', { class: 'pdp-dist-row' }, [
      el('span', { class: 'pdp-dist-label' }, `${star} 星`),
      el('span', { class: 'pdp-dist-track' }, [fill]),
      count,
    ]);
  });

  const RATING_HINTS = { 1: '很不满意', 2: '不太满意', 3: '一般', 4: '比较满意', 5: '非常满意' };
  const MIN_REVIEW_LEN = 5;
  const MAX_REVIEW_LEN = 500;
  // 写评价草稿：星级必须由用户点选，默认 0 表示未评分，不允许「默认好评」提交。
  const draft = { rating: 0, content: '', skuSpec: '', images: [], uploading: false };

  function selectReviews() {
    let list = allReviews.slice();
    if (listState.filter === 'good') list = list.filter((r) => r.rating >= 4);
    else if (listState.filter === 'mid') list = list.filter((r) => r.rating === 3);
    else if (listState.filter === 'bad') list = list.filter((r) => r.rating <= 2);
    if (listState.sort === 'helpful') list.sort((a, b) => (Number(b.helpful) || 0) - (Number(a.helpful) || 0));
    else list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return list;
  }

  const reviewList = el('div', { class: 'pdp-review-list' });
  const moreBtn = el('button', {
    type: 'button',
    class: 'ghost pdp-review-more',
    onclick: () => { listState.visible += REVIEW_PAGE; paintReviewList(); },
  }, '展开更多');

  /**
   * 有用投票：先乐观 ±1 让按钮立刻有反馈，再打服务端。
   * 在线时以服务端计数为准（天然幂等）；离线则由 localStorage 记账。
   */
  async function voteReview(r, ref) {
    const before = Number(r.helpful || 0);
    const wasVoted = Boolean(r.voted);
    const optimistic = !wasVoted;
    r.voted = optimistic;
    r.helpful = Math.max(0, before + (optimistic ? 1 : -1));
    paintVoteButton(ref, r);
    const res = await voteReviewApi(r.id);
    r.voted = Boolean(res.voted);
    // res.helpful 为 null 表示走了离线记账，此时按本地 ±1 修正
    if (res.online) r.helpful = Number(res.helpful) || 0;
    else r.helpful = Math.max(0, before + (res.voted ? 1 : -1));
    paintVoteButton(ref, r);
  }

  function paintVoteButton(ref, r) {
    ref.btn.classList.toggle('is-active', Boolean(r.voted));
    ref.btn.setAttribute('aria-pressed', r.voted ? 'true' : 'false');
    ref.text.textContent = r.voted ? '已赞同' : '有用';
    ref.count.textContent = String(Number(r.helpful) || 0);
  }

  /**
   * 追评发布：成功后把新追评并入主评价的 followUps 并重绘列表。
   * 主评价来自离线（本地 id ur-*）时由 store 自动落本地，不会静默丢内容。
   */
  async function followUpHandler(parent, payload) {
    const res = await publishFollowUpApi({
      reviewId: parent.id,
      productId: p.id,
      content: payload.content,
      images: payload.images,
    });
    const target = allReviews.find((r) => String(r.id) === String(parent.id));
    if (target) target.followUps = [...(target.followUps || []), res.review];
    paintReviewList();
    toast(res.online ? '追评已发布' : '追评已离线保存', res.online ? 'ok' : 'warn');
  }

  /**
   * 拉取服务端评价：成功后替换本地数据源并重绘。
   * 本地离线写过的评价若未出现在服务端结果里（如发布时断网），仍保留在最前面，
   * 保证用户看到自己写的内容不丢。
   */
  async function loadServerReviews() {
    const bundle = await fetchProductReviews(p.id, { limit: 100 });
    reviewSource = bundle.online ? 'server' : 'local';
    const localOnly = mergeReviews([], userReviews, votes)
      .filter((ur) => !bundle.reviews.some((r) => String(r.id) === String(ur.id)));
    allReviews = [...localOnly, ...bundle.reviews];
    listState.visible = REVIEW_PAGE;
    refreshOverview();
    paintReviewList();
    refreshAiSummary();
  }

  /** AI 摘要按当前样本重算（缓存以样本数为 key，条数变化即失效重建） */
  function refreshAiSummary() {
    requestAiReviewSummary({ ...p, reviews: allReviews })
      .then(paintAiSummary)
      .catch(() => paintAiSummary(null));
  }

  function paintReviewList() {
    const list = selectReviews();
    const shown = list.slice(0, listState.visible);
    reviewList.innerHTML = '';
    if (!shown.length) {
      reviewList.appendChild(el('div', { class: 'pdp-review-empty' },
        allReviews.length ? '该筛选条件下还没有评价。' : '还没有评价，购买体验后可以回来写下第一条感受。'));
    } else {
      shown.forEach((r) => reviewList.appendChild(reviewCard(r, voteReview, followUpHandler)));
    }
    const rest = list.length - shown.length;
    moreBtn.setAttribute('hidden', '');
    if (rest > 0) {
      moreBtn.textContent = `展开更多（还有 ${rest} 条）`;
      moreBtn.removeAttribute('hidden');
    } else {
      moreBtn.textContent = '展开更多';
    }
  }

  /* ---- 写评价表单 ---- */
  const starButtons = [1, 2, 3, 4, 5].map((star) => el('button', {
    type: 'button',
    class: 'pdp-form-star',
    'data-star': String(star),
    'aria-label': `评 ${star} 星`,
    onclick: () => { draft.rating = star; paintStars(); },
  }, '☆'));
  const starHint = el('span', { class: 'pdp-form-hint' }, '点击星星选择评分');
  function paintStars() {
    starButtons.forEach((btn, i) => {
      const on = i + 1 <= draft.rating;
      btn.textContent = on ? '★' : '☆';
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    starHint.textContent = draft.rating ? RATING_HINTS[draft.rating] : '点击星星选择评分';
  }

  const input = el('textarea', {
    class: 'pdp-form-textarea',
    rows: '4',
    maxlength: String(MAX_REVIEW_LEN),
    placeholder: `说说实际体验，例如做工、手感、与描述的差异…（至少 ${MIN_REVIEW_LEN} 个字）`,
    oninput: () => { draft.content = input.value || ''; paintCounter(); },
  });
  const counter = el('span', { class: 'pdp-form-counter' }, `0 / ${MAX_REVIEW_LEN}`);
  function paintCounter() { counter.textContent = `${String(draft.content || '').length} / ${MAX_REVIEW_LEN}`; }

  // 主按钮：香槟金底 + 深色文字（--gold / --ink），与「加入购物袋」保持同一主操作语言。
  const submitBtn = el('button', { type: 'submit', class: 'primary pdp-form-submit' }, '发布评价');

  // 买家秀：先 canvas 压缩再上传，返回服务端 URL 存进草稿；上限与服务端保持一致。
  const imgPreview = el('div', { class: 'pdp-form-thumbs' });
  const imgHint = el('span', { class: 'pdp-form-img-hint' }, `可选，最多 ${MAX_REVIEW_IMAGES} 张`);
  function paintImgPreview() {
    imgPreview.innerHTML = '';
    (draft.images || []).forEach((url, i) => {
      imgPreview.appendChild(el('div', { class: 'pdp-form-thumb' }, [
        el('img', { src: url, alt: `买家秀 ${i + 1}` }),
        el('button', {
          type: 'button',
          class: 'pdp-thumb-remove',
          'aria-label': '删除这张图片',
          onclick: () => { draft.images.splice(i, 1); paintImgPreview(); },
        }, '×'),
      ]));
    });
    imgHint.textContent = draft.images.length
      ? `已添加 ${draft.images.length} / ${MAX_REVIEW_IMAGES} 张`
      : `可选，最多 ${MAX_REVIEW_IMAGES} 张`;
  }

  async function handlePickImages(files) {
    const room = MAX_REVIEW_IMAGES - (draft.images || []).length;
    if (room <= 0) { toast(`最多上传 ${MAX_REVIEW_IMAGES} 张图片`, 'warn'); return; }
    if (draft.uploading) return;
    draft.uploading = true;
    imgHint.textContent = '正在压缩并上传…';
    submitBtn.disabled = true;
    try {
      for (const file of files.slice(0, room)) {
        const dataUrl = await compressImageFile(file);
        draft.images.push(await uploadReviewImage(dataUrl));
      }
      paintImgPreview();
    } catch (err) {
      toast(err.message || '图片上传失败', 'warn');
      paintImgPreview();
    } finally {
      draft.uploading = false;
      submitBtn.disabled = false;
    }
  }

  const fileInput = el('input', {
    type: 'file',
    class: 'pdp-file-input',
    accept: 'image/*',
    multiple: 'multiple',
    onchange: () => { handlePickImages(Array.from(fileInput.files || [])); fileInput.value = ''; },
  });

  // 多规格商品可选「已购规格」，单规格时隐藏（也可见但未订 SKU 时不显示该行）
  const specSelect = skus.length > 1
    ? el('select', {
        class: 'pdp-form-select',
        'aria-label': '已购规格',
        onchange: () => { draft.skuSpec = specSelect.value || ''; },
      }, skus.map((s) => el('option', { value: s.spec }, s.spec)))
    : null;

  const formBox = el('form', {
    class: 'pdp-review-form',
    hidden: 'hidden',
    novalidate: 'novalidate',
    onsubmit: submitReview,
  }, [
    el('div', { class: 'pdp-form-row' }, [
      el('span', { class: 'pdp-field-label' }, '你的评分'),
      el('div', { class: 'pdp-form-stars', role: 'group', 'aria-label': '评分星级' }, starButtons),
      starHint,
    ]),
    specSelect ? el('div', { class: 'pdp-form-row' }, [
      el('span', { class: 'pdp-field-label' }, '已购规格'),
      specSelect,
    ]) : null,
    el('div', { class: 'pdp-form-row' }, [
      el('span', { class: 'pdp-field-label' }, '买家秀'),
      el('label', { class: 'pdp-file-label' }, [fileInput, '选择图片']),
      imgHint,
    ]),
    imgPreview,
    el('div', { class: 'pdp-form-row' }, [
      el('span', { class: 'pdp-field-label' }, '评价内容'),
      input,
      el('div', { class: 'pdp-form-foot' }, [counter, submitBtn]),
    ]),
  ]);

  function toggleForm() {
    // 用 getAttribute 而非 hasAttribute：浏览器与轻量 DOM 环境都可靠。
    const opening = formBox.getAttribute('hidden') != null;
    if (opening) {
      draft.skuSpec = (typeof selected !== 'undefined' && selected && selected.spec) || (skus[0] && skus[0].spec) || '';
      if (specSelect && draft.skuSpec) specSelect.value = draft.skuSpec;
      formBox.removeAttribute('hidden');
      writeBtn.textContent = '收起表单';
    } else {
      formBox.setAttribute('hidden', 'hidden');
      writeBtn.textContent = '写评价';
    }
  }

  async function submitReview(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!draft.rating) { toast('请先选择星级评分', 'warn'); return; }
    const content = String(draft.content || '').trim();
    if (content.length < MIN_REVIEW_LEN) { toast(`评价内容至少 ${MIN_REVIEW_LEN} 个字`, 'warn'); return; }
    if (draft.uploading) { toast('图片还在上传中，请稍候', 'warn'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '发布中…';
    try {
      // 网关优先；失败自动落 localStorage（online=false → 提示离线保存）
      const { review, online } = await publishReviewApi(p.id, {
        rating: draft.rating,
        content,
        skuSpec: draft.skuSpec,
        images: draft.images || [],
      });
      allReviews.unshift(review);

      draft.rating = 0;
      draft.content = '';
      draft.images = [];
      input.value = '';
      paintStars();
      paintCounter();
      paintImgPreview();
      formBox.setAttribute('hidden', 'hidden');
      writeBtn.textContent = '写评价';
      // 重置到「全部 / 最新」，避免新评价被当前筛选条件挡住看不见。
      listState.filter = 'all';
      listState.sort = 'latest';
      listState.visible = REVIEW_PAGE;
      syncActiveButton(filterBtns, 'filter', listState.filter);
      syncActiveButton(sortBtns, 'sort', listState.sort);
      refreshOverview();
      paintReviewList();
      toast(online ? '评价已发布，感谢你的分享' : '评价已离线保存，联网后可查看同步状态', online ? 'ok' : 'warn');
      // AI 摘要按新样本重算：缓存以样本数为 key，条数变化即失效重建。
      requestAiReviewSummary({ ...p, reviews: allReviews })
        .then(paintAiSummary)
        .catch(() => paintAiSummary(null));
    } catch (err) {
      toast(err.message || '评价发布失败，请稍后重试', 'warn');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '发布评价';
    }
  }

  const filterMeta = [
    { key: 'all', label: (s) => `全部 ${s.total}` },
    { key: 'good', label: (s) => `好评 ${s.distribution[5] + s.distribution[4]}` },
    { key: 'mid', label: (s) => `中评 ${s.distribution[3]}` },
    { key: 'bad', label: (s) => `差评 ${s.distribution[2] + s.distribution[1]}` },
  ];

  function syncActiveButton(btns, key, value) {
    btns.forEach((b) => b.classList.toggle('is-active', b.dataset[key] === value));
  }

  const filterBtns = filterMeta.map((f) => el('button', {
    type: 'button',
    class: 'pdp-review-filter' + (f.key === 'all' ? ' is-active' : ''),
    'data-filter': f.key,
    onclick: () => {
      listState.filter = f.key;
      listState.visible = REVIEW_PAGE;
      syncActiveButton(filterBtns, 'filter', f.key);
      paintReviewList();
    },
  }, f.label(reviewSummary)));

  const sortBtns = [{ key: 'latest', label: '最新' }, { key: 'helpful', label: '最有用' }].map((s) => el('button', {
    type: 'button',
    class: 'pdp-review-sort' + (s.key === 'latest' ? ' is-active' : ''),
    'data-sort': s.key,
    onclick: () => {
      listState.sort = s.key;
      syncActiveButton(sortBtns, 'sort', s.key);
      paintReviewList();
    },
  }, s.label));

  const writeBtn = el('button', {
    type: 'button',
    class: 'ghost pdp-write-review',
    onclick: toggleForm,
  }, '写评价');

  const avgScoreEl = el('span', { class: 'pdp-review-avg' }, '—');
  const headTotal = el('span', { class: 'pdp-review-total' }, '暂无评价');
  const overviewBox = el('div', { class: 'pdp-review-overview' }, [
    el('div', { class: 'pdp-review-score' }, [
      avgScoreEl,
      el('span', { class: 'pdp-review-avg-unit' }, '分'),
    ]),
    el('div', { class: 'pdp-dist' }, distRows),
  ]);
  const toolbarBox = el('div', { class: 'pdp-review-toolbar' }, [
    el('div', { class: 'pdp-review-filters' }, filterBtns),
    el('div', { class: 'pdp-review-sorts' }, sortBtns),
  ]);

  /** 概览刷新：写入评价或首次渲染后重算均分、分布宽度与各筛选计数。 */
  function refreshOverview() {
    reviewSummary = buildReviewSummary(allReviews);
    const has = reviewSummary.total > 0;
    avgScoreEl.textContent = reviewSummary.avg ? String(reviewSummary.avg) : '—';
    headTotal.textContent = has ? `${fmtSales(reviewSummary.total)} 条评价` : '暂无评价';
    distNodes.forEach((node, star) => {
      const c = reviewSummary.distribution[star] || 0;
      node.count.textContent = String(c);
      node.fill.setAttribute('style', `width:${reviewSummary.total ? Math.round((c / reviewSummary.total) * 100) : 0}%`);
    });
    filterBtns.forEach((b, i) => { b.textContent = filterMeta[i].label(reviewSummary); });
    if (has) {
      overviewBox.removeAttribute('hidden');
      toolbarBox.removeAttribute('hidden');
    } else {
      overviewBox.setAttribute('hidden', 'hidden');
      toolbarBox.setAttribute('hidden', 'hidden');
    }
  }

  const reviewPanel = el('section', {
    id: 'pdp-reviews',
    class: 'panel pdp-reviews',
    tabindex: '-1',
  }, [
    el('div', { class: 'pdp-review-head' }, [
      el('h3', {}, '用户评价'),
      el('div', { class: 'pdp-review-summary' }, [
        el('span', { class: 'stars pdp-stars' }, starText(rating)),
        headTotal,
      ]),
      writeBtn,
    ]),
    overviewBox,
    toolbarBox,
    formBox,
    reviewList,
    moreBtn,
  ]);

  paintStars();
  paintCounter();
  paintImgPreview();
  paintReviewList();
  refreshOverview();
  body.appendChild(reviewPanel);
  page.appendChild(body);
  // 本地数据先落地首屏，再异步换服务端评价（联网即用真实数据，断网静默保持降级）
  loadServerReviews();

  /* ---- 相关推荐（保留原商品列表关联能力） ---- */
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
      relGrid.appendChild(productCard(r, { onDetail: (item) => openProductDetail(item, 'rec'), onAddCart: (item) => doAdd(item, 'rec') })),
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

  // 移动端操作吸底；桌面端使用信息区内的 .pdp-primary-actions。
  const mobileBar = el('div', { class: 'pdp-mobile-actions', role: 'group', 'aria-label': '商品操作' }, [
    mobileFav,
    mobileAdd,
    mobileBuy,
  ]);
  page.appendChild(mobileBar);

  syncFavorite();
  syncSelection();
  return page;
}

/**
 * 用户评价卡片。
 * onVote(review, btn)：由详情页注入的有用投票回调，负责落 localStorage 并回写按钮状态；
 * 不传则不渲染投票按钮（便于在其它场景复用本卡片）。
 */
/**
 * 图片压缩：等比缩到最长边 1200px 并转 JPEG（质量 0.82）。
 * 目的很直接——手机直出照片动辄 4-6MB，上传前压到 ~200KB，省流量也减轻网关压力。
 * @param {File} file
 * @returns {Promise<string>} dataURL
 */
function compressImageFile(file, maxEdge = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('未选择图片'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('当前浏览器不支持图片压缩'));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 买家秀大图查看：轻量遮罩，点击任意处关闭（Esc 关闭由 CSS 之外的 document 监听兜底） */
function openImageViewer(src) {
  const layer = el('div', {
    class: 'pdp-image-viewer',
    onclick: () => layer.setAttribute('hidden', 'hidden'),
  }, [
    el('img', { src, alt: '买家秀大图' }),
    el('button', { type: 'button', class: 'pdp-image-viewer-close', 'aria-label': '关闭' }, '×'),
  ]);
  (document.body || document.createElement('body')).appendChild(layer);
}

/** 买家秀九宫格：统一 1:1 裁切（object-fit: cover），点击可看大图 */
function reviewImages(images = []) {
  if (!Array.isArray(images) || !images.length) return null;
  return el('div', { class: 'pdp-review-images' }, images.map((src) => el('button', {
    type: 'button',
    class: 'pdp-review-thumb',
    'aria-label': '查看买家秀大图',
    onclick: () => openImageViewer(src),
  }, [el('img', { src, alt: '买家秀', loading: 'lazy' })])));
}

/** 追评块：比主评价轻一档，用左侧细线表达「挂在下面」的层级关系 */
function followUpBlock(f, r) {
  return el('div', { class: 'pdp-followup' }, [
    el('div', { class: 'pdp-followup-head' }, [
      el('span', { class: 'pdp-followup-tag' }, '追评'),
      f.created_at ? el('span', { class: 'pdp-followup-date' }, String(f.created_at).slice(0, 10)) : null,
    ]),
    el('div', { class: 'pdp-followup-content' }, f.content),
    reviewImages(f.images),
  ]);
}

/**
 * 追评表单：默认收起，只有「我的评价」才有入口。
 * 提交后由外层把新追评塞进 r.followUps 并重绘单张卡片，避免整列表跳动。
 */
function followUpForm(r, onSubmit) {
  const MAX_FU_LEN = 500;
  const MIN_FU_LEN = 5;
  const state = { content: '', images: [], open: false, uploading: false, busy: false };
  const area = el('textarea', {
    class: 'pdp-followup-textarea',
    rows: '3',
    maxlength: String(MAX_FU_LEN),
    placeholder: '补充使用感受，例如耐用度、售后、与预期的差异…',
    oninput: () => { state.content = area.value || ''; },
  });
  const hint = el('span', { class: 'pdp-followup-hint' }, `至少 ${MIN_FU_LEN} 个字`);
  const fileInput = el('input', {
    type: 'file',
    class: 'pdp-file-input',
    accept: 'image/*',
    multiple: 'multiple',
    onchange: () => { addImages(Array.from(fileInput.files || [])); fileInput.value = ''; },
  });
  const preview = el('div', { class: 'pdp-form-thumbs' });
  function paintPreview() {
    preview.innerHTML = '';
    state.images.forEach((url, i) => {
      preview.appendChild(el('div', { class: 'pdp-form-thumb' }, [
        el('img', { src: url, alt: `追评配图 ${i + 1}` }),
        el('button', {
          type: 'button',
          class: 'pdp-thumb-remove',
          'aria-label': '删除这张图片',
          onclick: () => { state.images.splice(i, 1); paintPreview(); },
        }, '×'),
      ]));
    });
  }
  async function addImages(files) {
    const room = MAX_REVIEW_IMAGES - state.images.length;
    if (room <= 0) { toast(`最多上传 ${MAX_REVIEW_IMAGES} 张图片`, 'warn'); return; }
    if (state.uploading) return;
    state.uploading = true;
    hint.textContent = '正在压缩并上传图片…';
    try {
      for (const file of files.slice(0, room)) {
        const dataUrl = await compressImageFile(file);
        const url = await uploadReviewImage(dataUrl);
        state.images.push(url);
      }
      paintPreview();
      hint.textContent = state.images.length ? `已添加 ${state.images.length} 张图` : `至少 ${MIN_FU_LEN} 个字`;
    } catch (e) {
      toast(e.message || '图片上传失败', 'warn');
      hint.textContent = '图片上传失败，可直接发布文字追评';
    } finally {
      state.uploading = false;
    }
  }
  const submitBtn = el('button', { type: 'submit', class: 'ghost pdp-followup-submit' }, '发布追评');
  const box = el('form', {
    class: 'pdp-followup-form',
    hidden: 'hidden',
    novalidate: 'novalidate',
    onsubmit: async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const content = String(state.content || '').trim();
      if (content.length < MIN_FU_LEN) { toast(`追评内容至少 ${MIN_FU_LEN} 个字`, 'warn'); return; }
      if (state.busy) return;
      state.busy = true;
      submitBtn.disabled = true;
      submitBtn.textContent = '发布中…';
      try {
        await onSubmit(r, { content, images: state.images });
        state.content = '';
        state.images = [];
        area.value = '';
        paintPreview();
        box.setAttribute('hidden', 'hidden');
        toggleBtn.textContent = '追评';
      } catch (err) {
        toast(err.message || '追评发布失败，请稍后重试', 'warn');
      } finally {
        state.busy = false;
        submitBtn.disabled = false;
        submitBtn.textContent = '发布追评';
      }
    },
  }, [
    area,
    el('div', { class: 'pdp-followup-actions' }, [
      el('label', { class: 'pdp-file-label' }, [fileInput, '添加图片']),
      hint,
      submitBtn,
    ]),
    preview,
  ]);
  const toggleBtn = el('button', {
    type: 'button',
    class: 'pdp-followup-toggle',
    onclick: () => {
      state.open = box.getAttribute('hidden') != null;
      if (state.open) { box.removeAttribute('hidden'); toggleBtn.textContent = '收起'; }
      else { box.setAttribute('hidden', 'hidden'); toggleBtn.textContent = '追评'; }
    },
  }, '追评');
  return el('div', { class: 'pdp-followup-wrap' }, [toggleBtn, box]);
}

function reviewCard(r, onVote, onFollowUp) {
  // 直接把节点引用交给回调，避免投票时回溯查询 DOM（也兼容无 querySelector 的环境）。
  const voteText = el('span', { class: 'pdp-vote-text' }, r.voted ? '已赞同' : '有用');
  const voteCount = el('span', { class: 'pdp-vote-count' }, String(Number(r.helpful) || 0));
  const voteBtn = onVote
    ? el('button', {
        type: 'button',
        class: 'pdp-vote' + (r.voted ? ' is-active' : ''),
        'aria-pressed': r.voted ? 'true' : 'false',
        onclick: () => onVote(r, { btn: voteBtn, text: voteText, count: voteCount }),
      }, [
        el('span', { class: 'pdp-vote-icon', 'aria-hidden': 'true' }, '↑'),
        voteText,
        voteCount,
      ])
    : null;
  const followUps = Array.isArray(r.followUps) ? r.followUps : [];
  const foot = voteBtn || r.skuSpec
    ? el('div', { class: 'rv-foot' }, [
        r.skuSpec ? el('span', { class: 'rv-spec' }, `已购规格：${r.skuSpec}`) : null,
        voteBtn,
      ])
    : null;
  return el('div', { class: 'review' + (r.mine ? ' is-mine' : '') }, [
    el('div', { class: 'rv-head' }, [
      el('span', { class: 'avatar' }, (r.author || '匿')[0]),
      el('div', {}, [
        el('div', { class: 'rv-name' }, [
          r.author || '匿名用户',
          r.mine ? el('span', { class: 'rv-mine-tag' }, '我的评价') : null,
        ]),
        el('div', { class: 'stars sm' }, starText(r.rating)),
      ]),
      r.created_at ? el('span', { class: 'rv-date' }, String(r.created_at).slice(0, 10)) : null,
    ]),
    el('div', { class: 'rv-content' }, r.content),
    foot,
    reviewImages(r.images),
    followUps.length ? el('div', { class: 'pdp-followup-list' }, followUps.map((f) => followUpBlock(f, r))) : null,
    r.mine && onFollowUp ? followUpForm(r, onFollowUp) : null,
  ]);
}

/** 立即购买：按当前所选规格与数量直达结算页 */
function buyNow(p, sku, from, qty = 1) {
  addToCart({ ...p, price: sku ? sku.price : p.price, spec: sku ? sku.spec : '' }, qty, sku ? sku.id : null);
  updateCartBadge();
  navigate('#/checkout' + (from ? `?from=${encodeURIComponent(from)}` : ''));
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
