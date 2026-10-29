// 分类浏览页：两级类目入口。每个一级类目用「该类目下真实商品的封面」拼成 2×2 拼图，
// 点击直接进商品列表并按该类目筛选（深链 #/products?cat=xxx）。
//
// 本页也带一套筛选与排序，但作用对象是「类目目录」而非商品：
//   - 价格区间：只留下该区间内有商品的类目，卡片上的件数同步变成区间内件数
//   - 排序：类目顺序 / 商品数 / 名称
// 条件写进 hash（#/categories?price=p100_500&sort=count），点进类目时会带进列表页，
// 保证「在分类页选的条件」不会一进列表就丢。
import { el, productThumb, emptyEditorial, isRealPic } from './ui.js';
import { api } from './api.js';
import { getProducts, deriveCategoryTree } from './views.js';
import { navigate } from './router.js';
import { isDemoMode } from './demo.js';
import { PRICE_BANDS, bandById, bandLabel } from './store/catalog.js';

const CAT_SORTS = [
  { id: 'default', label: '类目顺序' },
  { id: 'count', label: '商品数' },
  { id: 'name', label: '名称' },
];

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

/** 用该类目下的商品封面拼 2×2 拼图：优先真实照片，按子类去重保证四格不重样 */
function collage(items) {
  const seenSub = new Set();
  const picks = [];
  const take = (pool) => {
    for (const p of pool) {
      const k = p.subCategoryId || p.id;
      if (seenSub.has(k)) continue;
      seenSub.add(k);
      picks.push(p);
      if (picks.length === 4) return true;
    }
    return false;
  };
  // 先挑有真实图的（同类目里最"像照片"的四张），不够再补程序化封面
  if (!take(items.filter((p) => isRealPic(p)))) take(items);
  // 兜底补齐（类目商品极少时）
  for (let i = 0; picks.length < 4 && i < items.length * 2; i++) {
    const p = items[i % items.length];
    if (!picks.includes(p)) picks.push(p);
  }
  return el(
    'div',
    { class: 'cat-collage' },
    picks.slice(0, 4).map((p) => el('div', { class: 'tile' }, productThumb(p))),
  );
}

