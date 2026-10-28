// 运营侧售后审核台（#/admin/aftersales）。
//
// 与前台分开的三个理由：
//   1) 它要 X-Admin-Key，而前台所有接口用的都是用户会话令牌，混在一个页面里
//      会让「这次请求到底以谁的身份发出去」变得不可判断；
//   2) 不进登录守卫——运营账号与买家账号是两拨人，要求先登录买家账号才能进审核台
//      本身就是错的门禁；
//   3) 钥匙存 sessionStorage 而不是 localStorage：写进 localStorage 的凭据会一直躺在
//      硬盘上，谁打开这台电脑谁就是管理员。关掉标签页即失效。
//
// 审核动作直接改订单状态（退款入终态、换货重发货、驳回退回去），
// 所以每次操作后整页重新拉一次列表，不局部改那一张卡片——
// 卡片上显示的订单状态是从工单里带的，改完不重载会显示旧的。
import { api } from './api.js';
import { el, fmtPrice, loading, openModal, toast } from './ui.js';
import { navigate } from './router.js';
import { AFTERSALE_STATUS_TEXT, REFUNDABLE_TYPES } from './store/aftersaleStore.js';

const KEY_SLOT = 'maison_admin_key';
const PAGE_SIZE = 20;

// 不给筛选参数时默认停在「待处理」：运营打开审核台是想处理事情，
// 不是想看历史。要看全部得显式点一下（带 status=all，避免与「没带参数」混淆）。
const FILTERS = [
  { code: 'all', label: '全部' },
  { code: 'reviewing', label: '待处理' },
  { code: 'approved', label: '已同意' },
  { code: 'rejected', label: '已驳回' },
];
const DEFAULT_FILTER = 'reviewing';

function readKey() {
  try {
    return sessionStorage.getItem(KEY_SLOT) || '';
  } catch {
    return '';
  }
}

function writeKey(v) {
  try {
    if (v) sessionStorage.setItem(KEY_SLOT, v);
    else sessionStorage.removeItem(KEY_SLOT);
  } catch {
    /* 隐私模式下写不了：钥匙只活在当前页面内存里，这一次能用就行 */
  }
}

function adminHeaders() {
  return { 'X-Admin-Key': readKey(), 'X-Admin-Actor': 'ops-console' };
}

function fmtDate(iso) {
  const s = String(iso || '');
  return s ? s.slice(0, 16).replace('T', ' ') : '';
}

/** 401 / 403 都当作「钥匙不对或没启用」：两者对运营都是同一件事——拿不到列表 */
function isKeyRejected(e) {
  return e && (e.status === 401 || e.status === 403);
}

/* ============================================================
   取数
   ============================================================ */

async function fetchList({ status, page }) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  qs.set('page', String(page));
  qs.set('size', String(PAGE_SIZE));
  return api(`/api/aftersales?${qs}`, { headers: adminHeaders(), retries: 0 });
}

