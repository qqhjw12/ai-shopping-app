// 拼团视图：PDP 发起弹层 + 拼团大厅（#/group-buy）+ 团详情（#/group-buy/:id）。
//
// 三个实现约束：
//   1) 倒计时只用**一个**页级 interval，节点被路由摘掉就自停。每张卡片各起一个 setInterval
//      是最容易写出「切页后还在跑」的地方，这里统一走 mountCountdowns()。
//   2) 状态不缓存：每次渲染都从仓储重读，并用 groupStatus(group, now) 现算，
//      所以「模拟好友参团」之后无需任何补丁逻辑，重画一次就是新的真相。
//   3) 分享是 mock：复制的是本站 hash 链接 + 二维码占位，不接任何第三方 SDK。
//      +积分走积分体系既有的 share 行为，不新造奖励通道。
import { el, emptyEditorial, fmtPrice, openModal, productThumb, toast } from './ui.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import { addToCart } from './state.js';
import { recordBehavior } from './store/pointsStore.js';
import {
  GB_COPY, GB_OWNER_FALLBACK, GB_QR_NOTE, GB_SHARE_REWARD, GB_STATUS, GB_STATUS_TEXT,
  GB_TIERS, GB_TICK_MS, gbShareHash,
} from './store/groupBuyConfig.js';
import {
  createGroup, fmtCountdown, gbDiscountPct, getGroup, groupStatus, isUrgent, listGroups, markShared,
  pendingCheckout, remainingMs, remainingSlots, setPendingCheckout, simulateJoin, tierBySize,
} from './store/groupBuyStore.js';

/* ==================== 小工具 ==================== */

/** 团长昵称：未登录用配置里的兜底值，不用「匿名用户」这种听起来像出错的词。 */
function ownerName() {
  const u = getCurrentUser();
  const n = u && (u.nickname || u.name);
  return String(n || GB_OWNER_FALLBACK).slice(0, 24);
}

/** 圆形头像占位：只渲染昵称首字，不加载任何真实头像。 */
function avatarNode(member, index) {
  const name = String((member && member.name) || '好友');
  return el('span', {
    class: `gb-avatar${member && member.owner ? ' is-owner' : ''}`,
    title: member && member.owner ? `${name} · ${GB_COPY.ownerTag}` : name,
    'aria-label': `${name}${member && member.owner ? ` ${GB_COPY.ownerTag}` : ''}`,
    style: `--i:${index}`,
  }, name.slice(0, 1));
}

/** 空位占位：让「还差几个人」在视觉上一眼可见，不用读文字。 */
function emptySlotNode() {
  return el('span', { class: 'gb-avatar is-empty', 'aria-hidden': 'true' }, '+');
}

function statusPill(status) {
  return el('span', { class: `gb-status is-${status}` }, GB_STATUS_TEXT[status] || '—');
}

/**
 * 页级倒计时：一个 interval 驱动所有节点，只改 textContent / class。
 * 停止条件有两个——节点全被摘掉（路由切走）或所有团都不再是「待成团」。
 */
function mountCountdowns(pairs) {
  const live = pairs.filter((p) => p && p.node);
  if (!live.length) return () => {};
  let timer = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const paint = (p) => {
    const st = groupStatus(p.group);
    if (st === GB_STATUS.OPEN) {
      const left = remainingMs(p.group);
      p.node.textContent = fmtCountdown(left);
      p.node.classList.toggle('is-urgent', isUrgent(p.group));
    } else {
      p.node.textContent = st === GB_STATUS.FORMED ? GB_COPY.full : '—';
      p.node.classList.remove('is-urgent');
    }
    return st === GB_STATUS.OPEN;
  };
  const tick = () => {
    // 路由切走后 DOM 里已经没有这些节点，立即收手，避免整页驻留的 interval
    if (!live.some((p) => p.node.isConnected)) { stop(); return; }
    const anyOpen = live.map(paint).some(Boolean);
    if (!anyOpen) stop();
  };
  tick();
  timer = setInterval(tick, GB_TICK_MS);
  return stop;
}

