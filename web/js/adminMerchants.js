// 运营侧商家入驻审核台（#/admin/merchants）。
//
// 与售后审核台同构（同一个钥匙、同一个署名、同一套卡片语言），但审的东西完全不同：
// 售后台审的是「钱退不退」，这里审的是「这家能不能进平台」。
// 因此这一页要呈现的是**判断依据**——主体、信用代码、品牌来源、类目、价格带、
// 结算账户、售后承诺——而不是一段用户描述。
//
// 三条页面级约定：
//   1) 默认停在「待审核」：打开审核台是想处理事情，不是看历史（与售后台一致）；
//   2) 筛选走路由，刷新/前进后退都停在同一个视角；
//   3) 审完不局部改卡片，整页重拉：卡片上的状态、通知状态、计数徽标都要跟着变，
//      局部改一处一定会漏改另一处。
import { api, apiBase } from './api.js';
import { el, loading, openModal, toast } from './ui.js';
import { navigate } from './router.js';
import {
  adminHeaders,
  adminKeyGate,
  adminTabs,
  clearAdminIdentity,
  fmtStamp,
  isKeyRejected,
  readAdminActor,
  readAdminKey,
} from './adminShared.js';
import { FORM_CATEGORIES } from './merchant.js';

const PAGE_SIZE = 20;

const FILTERS = [
  { code: 'reviewing', label: '待审核' },
  { code: 'approved', label: '已通过' },
  { code: 'rejected', label: '未通过' },
  { code: 'withdrawn', label: '已撤回' },
  { code: 'all', label: '全部' },
];
const DEFAULT_FILTER = 'reviewing';

const STATUS_TEXT = { reviewing: '待审核', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
// 材料类型标签：运营看「有没有这份东西」，不看文件名后缀
const MATERIAL_LABEL = { license: '营业执照', brand_auth: '品牌授权', inspection: '质检报告', other: '其他材料' };
const ENTITY_LABEL = {
  brand: '原创品牌',
  factory: '源头工厂',
  studio: '设计师工作室',
  food: '食品产地',
  other: '其他',
};
const BRAND_SOURCE_LABEL = { owned: '自有品牌', exclusive: '独家代理', authorized: '授权代理' };
const SKU_LABEL = { lt50: '50 以内', '50-200': '50–200', '200-1000': '200–1000', gt1000: '1000 以上' };
const PRICE_LABEL = { lt100: '100 元以内', '100-500': '100–500 元', '500-2000': '500–2000 元', gt2000: '2000 元以上' };
const RETURN_LABEL = { '7days': '7 天无理由', '15days': '15 天无理由' };
const SHIP_LABEL = { '24h': '24 小时内', '48h': '48 小时内', '72h': '72 小时内' };
const CATEGORY_LABEL = new Map(FORM_CATEGORIES.map((c) => [c.id, c.t]));

const labelOf = (map, key, fallback = '—') => map[key] || fallback;
const catNames = (list) => (Array.isArray(list) ? list.map((id) => CATEGORY_LABEL.get(id) || id) : []);

/* ============================================================
   取数
   ============================================================ */

async function fetchList({ status, page }) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  qs.set('page', String(page));
  qs.set('size', String(PAGE_SIZE));
  return api(`/api/merchant/applications?${qs}`, { headers: adminHeaders(), retries: 0 });
}

async function fetchNoticeStats() {
  return api('/api/merchant/notices/stats', { headers: adminHeaders(), retries: 0 });
}

