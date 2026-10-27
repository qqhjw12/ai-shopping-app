// 分类浏览页：两级类目入口。每个一级类目用「该类目下真实商品的封面」拼成 2×2 拼图，
// 点击直接进商品列表并按该类目筛选（深链 #/products?cat=xxx）。
import { el, productThumb, emptyEditorial } from './ui.js';
import { api } from './api.js';
import { getProducts, deriveCategoryTree } from './views.js';
import { navigate } from './router.js';
import { isDemoMode } from './demo.js';

async function loadTree() {
  if (isDemoMode()) return null;
  try {
    const d = await api('/api/categories?tree=1', { retries: 0 });
    if (d && Array.isArray(d.categories) && d.categories.length) return d.categories;
  } catch {
    /* 网关不可用 → 走本地派生 */
  }
  return null;
}

/** 用该类目下的真实商品封面拼 2×2 拼图 */
function collage(items) {
  const picks = items.slice(0, 4);
  while (picks.length < 4 && items.length) picks.push(items[picks.length % items.length]);
  return el(
    'div',
    { class: 'cat-collage' },
    picks.map((p) => el('div', { class: 'tile' }, productThumb(p))),
  );
}

function categoryCard(cat, bucket, index) {
  const subs = (cat.children || []).slice(0, 4);
  const num = String(index + 1).padStart(2, '0');
  return el(
    'article',
    {
      class: 'cat-card',
      onclick: () => navigate(`#/products?cat=${encodeURIComponent(cat.id)}`),
    },
    [
      collage(bucket),
      el('div', { class: 'cat-body' }, [
        el('div', { class: 'cat-kicker' }, [
          el('span', {}, `CATEGORY / ${num}`),
          el('span', {}, `${cat.count} 件`),
        ]),
        el('div', { class: 'cat-title' }, [
          el('h3', {}, cat.name),
          el('span', { class: 'cat-arrow', 'aria-hidden': 'true' }, '↗'),
        ]),
        subs.length
          ? el(
              'div',
              { class: 'cat-subs' },
              subs.map((s) =>
                el(
                  'a',
                  {
                    href: `#/products?cat=${encodeURIComponent(cat.id)}&sub=${encodeURIComponent(s.id)}`,
                    onclick: (e) => {
                      e.stopPropagation();
                      navigate(`#/products?cat=${encodeURIComponent(cat.id)}&sub=${encodeURIComponent(s.id)}`);
                    },
                  },
                  `${s.name} · ${s.count}`,
                ),
              ),
            )
          : el('div', { class: 'cat-desc' }, cat.desc || '为日常保留一份恰到好处。'),
      ]),
    ],
  );
}

export async function renderCategories(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE ARCHIVE'),
      el('h1', { class: 'page-display' }, '全部分类'),
      el('p', {}, '以生活场景为线索，整理出一份不喧哗的物件目录。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      el('span', { class: 'intro-count' }, '16 个一级类目'),
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]));
  const wrap = el('div', { class: 'cat-page' });
  view.appendChild(wrap);
  wrap.appendChild(el('div', { class: 'skeleton-grid' }, Array.from({ length: 8 }, () => el('div', { class: 'skeleton' }))));

  let products = [];
  try {
    products = await getProducts();
  } catch {
    products = [];
  }
  const tree = (await loadTree()) || deriveCategoryTree(products);

  // 商品按一级类目分桶，用于拼图
  const buckets = new Map();
  for (const p of products) {
    const k = p.categoryId || 'misc';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }

  wrap.innerHTML = '';
  if (!tree.length) {
    wrap.appendChild(emptyEditorial({
      title: '目录正在整理',
      text: '稍后再来看看，或让 AI 私人买手带你寻找心仪之物。',
      primaryLabel: '回到首页',
      onPrimary: () => navigate('#/'),
    }));
    return;
  }
  const grid = el('div', { class: 'cat-grid' });
  tree.forEach((c, i) => grid.appendChild(categoryCard(c, buckets.get(c.id) || [], i)));
  wrap.appendChild(grid);
}
