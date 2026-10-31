// 商家工作台（#/merchant/dashboard）：入驻通过之后，商家真正干活的地方。
//
// 布局是「侧边导航 + 主内容区」，五个模块：概览 / 商品 / 库存 / 订单 / 店铺设置。
// 移动端侧边栏收成底部标签栏（不是抽屉）——商家在手机上补货、发货，
// 底部拇指可达比顶部汉堡菜单少一次点击。
//
// ---- 视觉取向（与买家侧的「华丽」刻意拉开） ----
//   这里是工作台，不是橱窗：降低装饰、提高信息密度。
//   · 字号：正文 12.5–13px、表格 12.5px、标签 10.5–11px；行高 1.6 起。
//   · 分隔：只用 1px var(--line) 的细线，不做重色块、不叠卡片阴影。
//   · 强调色仅 var(--gold) 一处（主按钮 / 当前导航 / 关键数字），
//     红（#8d3b31）只留给「库存预警 / 失败」，不让它变成装饰。
//   · 圆角沿用令牌：var(--r-card)=16 / var(--r-btn)=12 / var(--r-pill)=999。
//   · 字体沿用令牌：var(--serif) 只用于页面标题与数字大卡，正文表格用 var(--sans)。
//
// ---- 数据口径 ----
//   商品 / 库存 / 订单 / 店铺信息全部来自 store/merchantShopStore.js（本机 localStorage，
//   按入驻编号分桶）。真网关目前只负责「入驻申请」这一段；工作台的经营数据是
//   本机演示数据，这一点在页面顶部始终如实标注，不假装连了平台库。
import { el, openModal, toast } from './ui.js';
import { productArt } from './art.js';
import { api, isMissingEndpoint } from './api.js';
import * as merchantLocal from './merchantLocal.js';
import * as shopStore from './store/merchantShopStore.js';
import { createAdapter } from './merchantWorkspaceApi.js';
import { compressImageFile } from './imgUpload.js';
import { FORM_CATEGORIES } from './merchant.js';

/* ---------------- 小工具 ---------------- */

const catName = (id) => (FORM_CATEGORIES.find((c) => c.id === id) || {}).t || '未分类';

const money = (n) => `¥${Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;

/**
 * 商品状态文案。多一个「未通过」是必要的：运营驳回之后商品会一直挂在列表里，
 * 没有这个标签，商家只会看到一件「既不在售也无法上架」的货，然后来问为什么。
 */
const PRODUCT_STATUS_TEXT = { reviewing: '审核中', on: '在售', off: '已下架', rejected: '未通过' };

/** 本地时区的 MM-DD HH:mm：工作台是给商家看自己的单，别按 UTC 显示 */
function fmtTime(iso, { withYear = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const ymd = withYear ? `${d.getFullYear()}-` : '';
  return `${ymd}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  box: '<path d="M12 3.2 20.5 7.6v8.8L12 20.8 3.5 16.4V7.6L12 3.2Z"/><path d="M3.5 7.6 12 12l8.5-4.4M12 12v8.8"/>',
  layers: '<path d="M12 3.4 3.6 8 12 12.6 20.4 8 12 3.4Z"/><path d="m3.6 12.6 8.4 4.6 8.4-4.6"/>',
  receipt: '<path d="M6.4 3.4h11.2v17.2l-2.8-1.9-2.8 1.9-2.8-1.9-2.8 1.9V3.4Z"/><path d="M9.2 8.2h5.6M9.2 12h5.6"/>',
  sliders: '<path d="M4 7.4h8.4M17.2 7.4H20M4 16.6h3.4M12.2 16.6H20"/><circle cx="15" cy="7.4" r="2.1"/><circle cx="10" cy="16.6" r="2.1"/>',
};