function categoryCard(cat, bucket, index, { count, band }) {
  const subs = (cat.children || []).slice(0, 4);
  const num = String(index + 1).padStart(2, '0');
  const carry = band ? `&price=${encodeURIComponent(band.id)}` : '';
  return el(
    'article',
    {
      class: 'cat-card',
      onclick: () => navigate(`#/products?cat=${encodeURIComponent(cat.id)}${carry}`),
    },
    [
      collage(bucket),
      el('div', { class: 'cat-body' }, [
        el('div', { class: 'cat-kicker' }, [
          el('span', {}, `CATEGORY / ${num}`),
          el('span', {}, `${count} 件`),
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
                    href: `#/products?cat=${encodeURIComponent(cat.id)}&sub=${encodeURIComponent(s.id)}${carry}`,
                    onclick: (e) => {
                      e.stopPropagation();
                      navigate(`#/products?cat=${encodeURIComponent(cat.id)}&sub=${encodeURIComponent(s.id)}${carry}`);
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

export async function renderCategories(view, query = {}) {
  let band = bandById(query.price) || null;
  let sort = CAT_SORTS.some((s) => s.id === query.sort) ? query.sort : 'default';

  view.innerHTML = '';
  const introCount = el('span', { class: 'intro-count' }, '');
  view.appendChild(el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE ARCHIVE'),
      el('h1', { class: 'page-display' }, '全部分类'),
      el('p', {}, '以生活场景为线索，整理出一份不喧哗的物件目录。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      introCount,
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

  // 商品按一级类目分桶，用于拼图与区间内计数
  const buckets = new Map();
  for (const p of products) {
    const k = p.categoryId || 'misc';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }

  const inBand = (p) => {
    if (!band) return true;
    const price = Number(p.price) || 0;
    if (band.min != null && !(price >= band.min)) return false;
    if (band.max != null && !(price < band.max)) return false;
    return true;
  };

  function syncUrl() {
    const p = new URLSearchParams();
    if (band) p.set('price', band.id);
    if (sort && sort !== 'default') p.set('sort', sort);
    const s = p.toString();
    const target = `#/categories${s ? `?${s}` : ''}`;
    if (location.hash === target) return;
    try {
      history.replaceState(null, '', target);
    } catch {
      location.hash = target;
    }
  }

  const chip = (label, on, onclick, count) => el('button', {
    type: 'button',
    class: `chip small flt-chip${on ? ' active' : ''}`,
    'aria-pressed': on ? 'true' : 'false',
    onclick,
  }, [label, count != null ? el('span', { class: 'chip-ncnt' }, String(count)) : null]);

  function paint() {
    wrap.innerHTML = '';

    // 快速导航：横向滚动的「类目名 + 件数」chips，一键直达列表页。
    // 调研参考（Storefront UI / 主流电商）：用户最常见的动作是「直奔某个类目」，
    // 先给一条不用滚动整页的路，卡片区留给慢慢逛的人。
    const quick = el('div', { class: 'cat-quick', role: 'navigation', 'aria-label': '类目快速导航' },
      tree
        .map((c, i) => ({ c, count: (buckets.get(c.id) || []).filter(inBand).length }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .map(({ c, count }, i) => {
          const icon = (c.icon || '').trim();
          return el('a', {
            class: 'cat-quick-item',
            href: `#/products?cat=${encodeURIComponent(c.id)}${band ? `&price=${encodeURIComponent(band.id)}` : ''}`,
            onclick: (e) => {
              e.preventDefault();
              navigate(`#/products?cat=${encodeURIComponent(c.id)}${band ? `&price=${encodeURIComponent(band.id)}` : ''}`);
            },
          }, [
            icon ? el('span', { class: 'cat-quick-icon', 'aria-hidden': 'true' }, icon) : el('span', { class: 'cat-quick-num', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
            el('span', { class: 'cat-quick-name' }, c.name),
            el('span', { class: 'cat-quick-count' }, String(count)),
          ]);
        }),
    );
    wrap.appendChild(quick);

    // 工具栏：价格区间 + 排序（作用于类目目录本身）
    const toolbar = el('div', { class: 'cat-tools' }, [
      el('div', { class: 'cat-tools-group' }, [
        el('span', { class: 'filter-label' }, '价格区间'),
        el('div', { class: 'cat-tools-chips' }, [
          chip('全部价格', !band, () => { band = null; syncUrl(); paint(); }),
          ...PRICE_BANDS.map((b) => chip(b.label, Boolean(band && band.id === b.id), () => {
            band = band && band.id === b.id ? null : b;
            syncUrl();
            paint();
          })),
        ]),
      ]),
    ]);
    const select = el('select', {
      class: 'sort-select',
      'aria-label': '类目排序',
      onchange: (e) => { sort = e.target.value; syncUrl(); paint(); },
    }, CAT_SORTS.map((s) => el('option', { value: s.id }, s.label)));
    select.value = sort;
    toolbar.appendChild(el('label', { class: 'sort-wrap' }, [
      el('span', { class: 'sort-label' }, '排序'),
      select,
    ]));
    wrap.appendChild(toolbar);

    // 过滤 + 排序类目
    const rows = tree
      .map((c, i) => {
        const bucket = buckets.get(c.id) || [];
        const matched = bucket.filter(inBand);
        return { cat: c, bucket, matched, index: i, count: matched.length };
      })
      .filter((r) => r.count > 0);

    if (sort === 'count') rows.sort((a, b) => b.count - a.count || a.cat.name.localeCompare(b.cat.name, 'zh'));
    else if (sort === 'name') rows.sort((a, b) => a.cat.name.localeCompare(b.cat.name, 'zh'));

    introCount.textContent = `${rows.length} 个类目${band ? ` · ${bandLabel(band.min, band.max)}` : ''}`;

    if (!rows.length) {
      wrap.appendChild(emptyEditorial({
        title: '这个价位，暂时没有藏品',
        text: '换一个价格区间，或直接去甄选页用完整筛选找找看。',
        primaryLabel: '清空条件',
        onPrimary: () => { band = null; sort = 'default'; syncUrl(); paint(); },
        secondaryLabel: '去甄选页',
        onSecondary: () => navigate('#/products'),
      }));
      return;
    }

    const grid = el('div', { class: 'cat-grid' });
    rows.forEach((r, i) => grid.appendChild(
      categoryCard(r.cat, r.matched.length ? r.matched : r.bucket, i, { count: r.count, band }),
    ));
    wrap.appendChild(grid);
  }

  paint();
}