async function submitReview(id, payload) {
  return api(`/api/merchant/applications/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: adminHeaders(),
    body: payload,
    retries: 0,
  });
}

async function flushNotices() {
  return api('/api/merchant/notices/flush', { method: 'POST', headers: adminHeaders(), retries: 0 });
}

/**
 * 导出 CSV。
 *
 * 这里不能用 api()：它按 JSON 解析响应，而导出返回的是文件流。
 * 走原生 fetch + blob 下载，但**必须自己带管理密钥**——用 <a href> 直接链过去
 * 是最省事的写法，代价是把密钥拼进 URL：它会留在浏览器历史、被中间层的访问日志
 * 原样记下（查询串不脱敏），而密钥正是这个后台唯一的门。
 */
async function downloadCsv(status) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  const resp = await fetch(`${apiBase}/api/merchant/applications/export${qs.toString() ? `?${qs}` : ''}`, {
    headers: adminHeaders(),
  });
  if (!resp.ok) {
    let msg = `导出失败（${resp.status}）`;
    try {
      const d = await resp.json();
      if (d && d.error) msg = d.error;
    } catch { /* 非 JSON 错误体 */ }
    throw Object.assign(new Error(msg), { status: resp.status });
  }
  const blob = await resp.blob();
  // 文件名从 Content-Disposition 里取（服务端已按 RFC 5987 编好中文）
  const cd = resp.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : 'merchant-applications.csv');

  const href = URL.createObjectURL(blob);
  const a = el('a', { href, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器下载中断，留一拍再释放
  setTimeout(() => URL.revokeObjectURL(href), 4000);

  return {
    count: Number(resp.headers.get('x-export-count') || 0),
    total: Number(resp.headers.get('x-export-total') || 0),
    truncated: resp.headers.get('x-export-truncated') === '1',
    name,
  };
}

/* ============================================================
   钥匙门
   ============================================================ */

function keyGate(repaint) {
  return adminKeyGate({
    title: '商家入驻审核台',
    sub: '这一页不属于买家路径，也不属于商家路径，进入需要服务端的管理密钥。',
    hint: [
      '与售后审核台共用同一把钥匙和同一个署名，在那边登过就不用再登一次。',
      el('br', {}),
      '商家在审核期间可以自己改资料或撤回：卡片上出现「商家修改过 N 次」时，',
      '按最新一版重新看一遍再下结论——你手里的判断依据可能已经变过了。',
      el('br', {}),
      '审核是终态动作：通过或驳回之后不能再改。要反悔得走运营流程，页面不给第二次机会——',
      '「点错了再点一次」在审核这种场景里不是便利，是风险。',
    ],
    onPass: repaint,
  });
}

/* ============================================================
   审核弹层
   ============================================================ */

/**
 * 通过与驳回共用一个弹层。
 *
 * 驳回的理由必填，且会原样进入给商家的通知正文与状态页——
 * 商家看到「未通过」而不知道为什么，下一通就是咨询；理由里也正该写清「补什么能再交」。
 * 通过时备注选填：多数申请没什么可说的，强制写一句只会逼出「同意」两个字。
 */
function openReviewSheet({ record, action, onDone }) {
  openModal((modal, close) => {
    modal.classList.add('is-narrow');
    const isApprove = action === 'approve';
    const textarea = el('textarea', {
      class: 'as-note',
      rows: '3',
      maxlength: '200',
      placeholder: isApprove ? '给商家的说明（选填）' : '驳回理由（必填，会展示给商家并进入通知）',
    });
    const err = el('p', { class: 'as-error', role: 'alert' });
    const okBtn = el('button', {
      class: isApprove ? 'od-main-btn as-submit' : 'od-line-btn as-submit',
      type: 'submit',
    }, isApprove ? '确认通过' : '确认驳回');

    const fields = [
      el('h2', { class: 'as-title' }, isApprove ? '通过这份入驻申请' : '驳回这份入驻申请'),
      el('p', { class: 'as-sub' }, `${record.id} · ${record.company} · ${record.brand}`),
    ];
    if (isApprove) {
      fields.push(el('p', { class: 'as-hint' },
        '通过后商家会在原查询链接看到结果；系统同时把「已通过」的通知排进出站队列，'
        + '由后台投递（通道未配置时只会如实标注，不会假装发送）。'));
    } else {
      fields.push(el('p', { class: 'as-hint' },
        '驳回理由会原样发给商家。写清缺什么材料，比一句「资质不符」有用得多。'));
    }
    fields.push(
      el('label', { class: 'as-label' }, isApprove ? '审核说明' : '驳回理由'),
      textarea,
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
      const note = textarea.value.trim();
      if (!isApprove && !note) {
        err.textContent = '驳回必须填写理由';
        textarea.focus();
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = '提交中…';
      try {
        const d = await submitReview(record.id, { action, note });
        close();
        toast(isApprove ? '已通过，通知已排队' : '已驳回，通知已排队', 'ok');
        onDone(d && d.application);
      } catch (e) {
        okBtn.disabled = false;
        okBtn.textContent = isApprove ? '确认通过' : '确认驳回';
        err.textContent = (e && e.message) || '操作失败，请重试';
      }
    });

    modal.appendChild(form);
  });
}

/* ============================================================
   卡片
   ============================================================ */

function fact(dt, dd) {
  return el('div', { class: 'mzr-fact' }, [el('dt', {}, dt), el('dd', {}, dd || '—')]);
}

/**
 * 主体资质与经营方案。故意不折叠：审核要一眼看完，
 * 藏在「展开更多」里等于每次都要多点一下，还会漏看。
 */
function factsBlock(r) {
  return el('dl', { class: 'mzr-facts' }, [
    fact('信用代码', el('span', { class: 'num' }, r.creditCode)),
    fact('主体类型', labelOf(ENTITY_LABEL, r.entityKind, r.entityKind)),
    fact('联系人', `${r.contact} · ${r.phone}`),
    fact('邮箱', r.email || '未填'),
    fact('主营类目', catNames(r.categories).join('、')),
    fact('品牌来源', labelOf(BRAND_SOURCE_LABEL, r.brandSource, r.brandSource)),
    fact('预估 SKU', labelOf(SKU_LABEL, r.skuRange)),
    fact('主力价格带', labelOf(PRICE_LABEL, r.priceRange)),
    fact('开户名', r.bankAccount),
    fact('开户行', r.bankBranch || '未填'),
    // 库里本来就只有前 4 后 4：完整卡号从来没进过服务端存储
    fact('结算账号', el('span', { class: 'num' }, r.bankNoMasked || '—')),
    fact('售后承诺', `${labelOf(RETURN_LABEL, r.returnPolicy)} · ${labelOf(SHIP_LABEL, r.shipWithin)}发货`),
    fact('资质材料', materialsLine(r.materials)),
  ]);
}

/**
 * 材料清单：只显示清单（类型），因为线上本来就没收文件本体；文件名放 title 里。
 * 一份都没有时写「未提交」而不是留空——审核结论常常就卡在这一项上。
 */
function materialsLine(materials) {
  const list = Array.isArray(materials) ? materials : [];
  if (!list.length) return el('span', { class: 'mzr-mat-none' }, '未提交');
  return el('span', { class: 'mzr-mats' }, list.map((m) =>
    el('span', { class: 'mzr-mat', title: m.name }, MATERIAL_LABEL[m.kind] || m.kind)));
}

function noticeLine(notices) {
  if (!Array.isArray(notices) || !notices.length) return null;
  return el('p', { class: 'mzr-notices' }, [
    el('span', { class: 'mzr-notices-label' }, '结果通知'),
    ...notices.map((n) => el('span', {
      class: `mzr-notice is-${n.status}`,
      title: n.lastError || '',
    }, `${n.channelLabel} · ${n.statusLabel}${n.targetMasked ? ` · ${n.targetMasked}` : ''}`)),
  ]);
}

function recordCard(r, { reload }) {
  const kids = [
    el('div', { class: 'adm-card-head' }, [
      el('div', {}, [
        el('span', { class: 'adm-as-id num' }, r.id),
        el('span', { class: 'adm-order-id' }, labelOf(ENTITY_LABEL, r.entityKind, r.entityKind)),
      ]),
      el('span', { class: `adm-status s-${r.status}` }, STATUS_TEXT[r.status] || r.status),
    ]),
    el('div', { class: 'mzr-title' }, [
      el('strong', {}, r.company),
      el('span', {}, `品牌 ${r.brand}`),
    ]),
    // 提交后改过资料是个强信号：审核前值得重新看一遍，别拿着旧数据下结论。
    // 所以放在标题下面（第一屏），而不是塞进卡片底部的小字里
    r.revisionCount
      ? el('p', { class: 'mzr-revised' }, [
        el('span', { class: 'mzr-revised-badge' }, `商家修改过 ${r.revisionCount} 次`),
        el('span', {}, `最后 ${fmtStamp(r.lastRevisedAt)}`),
      ])
      : null,
    factsBlock(r),
    r.note ? el('p', { class: 'adm-note' }, `商家备注：${r.note}`) : null,
    r.dropship ? el('p', { class: 'mzr-flag' }, '支持一件代发') : null,
    el('p', { class: 'adm-meta' }, `提交于 ${fmtStamp(r.createdAt)}`),
  ];

  if (r.status === 'reviewing') {
    kids.push(el('div', { class: 'adm-actions' }, [
      el('button', {
        class: 'adm-btn',
        type: 'button',
        onclick: () => openReviewSheet({ record: r, action: 'approve', onDone: () => reload() }),
      }, '通过'),
      el('button', {
        class: 'adm-line-btn',
        type: 'button',
        onclick: () => openReviewSheet({ record: r, action: 'reject', onDone: () => reload() }),
      }, '驳回'),
    ]));
  } else if (r.status === 'withdrawn') {
    // 撤回没有「处理人」：是商家自己停下的，写成「处理人 —」会让人以为运营漏了操作
    kids.push(el('div', { class: 'adm-verdict' }, [
      el('span', { class: 'adm-verdict-main' }, `商家撤回 · ${fmtStamp(r.withdrawnAt)}`),
      el('span', { class: 'adm-verdict-note' }, '这份资料不再进入审核；想入驻需要重新提交'),
    ]));
  } else {
    const bits = [
      STATUS_TEXT[r.status] || r.status,
      `处理人 ${r.reviewedBy || '—'}`,
      fmtStamp(r.reviewedAt),
    ];
    kids.push(el('div', { class: 'adm-verdict' }, [
      el('span', { class: 'adm-verdict-main' }, bits.filter(Boolean).join(' · ')),
      r.reviewNote ? el('span', { class: 'adm-verdict-note' }, `意见：${r.reviewNote}`) : null,
    ]));
  }

  const line = noticeLine(r.notices);
  if (line) kids.push(line);

  return el('article', { class: `adm-card is-${r.status}`, 'data-application': r.id }, kids.filter(Boolean));
}

/* ============================================================
   列表
   ============================================================ */

function filterRow(active) {
  return el('div', { class: 'adm-filters' }, FILTERS.map((f) => el('button', {
    class: `adm-filter${f.code === active ? ' is-on' : ''}`,
    type: 'button',
    'data-filter': f.code,
    onclick: () => navigate(`#/admin/merchants?status=${f.code}`),
  }, f.label)));
}