function icon(name) {
  const s = el('span', { class: 'mdash-ico', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"
    stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.grid}</svg>`;
  return s;
}

/**
 * 商品封面：有真图就显示真图，没有就退回程序化 SVG。
 * 真图是商家上传到对象存储的（库里只存对象键，展示时现签地址）。
 */
function thumb(product, cls = '') {
  const box = el('span', { class: `mdash-thumb ${cls}`.trim(), 'aria-hidden': product.imageUrl ? 'false' : 'true' });
  if (product.imageUrl) box.appendChild(el('img', { src: product.imageUrl, alt: '', loading: 'lazy' }));
  else box.appendChild(productArt({ id: product.id, categoryId: product.categoryId }));
  return box;
}

/* ---------------- 五个模块的导航 ---------------- */

const TABS = [
  { id: 'overview', label: '概览', icon: 'grid', sub: '店铺今天的状态，一眼看完' },
  { id: 'products', label: '商品管理', icon: 'box', sub: '上架、下架、新增商品' },
  { id: 'inventory', label: '库存管理', icon: 'layers', sub: '改数量、盯预警线' },
  { id: 'orders', label: '订单管理', icon: 'receipt', sub: '待发货优先处理' },
  { id: 'settings', label: '店铺设置', icon: 'sliders', sub: '店铺名、简介与资质' },
];
const DEFAULT_TAB = 'overview';
const tabOf = (code) => TABS.find((t) => t.id === code) || TABS[0];

/* ---------------- 入口 ---------------- */

export async function renderMerchantDashboard(v, query = {}) {
  v.innerHTML = '';

  let id = String(query.id || '').trim();
  let key = String(query.key || '').trim();
  // 没带参数：用本机最近一条演示记录兜底（演示时常常直接从状态页点进来）
  if (!id || !key) {
    const recent = merchantLocal.latest();
    if (recent) {
      id = recent.application.id;
      key = recent.key;
    }
  }

  if (!id) {
    v.append(gateEmpty({ offline: false }));
    return;
  }

  const app = await loadApplication(id, key);
  if (!app) {
    v.append(gateEmpty({ offline: true }));
    return;
  }
  if (app.status !== 'approved') {
    v.append(gateNotApproved(app, { id, key }));
    return;
  }

  // 数据源：真记录优先读网关（平台商品表 + 交易库），连不上退回本机演示数据。
  // 403 说明审核没过（或凭证失效），与「还没开门」同一个出口。
  let adapter;
  try {
    adapter = await createAdapter(app, { id, key, isLocalId: merchantLocal.isLocalId(id) });
  } catch (e) {
    v.append(gateNotApproved(app, { id, key }));
    return;
  }

  let state;
  try {
    state = adapter.initial || (await adapter.load());
  } catch (e) {
    v.append(gateBroken(e));
    return;
  }

  const tab = TABS.some((t) => t.id === query.tab) ? query.tab : DEFAULT_TAB;
  const ctx = { app, id, key, tab, adapter, state };
  v.append(renderShell(ctx));
}

async function loadApplication(id, key) {
  if (merchantLocal.isLocalId(id)) return merchantLocal.get(id, key);
  try {
    const res = await api(`/api/merchant/applications/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`, { retries: 1 });
    return res.application;
  } catch {
    return null;
  }
}

/* ---------------- 三种进不去的状态 ---------------- */

function gateWrap(children) {
  return el('div', { class: 'merchant' }, [el('div', { class: 'mzw' }, children)]);
}

function gateEmpty({ offline }) {
  return gateWrap([
    el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
    el('div', { class: 'mz-apply-card' }, [
      el('h1', { class: 'mzw-title' }, '还没有可进入的店铺'),
      el('p', { class: 'mzw-sub' }, offline
        ? '这台站读不到入驻申请（没连网关，或链接里的凭证不对）。先在入驻页用本地演示模式提交一份，就能进工作台。'
        : '工作台要凭一份入驻申请进入。先去提交申请，审核通过后这里就是你的店铺后台。'),
      el('div', { class: 'mzf-result-actions' }, [
        el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '去提交入驻申请'),
        el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/join' }, '了解入驻条件'),
      ]),
    ]),
  ]);
}

/** 审核没过就没有工作台：这不是权限设计，而是事实——店铺还不存在 */
function gateNotApproved(app, { id, key }) {
  const statusHref = `#/merchant/apply?id=${encodeURIComponent(id)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  const wrap = gateWrap([
    el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
    el('div', { class: 'mz-apply-card' }, [
      el('div', { class: 'mzf-result-head' }, [
        el('span', { class: `mzf-status is-${app.status}` }, app.statusLabel || '审核中'),
        app.local ? el('span', { class: 'mzf-local-tag' }, '本地演示数据') : null,
      ].filter(Boolean)),
      el('h1', { class: 'mzw-title' }, '工作台还没开门'),
      el('p', { class: 'mzw-sub' }, app.status === 'reviewing'
        ? '资料还在审核中。通过之后，这里会出现商品、库存、订单三个模块。'
        : '这份申请没有通过审核，所以还没有店铺可以管理。'),
      el('div', { class: 'mzf-result-actions' }, [
        el('a', { class: 'mz-btn mz-btn--gold', href: statusHref }, '查看申请状态'),
        el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/apply' }, '重新提交申请'),
      ]),
    ]),
  ]);
  // 本地演示记录可以就地放行，省掉「回状态页点一下再回来」的折返
  if (app.local) {
    wrap.firstChild.appendChild(el('div', { class: 'mzf-demo' }, [
      el('span', { class: 'mzf-demo-tag' }, '演示'),
      el('span', { class: 'mzf-demo-note' }, '本机记录可以就地放行；真申请只能由运营台审核。'),
      el('button', {
        class: 'mzf-demo-btn',
        type: 'button',
        onclick: () => {
          merchantLocal.setStatus(app.id, 'approved');
          renderMerchantDashboard(document.getElementById('view'), { id, key });
        },
      }, '模拟审核通过'),
    ]));
  }
  return wrap;
}

function gateBroken(e) {
  return gateWrap([
    el('div', { class: 'mz-apply-card' }, [
      el('h1', { class: 'mzw-title' }, '工作台打不开'),
      el('p', { class: 'mzw-sub' }, e && e.code === 'storage'
        ? '浏览器不让写本地存储（隐私模式或空间已满），商品和订单存不下来。换个普通窗口再试。'
        : String((e && e.message) || '未知错误')),
      el('div', { class: 'mzf-result-actions' }, [
        el('a', { class: 'mz-btn mz-btn--ghost', href: '#/products' }, '先去逛逛商城'),
      ]),
    ]),
  ]);
}

/* ---------------- 外壳：侧边导航 + 主内容 ---------------- */

const tabHref = (ctx, tab) => `#/merchant/dashboard?tab=${tab}&id=${encodeURIComponent(ctx.id)}&key=${encodeURIComponent(ctx.key)}`;

function renderShell(ctx) {
  const wrap = el('div', { class: 'mdash' });
  const head = el('div', { class: 'mdash-head' });
  const body = el('div', { class: 'mdash-body' });
  ctx.head = head;
  ctx.body = body;
  ctx.shell = wrap;

  wrap.append(renderSide(ctx), el('div', { class: 'mdash-main' }, [head, body]), renderTabbar(ctx));
  paint(ctx);
  return wrap;
}

function renderSide(ctx) {
  const name = el('strong', { class: 'mdash-shop-name' }, ctx.state.shop.name);
  const logo = el('span', { class: `mdash-logo tone-${ctx.state.shop.logoColor || 0}` }, ctx.state.shop.logoText || '店');
  // 上传过 Logo 就显示真图；没有就用字标 + 主色占位（不空着，也不假装有图）
  if (ctx.state.shop.logoUrl) {
    logo.classList.add('is-photo');
    logo.style.backgroundImage = `url("${ctx.state.shop.logoUrl}")`;
    logo.textContent = '';
  }
  ctx.sideName = name;
  ctx.sideLogo = logo;

  return el('aside', { class: 'mdash-side' }, [
    el('div', { class: 'mdash-shop' }, [
      logo,
      el('div', { class: 'mdash-shop-text' }, [
        name,
        el('span', { class: 'mdash-shop-id num' }, ctx.app.id),
      ]),
    ]),
    el('nav', { class: 'mdash-nav', 'aria-label': '工作台导航' }, TABS.map((t) => el('a', {
      class: `mdash-navitem${t.id === ctx.tab ? ' is-active' : ''}`,
      href: tabHref(ctx, t.id),
      'aria-current': t.id === ctx.tab ? 'page' : null,
    }, [icon(t.icon), el('span', {}, t.label)]))),
    el('div', { class: 'mdash-side-foot' }, [
      el('span', { class: 'mdash-side-tag' }, '演示数据 · 仅存本机'),
      el('a', { class: 'mdash-side-link', href: '#/products' }, '回到商城 →'),
    ]),
  ]);
}

