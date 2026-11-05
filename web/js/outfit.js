// 详情页「AI 搭配」面板：按一级类目策略给出 2–4 件套装，可单件替换、整套加购。
// 规则全部在 store/outfitStore.js + outfitConfig.js，这里只负责画与交互。
import { el, fmtPrice, productThumb, toast } from './ui.js';
import { OUTFIT_COPY as COPY, OUTFIT_RULES } from './store/outfitConfig.js';
import {
  strategyFor, pickMates, reasonList, outfitTotals, replaceMate, outfitCartList,
} from './store/outfitStore.js';

async function loadPool() {
  // 动态 import 打破 views ↔ outfit 的静态循环（views 是调用方）
  const { getProducts } = await import('./views.js');
  return getProducts();
}

async function addAll(list) {
  const { doAdd } = await import('./views.js');
  list.forEach((p) => doAdd(p, 'outfit'));
}

/** 套装里的一行搭配：缩略图 + 名称 + 价格 + 一行理由 + 换一件/移出 */
function mateRow(mate, reason, onReplace, onRemove) {
  return el('li', { class: 'ot-mate', 'data-mate': String(mate.id) }, [
    el('a', { class: 'ot-mate-thumb', href: `#/product/${encodeURIComponent(mate.id)}` }, [productThumb(mate)]),
    el('div', { class: 'ot-mate-body' }, [
      el('a', { class: 'ot-mate-name', href: `#/product/${encodeURIComponent(mate.id)}` }, mate.name || ''),
      el('div', { class: 'ot-mate-meta' }, [
        el('span', { class: 'ot-mate-price' }, fmtPrice(mate.price)),
        mate.brand ? el('span', { class: 'ot-mate-brand' }, mate.brand) : null,
      ]),
      el('p', { class: 'ot-mate-reason', 'data-reason': reason.id }, reason.text),
    ]),
    el('div', { class: 'ot-mate-actions' }, [
      el('button', { type: 'button', class: 'ot-mini', 'data-replace': String(mate.id), onclick: onReplace }, COPY.replace),
      el('button', { type: 'button', class: 'ot-mini ot-mini-dim', 'data-drop': String(mate.id), onclick: onRemove }, COPY.remove),
    ]),
  ]);
}

/**
 * 详情页的搭配面板。默认收起（只显示入口按钮），点击才计算 ——
 * 不在详情页首屏就扫商品库，避免给每个 PDP 增加无谓开销。
 */
export function outfitPanel(product) {
  const section = el('section', { class: 'pdp-outfit panel', id: 'pdp-outfit', 'aria-label': COPY.title });
  let mates = [];
  let pool = [];
  let opened = false;
  let variant = 0;

  const head = el('div', { class: 'ot-head' }, [
    el('div', {}, [
      el('span', { class: 'eyebrow' }, COPY.eyebrow),
      el('h3', { class: 'ot-title' }, COPY.title),
    ]),
    el('span', { class: 'ot-hint' }, COPY.entryHint),
  ]);
  section.appendChild(head);

  const body = el('div', { class: 'ot-body' });
  section.appendChild(body);

  const entry = el('button', {
    type: 'button', class: 'ot-enter', id: 'ot-enter',
    onclick: () => open(),
  }, COPY.entry);
  body.appendChild(entry);

  const strategy = strategyFor(product);

  function paint() {
    body.innerHTML = '';
    if (!mates.length) {
      body.appendChild(el('p', { class: 'ot-empty' }, COPY.empty));
      return;
    }
    const totals = outfitTotals(product, mates);
    const reasons = reasonList(product, mates, strategy);

    body.appendChild(el('div', { class: 'ot-main' }, [
      el('a', { class: 'ot-main-thumb', href: `#/product/${encodeURIComponent(product.id)}` }, [productThumb(product)]),
      el('div', { class: 'ot-main-body' }, [
        el('span', { class: 'ot-main-tag' }, COPY.mainLabel),
        el('span', { class: 'ot-main-name' }, product.name || ''),
        el('span', { class: 'ot-main-price' }, fmtPrice(totals.mainPrice)),
      ]),
    ]));

    body.appendChild(el('ul', { class: 'ot-mates' }, mates.map((m, i) => mateRow(
      m,
      reasons[i],
      () => {
        const r = replaceMate(pool, product, mates, i);
        if (!r.ok) { toast(r.reason === 'no-alternative' ? '这一件暂时没有别的同类替代' : '换不了，稍后再试', 'warn'); return; }
        mates = r.mates;
        paint();
      },
      () => {
        if (mates.length <= 1) { toast('套装至少保留一件搭配', 'warn'); return; }
        mates = mates.filter((_, k) => k !== i);
        paint();
      },
    ))));

    body.appendChild(el('div', { class: 'ot-total' }, [
      el('div', { class: 'ot-total-line' }, [
        el('span', { class: 'ot-total-label' }, COPY.subtotal),
        el('span', { class: 'ot-total-sub' }, fmtPrice(totals.subtotal)),
      ]),
      el('div', { class: 'ot-total-line' }, [
        el('span', { class: 'ot-total-label' }, totals.discountLabel),
        el('span', { class: 'ot-total-save' }, `− ${fmtPrice(totals.saving)}`),
      ]),
      el('div', { class: 'ot-total-line is-final' }, [
        el('span', { class: 'ot-total-label' }, COPY.total),
        el('span', { class: 'ot-total-value', id: 'ot-total-value' }, fmtPrice(totals.total)),
      ]),
    ]));

    body.appendChild(el('div', { class: 'ot-actions' }, [
      el('button', {
        type: 'button', class: 'ot-add-all', id: 'ot-add-all',
        onclick: async () => {
          const list = outfitCartList(product, mates);
          await addAll(list);
          toast(`${COPY.addedAll}（${list.length} 件）`, 'ok');
        },
      }, COPY.addAll),
      el('button', {
        type: 'button', class: 'ot-refresh', id: 'ot-refresh',
        onclick: () => open({ force: true }),
      }, '重新搭配'),
    ]));

    body.appendChild(el('p', { class: 'ot-note' }, COPY.note));
  }

  async function open({ force = false } = {}) {
    if (opened && !force) return;
    if (!opened || force) {
      body.innerHTML = '';
      body.appendChild(el('p', { class: 'ot-loading' }, COPY.loading));
      if (force) variant += 1;
    }
    try {
      pool = await loadPool();
    } catch {
      pool = [];
    }
    mates = pickMates(pool, product, variant ? { variant } : undefined);
    opened = true;
    paint();
  }

  return section;
}
