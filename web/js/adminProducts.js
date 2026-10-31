// 运营侧商家商品审核台（#/admin/products）。
//
// 第三个运营台，与前两个同构：同一把钥匙、同一个署名、同一套筛选走路由的约定。
// 审的东西是「这件货能不能挂到商城里卖」。
//
// 页面级约定（与前两台一致，故不重复解释理由）：
//   1) 默认停在「待审核」；
//   2) 筛选走 query，刷新/前进后退停在同一个视角；
//   3) 审完整页重拉，局部改卡片一定会漏改计数。
//
// 与入驻审核的一处**不同**：商品被驳回之后商家可以改价改图再提交（下一轮做），
// 所以这里的「未通过」不是终态展示区，而是一份「为什么没过」的清单——
// 理由要写得具体（图糊了、标题夸大、类目选错），商家照着改才有意义。
import { api } from './api.js';
import { el, loading, openModal, toast } from './ui.js';
import {
  adminHeaders,
  adminKeyGate,
  adminTabs,
  clearAdminIdentity,
  fmtStamp,
  isKeyRejected,
  readAdminActor,
} from './adminShared.js';
import { FORM_CATEGORIES } from './merchant.js';

const PAGE_SIZE = 20;
const FILTERS = [
  { code: 'pending', label: '待审核' },
  { code: 'approved', label: '已通过' },
  { code: 'rejected', label: '未通过' },
  { code: 'all', label: '全部' },
];
const DEFAULT_FILTER = 'pending';
const CATEGORY_LABEL = new Map(FORM_CATEGORIES.map((c) => [c.id, c.t]));
const REVIEW_TEXT = { pending: '待审核', approved: '已通过', rejected: '未通过' };
const EVENT_TEXT = { submitted: '商家提交', approved: '审核通过', rejected: '审核驳回', on: '商家上架', off: '商家下架', stock: '调整库存' };

const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN')}`;

async function fetchList({ reviewStatus, page }) {
  const qs = new URLSearchParams();
  if (reviewStatus) qs.set('reviewStatus', reviewStatus);
  qs.set('page', String(page));
  qs.set('size', String(PAGE_SIZE));
  return api(`/api/admin/products?${qs}`, { headers: adminHeaders(), retries: 0 });
}