/** 移动端底部标签栏：与侧边导航同一份数据，图标 + 文字，拇指可达 */
function renderTabbar(ctx) {
  return el('nav', { class: 'mdash-tabbar', 'aria-label': '工作台导航（移动端）' }, TABS.map((t) => el('a', {
    class: `mdash-tab${t.id === ctx.tab ? ' is-active' : ''}`,
    href: tabHref(ctx, t.id),
    'aria-current': t.id === ctx.tab ? 'page' : null,
  }, [icon(t.icon), el('span', {}, t.label.replace('管理', ''))])));
}

/**
 * 从数据源重新取一遍再画。
 * 这样「改完库存 → 概览数字跟着变」「发完货 → 待发货少一单」都不需要手写同步逻辑——
 * 手写同步一定会漏，漏的那一处就是页面上两个数字互相打脸的 bug。
 */
async function refresh(ctx) {
  ctx.state = await ctx.adapter.load();
  paint(ctx);
}

/**
 * 重画当前模块（不重新取数）。
 */
function paint(ctx) {
  const tab = tabOf(ctx.tab);

  ctx.head.innerHTML = '';
  ctx.head.append(...[
    el('div', { class: 'mdash-head-main' }, [
      el('h1', { class: 'mdash-title' }, tab.label),
      el('p', { class: 'mdash-sub' }, tab.sub),
    ]),
    el('div', { class: 'mdash-head-side' }, headActions(ctx, tab)),
  ]);

  ctx.body.innerHTML = '';
  const onServer = ctx.state.source === 'server';
  ctx.body.append(el('div', { class: 'mdash-note' }, [
    el('span', { class: 'mdash-note-tag' }, onServer ? '平台库' : '演示'),
    el('span', {}, onServer
      ? '商品与订单来自平台库：新增商品提交后进运营审核，通过即在商城可搜可买；上下架、改库存、发货都真实生效。'
      : '商品与订单是本机示例数据，不接平台库：新增、上下架、改库存、发货都只改这台浏览器，不会影响商城。'),
  ]));
  ctx.body.append(PAGES[tab.id](ctx));
}

function headActions(ctx, tab) {
  const out = [];
  if (tab.id === 'products') {
    out.push(el('button', { class: 'mdash-btn is-gold', type: 'button', onclick: () => openProductSheet(ctx) }, '+ 新增商品'));
  }
  if (tab.id === 'inventory') {
    const low = ctx.state.stats.lowStockCount;
    if (low) out.push(el('span', { class: 'mdash-head-flag' }, `${low} 个商品低于预警线`));
  }
  if (tab.id === 'orders') {
    const pending = ctx.state.stats.pendingCount;
    if (pending) out.push(el('span', { class: 'mdash-head-flag' }, `${pending} 单待发货`));
  }
  out.push(el('a', { class: 'mdash-link-quiet', href: `#/merchant/apply?id=${encodeURIComponent(ctx.id)}&key=${encodeURIComponent(ctx.key)}` }, '申请详情'));
  return out;
}

/**
 * 统一的写操作包装：数据源抛什么，页面就 toast 什么，绝不让异常冒到 window。
 * 异步是因为真后端要走网络，但错误口径与本地模式保持一致：
 * 页面只关心「成不成」和「给用户看哪句话」。
 */
async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) toast(okText, 'ok');
    return { ok: true, value: r };
  } catch (e) {
    toast(String((e && e.message) || '操作没有成功'), 'warn');
    return { ok: false, error: e };
  }
}

/* ---------------- 概览 ---------------- */

function pageOverview(ctx) {
  const state = ctx.state;
  const s = state.stats;
  const recent = [...state.orders]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 5);

  return el('div', { class: 'mdash-stack' }, [
    el('div', { class: 'mdash-cards' }, [
      statCard(ctx, '在售商品', String(s.onSale), `全部 ${state.products.length} 个商品`, 'products'),
      statCard(ctx, '今日订单', String(s.todayOrderCount),
        s.todayOrderCount ? `金额 ${money(s.todayAmount)}` : '今天还没有新订单', 'orders'),
      statCard(ctx, '待发货', String(s.pendingCount),
        s.pendingCount ? '超过 48 小时会记入考核' : '全部处理完了', 'orders'),
      statCard(ctx, '库存预警', String(s.lowStockCount),
        s.lowStockCount ? `低于 ${shopStore.LOW_STOCK_AT} 件的在售商品` : '库存都还充足', 'inventory', s.lowStockCount > 0),
    ]),

    el('div', { class: 'mdash-split' }, [
      el('section', { class: 'mdash-block' }, [
        blockHead('最近订单', '全部订单', 'orders', ctx),
        recent.length
          ? orderTable(ctx, recent, { compact: true })
          : el('p', { class: 'mdash-empty' }, '还没有订单。上架商品后，商城的真实下单会出现在这里（当前是演示数据）。'),
      ]),
      el('section', { class: 'mdash-block' }, [
        blockHead('库存预警', '去补货', 'inventory', ctx),
        s.lowStock.length
          ? el('ul', { class: 'mdash-lowlist' }, s.lowStock.slice(0, 5).map((p) => el('li', {}, [
            thumb(p, 'is-sm'),
            el('div', { class: 'mdash-low-text' }, [
              el('strong', {}, p.name),
              el('span', {}, `${catName(p.categoryId)} · 预警线 ${p.warnAt}`),
            ]),
            el('span', { class: 'mdash-low-num num' }, `剩 ${p.stock}`),
          ])))
          : el('p', { class: 'mdash-empty' }, '没有库存告急的商品。'),
      ]),
    ]),

    el('section', { class: 'mdash-quick' }, [
      el('button', { class: 'mdash-quick-btn', type: 'button', onclick: () => openProductSheet(ctx) }, [
        el('strong', {}, '新增商品'), el('span', {}, '填名称、价格、库存，提交后进审核'),
      ]),
      el('a', { class: 'mdash-quick-btn', href: tabHref(ctx, 'orders') }, [
        el('strong', {}, '处理待发货'), el('span', {}, `${s.pendingCount} 单等你填运单号`),
      ]),
      el('a', { class: 'mdash-quick-btn', href: tabHref(ctx, 'inventory') }, [
        el('strong', {}, '补库存'), el('span', {}, `预警 ${s.lowStockCount} 个商品`),
      ]),
    ]),
  ]);
}

