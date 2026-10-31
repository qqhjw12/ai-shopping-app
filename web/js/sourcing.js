// 货源市场（供应商目录）：给有采购需求的商家 / 分销用户看的轻量目录。
//
// 三条边界，写在最前面免得以后越做越重：
//   1) 只有「看」——不做采购下单、不做支付、不做报价单流转。
//   2) 数据全是演示数据，页面顶部与 AI 结果处都标明，不假装接了真实供应商。
//   3) 筛选与搜索条件写进 hash（#/merchant/sourcing?cat=home&moq=m50&q=...），
//      刷新不丢、能分享给同事看同一批货。
import { el, fmtPrice, toast, emptyEditorial } from './ui.js';
import {
  listSuppliers, moqBandOf, MOQ_BANDS, SOURCE_CATEGORIES, REGIONS, findSourcing, totalSuppliers,
} from './store/sourcingData.js';

/** 从 hash 里读条件：非法值一律当「没选」，不让一条脏链接把页面搞成空白 */
function readFilters(query = {}) {
  const cat = SOURCE_CATEGORIES.some((c) => c.id === query.cat) ? query.cat : '';
  const moq = MOQ_BANDS.some((b) => b.id === query.moq) ? query.moq : 'all';
  const region = REGIONS.includes(query.region) ? query.region : '';
  return { cat, moq, region, need: String(query.q || '').trim() };
}

/* ---------------- 询盘（演示） ---------------- */

function askInquiry(name) {
  // 不假装发送成功到某处：文案里带「演示」，也不生成假的询盘编号
  toast(`已向「${name}」发送询盘（演示）`, 'ok');
}

/* ---------------- 供应商卡片 ---------------- */

function tagPill(text) {
  return el('span', { class: 'src-tag' }, text);
}

function productRow(p, supplierName) {
  return el('div', { class: 'src-item', 'data-product': p.name }, [
    el('span', { class: 'src-item-name' }, p.name),
    el('span', { class: 'src-item-price num' }, [fmtPrice(p.wholesale), el('em', {}, ' / 件')]),
    el('span', { class: 'src-item-stock' }, `库存 ${Number(p.stock).toLocaleString()}`),
    el('span', { class: 'src-item-moq' }, `起订 ${p.moq} ${p.unit}`),
    el('button', {
      class: 'src-act is-ghost', type: 'button', onclick: () => askInquiry(supplierName),
    }, '询价'),
  ]);
}

/**
 * 供应商卡片。
 * 商品列表默认收起：一屏能扫过十几家供应商的「谁在供什么」，
 * 比一进来就被几十行商品行淹没更有用（要细节才展开，展开状态不写进 hash）。
 */
function supplierCard(s, { open = false } = {}) {
  const items = el('div', { class: 'src-items', hidden: !open }, [
    el('div', { class: 'src-items-head' }, ['商品', '批发价', '库存', '起订', '']),
    ...s.products.map((p) => productRow(p, s.name)),
  ]);

  const toggle = el('button', {
    class: 'src-act is-quiet', type: 'button', 'aria-expanded': open ? 'true' : 'false',
  }, `可供应商品 ${s.products.length}`);
  const card = el('article', {
    class: `src-card${open ? ' is-open' : ''}`, 'data-supplier': s.id,
  }, [
    el('div', { class: 'src-card-head' }, [
      el('div', { class: 'src-id' }, [
        el('h3', { class: 'src-name' }, s.name),
        el('p', { class: 'src-line' }, [
          el('span', {}, s.categoryLabel),
          el('span', { class: 'src-dot', 'aria-hidden': 'true' }, '·'),
          el('span', {}, s.region),
          el('span', { class: 'src-dot', 'aria-hidden': 'true' }, '·'),
          el('span', {}, `起订 ${s.moq} 件`),
        ]),
      ]),
      el('span', { class: 'src-since num' }, `since ${s.since}`),
    ]),
    el('div', { class: 'src-tags' }, s.tags.map(tagPill)),
    el('p', { class: 'src-intro' }, s.intro),
    el('p', { class: 'src-facts' }, `月产能 ${Number(s.capacity).toLocaleString()} 件 · 打样 ${s.sample} 天 · ${s.lead} 天内发货`),
    el('div', { class: 'src-actions' }, [toggle, el('button', {
      class: 'src-act is-gold', type: 'button', onclick: () => askInquiry(s.name),
    }, '联系供应商')]),
    items,
  ]);

  toggle.addEventListener('click', () => {
    const next = items.hidden;
    items.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    card.classList.toggle('is-open', next);
  });
  return card;
}

