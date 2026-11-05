// 商品对比擂台：商品卡/详情页的「加入对比」开关、全局对比悬浮条、#/compare 页。
// 数据判断全部在 store/compareStore.js，这里只负责画。
import { el, fmtPrice, fmtSales, productThumb, toast } from './ui.js';
import { COMPARE_MAX, COMPARE_COPY as COPY } from './store/compareConfig.js';
import {
  getSnapshot, subscribe, toggleCompare, doRemove, doClear, isComparing,
  resolveProducts, buildTable,
} from './store/compareStore.js';

/* ==================== 商品卡 / 详情页的开关按钮 ==================== */

/**
 * 「加入对比」按钮：已加入则显示「已加入」并可再点移出。
 * 商品卡与详情页共用同一个组件，保证两处行为一致。
 */
export function compareToggle(product, { className = '', label = COPY.addLabel } = {}) {
  if (!product || product.id == null) return el('span');
  const id = String(product.id);
  const on = isComparing(getSnapshot(), id);
  const btn = el('button', {
    type: 'button',
    class: `cmp-toggle${on ? ' is-on' : ''} ${className}`.trim(),
    'data-compare-id': id,
    'aria-pressed': String(on),
    title: on ? '从对比中移除' : `加入对比（最多 ${COMPARE_MAX} 件）`,
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = toggleCompare(id);
      if (r && r.ok) {
        const nowOn = isComparing(getSnapshot(), id);
        btn.classList.toggle('is-on', nowOn);
        btn.setAttribute('aria-pressed', String(nowOn));
        btn.textContent = nowOn ? COPY.addedLabel : label;
        toast(nowOn ? `已加入对比（${r.count}/${COMPARE_MAX}）` : '已从对比移除', 'ok');
        return;
      }
      if (r && r.reason === 'full') toast(COPY.fullHint, 'warn');
      else if (r && r.reason === 'duplicate') toast(COPY.duplicateHint, 'warn');
      else if (r && r.reason === 'storage') toast('本地存储不可用，改动未能保存', 'err');
    },
  }, on ? COPY.addedLabel : label);
  return btn;
}

/* ==================== 全局对比悬浮条 ==================== */

let dockNode = null;

/**
 * 挂载底部悬浮条：有选中商品时才出现，点「去对比」进 #/compare。
 * 位置由 CSS 控制（详情页/吸底栏之上），不遮挡主操作。
 */
export function mountCompareDock() {
  if (typeof document === 'undefined' || dockNode) return dockNode;
  const node = el('div', { class: 'cmp-dock', id: 'cmp-dock', hidden: true, role: 'region', 'aria-label': '对比栏' });
  document.body.appendChild(node);
  dockNode = node;

  const paint = () => {
    const st = getSnapshot();
    const count = st.ids.length;
    const onComparePage = String(location.hash || '').startsWith('#/compare');
    node.hidden = count === 0 || onComparePage;
    node.innerHTML = '';
    if (node.hidden) return;
    node.appendChild(el('span', { class: 'cmp-dock-count', id: 'cmp-dock-count' }, [
      el('b', {}, String(count)),
      el('span', {}, `/${COMPARE_MAX} 已选`),
    ]));
    node.appendChild(el('span', { class: 'cmp-dock-dots', 'aria-hidden': 'true' },
      st.ids.map(() => el('i', { class: 'cmp-dock-dot' }))));
    node.appendChild(el('a', { class: 'cmp-dock-cta', id: 'cmp-dock-go', href: '#/compare' }, COPY.dockCta));
  };

  subscribe(paint);
  window.addEventListener('hashchange', paint);
  paint();
  return node;
}

/* ==================== 对比页 ==================== */

function valueText(row, value) {
  if (row.kind === 'number') {
    if (row.format === 'price') return fmtPrice(value);
    if (row.format === 'rating') return Number(value) > 0 ? `★ ${Number(value).toFixed(1)}` : '—';
    if (row.format === 'count') return Number(value) > 0 ? fmtSales(value) : '—';
    if (row.format === 'stock') return Number(value) > 0 ? `${value} 件` : '缺货';
    return String(value);
  }
  if (row.kind === 'score') return `${value} / 100`;
  return String(value || '—');
}

async function loadPool() {
  // 动态 import 打破 views ↔ compare 的静态循环；此时 views 早已加载完毕
  const { getProducts } = await import('./views.js');
  return getProducts();
}

async function addOneToCart(p) {
  const { doAdd } = await import('./views.js');
  doAdd(p, 'compare');
}