async function submitReview(id, payload) {
  return api(`/api/aftersales/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: payload,
    retries: 0,
  });
}

/* ============================================================
   钥匙门
   ============================================================ */

function keyGate(repaint) {
  const input = el('input', {
    class: 'adm-key-input',
    type: 'password',
    placeholder: 'ADMIN_API_KEY',
    'aria-label': '管理员密钥',
  });
  const err = el('p', { class: 'adm-error', role: 'alert' });

  const form = el('form', { class: 'adm-key-form' }, [
    el('h1', { class: 'adm-title' }, '售后审核台'),
    el('p', { class: 'adm-sub' }, '这一页不属于买家路径，进入需要服务端的管理密钥。'),
    input,
    err,
    el('div', { class: 'adm-actions' }, [
      el('button', { class: 'adm-btn', type: 'submit' }, '进入'),
    ]),
    el('p', { class: 'adm-hint' }, [
      '密钥取服务端环境变量 ADMIN_API_KEY；它只存在当前标签页，关闭即失效。',
      el('br', {}),
      '服务端未配置该变量时，这一页无法使用——写接口的默认姿态是关闭的。',
    ]),
  ]);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    if (!v) {
      err.textContent = '请输入管理密钥';
      return;
    }
    writeKey(v);
    repaint();
  });

  return el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    el('div', { class: 'adm-key-card' }, [form]),
  ]);
}

/* ============================================================
   审核弹层
   ============================================================ */

/**
 * 同意 / 驳回共用弹层。
 * 换货不显示退款金额：换的是货不是钱，摆一个金额输入框会诱导填出一个不存在的退款。
 * 驳回的理由是必填的：用户看到「已驳回」需要知道为什么，否则下一通投诉就来了。
 */
function openReviewSheet({ record, action, onDone }) {
  openModal((modal, close) => {
    modal.classList.add('is-narrow');
    const refundable = REFUNDABLE_TYPES.includes(record.type);

    const amountInput = el('input', {
      class: 'as-amount num',
      type: 'number',
      step: '0.01',
      min: '0',
      value: String(record.orderTotal ?? 0),
      'aria-label': '退款金额',
    });
    const noteArea = el('textarea', {
      class: 'as-note',
      rows: '3',
      maxlength: '200',
      placeholder: action === 'approve' ? '给用户的处理说明（选填）' : '驳回理由（必填，会展示给用户）',
    });
    const err = el('p', { class: 'as-error', role: 'alert' });
    const okBtn = el('button', {
      class: action === 'approve' ? 'od-main-btn as-submit' : 'od-line-btn as-submit',
      type: 'submit',
    }, action === 'approve' ? '确认同意' : '确认驳回');

    const fields = [
      el('h2', { class: 'as-title' }, action === 'approve' ? '同意这条售后申请' : '驳回这条售后申请'),
      el('p', { class: 'as-sub' }, `${record.id} · ${record.typeLabel} · ${record.reasonLabel}`),
    ];
    if (action === 'approve' && refundable) {
      fields.push(
        el('label', { class: 'as-label' }, '退款金额'),
        amountInput,
        el('p', { class: 'as-hint' }, `订单实付 ${fmtPrice(record.orderTotal)}，最多只能退到这个数。`),
      );
    }
    if (action === 'approve' && !refundable) {
      fields.push(el('p', { class: 'as-hint' }, '换货不产生退款，同意后订单将重新进入发货流程。'));
    }
    fields.push(
      el('label', { class: 'as-label' }, action === 'approve' ? '处理说明' : '驳回理由'),
      noteArea,
      err,
      el('div', { class: 'as-actions' }, [
        okBtn,
        el('button', { class: 'od-line-btn', type: 'button', onclick: close }, '取消'),
      ]),
    );

    const form = el('form', { class: 'as-form' }, fields);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err.textContent = '';
      const note = noteArea.value.trim();
      if (action === 'reject' && !note) {
        err.textContent = '驳回必须填写理由';
        return;
      }
      const payload = { action, note };
      if (action === 'approve' && refundable) {
        const amount = Number(amountInput.value);
        if (!Number.isFinite(amount) || amount < 0) {
          err.textContent = '退款金额不合法';
          return;
        }
        payload.refundAmount = amount;
      }
      okBtn.disabled = true;
      okBtn.textContent = '提交中…';
      try {
        const d = await submitReview(record.id, payload);
        close();
        toast(action === 'approve' ? '已同意，订单状态已更新' : '已驳回，订单已退回原状态', 'ok');
        onDone(d && d.aftersale);
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = action === 'approve' ? '确认同意' : '确认驳回';
        err.textContent = (e && e.message) || '操作失败，请重试';
      }
    });

    modal.appendChild(form);
  });
}

/* ============================================================
   列表
   ============================================================ */

/** 筛选：走路由而不是局部状态，刷新/前进后退都停在同一类工单上 */
function filterRow(active) {
  return el('div', { class: 'adm-filters' }, FILTERS.map((f) => el('button', {
    class: `adm-filter${f.code === active ? ' is-on' : ''}`,
    type: 'button',
    'data-filter': f.code,
    onclick: () => navigate(`#/admin/aftersales?status=${f.code}`),
  }, f.label)));
}

function statusPill(status) {
  return el('span', { class: `adm-status s-${status}` },
    AFTERSALE_STATUS_TEXT[status] || status || '—');
}

