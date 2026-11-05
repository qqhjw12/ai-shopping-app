// 心愿单：收藏页的「公开心愿单」开关 + 公开页（#/wishlist/:id，免登录可看）。
//
// 权限边界（刻意如此）：
//   · 公开页对**所有人**可读，包括未登录访客——强制登录才能许愿是很差的体验，
//     而且这份页面只有商品 id、理由和助力数，没有任何账号信息。
//   · 助力不要求登录，但按 scopeId() 去重，同一个人刷十次也只算一次。
//   · 领奖要求登录：券要发到「券包」，券包是按用户 id 存的，游客身份没有券包可发。
//     未登录时如实提示，而不是假装领到了。
//
// 奖励面额一律来自券目录（title / threshold），页面不写死「减 20」这类文案。
import { el, emptyEditorial, fmtPrice, productThumb, toast } from './ui.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import { catalogCoupon, claimCoupon, currentCatalog } from './store/couponStore.js';
import { scopeId } from './store/userScope.js';
import {
  WL_COPY,
  WL_REASON_MAX,
  WL_REASON_PRESETS,
} from './store/wishlistConfig.js';
import {
  canHelp, claimableTiers, displayReason, getPublic, help, loadBoard, markNoticesRead,
  markTierClaimed, publish, pushOwnerNotice, setReason, syncPublic, tierProgress, unpublish,
  unreadNotices, validateTiers,
} from './store/wishlistStore.js';

/* ==================== 小工具 ==================== */

/** 阶梯奖励的可读文案：以券目录为准，配置里只留 couponId。 */
function tierRewardText(tier) {
  const c = catalogCoupon(tier.couponId);
  return c ? c.title : tier.couponId;
}

/** 进度条：1px 青色细线，宽度按阈值归一化。 */
function progressBar(ratio, label) {
  const fill = el('span', { class: 'wl-progress-fill', style: `width:${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` });
  return el('div', { class: 'wl-progress-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-label': label }, [fill]);
}

function isOwner(pub) {
  return Boolean(pub && pub.ownerScope && pub.ownerScope === scopeId());
}

