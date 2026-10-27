// 分析看板：可视化推荐来源埋点的全链路数据（渠道占比 / 行为分布 / Top 商品 / 最近事件）。
// best-effort：未连接网关（演示模式）时显示友好空状态。
import { el, loading } from './ui.js';
import { getProducts, openProductDetail, SOURCE_META, SOURCE_LABELS } from './views.js';
import { fetchStats } from './track.js';

const EVENT_LABELS = {
  view_product: '浏览商品',
  search: '搜索',
  add_to_cart: '加入购物车',
  guide_recommend_click: '导购推荐点击',
  qa_recommend_click: '问答推荐点击',
  share: '分享',
};
const NEUTRAL = '#5b6472';

// 演示兜底：网关不可达（如 GitHub Pages 静态站点）时用的内置示例统计，
// 保证看板始终有内容可看，同时在顶部明确标注「示例数据」，不冒充真实埋点。
const SAMPLE_STATS = {
  total: 247,
  byEvent: {
    view_product: 118,
    search: 54,
    add_to_cart: 31,
    guide_recommend_click: 22,
    qa_recommend_click: 13,
    share: 9,
  },
  bySource: {
    guide: 86,
    search: 54,
    home: 45,
    list: 32,
    rec: 21,
    qa: 9,
  },
  byProduct: { p001: 34, p003: 28, p002: 22, p005: 17, p007: 12 },
  recent: [
    { event: 'view_product', source: 'guide', productId: 'p001', userId: 'u_demo1', ts: Date.now() - 12000 },
    { event: 'add_to_cart', source: 'search', productId: 'p003', userId: 'u_demo2', ts: Date.now() - 46000 },
    { event: 'qa_recommend_click', source: 'qa', productId: 'p002', userId: 'u_demo1', ts: Date.now() - 95000 },
    { event: 'search', source: 'search', productId: null, userId: 'u_demo3', ts: Date.now() - 150000 },
    { event: 'share', source: 'rec', productId: 'p005', userId: 'u_demo2', ts: Date.now() - 240000 },
    { event: 'guide_recommend_click', source: 'guide', productId: 'p007', userId: 'u_demo3', ts: Date.now() - 310000 },
  ],
};

function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return ts || '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function barRow(label, count, max, color, onClick) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  const bar = el('div', { class: 'bar' }, [el('span', { style: `width:${pct}%; background:${color}` })]);
  const row = el('div', { class: 'bar-row' }, [
    el('div', { class: 'bar-label' }, label),
    bar,
    el('div', { class: 'bar-val' }, String(count)),
  ]);
  if (onClick) row.style.cursor = 'pointer', row.onclick = onClick;
  return row;
}

function summaryCard(label, value) {
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'stat-val' }, String(value)),
    el('div', { class: 'stat-label' }, label),
  ]);
}

function section(title, children) {
  return el('section', { class: 'analytics-block' }, [
    el('h3', {}, title),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

export async function renderAnalytics(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'THE OBSERVATORY'),
      el('h1', { class: 'page-display' }, '来源与行为洞察'),
      el('p', {}, '每一次浏览与选择，都在构成更准确的品味画像。'),
    ]),
    el('div', { class: 'page-intro-aside' }, [
      el('span', { class: 'intro-count' }, 'LIVE SIGNALS'),
      el('span', { class: 'intro-line', 'aria-hidden': 'true' }),
    ]),
  ]));
  const wrap = el('div', { class: 'analytics' });
  view.appendChild(wrap);
  loading(wrap, '加载分析数据…');

  const [liveStats, products] = await Promise.all([
    fetchStats(),
    getProducts().catch(() => []),
  ]);

  // 网关不可达 → 用内置示例数据兜底（顶部标注，不冒充真实埋点）
  const isSample = !liveStats;
  const stats = liveStats || SAMPLE_STATS;

  const nameOf = (id) => (products.find((p) => p.id === id) || {}).name || id || '—';
  const sources = Object.entries(stats.bySource).sort((a, b) => b[1] - a[1]);
  const events = Object.entries(stats.byEvent).sort((a, b) => b[1] - a[1]);
  const productsRank = Object.entries(stats.byProduct).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxSrc = sources.length ? sources[0][1] : 0;
  const maxEvt = events.length ? events[0][1] : 0;

  wrap.innerHTML = '';

  if (isSample) {
    wrap.appendChild(el('div', { class: 'demo-banner' }, [
      el('b', {}, '示例'),
      '未连接 AI 网关，以下为内置示例数据。本地启动 ai-gateway 后通过 ?api= 接入，即可看到真实埋点统计。',
    ]));
  }

  // 概览
  wrap.appendChild(el('div', { class: 'stat-cards' }, [
    summaryCard('总事件', stats.total),
    summaryCard('来源渠道', sources.length),
    summaryCard('涉及商品', productsRank.length ? Object.keys(stats.byProduct).length : 0),
  ]));

  // 来源渠道占比（按渠道着色）
  wrap.appendChild(section('来源渠道占比', sources.length
    ? sources.map(([src, n]) => {
        const meta = SOURCE_META[src];
        const label = (SOURCE_LABELS[src]) || src;
        return barRow(label, n, maxSrc, meta ? meta.color : NEUTRAL);
      })
    : el('div', { class: 'cart-empty' }, '暂无来源数据')));

  // 行为类型分布
  wrap.appendChild(section('行为类型分布', events.length
    ? events.map(([evt, n]) => barRow(EVENT_LABELS[evt] || evt, n, maxEvt, NEUTRAL))
    : el('div', { class: 'cart-empty' }, '暂无行为数据')));

  // Top 商品
  wrap.appendChild(section('Top 商品（按浏览/互动）', productsRank.length
    ? productsRank.map(([pid, n]) => barRow(nameOf(pid), n, productsRank[0][1], NEUTRAL,
        () => openProductDetail({ id: pid, name: nameOf(pid) }, 'analytics')))
    : el('div', { class: 'cart-empty' }, '暂无商品数据')));

  // 最近事件
  const recentRows = (stats.recent || []).slice(0, 15).map((r) => el('div', { class: 'evt-row' }, [
    el('span', { class: 'evt-time' }, fmtTime(r.ts)),
    el('span', { class: 'evt-event' }, EVENT_LABELS[r.event] || r.event),
    el('span', { class: 'evt-source' }, (SOURCE_LABELS[r.source]) || r.source || '—'),
    el('span', { class: 'evt-product' }, nameOf(r.productId)),
  ]));
  wrap.appendChild(section('最近事件', recentRows.length
    ? el('div', { class: 'evt-list' }, recentRows)
    : el('div', { class: 'cart-empty' }, '暂无事件')));
}