function statCard(ctx, label, value, hint, tab, warn = false) {
  return el('a', { class: `mdash-card${warn ? ' is-warn' : ''}`, href: tabHref(ctx, tab) }, [
    el('span', { class: 'mdash-card-label' }, label),
    el('strong', { class: 'mdash-card-value num' }, value),
    el('span', { class: 'mdash-card-hint' }, hint),
  ]);
}

function blockHead(title, linkText, tab, ctx) {
  return el('div', { class: 'mdash-block-head' }, [
    el('h2', {}, title),
    el('a', { class: 'mdash-link-quiet', href: tabHref(ctx, tab) }, `${linkText} →`),
  ]);
}

/* ---------------- 商品管理 ---------------- */

const PRODUCT_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'on', label: '在售' },
  { id: 'off', label: '已下架' },
  { id: 'reviewing', label: '审核中' },
  { id: 'rejected', label: '未通过' },
];

function pageProducts(ctx) {
  const filter = ctx.productFilter || 'all';
  const all = ctx.state.products;
  const list = all.filter((p) => filter === 'all' || p.status === filter);
  const countOf = (f) => (f === 'all' ? all.length : all.filter((p) => p.status === f).length);

  return el('div', { class: 'mdash-stack' }, [
    el('div', { class: 'mdash-toolbar' }, [
      el('div', { class: 'mdash-chips' }, PRODUCT_FILTERS.map((f) => el('button', {
        class: `mdash-chip${f.id === filter ? ' is-active' : ''}`,
        type: 'button',
        onclick: () => { ctx.productFilter = f.id; paint(ctx); },
      }, `${f.label} ${countOf(f.id)}`))),
    ]),

    list.length
      ? el('div', { class: 'mdash-tablewrap' }, [
        el('table', { class: 'mdash-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, '商品'),
            el('th', { class: 'c-cat' }, '类目'),
            el('th', { class: 'c-price num' }, '价格'),
            // d-only：手机上藏掉库存列（库存页才是改它的地方），避免表格挤成横向滚动
            el('th', { class: 'c-stock d-only num' }, '库存'),
            el('th', {}, '状态'),
            el('th', { class: 'c-act' }, '操作'),
          ])),
          el('tbody', {}, list.map((p) => productRow(ctx, p))),
        ]),
      ])
      : el('p', { class: 'mdash-empty' }, filter === 'all'
        ? '还没有商品。点右上角「新增商品」开张。'
        : '这个状态下没有商品。'),

    el('p', { class: 'mdash-foot' },
      '新增商品会先进「审核中」，通过后才在商城展示。演示里可以用行内的「模拟通过」直接放行；'
      + '真实链路中这一步只能由平台运营做。'),
  ]);
}

function productRow(ctx, p) {
  const local = ctx.state.source === 'local';
  const canToggle = p.status === 'on' || p.status === 'off';
  const next = p.status === 'on' ? 'off' : 'on';

  return el('tr', { 'data-product': p.id }, [
    el('td', {}, el('div', { class: 'mdash-cell-main' }, [
      thumb(p),
      el('div', { class: 'mdash-cell-text' }, [
        el('strong', {}, p.name),
        el('span', { class: 'num' }, p.id),
      ]),
    ])),
    el('td', { class: 'c-cat mdash-dim' }, catName(p.categoryId)),
    el('td', { class: 'c-price num' }, money(p.price)),
    el('td', { class: 'c-stock d-only num' }, String(p.stock)),
    el('td', {}, el('span', { class: `mdash-pill is-${p.status}` }, PRODUCT_STATUS_TEXT[p.status] || p.status)),
    el('td', { class: 'c-act' }, [
      canToggle
        ? el('button', {
          class: 'mdash-link',
          type: 'button',
          onclick: async () => {
            const r = await act(() => ctx.adapter.setProductStatus(p.id, next),
              next === 'on' ? '已上架' : '已下架');
            if (r.ok) await refresh(ctx);
          },
        }, next === 'on' ? '上架' : '下架')
        : p.status === 'reviewing'
          // 审核中不可上下架；本机演示给一颗「模拟通过」，真链路只能等运营
          ? (local
            ? el('button', {
              class: 'mdash-link is-quiet',
              type: 'button',
              title: '演示：把这条商品置为在售（真链路只能由运营审核）',
              onclick: async () => {
                const r = await act(() => shopStore.approveProduct(ctx.app.id, p.id), '已放行，商品在售');
                if (r.ok) await refresh(ctx);
              },
            }, '模拟通过')
            : el('span', { class: 'mdash-dim' }, '等运营审核'))
          : el('span', { class: 'mdash-dim', title: p.reviewNote || '' }, '未通过'),
    ]),
  ]);
}

/* ---------------- 新增商品 ---------------- */

const IMAGE_NOTE = '图片用程序化封面占位：本机没有对象存储，真图上传要等平台接入私有桶 + 病毒扫描后再开放。';

