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
import { api, mediaUrl } from './api.js';
import { el, fmtPrice, loading, openModal, toast } from './ui.js';
import { navigate } from './router.js';
import {
  adminHeaders,
  adminKeyGate,
  adminTabs,
  clearAdminIdentity,
  isKeyRejected,
  readAdminActor,
  readAdminKey,
  writeAdminKey,
} from './adminShared.js';
import { AFTERSALE_STATUS_TEXT, REFUNDABLE_TYPES } from './store/aftersaleStore.js';

const PAGE_SIZE = 20;

// 不给筛选参数时默认停在「待处理」：运营打开审核台是想处理事情，
// 不是想看历史。要看全部得显式点一下（带 status=all，避免与「没带参数」混淆）。
const FILTERS = [
  { code: 'reviewing', label: '待处理' },
  { code: 'done', label: '处理记录' },
  { code: 'approved', label: '已同意' },
  { code: 'rejected', label: '已驳回' },
  { code: 'all', label: '全部' },
];
const DEFAULT_FILTER = 'reviewing';

/**
 * 钥匙门同时收「管理密钥」和「操作人」，与商家审核台共用同一组凭据
 * （同一班人、同一把钥匙，切台子不该让人重输）。
 */
function keyGate(repaint) {
  return adminKeyGate({
    title: '售后审核台',
    sub: '这一页不属于买家路径，进入需要服务端的管理密钥。',
    hint: [
      '密钥取服务端环境变量 ADMIN_API_KEY。两个值都只存在当前标签页，关闭即失效。',
      el('br', {}),
      '操作人会写进处理记录。它是自报的，服务端另外按钥匙本身记了指纹：',
      '名字方便人读，真正能追责的是指纹。',
    ],
    onPass: repaint,
  });
}

function fmtDate(iso) {
  const s = String(iso || '');
  return s ? s.slice(0, 16).replace('T', ' ') : '';
}

/* ============================================================
   取数
   ============================================================ */

async function fetchList({ status, reviewed, page }) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  // 「处理记录」= 所有已处理的，不带 status 只带 reviewed=1
  if (reviewed) qs.set('reviewed', '1');
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

/**
 * 凭证缩略图：有 url 的渲染成图（点击放大），只有文件名的退回文字。
 * 旧工单没有对象键，是升级前提交的——当时确实没传图，不假装有。
 */
function evidenceStrip(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const kids = list.map((f) => (f && f.url
    ? el('button', {
      class: 'adm-ev-thumb',
      type: 'button',
      'aria-label': `查看凭证 ${f.name || ''}`,
      onclick: () => openModal((modal, close) => {
        const wrap = el('div', { class: 'adm-ev-view' }, [
          el('img', { src: mediaUrl(f.url), alt: f.name || '凭证' }),
          el('p', { class: 'adm-ev-name' }, f.name || ''),
          el('div', { class: 'as-actions' }, [
            el('button', { class: 'adm-line-btn', type: 'button', onclick: close }, '关闭'),
          ]),
        ]);
        modal.appendChild(wrap);
      }),
    }, el('img', { src: mediaUrl(f.url), alt: '' }))
    : el('span', { class: 'adm-ev-tag' }, f.name || '凭证')));
  return el('div', { class: 'adm-ev-strip' }, kids);
}

/**
 * 打款状态条：只有退款类且已同意才出现。
 * 承诺（审核同意退款 ¥N）与事实（钱出去了）在账本上是两条记录，界面上也分开。
 */