/* ---------------- 页面 ---------------- */

export function renderSourcing(view, query = {}) {
  view.innerHTML = '';
  const st = readFilters(query);
  // 从工作台跳过来的会带 id/key：给一条明确的回头路，而不是让人按浏览器后退
  const backTo = query.id && query.key
    ? {
      href: `#/merchant/dashboard?tab=overview&id=${encodeURIComponent(query.id)}&key=${encodeURIComponent(query.key)}`,
      label: '返回工作台',
    }
    : { href: '#/products', label: '回到商城' };

  function syncUrl() {
    const p = new URLSearchParams();
    if (st.cat) p.set('cat', st.cat);
    if (st.moq && st.moq !== 'all') p.set('moq', st.moq);
    if (st.region) p.set('region', st.region);
    if (st.need) p.set('q', st.need);
    if (query.id) p.set('id', query.id);
    if (query.key) p.set('key', query.key);
    const s = p.toString();
    const target = `#/merchant/sourcing${s ? `?${s}` : ''}`;
    if (location.hash === target) return;
    try {
      history.replaceState(null, '', target);
    } catch {
      location.hash = target;
    }
  }

  /* ---- 头部 ---- */
  view.appendChild(el('div', { class: 'src-topbar' }, [
    el('a', { class: 'src-back', href: backTo.href }, `← ${backTo.label}`),
    el('span', { class: 'src-demo' }, '演示数据'),
  ]));

  view.appendChild(el('header', { class: 'page-intro src-intro-head' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'SUPPLY DIRECTORY'),
      el('h1', { class: 'page-display' }, '货源市场'),
      el('p', {}, '谁在供什么、起订多少、在哪儿。给有采购需求的商家看的目录，不含询价与交易。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      el('span', { class: 'intro-count' }, `${totalSuppliers()} 家供应商`),
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]));

  /* ---- AI 找货 ---- */
  const aiResult = el('div', { class: 'src-ai-result' });
  const aiInput = el('input', {
    class: 'src-ai-input',
    type: 'search',
    name: 'need',
    placeholder: '例：陶瓷茶具，小批量，要有现货',
    'aria-label': '用一句话说清你要找什么货',
    value: st.need,
  });
  const aiForm = el('form', { class: 'src-ai-form' }, [
    el('label', { class: 'src-ai-label' }, 'AI 找货'),
    aiInput,
    el('button', { class: 'src-ai-btn', type: 'submit' }, '帮我找'),
  ]);
  aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const need = aiInput.value.trim();
    if (!need) {
      toast('先说一句要找什么，例如「棉麻桌布 小批量」', 'warn');
      aiInput.focus();
      return;
    }
    st.need = need;
    syncUrl();
    paintAi();
  });

  view.appendChild(el('section', { class: 'src-ai' }, [
    aiForm,
    el('p', { class: 'src-ai-note' }, '演示能力：按主营类目、供应能力与起订量在这份演示目录里匹配，不接真实询价通道。'),
    aiResult,
  ]));

  /* ---- 筛选 ---- */
  const filterBar = el('div', { class: 'src-filters' });
  const listWrap = el('div', { class: 'src-list' });
  view.appendChild(filterBar);
  view.appendChild(listWrap);

  function chip(label, active, onClick, count) {
    return el('button', {
      class: `src-chip${active ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      onclick: onClick,
    }, count == null ? label : [label, el('span', { class: 'src-chip-n' }, String(count))]);
  }

  function paintFilters(rows) {
    const band = moqBandOf(st.moq);
    filterBar.innerHTML = '';
    filterBar.append(
      el('div', { class: 'src-filter-row' }, [
        el('span', { class: 'src-filter-label' }, '类目'),
        el('div', { class: 'src-chips' }, [
          chip('全部', !st.cat, () => { st.cat = ''; syncUrl(); paint(); }, totalSuppliers()),
          ...SOURCE_CATEGORIES.map((c) => chip(c.label, st.cat === c.id, () => {
            st.cat = st.cat === c.id ? '' : c.id;
            syncUrl();
            paint();
          }, c.count)),
        ]),
      ]),
      el('div', { class: 'src-filter-row' }, [
        el('span', { class: 'src-filter-label' }, '起订量'),
        el('div', { class: 'src-chips' }, MOQ_BANDS.map((b) => chip(b.label, band.id === b.id, () => {
          st.moq = b.id;
          syncUrl();
          paint();
        }))),
      ]),
      el('div', { class: 'src-filter-row' }, [
        el('span', { class: 'src-filter-label' }, '地区'),
        el('select', {
          class: 'src-select',
          'aria-label': '按地区筛选',
          onchange: (e) => { st.region = e.target.value; syncUrl(); paint(); },
        }, [
          el('option', { value: '' }, '全部地区'),
          ...REGIONS.map((r) => el('option', { value: r, selected: st.region === r || null }, r)),
        ]),
        el('span', { class: 'src-count' }, `共 ${rows.length} 家`),
        (st.cat || st.region || st.moq !== 'all')
          ? el('button', {
            class: 'src-act is-ghost src-clear', type: 'button',
            onclick: () => { st.cat = ''; st.moq = 'all'; st.region = ''; syncUrl(); paint(); },
          }, '清空筛选')
          : null,
      ]),
    );
  }

  function paintList(rows) {
    listWrap.innerHTML = '';
    if (!rows.length) {
      listWrap.appendChild(emptyEditorial({
        title: '这个条件下还没有货源',
        text: '换一个类目、放宽起订量，或者直接问上面的 AI 找货。',
        primaryLabel: '清空筛选',
        onPrimary: () => { st.cat = ''; st.moq = 'all'; st.region = ''; syncUrl(); paint(); },
      }));
      return;
    }
    rows.forEach((s) => listWrap.appendChild(supplierCard(s)));
  }

  /** 展开并滚到某家供应商：AI 结果点一下就落到目录里的那张卡上，不用自己再找 */
  function focusSupplier(id) {
    const card = listWrap.querySelector(`.src-card[data-supplier="${id}"]`);
    if (!card) return;
    const items = card.querySelector('.src-items');
    const toggle = card.querySelector('.src-act.is-quiet');
    if (items && items.hidden) {
      items.hidden = false;
      card.classList.add('is-open');
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-flash');
    setTimeout(() => card.classList.remove('is-flash'), 1200);
  }

  function paintAi() {
    aiResult.innerHTML = '';
    if (!st.need) return;
    const r = findSourcing(st.need);
    aiResult.appendChild(el('div', { class: 'src-ai-head' }, [
      el('span', { class: 'src-ai-hint' }, r.hint),
      el('span', { class: 'src-demo is-inline' }, '演示数据'),
    ]));
    if (!r.matched) return;

    aiResult.appendChild(el('div', { class: 'src-ai-block' }, [
      el('h3', { class: 'src-ai-sub' }, '推荐供应商'),
      el('div', { class: 'src-ai-suppliers' }, r.suppliers.map((s) => el('button', {
        class: 'src-ai-sup', type: 'button', onclick: () => focusSupplier(s.id),
      }, [
        el('strong', {}, s.name),
        el('span', { class: 'src-ai-sup-meta' }, `${s.categoryLabel} · ${s.region} · 起订 ${s.moq} 件`),
        el('span', { class: 'src-ai-sup-go' }, '查看 →'),
      ]))),
    ]));

    if (r.products.length) {
      aiResult.appendChild(el('div', { class: 'src-ai-block' }, [
        el('h3', { class: 'src-ai-sub' }, '可以看的货'),
        el('div', { class: 'src-ai-products' }, r.products.map((p) => el('div', { class: 'src-ai-prod' }, [
          el('span', { class: 'src-ai-prod-name' }, p.name),
          el('span', { class: 'src-ai-prod-price num' }, fmtPrice(p.wholesale)),
          el('span', { class: 'src-ai-prod-sup' }, p.supplierName),
        ]))),
      ]));
    }
  }

  function paint() {
    const rows = listSuppliers({ category: st.cat, moq: st.moq, region: st.region });
    paintFilters(rows);
    paintList(rows);
  }

  paint();
  paintAi();

  // 深链进来时把 AI 结果区带到视野里（?q= 是分享过来的搜索词）
  if (st.need) setTimeout(() => aiResult.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}

/** 用户端「找货源」入口条：一条安静的分隔条，不抢消费者主流程的注意力 */
export function sourcingStrip() {
  return el('a', { class: 'src-strip', href: '#/merchant/sourcing' }, [
    el('span', { class: 'src-strip-eyebrow' }, 'FOR MERCHANTS'),
    el('span', { class: 'src-strip-title' }, '找货源 · 供应商目录'),
    el('span', { class: 'src-strip-text' }, '有采购需求？看谁在供什么、起订多少。演示数据，不含交易。'),
    el('span', { class: 'src-strip-go' }, '→'),
  ]);
}