function openProductSheet(ctx) {
  openModal((modal, close) => {
    modal.classList.add('is-sheet');

    const nameIn = el('input', { class: 'mdash-input', type: 'text', maxlength: 40, placeholder: '如：手作粗陶马克杯' });
    const priceIn = el('input', { class: 'mdash-input', type: 'number', min: '0.01', step: '0.01', placeholder: '0.00', inputmode: 'decimal' });
    const stockIn = el('input', { class: 'mdash-input', type: 'number', min: '0', step: '1', value: '20', inputmode: 'numeric' });
    const warnIn = el('input', { class: 'mdash-input', type: 'number', min: '1', step: '1', value: String(shopStore.LOW_STOCK_AT), inputmode: 'numeric' });

    const catSel = el('select', { class: 'mdash-input' }, FORM_CATEGORIES.map((c) => el('option', {
      value: c.id,
      selected: (ctx.app.categories || [])[0] === c.id,
    }, c.t)));

    const preview = el('div', { class: 'mdash-thumb is-lg' });
    // imageKey 才是要提交的东西：URL 是现签的、会过期，存下来第二天就是死链
    let imageKey = '';
    let uploadedUrl = '';
    const imgHint = el('p', { class: 'mdash-imgbox-d' }, IMAGE_NOTE);
    const paintPreview = () => {
      preview.innerHTML = '';
      if (uploadedUrl) {
        preview.appendChild(el('img', { src: uploadedUrl, alt: '' }));
        return;
      }
      preview.appendChild(productArt({ id: `preview-${catSel.value}-${nameIn.value.length}`, categoryId: catSel.value }));
    };
    paintPreview();
    catSel.addEventListener('change', paintPreview);

    const fileIn = el('input', { class: 'mdash-file', type: 'file', accept: 'image/*' });
    fileIn.addEventListener('change', async () => {
      const file = fileIn.files && fileIn.files[0];
      if (!file) return;
      imgHint.textContent = '正在压缩并上传…';
      try {
        const dataUrl = await compressImageFile(file, 900, 0.82);
        const up = await ctx.adapter.uploadImage(dataUrl, 'product');
        imageKey = up.key;
        uploadedUrl = up.url;
        paintPreview();
        imgHint.textContent = '已上传。审核通过后，商城会展示这张图。';
      } catch (e) {
        imgHint.textContent = String((e && e.message) || '上传失败，也可以不传图直接提交');
      } finally {
        fileIn.value = '';
      }
    });

    const err = el('p', { class: 'mdash-error', role: 'alert' });
    const submit = el('button', { class: 'mdash-btn is-gold', type: 'submit' }, '提交审核');

    const form = el('form', { class: 'mdash-form', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      submit.disabled = true;
      const r = await act(() => ctx.adapter.createProduct({
        name: nameIn.value,
        price: Number(priceIn.value),
        stock: Number(stockIn.value),
        warnAt: Number(warnIn.value),
        categoryId: catSel.value,
        imageKey,
      }));
      submit.disabled = false;
      if (!r.ok) {
        err.textContent = String((r.error && r.error.message) || '提交没有成功');
        return;
      }
      close();
      ctx.productFilter = 'all';
      await refresh(ctx);
      toast('已提交，等待审核', 'ok');
    } }, [
      el('h2', { class: 'mdash-sheet-title' }, '新增商品'),
      el('p', { class: 'mdash-sheet-sub' }, '提交后状态为「审核中」，通过之前不会出现在商城。'),
      el('div', { class: 'mdash-form-grid' }, [
        field('商品名称', nameIn, { wide: true }),
        field('价格（元）', priceIn),
        field('初始库存', stockIn),
        field('类目', catSel),
        field('预警阈值', warnIn, { hint: `库存低于等于它就标黄，默认 ${shopStore.LOW_STOCK_AT}` }),
      ]),
      el('div', { class: 'mdash-imgbox' }, [
        preview,
        el('div', { class: 'mdash-imgbox-body' }, [
          el('strong', { class: 'mdash-imgbox-t' }, '商品图片（可选）'),
          el('p', { class: 'mdash-imgbox-d' },
            '建议 1:1 方图，会自动压到 900px 以内再上传；不传就用程序化封面占位。'),
          el('div', { class: 'mdash-upload' }, [
            el('button', { class: 'mdash-btn', type: 'button', onclick: () => fileIn.click() }, '选择图片'),
            fileIn,
          ]),
          imgHint,
        ]),
      ]),
      err,
      el('div', { class: 'mdash-sheet-actions' }, [
        el('button', { class: 'mdash-btn', type: 'button', onclick: close }, '取消'),
        submit,
      ]),
    ]);

    modal.append(form);
  });
}

function field(label, input, { wide = false, hint = '' } = {}) {
  return el('label', { class: `mdash-field${wide ? ' is-wide' : ''}` }, [
    el('span', { class: 'mdash-label' }, label),
    input,
    hint ? el('span', { class: 'mdash-hint' }, hint) : null,
  ].filter(Boolean));
}

/* ---------------- 库存管理 ---------------- */

function pageInventory(ctx) {
  const products = ctx.state.products;
  if (!products.length) {
    return el('div', { class: 'mdash-stack' }, [el('p', { class: 'mdash-empty' }, '还没有商品可管库存。先去商品管理新增一个。')]);
  }
  const low = ctx.state.stats.lowStockCount;

  return el('div', { class: 'mdash-stack' }, [
    el('p', { class: 'mdash-lede' }, low
      ? `有 ${low} 个在售商品低于预警线。直接改数字，离开输入框即保存。`
      : '库存都还充足。直接改数字，离开输入框即保存。'),

    el('div', { class: 'mdash-tablewrap' }, [
      el('table', { class: 'mdash-table' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, '商品'),
          el('th', { class: 'c-cat' }, '编号'),
          el('th', { class: 'c-stock' }, '库存'),
          el('th', { class: 'c-warn num' }, '预警线'),
          el('th', {}, '状态'),
        ])),
        el('tbody', {}, products.map((p) => inventoryRow(ctx, p))),
      ]),
    ]),
    el('p', { class: 'mdash-foot' },
      `预警规则：在售或待上架的商品，库存 ≤ 预警线（默认 ${shopStore.LOW_STOCK_AT}）时标记「库存预警」。`
      + '已下架商品不参与预警——它们不需要补货。'),
  ]);
}

