// 首页顶部「秒杀」区：一块嵌在暖色杂志页里的深空指挥舱。
//
// 视觉语言（Deep Space Command）刻意与全站其余部分不同源：
// 全站是浅色暖金，这里是近黑青绿底 + 单一霓虹 #22D3EE + 等宽读数 + 景深层叠。
// 之所以允许它「不一样」而不是全站换肤——秒杀在信息结构上本来就是异质的：
// 其他区块在讲故事，这一块在报数（还剩多久、还剩几件、抢到没有）。
//
// 但异质不等于失控：三种颜色的活儿分得很死——
//   青 #22D3EE 只用于「信号」：状态灯、倒计时数字、秒杀价、进度条、主按钮；
//   近黑只做底，不参与表意；
//   白只做正文。没有第四种颜色，也就不会滑向赛博朋克的多彩霓虹。
import { el, fmtPrice, productThumb, toast, updateCartBadge } from './ui.js';
import { addToCart } from './state.js';
import { navigate } from './router.js';
import { trackEvent } from './track.js';
import {
  readActive, phaseOf, remainingOf, markSold, onFlashChange,
} from './store/flashSaleStore.js';

let timer = null;
let unsubscribe = null;

const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

function clockParts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/** 停掉上一块秒杀区的计时器与订阅：路由离开后还每秒跑一次 DOM 查询就是纯泄漏 */
export function stopFlashSale() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/** 原价锚点：优先用商品自己的 originalPrice，没有就退回到秒杀前的售价 */
function listPriceOf(p, item) {
  const origin = Number(p.originalPrice);
  if (origin > item.price) return origin;
  const cur = Number(p.price);
  return cur > item.price ? cur : 0;
}

function offText(listPrice, salePrice) {
  if (!listPrice || listPrice <= salePrice) return '';
  return `-${Math.round((1 - salePrice / listPrice) * 100)}%`;
}

/* ============================================================
   单张秒杀卡
   ============================================================ */

function flashCard({ product: p, item, sale, phase, onGrab }) {
  const listPrice = listPriceOf(p, item);
  const left = item.stock - item.sold;
  const pct = item.stock > 0 ? Math.round((item.sold / item.stock) * 100) : 100;
  const soldOut = left <= 0;
  const buyable = phase === 'live' && !soldOut;

  const href = `#/product/${encodeURIComponent(p.id)}?from=flash`;

  const buyBtn = el('button', {
    type: 'button',
    class: `fs-buy${buyable ? '' : ' is-off'}`,
    disabled: buyable ? null : 'disabled',
    // 售罄与「未开始/已结束」要给出不同的话：同一个「不可购买」，
    // 用户需要知道是抢光了还是没开场
    onclick: () => onGrab(p, item, { jump: true }),
  }, soldOut ? '已抢光' : phase === 'pending' ? '即将开场' : phase === 'ended' ? '本场结束' : '立即抢购');

  const addBtn = el('button', {
    type: 'button',
    class: 'fs-add',
    'aria-label': `按秒杀价将 ${p.name} 加入购物袋`,
    disabled: buyable ? null : 'disabled',
    title: '按秒杀价加入购物袋',
    onclick: () => onGrab(p, item, { jump: false }),
  }, [
    el('span', { 'aria-hidden': 'true' }, '+'),
    el('span', { class: 'fs-add-word' }, '加购'),
  ]);

  const node = el('article', { class: 'fs-card', 'data-pid': String(p.id) }, [
    el('a', { class: 'fs-shot', href, 'aria-label': p.name, tabindex: '-1' }, [
      productThumb(p, { fade: false }),
      offText(listPrice, item.price) ? el('span', { class: 'fs-off' }, offText(listPrice, item.price)) : null,
    ]),
    el('div', { class: 'fs-body' }, [
      el('span', { class: 'fs-brand' }, p.isMerchant ? '商家直供' : (p.brand || p.category || 'MAISON')),
      el('a', { class: 'fs-name', href, title: p.name }, p.name),
      el('div', { class: 'fs-price-row' }, [
        el('span', { class: 'fs-price' }, fmtPrice(item.price)),
        listPrice ? el('del', { class: 'fs-was' }, fmtPrice(listPrice)) : null,
      ]),
      el('div', {
        class: 'fs-bar',
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': String(item.stock),
        'aria-valuenow': String(item.sold),
        'aria-label': `${p.name} 已抢 ${pct}%`,
      }, [el('i', { class: 'fs-bar-fill', style: `--p:${pct / 100}` })]),
      el('div', { class: 'fs-row' }, [
        el('span', {}, `已抢 ${pct}%`),
        el('span', { class: 'fs-left' }, soldOut ? '已售罄' : `剩 ${left} 件`),
      ]),
      el('div', { class: 'fs-acts' }, [buyBtn, addBtn]),
    ]),
  ]);

  // 把按钮引用一并交出去：阶段变化时逐个改 disabled / 文案，
  // 比 querySelectorAll('.fs-buy') 再反查商品更直接，也不依赖 DOM 查询能力
  return { node, buyBtn, addBtn, item, product: p };
}