function payoutBlock(record, reload) {
  if (!REFUNDABLE_TYPES.includes(record.type) || record.refundAmount == null) return null;
  const payout = record.payout;
  const amount = payout ? payout.amount : record.refundAmount;

  if (payout && payout.status === 'settled') {
    return el('div', { class: 'adm-payout is-settled' }, [
      el('span', {}, `打款 ${fmtPrice(amount)} · 已确认`),
      payout.settledAt ? el('span', { class: 'adm-payout-meta' }, fmtDate(payout.settledAt)) : null,
    ]);
  }

  const btn = el('button', {
    class: 'adm-line-btn',
    type: 'button',
    onclick: async () => {
      if (!payout || !payout.ledgerId) return;
      btn.disabled = true;
      btn.textContent = '确认中…';
      try {
        await api(`/api/ledger/refunds/${encodeURIComponent(payout.ledgerId)}/settle`, {
          method: 'POST',
          headers: adminHeaders(),
          retries: 0,
        });
        toast('已确认打款', 'ok');
        reload();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '确认已打款';
        toast((e && e.message) || '操作失败，请重试', 'warn');
      }
    },
  }, '确认已打款');

  return el('div', { class: 'adm-payout is-pending' }, [
    el('span', {}, `打款 ${fmtPrice(amount)} · 待打款`),
    btn,
  ]);
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
    evidenceStrip(record.evidence),
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
    bits.push(fmtDate(record.reviewedAt));
    // 处理人没记到就是真的没有：老数据在审核功能上线前就处理完了，
    // 显示一条「—」好过显示一个编出来的名字
    bits.push(`处理人 ${record.reviewer || '—'}`);
    children.push(el('div', { class: 'adm-verdict' }, [
      el('span', { class: 'adm-verdict-main' }, bits.filter(Boolean).join(' · ')),
      record.reviewNote ? el('span', { class: 'adm-verdict-note' }, `意见：${record.reviewNote}`) : null,
    ]));
    // 打款确认挂在同意卡片的底部：审核是承诺「该退」，打款是事实「退了」，
    // 两件事在账本上分两条记录，界面上也分开两行。
    const payout = payoutBlock(record, reload);
    if (payout) children.push(payout);
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

/**
 * 顶部总览。
 * 数字是**全库**的，不跟着筛选变：切到「已驳回」时总数跟着缩水只会让人怀疑
 * 是不是漏看了。切标签是换视角，不是换账本。
 */
function summaryRow(data) {
  const s = (data && data.summary) || {};
  const bits = [
    // 说「当前」而不是「共」：旁边三个胶囊加起来是全库的数字，
    // 写「共 2 条」会让人以为漏看了——当前视图 2 条、全库 3 条，两件事
    el('span', { class: 'adm-sum-count num' }, `当前 ${data.total} 条`),
    el('span', { class: 'adm-chip is-reviewing' }, `待处理 ${s.reviewing ?? 0}`),
    el('span', { class: 'adm-chip' }, `已同意 ${s.approved ?? 0}`),
    el('span', { class: 'adm-chip' }, `已驳回 ${s.rejected ?? 0}`),
  ];
  // 一笔都没退过时不显示金额：一个孤零零的 ¥0.00 只是占位噪音
  if (s.refundCount) {
    bits.push(el('span', { class: 'adm-sum-money' }, [
      '退款合计 ',
      el('b', { class: 'num' }, fmtPrice(s.refundTotal || 0)),
      `（${s.refundCount} 笔）`,
    ]));
  }
  return el('div', { class: 'adm-summary' }, bits);
}

/* ============================================================
   页面
   ============================================================ */

export async function renderAdminAftersales(view, query = {}) {
  const active = FILTERS.some((f) => f.code === query.status) ? query.status : DEFAULT_FILTER;
  const isDone = active === 'done';
  // 发给服务端的条件：「全部」不带 status；「处理记录」不带 status 只带 reviewed=1
  const status = active === 'all' || isDone ? '' : active;
  const reviewed = isDone;
  const page = Math.max(1, Number(query.page) || 1);

  const paint = () => renderAdminAftersales(view, query);

  // 钥匙或操作人缺一样都回钥匙门：只有钥匙的话，处理记录里全是无署名操作
  if (!readAdminKey() || !readAdminActor()) {
    view.innerHTML = '';
    view.appendChild(keyGate(paint));
    return;
  }

  view.innerHTML = '';
  const host = el('div', { class: 'adm-host' });
  view.appendChild(el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    adminTabs('aftersales'),
    el('div', { class: 'adm-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'AFTER-SALES CONSOLE'),
        el('h1', { class: 'adm-title' }, '售后审核台'),
        el('span', { class: 'adm-actor' }, `操作人 ${readAdminActor()}`),
      ]),
      el('button', {
        class: 'adm-line-btn',
        type: 'button',
        onclick: () => {
          clearAdminIdentity();
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
    data = await fetchList({ status, reviewed, page });
  } catch (e) {
    host.innerHTML = '';
    if (isKeyRejected(e)) {
      // 钥匙被拒：留在这一页没有意义，直接退回钥匙门，并把失效的钥匙清掉，
      // 否则会在「钥匙门 → 列表 → 401 → 钥匙门」之间来回弹。
      writeAdminKey('');
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
    const [title, desc] = isDone
      ? ['还没有处理记录', '处理过的工单会出现在这里，按处理时间倒序。']
      : [
        '这一类暂时没有工单',
        active === 'reviewing' ? '待处理的都处理完了。' : '用户提交售后申请后会出现在这里。',
      ];
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, title),
      el('p', {}, desc),
    ]));
    return;
  }

  host.appendChild(summaryRow(data));
  list.forEach((r) => host.appendChild(recordCard(r, { reload: paint })));
  const p = pager(page, data.size || PAGE_SIZE, data.total, active);
  if (p) host.appendChild(p);
}