async function submitReview(id, payload) {
  return api(`/api/admin/products/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: payload,
    retries: 0,
  });
}

async function fetchDetail(id) {
  return api(`/api/admin/products/${encodeURIComponent(id)}`, { headers: adminHeaders(), retries: 0 });
}

/* ---------------- 审核弹层 ---------------- */

function openReviewSheet({ product, action, onDone }) {
  openModal((modal, close) => {
    modal.classList.add('is-narrow');
    const isApprove = action === 'approve';
    const textarea = el('textarea', {
      class: 'as-note',
      rows: '3',
      maxlength: '200',
      placeholder: isApprove ? '给商家的说明（选填）' : '驳回理由（必填，会展示给商家）',
    });
    const err = el('p', { class: 'as-error', role: 'alert' });
    const okBtn = el('button', {
      class: isApprove ? 'od-main-btn as-submit' : 'od-line-btn as-submit',
      type: 'submit',
    }, isApprove ? '确认通过' : '确认驳回');

    const form = el('form', { class: 'as-form' }, [
      el('h2', { class: 'as-title' }, isApprove ? '让这件商品上架' : '驳回这件商品'),
      el('p', { class: 'as-sub' }, `${product.id} · ${product.name} · ${money(product.price)} · 库存 ${product.stock}`),
      el('p', { class: 'as-hint' }, isApprove
        ? '通过后商品立即在商城可搜可买（库存按商家填的数量卖），商家后续可自行上下架。'
        : '驳回理由会原样展示给商家。写清问题所在（图不清晰、标题夸大、类目选错），比一句「不符合要求」有用得多。'),
      el('label', { class: 'as-label' }, isApprove ? '审核说明' : '驳回理由'),
      textarea,
      err,
      el('div', { class: 'as-actions' }, [
        okBtn,
        el('button', { class: 'od-line-btn', type: 'button', onclick: close }, '取消'),
      ]),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const note = textarea.value.trim();
      if (!isApprove && !note) {
        err.textContent = '驳回必须填写理由';
        textarea.focus();
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = '提交中…';
      try {
        await submitReview(product.id, { action, note });
        close();
        toast(isApprove ? '已通过，商品在售' : '已驳回', 'ok');
        onDone();
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = isApprove ? '确认通过' : '确认驳回';
        err.textContent = (e && e.message) || '操作失败，请重试';
      }
    });

    modal.appendChild(form);
  });
}

/* ---------------- 详情弹层（含轨迹） ---------------- */

async function openDetailSheet(product) {
  openModal((modal) => {
    modal.classList.add('is-narrow');
    const body = el('div', { class: 'apr-detail' });
    modal.append(
      el('h2', { class: 'as-title' }, product.name),
      el('p', { class: 'as-sub' }, `${product.id} · 商家 ${product.brand || '—'}`),
      body,
    );
    body.appendChild(el('p', { class: 'as-hint' }, '正在取审核轨迹…'));
    fetchDetail(product.id)
      .then((d) => {
        body.innerHTML = '';
        const p = d.product || product;
        body.append(
          el('dl', { class: 'mzr-facts' }, [
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '价格'), el('dd', {}, money(p.price))]),
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '库存'), el('dd', {}, String(p.stock))]),
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '预警线'), el('dd', {}, String(p.warnAt))]),
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '类目'), el('dd', {}, CATEGORY_LABEL.get(p.categoryId) || p.categoryId)]),
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '审核结论'), el('dd', {}, REVIEW_TEXT[p.reviewStatus] || p.reviewStatus)]),
            el('div', { class: 'mzr-fact' }, [el('dt', {}, '审核意见'), el('dd', {}, p.reviewNote || '—')]),
          ]),
          el('h3', { class: 'apr-sub' }, '轨迹'),
          el('ul', { class: 'apr-events' }, (d.events || []).map((ev) => el('li', {}, [
            el('span', { class: 'apr-ev-dot', 'aria-hidden': 'true' }, '·'),
            el('div', {}, [
              el('strong', {}, EVENT_TEXT[ev.event] || ev.event),
              el('span', {}, `${fmtStamp(ev.at)}${ev.note ? ` · ${ev.note}` : ''}`),
            ]),
          ]))),
        );
      })
      .catch((e) => {
        body.innerHTML = '';
        body.appendChild(el('p', { class: 'as-error' }, (e && e.message) || '轨迹取不到'));
      });
  });
}

/* ---------------- 卡片 ---------------- */

function productCard(p, { reload }) {
  const thumb = el('div', { class: 'apr-thumb' });
  if (p.imageUrl) thumb.appendChild(el('img', { src: p.imageUrl, alt: '', loading: 'lazy' }));
  else thumb.appendChild(el('span', {}, '无图'));

  const actions = [];
  if (p.reviewStatus === 'pending') {
    actions.push(el('button', {
      class: 'od-main-btn apr-act',
      type: 'button',
      onclick: () => openReviewSheet({ product: p, action: 'approve', onDone: reload }),
    }, '通过'));
    actions.push(el('button', {
      class: 'od-line-btn apr-act',
      type: 'button',
      onclick: () => openReviewSheet({ product: p, action: 'reject', onDone: reload }),
    }, '驳回'));
  }
  actions.push(el('button', {
    class: 'adm-line-btn apr-act',
    type: 'button',
    onclick: () => openDetailSheet(p),
  }, '详情与轨迹'));

  return el('article', { class: 'adm-card apr-card', 'data-product': p.id }, [
    el('div', { class: 'adm-card-head' }, [
      el('div', {}, [
        el('span', { class: 'adm-as-id num' }, p.id),
        el('span', { class: 'adm-order-id' }, p.brand || '—'),
      ]),
      el('span', { class: `adm-status s-${p.reviewStatus === 'approved' ? 'approved' : p.reviewStatus === 'rejected' ? 'rejected' : 'reviewing'}` },
        REVIEW_TEXT[p.reviewStatus] || p.reviewStatus),
    ]),
    el('div', { class: 'apr-body' }, [
      thumb,
      el('div', { class: 'apr-meta' }, [
        el('strong', { class: 'apr-name' }, p.name),
        el('p', { class: 'apr-line' }, [
          el('span', {}, money(p.price)),
          el('span', {}, `库存 ${p.stock}`),
          el('span', {}, CATEGORY_LABEL.get(p.categoryId) || p.categoryId || '—'),
        ]),
        p.reviewNote ? el('p', { class: 'apr-note' }, `审核意见：${p.reviewNote}`) : null,
        el('p', { class: 'apr-line apr-dim' }, [
          el('span', {}, `提交 ${fmtStamp(p.createdAt)}`),
          p.reviewedAt ? el('span', {}, `审核 ${fmtStamp(p.reviewedAt)}`) : null,
        ].filter(Boolean)),
      ].filter(Boolean)),
    ]),
    el('div', { class: 'apr-actions' }, actions),
  ]);
}

/* ---------------- 页面 ---------------- */

export async function renderAdminProducts(view, query = {}) {
  view.innerHTML = '';
  const currentQuery = query;
  const paint = () => renderAdminProducts(view, currentQuery);

  if (!readAdminActor() || !adminHeaders()['X-Admin-Key']) {
    view.appendChild(adminKeyGate({
      title: '商家商品审核台',
      sub: '商城里哪些货能卖，由这一页决定。进入需要服务端的管理密钥。',
      hint: [
        '与售后审核台、入驻审核台共用同一把钥匙和同一个署名，任一台登过就不用再登。',
        el('br', {}),
        '通过 = 立即在商城可搜可买；驳回必须写理由，商家照着改才有意义。',
      ],
      onPass: paint,
    }));
    return;
  }

  const active = FILTERS.some((f) => f.code === query.reviewStatus) ? query.reviewStatus : DEFAULT_FILTER;
  const page = Math.max(1, Number(query.page) || 1);

  const host = el('div', { class: 'apr-list' });
  const filterRow = el('div', { class: 'mzr-filters' }, FILTERS.map((f) => el('a', {
    class: `mzr-filter${f.code === active ? ' is-on' : ''}`,
    href: `#/admin/products?reviewStatus=${f.code}`,
  }, f.label)));

  view.appendChild(el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    adminTabs('products'),
    el('div', { class: 'adm-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'MERCHANT GOODS REVIEW'),
        el('h1', { class: 'adm-title' }, '商家商品审核台'),
        el('span', { class: 'adm-actor' }, `操作人 ${readAdminActor()}`),
      ]),
      el('div', { class: 'mzr-head-actions' }, [
        el('button', {
          class: 'adm-line-btn',
          type: 'button',
          onclick: () => { clearAdminIdentity(); paint(); },
        }, '退出'),
      ]),
    ]),
    filterRow,
    host,
  ]));
  loading(host, '正在取回待审商品…');

  let data;
  try {
    data = await fetchList({ reviewStatus: active, page });
  } catch (e) {
    host.innerHTML = '';
    if (isKeyRejected(e)) {
      clearAdminIdentity();
      paint();
      toast(`无法访问：${(e && e.message) || '密钥无效'}`, 'warn');
      return;
    }
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, '没有取到商品'),
      el('p', {}, (e && e.message) || '请稍后重试'),
      el('button', { class: 'adm-line-btn', type: 'button', onclick: paint }, '重试'),
    ]));
    return;
  }

  const counts = (data && data.counts) || {};
  // 计数徽标直接写进筛选条：运营最关心「还剩几件没审」
  filterRow.querySelectorAll('.mzr-filter').forEach((a, i) => {
    const code = FILTERS[i].code;
    const n = code === 'all' ? counts.all : counts[code];
    if (n != null) a.textContent = `${FILTERS[i].label} ${n}`;
  });

  host.innerHTML = '';
  const list = (data && data.items) || [];
  if (!list.length) {
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, active === 'pending' ? '没有待审核的商品' : '这一类暂时没有商品'),
      el('p', {}, active === 'pending'
        ? '商家新增商品后会出现在这里。通过之后它会立即出现在商城的类目与搜索里。'
        : '换个筛选条件看看。'),
    ]));
    return;
  }

  list.forEach((p) => host.appendChild(productCard(p, { reload: paint })));

  if ((data.total || 0) > PAGE_SIZE) {
    const pages = Math.ceil(data.total / PAGE_SIZE);
    host.appendChild(el('div', { class: 'mzr-pager' }, [
      el('a', {
        class: `mzr-page${page <= 1 ? ' is-off' : ''}`,
        href: `#/admin/products?reviewStatus=${active}&page=${Math.max(1, page - 1)}`,
      }, '← 上一页'),
      el('span', { class: 'mzr-page-num' }, `${page} / ${pages}`),
      el('a', {
        class: `mzr-page${page >= pages ? ' is-off' : ''}`,
        href: `#/admin/products?reviewStatus=${active}&page=${Math.min(pages, page + 1)}`,
      }, '下一页 →'),
    ]));
  }
}