/** 复制公开链接（mock，不接任何分享 SDK）。 */
function copyPublicLink(pub) {
  const url = `${location.origin}${location.pathname}#/wishlist/${encodeURIComponent(pub.id)}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url)
      .then(() => toast(WL_COPY.copied, 'ok'))
      .catch(() => toast(WL_COPY.copyFail, 'warn'));
  } else {
    toast(WL_COPY.copyFail, 'warn');
  }
}

/* ==================== 收藏页：公开开关面板 ==================== */

/**
 * 收藏页顶部的公开面板。
 * favIds 是「当前收藏的商品 id（按收藏顺序）」，开关打开时就是这份快照被公开出去；
 * 收藏增删后再次进入收藏页会重新发布，公开页不会残留已取关的商品。
 */
export function wishlistPanel(favIds = []) {
  const host = el('section', { class: 'wl-panel' });
  const ids = (Array.isArray(favIds) ? favIds : []).map(String).filter(Boolean);

  // 收藏增删后自动刷新公开快照：否则公开页会残留已取关的商品。
  // 收藏清空时直接收回公开——一份空心愿单分享出去只会让人以为页面坏了。
  const seed = loadBoard();
  if (seed.public && seed.id) {
    if (ids.length) syncPublic(ids, { ownerName: seed.ownerName, reason: seed.reason });
    else unpublish();
  }

  const paint = () => {
    host.innerHTML = '';
    const board = loadBoard();
    const pub = board.id ? getPublic(board.id) : null;
    const on = Boolean(pub);

    // 配置体检：阶梯里的券必须真实存在，否则达标也发不出去（只警告，不阻塞页面）
    validateTiers(currentCatalog());

    const notices = unreadNotices();
    if (notices.length) {
      host.appendChild(el('div', { class: 'wl-notice', role: 'status' }, [
        el('span', { class: 'wl-notice-dot', 'aria-hidden': 'true' }),
        el('div', { class: 'wl-notice-body' }, [
          el('b', {}, WL_COPY.noticeTitle),
          el('span', {}, notices.map((n) => WL_COPY.noticeBody(tierRewardText({ couponId: n.couponId }))).join(' · ')),
        ]),
        el('button', {
          class: 'wl-line-btn', type: 'button',
          onclick: () => { markNoticesRead(); paint(); },
        }, '知道了'),
      ]));
    }

    const switchRow = el('div', { class: 'wl-switch-row' }, [
      el('label', { class: 'wl-switch' }, [
        el('input', {
          type: 'checkbox', checked: on,
          'aria-label': WL_COPY.publicToggle,
          onchange: (e) => {
            const want = Boolean(e.target.checked);
            if (want) {
              if (!ids.length) { toast(WL_COPY.publicEmpty, 'warn'); e.target.checked = false; return; }
              const r = publish(ids, {
                ownerName: (getCurrentUser() && getCurrentUser().nickname) || '',
                reason: loadBoard().reason || WL_REASON_PRESETS[0],
              });
              if (!r.ok) { toast('公开失败，请重试', 'err'); e.target.checked = false; return; }
              toast('心愿单已公开，可以复制链接发给朋友了', 'ok');
            } else {
              unpublish();
              toast('已收回公开', 'ok');
            }
            paint();
          },
        }),
        el('span', { class: 'wl-switch-track', 'aria-hidden': 'true' }, [el('span', { class: 'wl-switch-knob' })]),
        el('span', { class: 'wl-switch-label' }, WL_COPY.publicToggle),
      ]),
      el('span', { class: 'wl-switch-hint' }, on ? WL_COPY.publicOn : WL_COPY.publicOff),
    ]);
    host.appendChild(switchRow);

    if (!on) return;

    const prog = tierProgress(pub);
    const reasonInput = el('input', {
      class: 'wl-reason-input', type: 'text', maxlength: String(WL_REASON_MAX),
      value: displayReason(pub), 'aria-label': WL_COPY.reasonLabel,
      placeholder: WL_REASON_PRESETS[0],
    });

    host.appendChild(el('div', { class: 'wl-public-row' }, [
      reasonInput,
      el('button', {
        class: 'wl-line-btn', type: 'button',
        onclick: () => {
          const text = reasonInput.value;
          setReason(text);
          if (ids.length) syncPublic(ids, { reason: text });
          toast('心愿理由已更新', 'ok');
          paint();
        },
      }, '保存理由'),
      el('button', { class: 'wl-line-btn', type: 'button', onclick: () => copyPublicLink(pub) }, WL_COPY.copyLink),
      el('a', { class: 'wl-line-btn', href: `#/wishlist/${encodeURIComponent(pub.id)}` }, WL_COPY.openPublic),
    ]));

    host.appendChild(el('div', { class: 'wl-mini-progress' }, [
      el('span', { class: 'wl-mini-text' }, prog.next
        ? WL_COPY.progress(prog.have, prog.next.need)
        : WL_COPY.progressDone(prog.have)),
      progressBar(prog.ratio, '助力进度'),
    ]));

    const mine = claimableTiers(pub);
    if (mine.length) {
      host.appendChild(el('div', { class: 'wl-claim-row' }, mine.map((t) => el('button', {
        class: 'wl-claim-btn', type: 'button',
        onclick: () => claimReward(pub, t, paint),
      }, `${WL_COPY.claimCta} · ${tierRewardText(t)}`))));
    }
    host.appendChild(el('p', { class: 'wl-owner-hint' }, WL_COPY.ownerHint));
  };

  paint();
  return host;
}

/** 领奖：券要进券包，所以必须有真实登录用户。 */
async function claimReward(pub, tier, onDone) {
  const user = getCurrentUser();
  if (!user || !user.id) { toast(WL_COPY.claimLogin, 'warn'); return; }
  try {
    await claimCoupon(user.id, tier.couponId);
    markTierClaimed(pub.id, tier.threshold);
    toast(WL_COPY.claimToast(tierRewardText(tier)), 'ok');
    if (typeof onDone === 'function') onDone();
  } catch (e) {
    toast((e && e.message) || '领取失败，请稍后重试', 'err');
  }
}

/* ==================== 公开页（免登录） ==================== */

