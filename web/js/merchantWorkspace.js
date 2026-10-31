// 商家工作台（#/merchant/workspace）：入驻通过之后商家真正要去的地方。
//
// 现在这一步**只做入口和概览**，不假装已有商品/订单/结算后台：
//   - 概览块的数字全部来自他自己的申请（类目、SKU 预估、时效、结算周期），
//     不是编出来的「今日 GMV」；
//   - 三个模块位置明写「未开放」，不用骨架屏假装在加载——
//     商家点进去发现什么都没有，比一开始就告诉他「还没有」更伤信任。
//
// 数据来源与状态页同一套口径：本地演示记录读 localStorage，真申请读网关。
import { el } from './ui.js';
import { api, isMissingEndpoint } from './api.js';
import * as merchantLocal from './merchantLocal.js';
import { FORM_CATEGORIES } from './merchant.js';

const SKU_LABEL = { lt50: '50 以内', '50-200': '50–200', '200-1000': '200–1000', gt1000: '1000 以上' };
const SHIP_LABEL = { '24h': '24 小时内', '48h': '48 小时内', '72h': '72 小时内' };
const KIND_LABEL = { license: '营业执照', brand_auth: '品牌授权', inspection: '质检报告', other: '其他材料' };

const catNames = (ids) => (Array.isArray(ids) ? ids : [])
  .map((id) => (FORM_CATEGORIES.find((c) => c.id === id) || {}).t)
  .filter(Boolean);

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadApplication(id, key) {
  if (merchantLocal.isLocalId(id)) return merchantLocal.get(id, key);
  try {
    const res = await api(`/api/merchant/applications/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`, { retries: 1 });
    return res.application;
  } catch (e) {
    return { __error: e };
  }
}

export async function renderMerchantWorkspace(v, query = {}) {
  v.innerHTML = '';
  let id = String(query.id || '').trim();
  let key = String(query.key || '').trim();

  // 没带参数：用本机最近一条演示记录兜底（演示时常从「商户中心」直接点进来）
  if (!id || !key) {
    const recent = merchantLocal.latest();
    if (recent) {
      v.append(renderShell(recent.application, { id: recent.application.id, key: recent.key }));
      return;
    }
  }

  const data = await loadApplication(id, key);

  if (!data || data.__error) {
    const offline = data && data.__error && (data.__error.kind === 'offline' || isMissingEndpoint(data.__error));
    v.append(el('div', { class: 'merchant mzw' }, [
      el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
      el('div', { class: 'mz-apply-card' }, [
        el('h1', { class: 'mzw-title' }, '还没有可进入的店铺'),
        el('p', { class: 'mzw-sub' }, offline
          ? '这台站没有后端（静态演示站），读不到申请。先在入驻页用本地演示模式提交一份，就能看到工作台的样子。'
          : '工作台要凭一份入驻申请进入。先去提交申请，审核通过后这里会显示你的店铺概览。'),
        el('div', { class: 'mzf-result-actions' }, [
          el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '去提交入驻申请'),
          el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/join' }, '了解入驻条件'),
        ]),
      ]),
    ]));
    return;
  }

  v.append(renderShell(data, { id, key }));
}