/**
 * 顶部总览。
 * 数量是全库的，不跟着筛选变（切视角不是换账本）；
 * 通知队列单列一行：审核结论已经落库但通知没出去，是两件事，不能混成一个数字。
 */
function summaryRow(data, notices) {
  const s = (data && data.stats) || {};
  const kids = [
    el('span', { class: 'adm-sum-count num' }, `当前 ${data.total} 条`),
    el('span', { class: 'adm-chip is-reviewing' }, `待审核 ${s.reviewing ?? 0}`),
    el('span', { class: 'adm-chip' }, `已通过 ${s.approved ?? 0}`),
    el('span', { class: 'adm-chip' }, `未通过 ${s.rejected ?? 0}`),
    el('span', { class: 'adm-chip' }, `已撤回 ${s.withdrawn ?? 0}`),
  ];
  if (notices) {
    const ch = notices.channel || {};
    kids.push(el('span', { class: 'mzr-queue' }, [
      el('span', { class: `mzr-queue-state${ch.ready ? ' is-ready' : ''}` },
        ch.ready ? '通知通道已接入' : `通知通道未配置（${ch.reason || 'NOTIFY_WEBHOOK_URL'}）`),
      notices.queued ? el('span', { class: 'adm-chip' }, `待发送 ${notices.queued}`) : null,
      notices.failed ? el('span', { class: 'adm-chip is-danger' }, `发送失败 ${notices.failed}`) : null,
    ]));
  }
  return el('div', { class: 'adm-summary' }, kids.filter(Boolean));
}