function inventoryRow(ctx, product) {
  let stock = product.stock;
  const row = el('tr', { 'data-product': product.id, class: stock <= product.warnAt && product.status !== 'off' ? 'is-low' : '' });

  const input = el('input', {
    class: 'mdash-stock-input num',
    type: 'number',
    min: '0',
    max: '99999',
    step: '1',
    value: String(stock),
    inputmode: 'numeric',
    'aria-label': `${product.name} 库存`,
  });

  const flag = el('span', { class: 'mdash-pill is-low' }, '库存预警');

  /** 保存成功后就地更新这一行（重画整表会把用户下一步要点的输入框挪走） */
  const save = async (val) => {
    const n = Math.floor(Number(val));
    if (!Number.isFinite(n) || n < 0) {
      input.value = String(stock);
      toast('库存要填 0 以上的整数', 'warn');
      return;
    }
    if (n === stock) return;
    const r = await act(() => ctx.adapter.updateStock(product.id, n));
    if (!r.ok) {
      input.value = String(stock);
      return;
    }
    stock = n;
    input.value = String(n);
    const isLow = stock <= product.warnAt && product.status !== 'off';
    row.classList.toggle('is-low', isLow);
    if (isLow) {
      if (!flag.isConnected) flagCell.appendChild(flag);
    } else {
      flag.remove();
    }
  };

  const bump = (delta) => () => {
    const next = Math.max(0, Math.min(99999, stock + delta));
    if (next !== stock) save(next);
  };

  input.addEventListener('change', () => save(input.value));
  // 回车即提交并按 Tab 的语义离开，避免用户以为没生效又点一次
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(input.value); input.blur(); }
  });

  const flagCell = el('td', {}, [
    el('span', { class: `mdash-pill is-${product.status}` }, PRODUCT_STATUS_TEXT[product.status] || product.status),
    stock <= product.warnAt && product.status !== 'off' ? flag : null,
  ].filter(Boolean));

  row.append(
    el('td', {}, el('div', { class: 'mdash-cell-main' }, [
      thumb(product, 'is-sm'),
      el('div', { class: 'mdash-cell-text' }, [
        el('strong', {}, product.name),
        el('span', {}, catName(product.categoryId)),
      ]),
    ])),
    el('td', { class: 'c-cat num mdash-dim' }, product.id),
    el('td', { class: 'c-stock' }, el('div', { class: 'mdash-stepper' }, [
      el('button', { class: 'mdash-step', type: 'button', 'aria-label': '减 1', onclick: bump(-1) }, '−'),
      input,
      el('button', { class: 'mdash-step', type: 'button', 'aria-label': '加 1', onclick: bump(1) }, '+'),
    ])),
    el('td', { class: 'c-warn num mdash-dim' }, String(product.warnAt)),
    flagCell,
  );
  return row;
}

/* ---------------- 订单管理 ---------------- */

const ORDER_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待发货' },
  { id: 'shipped', label: '已发货' },
  { id: 'done', label: '已完成' },
];

function pageOrders(ctx) {
  const filter = ctx.orderFilter || 'all';
  const all = [...ctx.state.orders].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const list = all.filter((o) => filter === 'all' || o.status === filter);
  const countOf = (f) => (f === 'all' ? all.length : all.filter((o) => o.status === f).length);

  return el('div', { class: 'mdash-stack' }, [
    el('div', { class: 'mdash-toolbar' }, [
      el('div', { class: 'mdash-chips' }, ORDER_FILTERS.map((f) => el('button', {
        class: `mdash-chip${f.id === filter ? ' is-active' : ''}`,
        type: 'button',
        onclick: () => { ctx.orderFilter = f.id; paint(ctx); },
      }, `${f.label} ${countOf(f.id)}`))),
    ]),
    list.length
      ? el('div', { class: 'mdash-tablewrap' }, [orderTable(ctx, list, {})])
      : el('p', { class: 'mdash-empty' }, '这个状态下没有订单。'),
    el('p', { class: 'mdash-foot' },
      '发货只需填运单号：状态变「已发货」并记下时间。真实链路里这一步会回调商城通知买家，'
      + '当前是演示数据，不会真的发短信。'),
  ]);
}

function orderTable(ctx, orders, { compact = false } = {}) {
  return el('table', { class: 'mdash-table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '订单号'),
      el('th', {}, '商品'),
      el('th', { class: 'c-price num' }, '金额'),
      el('th', {}, '状态'),
      el('th', { class: 'c-time' }, '下单时间'),
      el('th', { class: 'c-act' }, '操作'),
    ])),
    el('tbody', {}, orders.map((o) => orderRow(ctx, o, { compact }))),
  ]);
}

function orderRow(ctx, o, { compact }) {
  const row = el('tr', {
    'data-order': o.id,
    class: 'is-clickable',
    onclick: () => openOrderSheet(ctx, o.id),
  }, [
    el('td', {}, el('span', { class: 'num mdash-order-id' }, o.id)),
    el('td', {}, el('div', { class: 'mdash-cell-text' }, [
      el('strong', {}, o.productName),
      el('span', {}, `× ${o.qty}`),
    ])),
    el('td', { class: 'c-price num' }, money(o.amount)),
    el('td', {}, el('span', { class: `mdash-pill is-o-${o.status}` }, shopStore.ORDER_STATUS_LABEL[o.status] || o.status)),
    el('td', { class: 'c-time mdash-dim num' }, fmtTime(o.createdAt)),
    el('td', { class: 'c-act' }, o.status === 'pending'
      ? el('button', {
        class: 'mdash-link',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); openShipSheet(ctx, o.id); },
      }, '发货')
      : el('button', {
        class: 'mdash-link is-quiet',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); openOrderSheet(ctx, o.id); },
      }, compact ? '查看' : '详情')),
  ]);
  return row;
}

function openShipSheet(ctx, orderId) {
  const order = ctx.state.orders.find((o) => o.id === orderId);
  if (!order) return;

  openModal((modal, close) => {
    modal.classList.add('is-sheet');
    const carrier = el('select', { class: 'mdash-input' }, shopStore.CARRIERS.map((c) => el('option', { value: c }, c)));
    const no = el('input', {
      class: 'mdash-input num',
      type: 'text',
      maxlength: 32,
      placeholder: '如 SF139700228841',
      autocomplete: 'off',
    });
    const err = el('p', { class: 'mdash-error', role: 'alert' });

    modal.append(el('form', { class: 'mdash-form', onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const r = await act(() => ctx.adapter.shipOrder(orderId, { carrier: carrier.value, trackingNo: no.value }));
      if (!r.ok) {
        err.textContent = String((r.error && r.error.message) || '发货没有成功');
        return;
      }
      close();
      await refresh(ctx);
      toast('已发货', 'ok');
    } }, [
      el('h2', { class: 'mdash-sheet-title' }, '填写运单号'),
      el('p', { class: 'mdash-sheet-sub' }, `${order.id} · ${order.productName} × ${order.qty} · ${money(order.amount)}`),
      el('div', { class: 'mdash-form-grid' }, [
        field('快递公司', carrier),
        field('运单号', no, { hint: '6–32 位字母或数字' }),
      ]),
      el('p', { class: 'mdash-hint' }, `收货信息：${order.buyer} · ${order.region}（演示数据已打码）`),
      err,
      el('div', { class: 'mdash-sheet-actions' }, [
        el('button', { class: 'mdash-btn', type: 'button', onclick: close }, '取消'),
        el('button', { class: 'mdash-btn is-gold', type: 'submit' }, '确认发货'),
      ]),
    ]));
  });
}