/** 对比页：桌面走细线表格，移动端走横向滚动卡片，两套结构同一份数据。 */
export function renderCompare(view) {
  view.innerHTML = '';
  const page = el('section', { class: 'cmp-page' });
  view.appendChild(page);

  const head = el('header', { class: 'cmp-head' }, [
    el('span', { class: 'eyebrow' }, COPY.eyebrow),
    el('h1', { class: 'cmp-title' }, COPY.title),
    el('p', { class: 'cmp-lead' }, COPY.lead),
  ]);
  page.appendChild(head);

  const stage = el('div', { class: 'cmp-stage' });
  page.appendChild(stage);

  const footer = el('div', { class: 'cmp-foot' }, [
    el('span', { class: 'cmp-note' }, COPY.note),
    el('span', { class: 'cmp-note cmp-note-dim' }, COPY.attrSwitched),
  ]);
  page.appendChild(footer);

  let pool = [];
  let poolReady = false;
  let poolFailed = false;
  let diffOnly = false;

  const paint = () => {
    const st = getSnapshot();
    stage.innerHTML = '';

    if (!st.ids.length) {
      stage.appendChild(el('div', { class: 'cmp-empty' }, [
        el('p', { class: 'cmp-empty-text' }, COPY.empty),
        el('a', { class: 'cmp-empty-cta', href: '#/products' }, COPY.emptyCta),
      ]));
      return;
    }

    // 首屏 paint 是同步的，getProducts() 是异步的：池还没到就说「商品不在库中」
    // 会先闪一帧假错误。这里显式区分「加载中 / 加载失败 / 已就绪」三态。
    if (!poolReady) {
      stage.appendChild(el('p', { class: 'cmp-hint', id: 'cmp-loading' }, COPY.loading));
      return;
    }
    if (poolFailed) {
      stage.appendChild(el('p', { class: 'cmp-hint cmp-hint-warn', id: 'cmp-load-failed' }, COPY.loadFailed));
      return;
    }

    const products = resolveProducts(pool, st.ids);
    const table = buildTable(products);

    const bar = el('div', { class: 'cmp-toolbar' }, [
      el('span', { class: 'cmp-count' }, `${products.length}/${COMPARE_MAX} 件`),
      el('label', { class: 'cmp-switch' }, [
        el('input', {
          type: 'checkbox',
          id: 'cmp-diff-toggle',
          checked: diffOnly,
          onchange: (e) => { diffOnly = e.target.checked; paint(); },
        }),
        el('span', {}, COPY.diffToggle),
      ]),
      el('button', {
        type: 'button', class: 'cmp-clear', id: 'cmp-clear',
        onclick: () => { doClear(); },
      }, COPY.clearAll),
    ]);
    stage.appendChild(bar);

    if (products.length < st.ids.length) {
      stage.appendChild(el('p', { class: 'cmp-hint' }, COPY.missing));
    }

    const wrap = el('div', { class: `cmp-wrap${diffOnly ? ' is-diff-only' : ''}` });
    wrap.appendChild(tableNode(table));
    wrap.appendChild(cardsNode(table, products));
    stage.appendChild(wrap);

    if (products.length < 2) {
      stage.appendChild(el('p', { class: 'cmp-hint' }, COPY.oneHint));
    }
    const hasDiff = table.rows.some((r) => r.different);
    if (diffOnly && !hasDiff) {
      stage.appendChild(el('p', { class: 'cmp-hint cmp-hint-warn' }, COPY.allSame));
    }
  };

  function cellActions(p) {
    return el('div', { class: 'cmp-col-actions' }, [
      el('a', { class: 'cmp-col-link', href: `#/product/${encodeURIComponent(p.id)}` }, '详情'),
      el('button', {
        type: 'button', class: 'cmp-col-add', 'data-add': String(p.id),
        onclick: () => { addOneToCart(p); },
      }, '加购'),
      el('button', {
        type: 'button', class: 'cmp-col-remove', 'data-remove': String(p.id),
        onclick: () => { doRemove(p.id); },
      }, COPY.remove),
    ]);
  }

  function tableNode(table) {
    const { products } = table;
    const thead = el('thead', {}, [
      el('tr', {}, [
        el('th', { class: 'cmp-th-dim', scope: 'col' }, '对比项'),
        ...products.map((p) => el('th', { class: 'cmp-th-item', scope: 'col', 'data-col': String(p.id) }, [
          el('a', { class: 'cmp-col-thumb', href: `#/product/${encodeURIComponent(p.id)}` }, [productThumb(p)]),
          el('span', { class: 'cmp-col-name' }, p.name || ''),
          cellActions(p),
        ])),
      ]),
    ]);
    const tbody = el('tbody', {}, table.rows.map((row) => el('tr', {
      class: 'cmp-row',
      'data-dim': row.key,
      'data-diff': row.different ? '1' : '0',
    }, [
      el('th', { class: 'cmp-dim', scope: 'row' }, [
        el('span', { class: 'cmp-dim-label' }, row.label),
        row.better ? el('span', { class: 'cmp-dim-better' }, row.better === 'lower' ? '低者优' : '高者优') : null,
      ]),
      ...products.map((p, i) => el('td', {
        class: `cmp-val${row.best.includes(i) ? ' is-best' : ''}`,
        'data-best': row.best.includes(i) ? '1' : '0',
      }, valueText(row, row.values[i]))),
    ])));
    return el('table', { class: 'cmp-table', id: 'cmp-table' }, [thead, tbody]);
  }

  function cardsNode(table, products) {
    return el('div', { class: 'cmp-cards', id: 'cmp-cards' }, products.map((p, i) => el('article', {
      class: 'cmp-card', 'data-col': String(p.id),
    }, [
      el('div', { class: 'cmp-card-head' }, [
        el('a', { class: 'cmp-col-thumb', href: `#/product/${encodeURIComponent(p.id)}` }, [productThumb(p)]),
        el('span', { class: 'cmp-col-name' }, p.name || ''),
        cellActions(p),
      ]),
      el('dl', { class: 'cmp-card-dims' }, table.rows.flatMap((row) => [
        el('div', {
          class: `cmp-card-row${row.different ? '' : ' is-same'}`,
          'data-dim': row.key,
          'data-diff': row.different ? '1' : '0',
        }, [
          el('dt', {}, row.label),
          el('dd', {
            class: row.best.includes(i) ? 'is-best' : '',
            'data-best': row.best.includes(i) ? '1' : '0',
          }, valueText(row, row.values[i])),
        ]),
      ])),
    ])));
  }

  const off = subscribe(() => { if (!page.isConnected) { off(); return; } paint(); });
  paint();
  loadPool().then((list) => {
    pool = list;
    poolReady = true;
    if (page.isConnected) paint();
  }).catch(() => {
    poolFailed = true;
    poolReady = true;
    if (page.isConnected) paint();
  });
  return page;
}