/** 二维码占位：用团号的字符码点生成 25 格伪随机点阵，纯 CSS 渲染，不引库。 */
function qrPlaceholder(seed) {
  const s = String(seed || 'GB');
  const cells = [];
  for (let i = 0; i < 25; i += 1) {
    const code = s.charCodeAt(i % s.length) + i * 7;
    cells.push(el('span', { class: code % 3 === 0 ? 'on' : '' }));
  }
  return el('div', { class: 'gb-qr', role: 'img', 'aria-label': GB_QR_NOTE, title: GB_QR_NOTE }, cells);
}

/** mock 分享：复制 hash 链接 + 触发一次 share 行为（积分体系里的既定任务）。 */
function copyInviteLink(group) {
  const url = `${location.origin}${location.pathname}${gbShareHash(group.id)}`;
  const done = () => {
    markShared(group.id);
    // 分享奖励走积分体系既有的 share 任务：这里只负责「记录行为」，
    // 真正的 +N 积分由用户在积分页领取，所以文案不能说「已到账」。
    recordBehavior('share');
    toast(`${GB_COPY.inviteCopied} · ${GB_COPY.inviteTaskHint(GB_SHARE_REWARD)}`, 'ok');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => toast(GB_COPY.inviteFail, 'warn'));
  } else {
    toast(GB_COPY.inviteFail, 'warn');
  }
}

/* ==================== PDP：发起拼团弹层 ==================== */

/**
 * 发起拼团：档位选择 + 团价实时预览，确认后建团并跳到团详情。
 * 团价当着用户的面算，绝不出现「创建后再告诉你多少钱」。
 */