/** 订单详情：右侧滑出（复用弹层的遮罩与 Esc，视觉上是抽屉） */
function openOrderSheet(ctx, orderId) {
  const o = ctx.state.orders.find((x) => x.id === orderId);
  if (!o) return;

  openModal((modal, close) => {
    modal.classList.add('is-sheet');

    const line = (label, value, extra) => el('div', { class: 'mdash-kv' }, [
      el('span', {}, label),
      el('strong', { class: extra || '' }, value),
    ]);

    modal.append(
      el('div', { class: 'mdash-sheet-head' }, [
        el('div', {}, [
          el('span', { class: 'mdash-label' }, '订单号'),
          el('h2', { class: 'mdash-sheet-title num' }, o.id),
        ]),
        el('span', { class: `mdash-pill is-o-${o.status}` }, shopStore.ORDER_STATUS_LABEL[o.status] || o.status),
      ]),
      el('div', { class: 'mdash-kv-list' }, [
        line('商品', o.productName),
        line('单价 × 数量', `${money(o.price)} × ${o.qty}`),
        line('金额', money(o.amount), 'num'),
        line('买家', `${o.buyer} · ${o.region}`),
        line('下单时间', fmtTime(o.createdAt, { withYear: true })),
        o.shippedAt ? line('发货时间', fmtTime(o.shippedAt, { withYear: true })) : null,
        o.carrier ? line('物流', `${o.carrier} · ${o.trackingNo}`) : null,
        o.finishedAt ? line('完成时间', fmtTime(o.finishedAt, { withYear: true })) : null,
      ].filter(Boolean)),
      el('div', { class: 'mdash-timeline' }, [
        tlStep('已下单', fmtTime(o.createdAt), true),
        tlStep('已发货', o.shippedAt ? fmtTime(o.shippedAt) : '等待填写运单号', Boolean(o.shippedAt)),
        tlStep('已完成', o.finishedAt ? fmtTime(o.finishedAt) : '买家确认收货后', Boolean(o.finishedAt)),
      ]),
      el('div', { class: 'mdash-sheet-actions' }, [
        el('button', { class: 'mdash-btn', type: 'button', onclick: close }, '关闭'),
        o.status === 'pending'
          ? el('button', {
            class: 'mdash-btn is-gold',
            type: 'button',
            onclick: () => { close(); openShipSheet(ctx, o.id); },
          }, '填写运单号并发货')
          : null,
        o.status === 'shipped' && ctx.state.source === 'local'
          ? el('button', {
            class: 'mdash-btn',
            type: 'button',
            title: '演示：真实链路里由买家确认收货触发',
            onclick: async () => {
              const r = await act(() => ctx.adapter.finishOrder(o.id), '已标记完成');
              if (r.ok) { close(); await refresh(ctx); }
            },
          }, '模拟确认收货')
          : null,
        o.status === 'shipped' && ctx.state.source === 'server'
          ? el('p', { class: 'mdash-hint' }, '这一单已交给快递。买家确认收货后会自动变成「已完成」。')
          : null,
      ].filter(Boolean)),
    );
  });
}

function tlStep(label, text, done) {
  return el('div', { class: `mdash-tl-step${done ? ' is-done' : ''}` }, [
    el('span', { class: 'mdash-tl-dot', 'aria-hidden': 'true' }, done ? '✓' : '·'),
    el('div', {}, [el('strong', {}, label), el('span', {}, text)]),
  ]);
}

/* ---------------- 店铺设置 ---------------- */

const LOGO_TONES = ['墨', '陶', '茶', '竹', '靛', '砂'];

