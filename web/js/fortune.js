/**
 * fortune.js —— 首页「今日一签」卡 + 盲盒玩法共用的轻量提示。
 *
 * 刻意做成安静排版：等宽日期、衬线短句、--color-surface-2 底、没有弹窗、
 * 没有抽奖转盘、没有「大吉 / 运势」这类措辞。每天首次打开生成一次，状态
 * 由 blindboxStore 按 用户 + 日期 持久化；刷新、换账号、跨天都由数据层负责。
 */
import { el, fmtPrice } from './ui.js';
import { addFavorite } from './store/favoriteStore.js';
import { getSnapshot as pointsSnapshot } from './store/pointsStore.js';
import {
  BLINDBOX_RULES as R, BB_COPY,
} from './store/blindboxConfig.js';
import {
  doFortune, doRerollFortune, doAcceptFortune,
  getSnapshot, subscribe, resolveProduct, canRerollFortune,
} from './store/blindboxStore.js';

/** 轻量 toast：固定、不拦截点击、240ms 一次性淡入，reduced-fx 下直接静态显示 */
export function bbToast(msg, kind = 'ok') {
  if (typeof document === 'undefined' || !document.body) return;
  // 连续操作只留最新一条，避免多条 toast 堆叠遮挡按钮
  document.querySelectorAll('.bb-toast').forEach((n) => n.remove());
  const t = el('div', {
    class: `bb-toast${kind === 'warn' ? ' is-warn' : ''}`,
    role: 'status',
    'aria-live': 'polite',
  }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

export function renderHomeFortune(products) {
  // 幂等：当天已生成则原样返回，绝不因为刷新/重进首页就换签
  doFortune(products);

  const root = el('section', { class: 'ft-card', 'aria-label': '今日一签' });

  const paint = () => {
    const st = getSnapshot();
    const p = resolveProduct(products, st.fortune.productId);
    const accepted = Boolean(st.fortune.accepted);
    const canReroll = canRerollFortune(st);
    const affordable = pointsSnapshot().account.points >= R.fortuneRerollCost;
    const dateText = String(st.date || '').replace(/-/g, ' / ');

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'ft-head' }, [
      el('span', { class: 'ft-eyebrow' }, BB_COPY.fortuneEyebrow),
      el('span', { class: 'ft-date' }, dateText),
    ]));
    root.appendChild(el('p', { class: 'ft-quote' }, `「${st.fortune.quote || '今天也慢慢来。'}」`));

    root.appendChild(el('div', { class: 'ft-good' }, [
      el('span', { class: 'ft-good-label' }, '今日好物'),
      p
        ? el('a', {
          class: 'ft-good-name',
          href: `#/product/${encodeURIComponent(p.id)}?from=fortune`,
        }, p.name)
        : el('span', { class: 'ft-good-name is-missing' }, '暂不可见'),
      p ? el('span', { class: 'ft-good-price' }, fmtPrice(p.price)) : null,
    ]));

    root.appendChild(el('div', { class: 'ft-actions' }, [
      el('button', {
        type: 'button',
        class: 'bb-btn ft-accept',
        disabled: accepted || !p,
        onclick: () => {
          if (!p) return;
          const added = addFavorite(p);
          doAcceptFortune();
          bbToast(added ? '已收下今日好物，放进收藏夹了' : '它已经在收藏夹里了', added ? 'ok' : 'warn');
        },
      }, accepted ? BB_COPY.fortuneAccepted : BB_COPY.fortuneAccept),
      el('button', {
        type: 'button',
        class: 'bb-btn ft-reroll',
        disabled: !canReroll || !affordable,
        onclick: () => {
          const r = doRerollFortune(products);
          if (r.ok) bbToast(`−${R.fortuneRerollCost} 积分 · 换了一句今天的话`);
          else if (r.reason === 'insufficient') bbToast('积分不够，去任务中心做点任务再来', 'warn');
          else if (r.reason === 'limit') bbToast('今天已经再抽过一次了，明天见', 'warn');
          else bbToast('这次没抽成，稍后再试', 'warn');
        },
      }, `${BB_COPY.fortuneReroll} · ${R.fortuneRerollCost} 积分`),
    ]));

    root.appendChild(el('div', { class: 'ft-hint' },
      `每天首次打开生成一次 · 再抽每日限 ${R.fortuneRerollLimit} 次 · 当前 ${pointsSnapshot().account.points} 积分`));
  };

  const off = subscribe(() => {
    if (!root.isConnected) { off(); return; }
    paint();
  });
  paint();
  return root;
}
