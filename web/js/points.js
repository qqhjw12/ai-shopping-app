/**
 * points.js —— 积分 / 每日签到 / 任务中心 / 会员等级的视图层。
 *
 * 职责边界：只做「读数据层 → 渲染 → 把点击转给数据层动作」，
 * 不含任何积分规则（规则在 store/pointsConfig.js）、不碰商品数据、不改业务分支。
 * 两个入口：
 *   · renderPoints(view)     —— 独立路由 #/points 完整页；
 *   · renderPointsEntry()    —— 个人中心的精简签到卡（同一套数据层，实时联动）。
 *
 * 反馈纪律：只有 300ms 一次性积分上浮 + 轻量 toast（pointer-events:none），
 * 无弹窗、无无限循环动画；reduced-fx 下动效由 CSS 关闭。
 */
import { el } from './ui.js';
import {
  dateKey, calendarDays, levelProgress, getSnapshot, doSignIn, doClaim, subscribe,
} from './store/pointsStore.js';
import {
  SIGNIN_RULES, TASK_DEFS, TASK_TYPE_LABEL, TASK_STATUS, LEDGER_SHOW,
} from './store/pointsConfig.js';

/* ---------------- 轻量 toast：不遮挡操作（pointer-events 由 CSS 关闭） ---------------- */
function pointsToast(msg) {
  if (typeof document === 'undefined') return;
  const old = document.querySelector('.pt-toast');
  if (old) old.remove();
  const node = el('div', { class: 'pt-toast', role: 'status' }, msg);
  document.body.appendChild(node);
  setTimeout(() => node.classList.add('is-leaving'), 1900);
  setTimeout(() => node.remove(), 2200);
}

/** 积分数字上浮：300ms 一次性，animationend 后移除 class，绝不常驻 */
function bumpPoints() {
  if (typeof document === 'undefined') return;
  const node = document.querySelector('.pt-points-value');
  if (!node) return;
  node.classList.remove('is-bump');
  void node.offsetWidth;
  node.classList.add('is-bump');
  node.addEventListener('animationend', () => node.classList.remove('is-bump'), { once: true });
}

/** 所有签到按钮共用的点击处理（积分页 / 个人中心入口） */
function handleSignIn() {
  const result = doSignIn();
  if (!result.ok) {
    pointsToast('今日已签到，明天再来');
    return;
  }
  pointsToast(`+${result.amount} 积分${result.label ? ` · ${result.label}加成` : ''}`);
  bumpPoints();
}

function handleClaim(taskId) {
  const result = doClaim(taskId);
  if (!result.ok) {
    pointsToast(result.reason === 'claimed' ? '该奖励已领取' : '任务尚未完成');
    return;
  }
  pointsToast(`+${result.amount} 积分已入账`);
}

/* ---------------- 组件 ---------------- */

function pageHeader() {
  return el('header', { class: 'page-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'REWARD BASE'),
      el('h1', { class: 'page-display' }, '积分与任务'),
      el('p', {}, '签到、任务与等级进度，全部来自你的真实操作。'),
    ]),
  ]);
}

function signInCard(st) {
  const today = dateKey();
  const signedToday = st.account.lastSignInDate === today;
  const days = calendarDays(today);
  const cal = el('div', { class: 'pt-cal' }, days.map((key) => {
    const signed = st.account.signInDates.includes(key);
    return el('div', { class: `pt-day${key === today ? ' is-today' : ''}`, 'data-date': key }, [
      el('span', { class: `pt-dot${signed ? ' is-signed' : ''}`, 'data-signed': signed ? '1' : '0' }),
      el('span', { class: 'pt-day-label' }, key.slice(5).replace('-', '/')),
    ]);
  }));

  return el('div', { class: 'pt-card pt-signin-card' }, [
    el('div', { class: 'pt-card-head' }, [
      el('span', { class: 'pt-card-title' }, '每日签到'),
      el('span', { class: 'pt-streak' }, `连续 ${st.account.signInStreak} 天`),
    ]),
    el('div', { class: 'pt-label' }, '当前积分'),
    el('div', { class: 'pt-points-value', id: 'pt-points-value' }, st.account.points),
    cal,
    el('button', {
      type: 'button',
      class: 'pt-btn pt-signin-btn',
      id: 'pt-signin-btn',
      disabled: signedToday,
      onclick: handleSignIn,
    }, signedToday ? '今日已签到' : `签到 +${SIGNIN_RULES.base}`),
    el('div', { class: 'pt-hint' }, SIGNIN_RULES.hint),
  ]);
}

function levelCard(st) {
  const lp = levelProgress(st.account.totalEarned);
  return el('div', { class: 'pt-card pt-level-card' }, [
    el('div', { class: 'pt-card-head' }, [
      el('span', { class: 'pt-card-title' }, '会员等级'),
      el('span', { class: 'pt-level-name' }, `Lv${lp.current.level} ${lp.current.name}`),
    ]),
    el('div', { class: 'pt-label' }, '累计获得'),
    el('div', { class: 'pt-total-earned' }, st.account.totalEarned),
    el('div', { class: 'pt-level-track' }, [
      el('div', { class: 'pt-level-fill', style: `width:${(lp.ratio * 100).toFixed(1)}%` }),
    ]),
    el('div', { class: 'pt-hint' }, lp.next
      ? `距 Lv${lp.next.level} ${lp.next.name} 还差 ${lp.remain} 分`
      : '已达最高等级 · Lv5 收藏家'),
  ]);
}