function pager(page, size, total, active) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return null;
  // status 一律写进 URL：省略它会被当成「没筛选」而落回默认的待审核
  const go = (p) => navigate(`#/admin/merchants?status=${active}&page=${p}`);
  return el('div', { class: 'adm-pager' }, [
    el('button', { class: 'adm-line-btn', type: 'button', disabled: page <= 1, onclick: () => go(page - 1) }, '上一页'),
    el('span', { class: 'adm-pager-info num' }, `${page} / ${pages}`),
    el('button', { class: 'adm-line-btn', type: 'button', disabled: page >= pages, onclick: () => go(page + 1) }, '下一页'),
  ]);
}

/* ============================================================
   页面
   ============================================================ */

export async function renderAdminMerchants(view, query = {}) {
  const active = FILTERS.some((f) => f.code === query.status) ? query.status : DEFAULT_FILTER;
  // 「全部」不带 status；其余按状态取
  const status = active === 'all' ? '' : active;
  const page = Math.max(1, Number(query.page) || 1);

  const paint = () => renderAdminMerchants(view, query);

  if (!readAdminKey() || !readAdminActor()) {
    view.innerHTML = '';
    view.appendChild(keyGate(paint));
    return;
  }

  view.innerHTML = '';
  const host = el('div', { class: 'adm-host' });
  const flushBtn = el('button', {
    class: 'adm-line-btn',
    type: 'button',
    onclick: async () => {
      flushBtn.disabled = true;
      flushBtn.textContent = '投递中…';
      try {
        const r = await flushNotices();
        const bits = [`发送 ${r.sent}`, `跳过 ${r.skipped}`, r.retry ? `待重试 ${r.retry}` : '', r.dead ? `失败 ${r.dead}` : ''];
        toast(`通知投递完成：${bits.filter(Boolean).join(' · ')}`, r.dead ? 'warn' : 'ok');
        paint();
      } catch (e) {
        flushBtn.disabled = false;
        flushBtn.textContent = '立即投递通知';
        toast((e && e.message) || '投递失败，请稍后重试', 'warn');
      }
    },
  }, '立即投递通知');

  // 导出按「当前视角」走：运营筛了未通过再点导出，要的是未通过那一批，
  // 而不是把全库下载下来自己去筛（那等于让他在 Excel 里重做一遍筛选）
  const exportBtn = el('button', {
    class: 'adm-line-btn',
    type: 'button',
    'data-role': 'export',
    onclick: async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = '导出中…';
      try {
        const r = await downloadCsv(status);
        toast(r.truncated
          ? `已导出前 ${r.count} 条（共 ${r.total} 条，请缩小筛选范围）`
          : `已导出 ${r.count} 条`, r.truncated ? 'warn' : 'ok');
      } catch (e) {
        if (isKeyRejected(e)) {
          clearAdminIdentity();
          paint();
          toast('密钥失效，请重新进入', 'warn');
        } else {
          toast((e && e.message) || '导出失败', 'warn');
        }
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = '导出 CSV';
      }
    },
  }, '导出 CSV');

  view.appendChild(el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    adminTabs('merchants'),
    el('div', { class: 'adm-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'MERCHANT ONBOARDING'),
        el('h1', { class: 'adm-title' }, '商家入驻审核台'),
        el('span', { class: 'adm-actor' }, `操作人 ${readAdminActor()}`),
      ]),
      el('div', { class: 'mzr-head-actions' }, [
        exportBtn,
        flushBtn,
        el('button', {
          class: 'adm-line-btn',
          type: 'button',
          onclick: () => {
            clearAdminIdentity();
            paint();
          },
        }, '退出'),
      ]),
    ]),
    filterRow(active),
    host,
  ]));
  loading(host, '正在取回入驻申请…');

  let data;
  let notices = null;
  try {
    // 两个请求并行：计数徽标与列表是两块独立信息，串行只会让人多等一次往返
    [data, notices] = await Promise.all([
      fetchList({ status, page }),
      fetchNoticeStats().catch(() => null),
    ]);
  } catch (e) {
    host.innerHTML = '';
    if (isKeyRejected(e)) {
      clearAdminIdentity();
      paint();
      toast(`无法访问：${(e && e.message) || '密钥无效'}`, 'warn');
      return;
    }
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, '没有取到入驻申请'),
      el('p', {}, (e && e.message) || '请稍后重试'),
      el('button', { class: 'adm-line-btn', type: 'button', onclick: paint }, '重试'),
    ]));
    return;
  }

  host.innerHTML = '';
  const list = (data && data.items) || [];
  host.appendChild(summaryRow(data, notices));

  if (!list.length) {
    host.appendChild(el('div', { class: 'adm-empty' }, [
      el('h2', {}, active === 'reviewing' ? '没有待审核的申请' : '这一类暂时没有申请'),
      el('p', {}, active === 'reviewing'
        ? '待审核的都处理完了。商家提交入驻申请后会出现在这里。'
        : '换个筛选条件看看，或者在售后台确认一下钥匙是不是同一把。'),
    ]));
    return;
  }

  list.forEach((r) => host.appendChild(recordCard(r, { reload: paint })));
  const p = pager(page, data.size || PAGE_SIZE, data.total, active);
  if (p) host.appendChild(p);
}