function recordCard(record, { reload }) {
  const children = [
    el('div', { class: 'adm-card-head' }, [
      el('div', {}, [
        el('span', { class: 'adm-as-id num' }, record.id),
        el('span', { class: 'adm-order-id num' }, `订单 ${record.orderId}`),
      ]),
      statusPill(record.status),
    ]),
    el('div', { class: 'adm-goods' }, [
      el('span', { class: 'adm-goods-name' }, (record.items || []).map((i) => i.name).join('、') || '商品'),
      el('span', { class: 'adm-goods-meta' }, `${record.itemCount} 件 · 实付 ${fmtPrice(record.orderTotal)}`),
    ]),
    el('div', { class: 'adm-reason' }, [
      el('span', { class: 'adm-type' }, record.typeLabel),
      el('span', {}, record.reasonLabel),
    ]),
    record.note ? el('p', { class: 'adm-note' }, record.note) : null,
    record.evidence && record.evidence.length
      ? el('p', { class: 'adm-ev' }, `凭证 ${record.evidence.length} 份：${record.evidence.map((f) => f.name).join('、')}`)
      : null,
    el('p', { class: 'adm-meta' }, `提交于 ${fmtDate(record.createdAt)}`),
  ];

  if (record.status === 'reviewing') {
    children.push(el('div', { class: 'adm-actions' }, [
      el('button', {
        class: 'adm-btn',
        type: 'button',
        onclick: () => openReviewSheet({
          record,
          action: 'approve',
          onDone: () => reload(),
        }),
      }, '同意'),
      el('button', {
        class: 'adm-line-btn',
        type: 'button',
        onclick: () => openReviewSheet({
          record,
          action: 'reject',
          onDone: () => reload(),
        }),
      }, '驳回'),
    ]));
  } else {
    const bits = [record.statusLabel];
    if (REFUNDABLE_TYPES.includes(record.type) && record.refundAmount != null) {
      bits.push(`退款 ${fmtPrice(record.refundAmount)}`);
    }
    bits.push(`${fmtDate(record.reviewedAt)}`);
    children.push(el('div', { class: 'adm-verdict' }, [
      el('span', { class: 'adm-verdict-main' }, bits.filter(Boolean).join(' · ')),
      record.reviewNote ? el('span', { class: 'adm-verdict-note' }, `意见：${record.reviewNote}`) : null,
    ]));
  }

  return el('article', { class: `adm-card is-${record.status}`, 'data-aftersale': record.id }, children);
}

function pager(page, size, total, active) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  // status 一律写进 URL：省略它会被当成「没筛选」而落回默认的待处理，
  // 在「全部」里翻第二页就莫名其妙只剩待处理了。
  const go = (p) => navigate(`#/admin/aftersales?status=${active}&page=${p}`);
  return el('div', { class: 'adm-pager' }, [
    el('button', {
      class: 'adm-line-btn',
      type: 'button',
      disabled: page <= 1,
      onclick: () => go(page - 1),
    }, '上一页'),
    el('span', { class: 'adm-pager-info num' }, `${page} / ${pages}`),
    el('button', {
      class: 'adm-line-btn',
      type: 'button',
      disabled: page >= pages,
      onclick: () => go(page + 1),
    }, '下一页'),
  ]);
}

/* ============================================================
   页面
   ============================================================ */

export async function renderAdminAftersales(view, query = {}) {
  const active = FILTERS.some((f) => f.code === query.status) ? query.status : DEFAULT_FILTER;
  // 发给服务端的筛选值：「全部」不带 status，其余原样
  const status = active === 'all' ? '' : active;
  const page = Math.max(1, Number(query.page) || 1);

  const paint = () => renderAdminAftersales(view, query);

  if (!readKey()) {
    view.innerHTML = '';
    view.appendChild(keyGate(paint));
    return;
  }

  view.innerHTML = '';
  const host = el('div', { class: 'adm-host' });
  view.appendChild(el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    el('div', { class: 'adm-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'AFTER-SALES CONSOLE'),
        el('h1', { class: 'adm-title' }, '售后审核台'),
      ]),
      el('button', {
        class: 'adm-line-btn',
        type: 'button',
        onclick: () => {
          writeKey('');
          paint();
        },
      }, '退出'),
    ]),
    filterRow(active),
    host,
  ]));
  loading(host, '正在取回工单…');

  let data;
  try {
    data = await fetchList({ status, page });
  } catch (e) {
    host.innerHTML = '';
    if (isKeyRejected(e)) {
      // 钥匙被拒：留在这一页没有意义，直接退回钥匙门，并把失效的钥匙清掉，
      // 否则会在「钥匙门 → 列表 → 401 → 钥匙门」之间来回弹。
      writeKey('');
      paint();
      toast(`无法访问：${(e && e.message) || '密钥无效'}`, 'warn');
      return;
    }
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, '没有取到工单'),
      el('p', {}, (e && e.message) || '请稍后重试'),
      el('button', { class: 'adm-line-btn', type: 'button', onclick: paint }, '重试'),
    ]));
    return;
  }

  host.innerHTML = '';
  const list = (data && data.items) || [];
  if (!list.length) {
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, status ? '这一类暂时没有工单' : '还没有售后工单'),
      el('p', {}, status === 'reviewing' ? '待处理的都处理完了。' : '用户提交售后申请后会出现在这里。'),
    ]));
    return;
  }

  host.appendChild(el('div', { class: 'adm-summary' }, `共 ${data.total} 条`));
  list.forEach((r) => host.appendChild(recordCard(r, { reload: paint })));
  const p = pager(page, data.size || PAGE_SIZE, data.total, active);
  if (p) host.appendChild(p);
}