function renderShell(data, { id, key }) {
  const wrap = el('div', { class: 'merchant mzw' });
  const statusHref = `#/merchant/apply?id=${encodeURIComponent(id)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;

  wrap.append(
    el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
    el('span', { class: 'eyebrow' }, 'MERCHANT WORKSPACE'),
  );

  // 审核没过就没有工作台：这不是权限设计，而是事实——店铺还不存在
  if (data.status !== 'approved') {
    wrap.append(el('div', { class: 'mz-apply-card' }, [
      el('div', { class: 'mzf-result-head' }, [
        el('span', { class: `mzf-status is-${data.status}` }, data.statusLabel || '审核中'),
        data.local ? el('span', { class: 'mzf-local-tag' }, '本地演示数据') : null,
      ].filter(Boolean)),
      el('h1', { class: 'mzw-title' }, '工作台还没开门'),
      el('p', { class: 'mzw-sub' }, data.status === 'reviewing'
        ? '资料还在审核中。通过之后，这里会显示你的店铺概览、商品与结算入口。'
        : '这份申请没有通过审核，所以还没有店铺可以管理。'),
      el('div', { class: 'mzf-result-actions' }, [
        el('a', { class: 'mz-btn mz-btn--gold', href: statusHref }, '查看申请状态'),
        el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/apply' }, '重新提交申请'),
      ]),
    ]));
    return wrap;
  }

  const cats = catNames(data.categories);
  const mats = Array.isArray(data.materials) ? data.materials : [];

  wrap.append(
    el('header', { class: 'mzw-head' }, [
      el('div', { class: 'mzw-head-main' }, [
        el('span', { class: 'mzw-badge' }, '已通过审核'),
        validTag(data),
        el('h1', { class: 'mzw-title' }, data.brand || data.company || '我的店铺'),
        el('p', { class: 'mzw-sub' }, [data.company, cats.join(' / ')].filter(Boolean).join(' · ')),
      ].filter(Boolean)),
      el('div', { class: 'mzw-head-side' }, [
        el('span', { class: 'mzw-idlabel' }, '申请编号'),
        el('strong', { class: 'mzw-id num' }, data.id),
        el('a', { class: 'mzw-link', href: statusHref }, '查看申请详情 →'),
      ]),
    ]),
    data.local
      ? el('p', { class: 'mzw-local' },
        '当前是本地演示数据：这条申请只存在这台设备的浏览器里，工作台里的店铺也是模拟的，不会真的上架商品。')
      : null,
    // 概览只放「从他自己资料里算得出来」的数字
    el('section', { class: 'mzw-stats' }, [
      statCard('主营类目', String(cats.length || '—'), cats.join('、') || '未填写'),
      statCard('预估 SKU', SKU_LABEL[data.skuRange] || '—', '上架时可分批导入'),
      statCard('发货时效', SHIP_LABEL[data.shipWithin] || '—', '超时会记入店铺考核'),
      statCard('结算周期', 'T+7', '确认收货后第 7 天入账'),
    ]),
    el('section', { class: 'mzw-block' }, [
      el('h2', { class: 'mzw-block-title' }, '接下来要做的'),
      el('ul', { class: 'mzw-todo' }, [
        todoRow('上传首批商品', '把 SKU 与库存导进来，AI 导购才能推荐你', '未开放'),
        todoRow('确认结算账户', `当前绑定 ${data.bankNoMasked || '未填写'}（${data.bankAccount || '—'}）`, '已就绪'),
        todoRow('设置售后与发货规则', '平台上架前会再确认一次', '未开放'),
      ]),
    ]),
    el('section', { class: 'mzw-block' }, [
      el('h2', { class: 'mzw-block-title' }, '已提交的资质材料'),
      mats.length
        ? el('ul', { class: 'mzw-mats' }, mats.map((m) => el('li', {}, [
          el('span', { class: 'mzw-mat-kind' }, KIND_LABEL[m.kind] || m.kind),
          el('span', { class: 'mzw-mat-name' }, m.name || '—'),
          el('span', { class: 'mzw-mat-size num' }, fmtSize(m.size)),
        ])))
        : el('p', { class: 'mzw-empty' }, '这份申请没有登记材料清单。'),
    ]),
    el('div', { class: 'mzf-result-actions' }, [
      el('a', { class: 'mz-btn mz-btn--gold', href: '#/products' }, '去商城看看同行在卖什么'),
      el('a', { class: 'mz-btn mz-btn--ghost', href: statusHref }, '查看申请详情'),
    ]),
    el('p', { class: 'mzw-foot' }, '商品、订单、结算三个模块还在内测，开放后会在本页出现入口。'),
  );
  return wrap;
}

function validTag(data) {
  return data.local ? el('span', { class: 'mzf-local-tag' }, '本地演示数据') : null;
}

function statCard(label, value, hint) {
  return el('div', { class: 'mzw-stat' }, [
    el('span', { class: 'mzw-stat-label' }, label),
    el('strong', { class: 'mzw-stat-value' }, value),
    el('span', { class: 'mzw-stat-hint' }, hint),
  ]);
}

function todoRow(title, desc, state) {
  const ready = state === '已就绪';
  return el('li', { class: `mzw-todo-row${ready ? ' is-ready' : ''}` }, [
    el('span', { class: 'mzw-todo-dot', 'aria-hidden': 'true' }, ready ? '✓' : '·'),
    el('div', { class: 'mzw-todo-body' }, [
      el('strong', {}, title),
      el('span', {}, desc),
    ]),
    el('span', { class: 'mzw-todo-state' }, state),
  ]);
}