export function openGroupBuySheet(product) {
  if (!product || !product.id) return;
  const pid = String(product.id);
  const unitPrice = Number(product.price) || 0;
  if (!unitPrice) {
    toast('该商品暂无价格，无法开团', 'warn');
    return;
  }
  let size = 3;

  openModal((modal, close) => {
    modal.classList.add('is-narrow');
    const priceBox = el('div', { class: 'gb-pricebox' });
    const tierList = el('div', { class: 'gb-tiers', role: 'radiogroup', 'aria-label': '选择成团人数' });

    const paintPrice = () => {
      const tier = tierBySize(size);
      const gp = Math.round(unitPrice * (1 - tier.discount) * 100) / 100;
      priceBox.innerHTML = '';
      priceBox.appendChild(el('div', { class: 'gb-pricebox-row' }, [
        el('span', { class: 'gb-price-label' }, GB_COPY.groupPriceLabel),
        el('b', { class: 'gb-price-main num' }, fmtPrice(gp)),
        el('span', { class: 'gb-price-save num' }, GB_COPY.priceSave(gbDiscountPct(tier.discount))),
      ]));
      priceBox.appendChild(el('div', { class: 'gb-pricebox-sub' }, [
        el('span', {}, `${GB_COPY.singlePriceLabel} ${fmtPrice(unitPrice)}`),
        el('span', { class: 'num' }, `每位省 ${fmtPrice(Math.round((unitPrice - gp) * 100) / 100)}`),
      ]));
      // 档位按钮同步选中态（不用重建节点，避免点一次跳一次焦点）
      Array.from(tierList.children).forEach((btn, i) => {
        const on = GB_TIERS[i].size === size;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };

    GB_TIERS.forEach((t) => {
      tierList.appendChild(el('button', {
        class: 'gb-tier', type: 'button', role: 'radio',
        'aria-checked': t.size === size ? 'true' : 'false',
        onclick: () => { size = t.size; paintPrice(); },
      }, [
        el('span', { class: 'gb-tier-label' }, t.label),
        el('span', { class: 'gb-tier-off num' }, GB_COPY.priceSave(gbDiscountPct(t.discount))),
        el('span', { class: 'gb-tier-hint' }, t.hint),
      ]));
    });

    const submit = el('button', { class: 'gb-submit', type: 'submit' }, GB_COPY.createCta);

    const form = el('form', {
      class: 'gb-sheet',
      onsubmit: (e) => {
        e.preventDefault();
        const r = createGroup(product, size, ownerName());
        if (!r.ok) {
          toast(r.reason === 'full' ? '你的团太多了，先去拼团大厅清理一下' : '开团失败，请重试', 'err');
          return;
        }
        close();
        toast(GB_COPY.createdToast(r.group.no), 'ok');
        navigate(`#/group-buy/${encodeURIComponent(r.group.id)}`);
      },
    }, [
      el('span', { class: 'eyebrow' }, GB_COPY.eyebrow),
      el('h2', { class: 'gb-sheet-title' }, GB_COPY.startTitle),
      el('p', { class: 'gb-sheet-lead' }, GB_COPY.startLead),
      el('div', { class: 'gb-sheet-product' }, [
        el('div', { class: 'gb-thumb' }, productThumb(product)),
        el('div', { class: 'gb-thumb-info' }, [
          el('div', { class: 'gb-thumb-name' }, product.name || '商品'),
          el('div', { class: 'gb-thumb-spec num' }, fmtPrice(unitPrice)),
        ]),
      ]),
      tierList,
      priceBox,
      el('div', { class: 'gb-sheet-actions' }, [
        el('button', { class: 'gb-cancel', type: 'button', onclick: () => close() }, '先不开了'),
        submit,
      ]),
    ]);

    paintPrice();
    modal.appendChild(form);
  });
}

/** PDP 上的入口按钮（由 views.js 挂到次要操作区）。 */
export function groupBuyButton(product, className = '') {
  return el('button', {
    class: `gb-start-btn ${className}`.trim(),
    type: 'button',
    onclick: () => openGroupBuySheet(product),
  }, [
    el('span', { class: 'gb-start-ico', 'aria-hidden': 'true' }, '◎'),
    GB_COPY.startCta,
  ]);
}

/* ==================== 拼团大厅 ==================== */

function groupCard(g, { onOpen }) {
  const st = groupStatus(g);
  const tier = tierBySize(g.size);
  const left = remainingSlots(g);
  const countdown = el('span', { class: 'gb-count num' }, fmtCountdown(Math.max(0, remainingMs(g))));
  const members = g.members.map((m, i) => avatarNode(m, i));
  for (let i = 0; i < left; i += 1) members.push(emptySlotNode());

  const card = el('article', { class: 'gb-card', onclick: onOpen, tabindex: '0', role: 'link', 'aria-label': `${g.product.name} ${g.no}` }, [
    el('div', { class: 'gb-card-media' }, productThumb({ id: g.productId, name: g.product.name, coverColor: g.product.coverColor })),
    el('div', { class: 'gb-card-main' }, [
      el('div', { class: 'gb-card-top' }, [
        statusPill(st),
        el('span', { class: 'gb-card-no num' }, g.no),
      ]),
      el('div', { class: 'gb-card-name' }, g.product.name || '商品'),
      el('div', { class: 'gb-card-price' }, [
        el('b', { class: 'num' }, fmtPrice(g.groupPrice)),
        el('s', { class: 'num' }, fmtPrice(g.unitPrice)),
        el('span', { class: 'gb-card-off num' }, GB_COPY.priceSave(gbDiscountPct(g.discount))),
      ]),
      el('div', { class: 'gb-card-members' }, members),
      el('div', { class: 'gb-card-foot' }, [
        el('span', { class: 'gb-card-left' }, st === GB_STATUS.OPEN ? GB_COPY.remaining(left) : GB_STATUS_TEXT[st]),
        st === GB_STATUS.OPEN ? countdown : el('span', { class: 'gb-card-left' }, `${tier.label}`),
      ]),
    ]),
  ]);
  return { card, countdown, group: g };
}

export async function renderGroupBuyList(view) {
  view.innerHTML = '';
  let tab = 'open';

  view.appendChild(el('header', { class: 'gb-heading' }, [
    el('div', {}, [
      el('span', { class: 'eyebrow' }, GB_COPY.eyebrow),
      el('h1', { class: 'page-display' }, GB_COPY.title),
    ]),
    el('p', { class: 'gb-heading-note' }, GB_COPY.lead),
  ]));

  const tabs = el('div', { class: 'gb-tabs', role: 'tablist' });
  const grid = el('div', { class: 'gb-grid' });
  view.appendChild(tabs);
  view.appendChild(grid);

  const paint = () => {
    tabs.innerHTML = '';
    ['open', 'done'].forEach((key) => {
      tabs.appendChild(el('button', {
        class: `gb-tab${tab === key ? ' is-on' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': tab === key ? 'true' : 'false',
        onclick: () => { tab = key; paint(); },
      }, key === 'open' ? GB_COPY.filterOpen : GB_COPY.filterDone));
    });

    const all = listGroups();
    const list = all.filter((g) => (tab === 'open'
      ? groupStatus(g) === GB_STATUS.OPEN
      : groupStatus(g) !== GB_STATUS.OPEN));

    grid.innerHTML = '';
    if (!list.length) {
      grid.appendChild(emptyEditorial({
        title: tab === 'open' ? GB_COPY.emptyTitle : '这里还没有结束的团',
        text: tab === 'open' ? GB_COPY.emptyLead : '成团或过期后，团会落到这里留档',
        primaryLabel: tab === 'open' ? GB_COPY.emptyCta : '',
        onPrimary: tab === 'open' ? () => navigate('#/products') : undefined,
      }));
      return;
    }
    const pairs = [];
    list.forEach((g) => {
      const { card, countdown } = groupCard(g, {
        onOpen: () => navigate(`#/group-buy/${encodeURIComponent(g.id)}`),
      });
      grid.appendChild(card);
      pairs.push({ node: countdown, group: g });
    });
    mountCountdowns(pairs);
  };

  paint();
}

/* ==================== 团详情 ==================== */

export async function renderGroupBuyDetail(view, id, query = {}) {
  view.innerHTML = '';
  const group = getGroup(id);

  if (!group) {
    view.appendChild(emptyEditorial({
      title: GB_COPY.notFound,
      text: '链接可能来自另一台设备，或这个团已被清理。',
      primaryLabel: GB_COPY.notFoundCta,
      onPrimary: () => navigate('#/group-buy'),
    }));
    return;
  }

  view.appendChild(el('a', { class: 'back-link', href: '#/group-buy' }, '← 返回拼团大厅'));
  // 移动端底部有固定操作条：正文包一层，给吸底条留出让位空间
  const page = el('div', { class: 'gb-page' });
  view.appendChild(page);

  const { getProductById } = await import('./views.js');
  const product = await getProductById(group.productId);
  const st = groupStatus(group);
  const left = remainingSlots(group);
  const tier = tierBySize(group.size);
  const countdown = el('span', { class: 'gb-detail-count num' }, fmtCountdown(Math.max(0, remainingMs(group))));

  if (query && query.invite) {
    page.appendChild(el('div', { class: 'gb-invite-bar', role: 'status' }, [
      el('span', { class: 'gb-invite-dot', 'aria-hidden': 'true' }),
      GB_COPY.inviteLanding,
    ]));
  }

  /* --- 团主体 --- */
  const members = group.members.map((m, i) => avatarNode(m, i));
  for (let i = 0; i < left; i += 1) members.push(emptySlotNode());

  const headCard = el('section', { class: 'gb-detail-card' }, [
    el('div', { class: 'gb-detail-top' }, [
      statusPill(st),
      el('span', { class: 'gb-detail-no num' }, `团号 ${group.no}`),
      el('span', { class: 'gb-detail-tier' }, tier.label),
    ]),
    el('div', { class: 'gb-detail-body' }, [
      el('div', { class: 'gb-detail-media' }, productThumb({ id: group.productId, name: group.product.name, coverColor: group.product.coverColor })),
      el('div', { class: 'gb-detail-info' }, [
        el('div', { class: 'gb-detail-name' }, group.product.name || '商品'),
        el('div', { class: 'gb-detail-price' }, [
          el('b', { class: 'num' }, fmtPrice(group.groupPrice)),
          el('s', { class: 'num' }, fmtPrice(group.unitPrice)),
          el('span', { class: 'gb-card-off num' }, GB_COPY.priceSave(gbDiscountPct(group.discount))),
        ]),
        el('div', { class: 'gb-detail-left' }, st === GB_STATUS.OPEN ? GB_COPY.remaining(left) : GB_STATUS_TEXT[st]),
        el('div', { class: 'gb-detail-deadline' }, [
          el('span', { class: 'gb-detail-label' }, `${GB_COPY.deadlineLabel} `),
          st === GB_STATUS.OPEN ? countdown : el('span', { class: 'num' }, String(group.deadlineAt || '').slice(5, 16).replace('T', ' ')),
        ]),
      ]),
    ]),
    el('div', { class: 'gb-detail-members' }, [
      el('div', { class: 'gb-detail-mlabel' }, `${GB_COPY.membersTitle} ${group.members.length}/${group.size}`),
      el('div', { class: 'gb-avatars' }, members),
    ]),
    product ? null : el('p', { class: 'gb-warn' }, GB_COPY.noProduct),
  ]);

  /* --- 分享 --- */
  const shareCard = el('section', { class: 'gb-share-card' }, [
    el('div', { class: 'gb-share-copy' }, [
      el('h3', { class: 'gb-share-title' }, GB_COPY.shareTitle),
      el('p', { class: 'gb-share-note' }, `复制链接发给朋友一起拼；分享任务记 1 次，${GB_COPY.inviteTaskHint(GB_SHARE_REWARD)}。`),
      el('div', { class: 'gb-share-actions' }, [
        el('button', { class: 'gb-invite-btn', type: 'button', onclick: () => copyInviteLink(group) }, GB_COPY.inviteCta),
        el('a', { class: 'gb-line-btn', href: `#/product/${encodeURIComponent(group.productId)}` }, '看商品'),
      ]),
    ]),
    qrPlaceholder(group.no),
  ]);

  /* --- 演示区：模拟好友参团（刻意做得不显眼） --- */
  const simBtn = el('button', {
    class: 'gb-sim',
    type: 'button',
    disabled: st !== GB_STATUS.OPEN && st !== GB_STATUS.FORMED,
    onclick: () => {
      const r = simulateJoin(group.id);
      if (!r.ok) {
        const msg = r.reason === 'formed' ? GB_COPY.full
          : r.reason === 'expired' ? GB_COPY.failedToast
            : '参团失败，请重试';
        toast(msg, 'warn');
        return;
      }
      toast(r.reason === 'formed' ? GB_COPY.formedToast : `${r.name} ${GB_COPY.simulateDone}`, 'ok');
      renderGroupBuyDetail(view, group.id, {});
    },
  }, GB_COPY.simulateCta);

  /* --- 吸底操作条 --- */
  const formed = st === GB_STATUS.FORMED;
  const buyBtn = el('button', {
    class: 'gb-buy-btn',
    type: 'button',
    disabled: !formed || !product,
    onclick: () => {
      if (!product) { toast(GB_COPY.noProduct, 'warn'); return; }
      // 团价直接作为商品价格传入购物袋：结算页显示的金额 == 这里的团价
      addToCart({ ...product, price: group.groupPrice }, 1, null);
      setPendingCheckout(group);
      const pend = pendingCheckout();
      toast(pend ? `已按拼团价 ${fmtPrice(group.groupPrice)} 加入结算` : '结算草稿写入失败，请重试', pend ? 'ok' : 'warn');
      if (pend) navigate('#/checkout');
    },
  }, formed ? GB_COPY.checkoutCta : GB_COPY.remaining(Math.max(1, left)));

  const bar = el('div', { class: 'gb-bar' }, [
    el('div', { class: 'gb-bar-price' }, [
      el('span', { class: 'gb-bar-label' }, GB_COPY.groupPriceLabel),
      el('b', { class: 'num' }, fmtPrice(group.groupPrice)),
    ]),
    buyBtn,
  ]);

  page.appendChild(headCard);
  page.appendChild(shareCard);
  // 演示按钮只在「待成团」时出现：已成团/已失败的团点了也没有语义
  if (st === GB_STATUS.OPEN) {
    page.appendChild(el('div', { class: 'gb-sim-row' }, [simBtn, el('span', { class: 'gb-sim-hint' }, GB_COPY.simulateHint)]));
  }
  page.appendChild(bar);

  mountCountdowns([{ node: countdown, group }]);
}