function tasksCard(st) {
  return el('div', { class: 'pt-card pt-tasks-card' }, [
    el('div', { class: 'pt-card-head' }, [
      el('span', { class: 'pt-card-title' }, '任务中心'),
      el('span', { class: 'pt-hint' }, '进度由真实行为累加'),
    ]),
    ...TASK_DEFS.map((def) => {
      const t = st.tasks[def.id];
      const statusClass = t.status === TASK_STATUS.CLAIMABLE ? 'is-claimable'
        : t.status === TASK_STATUS.DONE ? 'is-done' : '';
      const action = t.status === TASK_STATUS.CLAIMABLE
        ? el('button', {
          type: 'button', class: 'pt-btn', 'data-claim': def.id,
          onclick: () => handleClaim(def.id),
        }, `领取 +${def.reward}`)
        : t.status === TASK_STATUS.DONE
          ? el('button', { type: 'button', class: 'pt-btn pt-btn--done', disabled: true }, '已领取')
          : el('span', { class: 'pt-task-progress' }, `${t.progress}/${def.target}`);
      return el('div', { class: 'pt-task', 'data-task': def.id }, [
        el('div', { class: 'pt-task-main' }, [
          el('div', { class: 'pt-task-title' }, [
            el('span', { class: 'pt-tag' }, TASK_TYPE_LABEL[def.type]),
            def.title,
          ]),
          el('div', { class: 'pt-task-desc' }, def.description),
        ]),
        el('div', { class: 'pt-task-side' }, [
          el('span', { class: `pt-badge ${statusClass}`, 'data-status': t.status }, t.status),
          action,
        ]),
      ]);
    }),
  ]);
}

function ledgerCard(st) {
  const rows = st.ledger.slice(0, LEDGER_SHOW);
  return el('div', { class: 'pt-card pt-ledger-card' }, [
    el('div', { class: 'pt-card-head' }, [
      el('span', { class: 'pt-card-title' }, '积分流水'),
      el('span', { class: 'pt-hint' }, `最近 ${rows.length} 条 / 共 ${st.ledger.length} 条`),
    ]),
    rows.length
      ? el('div', { class: 'pt-ledger-list' }, rows.map((x) => el('div', { class: 'pt-ledger-row' }, [
        el('span', { class: 'pt-ledger-type' }, x.type),
        el('span', { class: 'pt-ledger-desc' }, x.description),
        el('span', { class: 'pt-ledger-amount' }, `+${x.amount}`),
        el('span', { class: 'pt-ledger-time' }, String(x.createdAt).slice(0, 16).replace('T', ' ')),
      ])))
      : el('div', { class: 'pt-hint' }, '还没有积分记录，先去签到吧。'),
  ]);
}

/* ---------------- 入口 1：独立路由 #/points ---------------- */

export function renderPoints(view) {
  view.innerHTML = '';
  const page = el('section', { class: 'pt-page' });
  view.appendChild(page);

  const paint = () => {
    const st = getSnapshot();
    page.innerHTML = '';
    page.appendChild(pageHeader());
    page.appendChild(el('div', { class: 'pt-grid' }, [signInCard(st), levelCard(st)]));
    page.appendChild(tasksCard(st));
    page.appendChild(ledgerCard(st));
  };

  // 埋点 / 签到 / 领取都会 notify；页面离开 DOM 后自动退订，避免监听器堆积
  const off = subscribe(() => {
    if (!page.isConnected) { off(); return; }
    paint();
  });
  paint();
  return page;
}

/* ---------------- 入口 2：个人中心精简签到卡 ---------------- */

export function renderPointsEntry() {
  const root = el('div', { class: 'pt-card pt-entry-card' });
  const paint = () => {
    const st = getSnapshot();
    const lp = levelProgress(st.account.totalEarned);
    const signedToday = st.account.lastSignInDate === dateKey();
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'pt-entry-head' }, [
      el('span', { class: 'eyebrow' }, 'REWARD BASE'),
      el('a', { class: 'pt-entry-link', href: '#/points' }, '积分与任务 →'),
    ]));
    root.appendChild(el('div', { class: 'pt-entry-body' }, [
      el('div', { class: 'pt-entry-info' }, [
        el('div', { class: 'pt-label' }, '当前积分'),
        el('div', { class: 'pt-points-value pt-entry-points' }, st.account.points),
        el('div', { class: 'pt-hint' },
          `Lv${lp.current.level} ${lp.current.name} · 连续签到 ${st.account.signInStreak} 天`),
      ]),
      el('button', {
        type: 'button', class: 'pt-btn pt-entry-signin', disabled: signedToday,
        onclick: handleSignIn,
      }, signedToday ? '今日已签到' : `签到 +${SIGNIN_RULES.base}`),
    ]));
  };
  const off = subscribe(() => {
    if (!root.isConnected) { off(); return; }
    paint();
  });
  paint();
  return root;
}