/* ============================================================
   整块
   ============================================================ */

/**
 * 渲染首页秒杀区。
 * @param {Array} products 商品池（用于把 productId 还原成商品）
 * @param {{ onGone?: Function }} opts onGone 在没有可展示场次时回调，页面据此收起占位
 * @returns {HTMLElement|null}
 */
export function renderFlashSale(products = [], { onGone } = {}) {
  stopFlashSale();

  const active = readActive(products);
  if (!active) {
    if (typeof onGone === 'function') onGone();
    return null;
  }

  const { sale } = active;
  const byId = new Map(products.map((p) => [String(p.id), p]));
  // 配置里的商品可能已被下架：能还原的才展示，剩不下一件时整块收起
  const entries = sale.items
    .map((item) => ({ item, product: byId.get(item.productId) }))
    .filter((e) => e.product);

  if (!entries.length) {
    if (typeof onGone === 'function') onGone();
    return null;
  }

  const totalStock = entries.reduce((s, e) => s + e.item.stock, 0);
  const totalSold = entries.reduce((s, e) => s + e.item.sold, 0);
  const totalPct = totalStock > 0 ? Math.round((totalSold / totalStock) * 100) : 0;

  /* ---- HUD：左舱 ---- */
  const digits = [el('span', { class: 'fs-digit' }), el('i', { class: 'fs-colon' }, ':'),
    el('span', { class: 'fs-digit' }), el('i', { class: 'fs-colon' }, ':'),
    el('span', { class: 'fs-digit' })];
  const clockLabel = el('span', { class: 'fs-clock-label' }, 'ENDS IN');
  const liveDot = el('i', { class: 'fs-dot', 'aria-hidden': 'true' });
  const stateWord = el('span', { class: 'fs-state' }, 'LIVE');
  const meterFill = el('i', { class: 'fs-meter-fill', style: `--p:${totalPct / 100}` });
  const meterRead = el('div', { class: 'fs-meter-read' }, [
    el('span', {}, `已抢 ${totalSold}`),
    el('span', {}, `共 ${totalStock} 件`),
  ]);

  const hud = el('div', { class: 'fs-hud' }, [
    el('div', { class: 'fs-hud-top' }, [
      el('span', { class: 'fs-signal' }, [liveDot, stateWord]),
      el('span', { class: 'fs-proto' }, sale.protocol),
    ]),
    el('h2', { class: 'fs-title' }, sale.title),
    el('div', { class: 'fs-clock' }, [clockLabel, el('div', { class: 'fs-digits' }, digits)]),
    sale.note ? el('p', { class: 'fs-note' }, sale.note) : null,
    el('div', { class: 'fs-meter' }, [meterFill]),
    meterRead,
  ]);

  /* ---- 抢购动作 ---- */
  function onGrab(p, item, { jump }) {
    const phase = phaseOf(sale);
    if (phase === 'ended') {
      toast('本场已结束，等下一场开场', 'warn');
      return;
    }
    if (phase === 'paused') {
      toast('本场已暂停，稍后再来', 'warn');
      return;
    }
    if (phase === 'pending') {
      toast('还没开场，开场后就能抢', 'warn');
      return;
    }
    if (remainingOf(item) <= 0) {
      toast('这件已经被抢光了', 'warn');
      return;
    }

    // 秒杀条目用 `flash-<场次>` 当 skuId：购物袋的 key 是 productId::skuId，
    // 这样秒杀价条目与原价条目在袋子里是两行，不会互相改价。
    // localOnly —— 秒杀价只存在于本机这份场次配置里，推到服务端会被服务端价覆盖回原价，
    // 等于秒杀白做；价格由本地场次兜底，下单时仍走既有结算链路。
    addToCart({
      ...p,
      price: item.price,
      originalPrice: listPriceOf(p, item) || p.price,
      spec: `秒杀价 · ${sale.title}`,
    }, 1, `flash-${sale.id}`, { localOnly: true });

    updateCartBadge();
    trackEvent({ event: 'add_to_cart', source: 'flash', productId: p.id });
    markSold(item.productId, 1);
    toast(`已按秒杀价 ${fmtPrice(item.price)} 锁定：${p.name}`, 'ok');
    if (jump) navigate('#/checkout?from=flash');
  }

  /* ---- 轨道：右舱 ---- */
  const cards = entries.map((e) => flashCard({ ...e, sale, phase: active.phase, onGrab }));

  const track = el('div', { class: 'fs-track' }, cards.map((c) => c.node));
  const step = (dir) => {
    if (typeof track.scrollBy !== 'function') return;
    track.scrollBy({ left: dir * Math.max(240, track.clientWidth * 0.8), behavior: 'smooth' });
  };

  const nav = el('div', { class: 'fs-nav' }, [
    el('button', { type: 'button', class: 'fs-arrow', 'aria-label': '向前看', onclick: () => step(-1) }, '‹'),
    el('button', { type: 'button', class: 'fs-arrow', 'aria-label': '向后看', onclick: () => step(1) }, '›'),
  ]);

  const stage = el('div', { class: 'fs-stage' }, [
    el('div', { class: 'fs-stage-head' }, [
      el('span', { class: 'fs-stage-label' }, `${entries.length} 件在抢`),
      nav,
    ]),
    track,
  ]);

  const section = el('section', {
    class: 'fs-sale',
    'aria-label': `秒杀活动：${sale.title}`,
    // 阶段是 DOM 上的一个属性：e2e 与样式都以它为准，不必再从文案反推
    'data-phase': active.phase,
    'data-sale': sale.id,
  }, [
    el('div', { class: 'fs-grid', 'aria-hidden': 'true' }),
    hud,
    stage,
  ]);

  /* ---- 每秒一次：只碰文本与宽度，不做布局动画 ---- */
  function paintClock() {
    const phase = phaseOf(sale);
    const left = Math.max(0, sale.endAt - Date.now());
    const { h, m, s } = clockParts(left);

    if (phase === 'pending') {
      const untilStart = Math.max(0, sale.startAt - Date.now());
      const p = clockParts(untilStart);
      [p.h, p.m, p.s].forEach((v, i) => { digits[i * 2].textContent = pad2(v); });
      clockLabel.textContent = 'STARTS IN';
      stateWord.textContent = 'ARMED';
      liveDot.classList.remove('is-live');
    } else if (phase === 'ended') {
      [0, 0, 0].forEach((v, i) => { digits[i * 2].textContent = pad2(v); });
      clockLabel.textContent = 'CAPTURED';
      stateWord.textContent = 'CLOSED';
      liveDot.classList.remove('is-live');
    } else {
      [h, m, s].forEach((v, i) => { digits[i * 2].textContent = pad2(v); });
      clockLabel.textContent = 'ENDS IN';
      stateWord.textContent = phase === 'paused' ? 'HOLD' : 'LIVE';
      liveDot.classList.toggle('is-live', phase === 'live');
    }

    if (phase !== section.dataset.phase) {
      section.dataset.phase = phase;
      applyPhase(phase);
    }
    return phase;
  }

  /** 阶段变了才动按钮：每秒重刷全部按钮的 disabled 会让正在点击的手感变差 */
  function applyPhase(phase) {
    cards.forEach(({ buyBtn, addBtn, item }) => {
      const soldOut = item.stock - item.sold <= 0;
      const ok = phase === 'live' && !soldOut;
      buyBtn.classList.toggle('is-off', !ok);
      buyBtn.disabled = !ok;
      buyBtn.textContent = soldOut
        ? '已抢光'
        : phase === 'pending' ? '即将开场' : phase === 'ended' ? '本场结束' : '立即抢购';
      addBtn.disabled = !ok;
    });
  }

  paintClock();
  timer = setInterval(() => {
    // 路由切走后这块已经被摘掉了：计时器继续跑就是在为一个不存在的节点每秒算一次时间
    if (!section.isConnected) {
      stopFlashSale();
      return;
    }
    const phase = paintClock();
    if (phase === 'ended') {
      // 收舱后停表：继续每秒跑一次是在烧电
      if (timer) clearInterval(timer);
      timer = null;
    }
  }, 1000);

  // 同一浏览器的其他标签页改了场次（或本页 markSold）→ 重画整块。
  // 重画而不是打补丁，是因为库存变化可能连带改变「已抢光」这类文案，逐字段同步更易漏。
  unsubscribe = onFlashChange(() => {
    const host = section.parentNode;
    if (!host) return;
    const next = renderFlashSale(products, { onGone });
    if (next) host.replaceChild(next, section);
    else host.removeChild(section);
  });

  return section;
}

/** 供测试与后台预览：判断现在是否该出现这块 */
export function flashSaleVisible(products = []) {
  const active = readActive(products);
  return Boolean(active && active.sale);
}