export async function renderWishlist(view, id) {
  view.innerHTML = '';
  const pub = getPublic(id);

  if (!pub) {
    view.appendChild(emptyEditorial({
      title: WL_COPY.notFound,
      text: '链接可能已失效，或主人收回了公开。',
      primaryLabel: WL_COPY.notFoundCta,
      onPrimary: () => navigate('#/products'),
    }));
    return;
  }

  const { getProductById } = await import('./views.js');
  const prog = tierProgress(pub);
  const mine = isOwner(pub);
  const gate = canHelp(pub, scopeId());

  /* --- 头部 --- */
  const page = el('div', { class: 'wl-page' });
  view.appendChild(page);
  page.appendChild(el('header', { class: 'wl-head' }, [
    el('span', { class: 'eyebrow' }, WL_COPY.eyebrow),
    el('h1', { class: 'page-display' }, pub.ownerName ? `${pub.ownerName} 的心愿单` : '一份心愿单'),
    el('p', { class: 'wl-head-note' }, `${WL_COPY.itemsCount(pub.products.length)} · ${WL_COPY.visitors(prog.have)}`),
  ]));

  /* --- 心愿理由 --- */
  page.appendChild(el('section', { class: 'wl-reason-card' }, [
    el('span', { class: 'wl-reason-label' }, WL_COPY.reasonLabel),
    el('p', { class: 'wl-reason-text' }, `「${displayReason(pub)}」`),
  ]));

  /* --- 助力进度 --- */
  const tierChips = el('div', { class: 'wl-tiers' }, prog.tiers.map((t) => el('span', {
    class: `wl-tier${t.unlocked ? ' is-on' : ''}`,
  }, t.unlocked ? WL_COPY.tierUnlocked(tierRewardText(t)) : WL_COPY.tierLocked(tierRewardText(t), t.need))));

  page.appendChild(el('section', { class: 'wl-progress-card' }, [
    el('div', { class: 'wl-progress-head' }, [
      el('b', { class: 'wl-progress-num num' }, String(prog.have)),
      el('span', { class: 'wl-progress-text' }, prog.next
        ? WL_COPY.progress(prog.have, prog.next.need)
        : WL_COPY.progressDone(prog.have)),
    ]),
    progressBar(prog.ratio, '助力进度'),
    tierChips,
  ]));

  /* --- 商品列表（单列，图片不加载真实头像/大图以外的资源） --- */
  const list = el('section', { class: 'wl-items' });
  const resolved = await Promise.all(pub.products.map((pid) => getProductById(pid).catch(() => null)));
  let shown = 0;
  resolved.forEach((p, i) => {
    if (!p) return;
    shown += 1;
    list.appendChild(el('a', { class: 'wl-item', href: `#/product/${encodeURIComponent(p.id)}` }, [
      el('div', { class: 'wl-item-media' }, productThumb(p)),
      el('div', { class: 'wl-item-info' }, [
        el('div', { class: 'wl-item-name' }, p.name || '商品'),
        el('div', { class: 'wl-item-meta num' }, `${fmtPrice(p.price)}${p.brand ? ` · ${p.brand}` : ''}`),
      ]),
      el('span', { class: 'wl-item-idx num' }, String(i + 1).padStart(2, '0')),
    ]));
  });
  if (!shown) list.appendChild(el('p', { class: 'wl-empty' }, WL_COPY.emptyPublic));
  page.appendChild(list);

  /* --- 主人侧：领奖 --- */
  if (mine) {
    const claimable = claimableTiers(pub);
    if (claimable.length) {
      page.appendChild(el('section', { class: 'wl-owner-claim' }, [
        el('p', { class: 'wl-owner-hint' }, WL_COPY.ownerHint),
        el('div', { class: 'wl-claim-row' }, claimable.map((t) => el('button', {
          class: 'wl-claim-btn', type: 'button',
          onclick: () => claimReward(pub, t, () => renderWishlist(view, pub.id)),
        }, `${WL_COPY.claimCta} · ${tierRewardText(t)}`))),
      ]));
    }
    page.appendChild(el('p', { class: 'wl-owner-hint' }, '这是你的公开页。别人看到的和你看到的一样。'));
    return;
  }

  /* --- 访客侧：助力按钮吸底 --- */
  const btn = el('button', {
    class: 'wl-help-btn',
    type: 'button',
    disabled: !gate.ok,
    onclick: () => {
      const r = help(pub.id);
      if (!r.ok) {
        const msg = r.reason === 'done' ? WL_COPY.duplicateHelp
          : r.reason === 'self' ? WL_COPY.selfHelp
            : r.reason === 'maxed' ? '这份心愿单已经拿满奖励了'
              : '助力失败，请重试';
        toast(msg, 'warn');
        return;
      }
      if (r.unlocked) {
        // 跨过阈值：给主人留一条通知（同源 localStorage，主人下次打开收藏页就能看到）
        pushOwnerNotice(r.public, r.unlocked);
        toast(`助力成功，${tierRewardText(r.unlocked)}已解锁`, 'ok');
      } else {
        toast(WL_COPY.helpedToast, 'ok');
      }
      renderWishlist(view, pub.id);
    },
  }, gate.ok ? WL_COPY.helpCta : (gate.reason === 'done' ? WL_COPY.helpedCta : WL_COPY.helpCta));

  page.appendChild(el('div', { class: 'wl-bar' }, [
    el('span', { class: 'wl-bar-note' }, WL_COPY.loginHint),
    btn,
  ]));
}
