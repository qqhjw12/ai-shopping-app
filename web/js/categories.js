// 分类浏览页：两级类目入口。每个一级类目用「该类目下真实商品的封面」拼成 2×2 拼图，
// 点击直接进商品列表并按该类目筛选（深链 #/products?cat=xxx）。
import { el } from './ui.js';
import { productArt } from './art.js';
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
    picks.map((p) => el('div', { class: 'tile' }, productArt(p))),
  );
}

function categoryCard(cat, bucket) {
  const subs = (cat.children || []).slice(0, 4);
  return el(
    'article',
    {
      class: 'cat-card',
      onclick: () => navigate(`#/products?cat=${encodeURIComponent(cat.id)}`),
    },
    [
      collage(bucket),
      el('div', { class: 'cat-body' }, [
        el('div', { class: 'cat-title' }, [
          el('span', { class: 'cat-icon' }, cat.icon || '🛍️'),
          el('h3', {}, cat.name),
        ]),
        el('div', { class: 'cat-count' }, `${cat.count} 件商品`),
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
                  `${s.name} ${s.count}`,
                ),
              ),
            )
          : el('div', { class: 'cat-desc' }, cat.desc || ''),
      ]),
      el('div', { class: 'cat-go' }, '去看看 →'),
    ],
  );
}

export async function renderCategories(view) {
  view.innerHTML = '';
  const wrap = el('div', { class: 'cat-page' });
  view.appendChild(
    el('div', { class: 'section-title' }, [
      el('h2', {}, '🗂️ 全部分类'),
      el('span', { class: 'sub' }, '16 个一级类目 · 48 个细分品类'),
    ]),
  );
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
    wrap.appendChild(el('div', { class: 'cart-empty' }, '暂无分类数据'));
    return;
  }
  const grid = el('div', { class: 'cat-grid' });
  tree.forEach((c) => grid.appendChild(categoryCard(c, buckets.get(c.id) || [])));
  wrap.appendChild(grid);
}
