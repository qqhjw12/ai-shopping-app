/**
 * blindbox.js —— 独立路由 #/blindbox：AI 盲盒推荐。
 *
 * 商品池来自 views.js 的 getProducts()（全站同一真源），所以开出的商品
 * 一定能「查看详情 / 加入购物袋 / 加入收藏」，不是一堆与商品库无关的假卡。
 * 偏好、次数、推荐理由、动效节奏全部由配置与数据层决定，本文件只画界面。
 */
import { el, productCard } from './ui.js';
import { getProducts, openProductDetail, doAdd } from './views.js';
import { getSnapshot as pointsSnapshot } from './store/pointsStore.js';
import {
  PREF_DIMENSIONS, MAX_PREFERENCES, BLINDBOX_RULES as R, BB_COPY,
} from './store/blindboxConfig.js';
import {
  getSnapshot, subscribe, doOpenBox, doSwap, doSetPrefs,
  resolveProduct, swapQuota, canonicalPrefs, prefsLabel,
} from './store/blindboxStore.js';
import { bbToast } from './fortune.js';

export function renderBlindbox(view) {
  view.innerHTML = '';
  const page = el('section', { class: 'bb-page' });
  view.appendChild(page);

  let pool = [];
  // 偏好是「刷新后状态保持」的一部分：数据层把 box.prefs 落盘了，这里必须读回来。
  // 否则刷新后 UI 回到「不设限」，点「换一个」还会用空偏好把已存的 box.prefs 抹掉。
  const initial = getSnapshot();
  let selected = canonicalPrefs(
    Object.keys(initial.box.prefs || {}).length ? initial.box.prefs
      : ((initial.box.current && initial.box.current.prefs) || {}),
  );
  let animateNext = false; // 每次成功抽取播一次 300ms 一次性开盒动效

  /* ---------------- 偏好选择 ---------------- */
  function commitPrefs() {
    // doSetPrefs 内部 notify → 订阅重绘；save 失败时没有通知，用一次显式 paint 兜底
    if (!doSetPrefs(selected)) paint();
  }

  function onChip(dim, opt) {
    const next = { ...selected };
    if (next[dim.key] === opt.id) delete next[dim.key];
    else {
      if (Object.keys(next).length >= MAX_PREFERENCES && !next[dim.key]) {
        bbToast(`最多选 ${MAX_PREFERENCES} 个偏好维度，先取消一个`, 'warn');
        return;
      }
      next[dim.key] = opt.id;
    }
    selected = canonicalPrefs(next);
    commitPrefs();
  }

  function prefsBlock(st) {
    const chosen = Object.keys(selected).length;
    return el('div', { class: 'bb-prefs' }, [
      el('div', { class: 'bb-prefs-head' }, [
        el('span', { class: 'eyebrow' }, 'PREFERENCES / 偏好维度'),
        el('span', { class: 'bb-prefs-count' }, `已选 ${chosen} / ${MAX_PREFERENCES}（可不选）`),
      ]),
      ...PREF_DIMENSIONS.map((dim) => el('div', { class: 'bb-pref-row', 'data-dim': dim.key }, [
        el('span', { class: 'bb-pref-label' }, [dim.label, el('small', {}, dim.hint)]),
        el('div', { class: 'bb-chips' }, dim.options.map((opt) => el('button', {
          type: 'button',
          class: `bb-chip${selected[dim.key] === opt.id ? ' is-active' : ''}`,
          'data-pref': opt.id,
          'aria-pressed': selected[dim.key] === opt.id ? 'true' : 'false',
          onclick: () => onChip(dim, opt),
        }, opt.label))),
      ])),
      el('div', { class: 'bb-prefs-foot' }, [
        el('span', { class: 'bb-prefs-summary' },
          `${prefsLabel(selected)}${chosen ? (st.box.opened ? ' · 换一个时生效' : ' · 开盒时生效') : ''}`),
        chosen
          ? el('button', {
            type: 'button', class: 'bb-text-btn', id: 'bb-prefs-clear',
            onclick: () => { selected = {}; commitPrefs(); },
          }, '清空偏好')
          : null,
      ]),
    ]);
  }

  /* ---------------- 结果区 ---------------- */
  function resultBlock(st) {
    // 首屏 paint 是同步的，而 getProducts() 是异步的：池还没到位时 pool=[]，
    // 不能把 resolveProduct([]) === null 当成「商品下架」，否则每次刷新都会先闪一帧错误文案。
    if (!pool.length) {
      return el('div', { class: 'bb-result' }, [
        el('div', { class: 'bb-empty' }, BB_COPY.emptyPick),
      ]);
    }
    const p = resolveProduct(pool, st.box.current && st.box.current.productId);
    const q = swapQuota(st);
    const balance = pointsSnapshot().account.points;

    const frame = el('div', { class: 'bb-reveal-frame', 'aria-hidden': 'true' });
    const body = el('div', { class: 'bb-result-body' }, [
      el('div', { class: 'bb-result-tag' }, BB_COPY.eyebrow),
      p
        ? productCard(p, {
          className: 'bb-pcard',
          onDetail: (x) => openProductDetail(x, 'blindbox'),
          onAddCart: (x) => doAdd(x, 'blindbox'),
        })
        : el('div', { class: 'bb-empty' }, '这件好物暂时不在目录里了，换一个看看。'),
      el('p', { class: 'bb-reason' }, [
        el('span', { class: 'bb-reason-label' }, '为什么推荐给你'),
        el('span', { class: 'bb-reason-text' }, (st.box.current && st.box.current.reason) || ''),
      ]),
      el('div', { class: 'bb-result-actions' }, [
        el('button', {
          type: 'button',
          class: 'bb-btn bb-swap',
          id: 'bb-swap-btn',
          disabled: !q.canFree && !q.canPoints,
          'data-via': q.canPoints ? 'points' : 'free',
          onclick: () => onSwap(),
        }, q.canPoints
          ? `${BB_COPY.swapBtn} · ${R.pointsPerSwap} 积分（剩 ${q.pointLeft} 次）`
          : `${BB_COPY.swapBtn}（今日剩 ${q.freeLeft} 次）`),
        el('span', { class: 'bb-balance' }, `当前 ${balance} 积分`),
      ]),
      q.exhausted
        ? el('div', { class: 'bb-exhausted' }, [
          el('span', {}, BB_COPY.exhausted),
          el('a', { class: 'bb-text-link', href: '#/points' }, '去任务中心赚积分 →'),
        ])
        : null,
    ]);

    const wrap = el('div', { class: 'bb-result' }, [frame, body]);
    if (animateNext) {
      animateNext = false;
      wrap.classList.add('is-opening');
      // 一次性：animationend 移除 class；reduced-fx 下无动画，用 420ms 兜底清掉
      frame.addEventListener('animationend', () => wrap.classList.remove('is-opening'), { once: true });
      setTimeout(() => wrap.classList.remove('is-opening'), 420); // reduced-fx 下无动画，兜底清 class
    }
    return wrap;
  }

  function closedBlock(st) {
    const ready = pool.length > 0;
    return el('div', { class: 'bb-closed' }, [
      el('div', { class: 'bb-box-mark', 'aria-hidden': 'true' }, [
        el('span', {}, '◇'),
        el('span', { class: 'bb-box-mark-label' }, 'AI BLINDBOX'),
      ]),
      el('p', { class: 'bb-closed-copy' }, ready ? BB_COPY.boxHint : BB_COPY.emptyPick),
      el('button', {
        type: 'button', class: 'bb-btn bb-open', id: 'bb-open-btn', disabled: !ready,
        onclick: () => {
          animateNext = true;
          const r = doOpenBox(pool, selected);
          if (!r.ok) {
            animateNext = false;
            bbToast(r.reason === 'limit' ? '今天的次数用完了，明天再来' : '这次没开成，稍后再试', 'warn');
          } else bbToast(`开出了 ${r.product.name}`);
        },
      }, BB_COPY.openBtn),
      st.box.draws > 0 ? el('span', { class: 'bb-hint' }, '刷新不会重置今天的次数') : null,
    ]);
  }

  function onSwap() {
    animateNext = true;
    const r = doSwap(pool, selected);
    if (!r.ok) {
      animateNext = false;
      if (r.reason === 'insufficient') bbToast('积分不够，去任务中心做点任务再来', 'warn');
      else if (r.reason === 'limit') bbToast('今天的次数用完了，明天再来', 'warn');
      else bbToast('这次没换成功，稍后再试', 'warn');
      return;
    }
    bbToast(`换成了 ${r.product.name}`);
  }

  /* ---------------- 整页重绘 ---------------- */
  function paint() {
    const st = getSnapshot();
    const q = swapQuota(st);
    page.innerHTML = '';
    page.appendChild(el('div', { class: 'bb-head' }, [
      el('span', { class: 'eyebrow' }, 'AI BLINDBOX / 惊喜选品'),
      el('h1', {}, BB_COPY.boxTitle),
      el('p', {}, BB_COPY.boxHint),
    ]));
    page.appendChild(el('div', { class: 'bb-panel' }, [
      prefsBlock(st),
      el('div', { class: 'bb-stage', id: 'bb-stage' },
        st.box.opened && st.box.current ? resultBlock(st) : closedBlock(st)),
    ]));
    page.appendChild(el('div', { class: 'bb-quota' }, [
      el('span', {}, `今日已抽 ${st.box.draws} / ${R.maxDrawsPerDay} 次`),
      el('span', {}, `免费换一个 ${st.box.swaps} / ${R.freeSwaps}`),
      el('span', {}, `积分兑换 ${st.box.pointSwaps} / ${R.maxPointSwaps}`),
      el('span', { class: 'bb-quota-state' }, q.exhausted ? '今日次数已用尽' : '次数按用户 + 日期隔离'),
    ]));
  }

  // 首屏同步画骨架，再异步取全站商品池；池到位后重绘（偏好/次数不丢）
  paint();
  getProducts().then((list) => {
    pool = Array.isArray(list) ? list : [];
    if (page.isConnected) paint();
  }).catch(() => {
    pool = [];
    if (page.isConnected) paint();
  });

  const off = subscribe(() => {
    if (!page.isConnected) { off(); return; }
    paint();
  });
  return page;
}