function pageSettings(ctx) {
  const shop = ctx.state.shop;
  const nameIn = el('input', { class: 'mdash-input', type: 'text', maxlength: 30, value: shop.name });
  const introIn = el('textarea', { class: 'mdash-input', maxlength: 120, rows: 3 });
  introIn.value = shop.intro;
  const logoIn = el('input', { class: 'mdash-input', type: 'text', maxlength: 2, value: shop.logoText });
  let tone = Number(shop.logoColor) || 0;

  // 计数器要跟着输入走：简介是最容易被写超的一个字段，静默截断比报错更让人火大
  const introCount = el('span', { class: 'mdash-hint' }, `${introIn.value.length}/120`);
  introIn.addEventListener('input', () => { introCount.textContent = `${introIn.value.length}/120`; });

  const logoPreview = el('span', { class: `mdash-logo is-lg tone-${tone}` }, shop.logoText || '店');
  if (shop.logoUrl) {
    logoPreview.classList.add('is-photo');
    logoPreview.style.backgroundImage = `url("${shop.logoUrl}")`;
    logoPreview.textContent = '';
  }
  logoIn.addEventListener('input', () => {
    logoPreview.classList.remove('is-photo');
    logoPreview.style.backgroundImage = '';
    logoPreview.textContent = logoIn.value.trim().slice(0, 2) || '店';
  });

  // Logo 真图上传：库里存对象键，展示用现签地址
  let logoKey = shop.logoKey || '';
  const logoFile = el('input', { class: 'mdash-file', type: 'file', accept: 'image/*' });
  const logoHint = el('p', { class: 'mdash-hint' }, logoKey
    ? '已上传自定义 Logo，保存后生效。'
    : '没上传就用字标 + 主色占位；建议 1:1 方图。');
  logoFile.addEventListener('change', async () => {
    const file = logoFile.files && logoFile.files[0];
    if (!file) return;
    logoHint.textContent = '正在压缩并上传…';
    try {
      const dataUrl = await compressImageFile(file, 512, 0.86);
      const up = await ctx.adapter.uploadImage(dataUrl, 'logo');
      logoKey = up.key;
      logoPreview.classList.add('is-photo');
      logoPreview.style.backgroundImage = `url("${up.url}")`;
      logoPreview.textContent = '';
      logoHint.textContent = '已上传。点「保存修改」生效。';
    } catch (e) {
      logoHint.textContent = String((e && e.message) || '上传失败');
    } finally {
      logoFile.value = '';
    }
  });

  const swatches = el('div', { class: 'mdash-t tones' }, LOGO_TONES.map((label, i) => el('button', {
    class: `mdash-tone tone-${i}${i === tone ? ' is-active' : ''}`,
    type: 'button',
    'aria-label': `主色 ${label}`,
    onclick: (e) => {
      tone = i;
      logoPreview.className = `mdash-logo is-lg tone-${tone}`;
      swatches.querySelectorAll('.mdash-tone').forEach((b) => b.classList.remove('is-active'));
      e.currentTarget.classList.add('is-active');
    },
  }, label)));

  const err = el('p', { class: 'mdash-error', role: 'alert' });

  return el('div', { class: 'mdash-stack' }, [
    el('section', { class: 'mdash-block' }, [
      el('div', { class: 'mdash-block-head' }, [el('h2', {}, '店铺信息')]),
      el('form', { class: 'mdash-form', onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const r = await act(() => ctx.adapter.updateShop({
          name: nameIn.value,
          intro: introIn.value,
          logoText: logoIn.value,
          logoColor: tone,
          logoKey,
        }), '店铺信息已保存');
        if (!r.ok) {
          err.textContent = String((r.error && r.error.message) || '保存没有成功');
          return;
        }
        // 侧边栏的店名/字标就地跟着改，不必整页重画（免得用户丢了刚滚到的位置）
        ctx.state = r.value;
        ctx.sideName.textContent = r.value.shop.name;
        ctx.sideLogo.className = `mdash-logo tone-${r.value.shop.logoColor}`;
        ctx.sideLogo.textContent = r.value.shop.logoText;
        if (r.value.shop.logoUrl) {
          ctx.sideLogo.classList.add('is-photo');
          ctx.sideLogo.style.backgroundImage = `url("${r.value.shop.logoUrl}")`;
          ctx.sideLogo.textContent = '';
        }
      } }, [
        el('div', { class: 'mdash-form-grid' }, [
          field('店铺名称', nameIn, { hint: '展示在商城商品卡上的名字' }),
          field('店铺简介', introIn, { wide: true, hint: introCount }),
        ]),
        el('div', { class: 'mdash-logobox' }, [
          logoPreview,
          el('div', { class: 'mdash-logobox-body' }, [
            el('div', { class: 'mdash-form-grid' }, [field('字标（≤2 字）', logoIn)]),
            el('span', { class: 'mdash-label' }, '主色'),
            swatches,
            el('div', { class: 'mdash-upload' }, [
              el('button', { class: 'mdash-btn', type: 'button', onclick: () => logoFile.click() }, '上传 Logo'),
              logoFile,
            ]),
            logoHint,
          ]),
        ]),
        el('p', { class: 'mdash-hint' }, `上次保存：${fmtTime(shop.updatedAt, { withYear: true })}。Logo 用字标 + 主色占位，真图上传与商品图一起等平台存储。`),
        err,
        el('div', { class: 'mdash-sheet-actions' }, [
          el('button', { class: 'mdash-btn is-gold', type: 'submit' }, '保存修改'),
        ]),
      ]),
    ]),

    el('section', { class: 'mdash-block' }, [
      el('div', { class: 'mdash-block-head' }, [el('h2', {}, '资质与结算')]),
      el('p', { class: 'mdash-hint' }, '这些来自入驻申请，要改请回到申请详情走「修改资料」（审核通过后需联系运营）。'),
      el('div', { class: 'mdash-kv-list' }, [
        kv('入驻编号', ctx.app.id),
        kv('主体', ctx.app.company || '—'),
        kv('主营类目', (ctx.app.categories || []).map(catName).join('、') || '—'),
        kv('结算卡', ctx.app.bankNoMasked || '—'),
        el('div', { class: 'mdash-kv' }, [
          el('span', {}, '资质材料'),
          el('div', { class: 'mdash-mats' }, (ctx.app.materials || []).length
            ? ctx.app.materials.map((m) => el('span', { class: 'mdash-mat' }, m.name || m.kind))
            : [el('span', { class: 'mdash-dim' }, '未登记')]),
        ]),
      ]),
    ]),

    // 连了平台库就没有「演示数据」这回事：这里的商品与订单是真的，不该给重置按钮
    ctx.state.source === 'local' ? el('section', { class: 'mdash-block is-danger' }, [
      el('div', { class: 'mdash-block-head' }, [el('h2', {}, '演示数据')]),
      el('p', { class: 'mdash-hint' }, '工作台的商品与订单只存在这台浏览器里。重置会把它们恢复成初始示例（店铺名也会重新派生），不影响入驻申请。'),
      el('div', { class: 'mdash-sheet-actions' }, [
        el('button', {
          class: 'mdash-btn is-danger',
          type: 'button',
          onclick: () => openResetSheet(ctx),
        }, '重置演示数据'),
      ]),
    ]) : null,
  ]);
}

function kv(label, value) {
  return el('div', { class: 'mdash-kv' }, [el('span', {}, label), el('strong', {}, value)]);
}

function openResetSheet(ctx) {
  openModal((modal, close) => {
    modal.append(
      el('h2', { class: 'mdash-sheet-title' }, '重置演示数据？'),
      el('p', { class: 'mdash-sheet-sub' }, '商品、库存、订单会回到初始示例，你在本机加的东西会消失。入驻申请与店铺名不受影响（店铺名会重新派生）。'),
      el('div', { class: 'mdash-sheet-actions' }, [
        el('button', { class: 'mdash-btn', type: 'button', onclick: close }, '算了'),
        el('button', {
          class: 'mdash-btn is-danger',
          type: 'button',
          onclick: async () => {
            const r = await act(() => shopStore.resetShop(ctx.app), '演示数据已重置');
            close();
            if (r.ok) await refresh(ctx);
          },
        }, '确认重置'),
      ]),
    );
  });
}

/* ---------------- 模块表 ---------------- */

const PAGES = {
  overview: pageOverview,
  products: pageProducts,
  inventory: pageInventory,
  orders: pageOrders,
  settings: pageSettings,
};
