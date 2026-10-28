// 优惠券中心（#/coupons）：可领券列表 + 我的券包摘要。
//
// 页面只有一个动作（领取），所以不需要「先选再确认」这类中间态：
// 点击 → 立刻落盘 → 按钮变「已领取」+ 顶部计数 +1，用户不用刷新就知道领到了。
// 未登录可以浏览（券是公开信息），但领取必须登录——点击时带 redirect 跳登录，
// 登录回来还落在券中心，不会把人丢到首页。
import { el, toast } from './ui.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import {
  STATE_TEXT, claimCoupon, currentCatalog, fetchCatalog, fmtCouponValue, listWallet,
  onWalletChange, syncWallet, walletStats,
} from './store/couponStore.js';

function fmtDay(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 折扣券的减免百分比：amount=10 → 「10」（即减一成，9 折） */
function trimPct(n) {
  return String(Math.round((Number(n) || 0) * 10) / 10).replace(/\.0$/, '');
}

export function renderCoupons(view) {
  const user = getCurrentUser();
  view.innerHTML = '';

  const page = el('section', { class: 'cp-page' });
  const walletBar = el('div', { class: 'cp-wallet-bar' });
  const grid = el('div', { class: 'cp-grid' });

  page.appendChild(el('header', { class: 'cp-hero' }, [
    el('div', { class: 'cp-hero-main' }, [
      el('span', { class: 'eyebrow' }, 'COUPON CENTER'),
      el('h1', { class: 'page-display' }, '优惠券中心'),
      el('p', { class: 'cp-hero-note' }, '领取后自动存入券包，结算时按你的购物袋自动匹配最优的一张'),
    ]),
    walletBar,
  ]));
  page.appendChild(grid);
  page.appendChild(el('p', { class: 'cp-foot-note' },
    '优惠券不可兑换现金，每笔订单限用一张；面额为演示数据，接入真实券池后由运营配置。'));
  view.appendChild(page);

  /* ---------------- 我的券包摘要 ---------------- */
  function paintWallet() {
    walletBar.innerHTML = '';
    if (!user) {
      walletBar.appendChild(el('div', { class: 'cp-wallet cp-wallet-guest' }, [
        el('span', { class: 'cp-wallet-label' }, '我的券包'),
        el('span', { class: 'cp-wallet-hint' }, '登录后查看已领取的优惠券'),
        el('a', {
          class: 'cp-wallet-link',
          href: `#/login?redirect=${encodeURIComponent('/coupons')}`,
        }, '登录 →'),
      ]));
      return;
    }
    const s = walletStats(user.id);
    const chip = (key, label, n) => el('a', {
      class: `cp-stat cp-stat-${key}`,
      href: '#/account?tab=coupons',
    }, [
      el('b', { class: 'cp-stat-n num' }, String(n)),
      el('span', { class: 'cp-stat-label' }, label),
    ]);
    walletBar.appendChild(el('div', { class: 'cp-wallet' }, [
      el('div', { class: 'cp-wallet-head' }, [
        el('span', { class: 'cp-wallet-label' }, '我的券包'),
        el('a', { class: 'cp-wallet-link', href: '#/account?tab=coupons' }, '查看全部 →'),
      ]),
      el('div', { class: 'cp-stats' }, [
        chip('unused', STATE_TEXT.unused, s.unused),
        chip('used', STATE_TEXT.used, s.used),
        chip('expired', STATE_TEXT.expired, s.expired),
      ]),
    ]));
  }

  /* ---------------- 券卡列表 ---------------- */
  function paintGrid() {
    grid.innerHTML = '';
    // 可领取的排在前面：用户进来是为了领券，已领的只是状态回显
    const mine = user ? listWallet(user.id) : [];
    const held = new Set(mine.filter((w) => w.state === 'unused').map((w) => String(w.couponId)));
    const rows = [...currentCatalog()].sort((a, b) => {
      const ca = held.has(String(a.id));
      const cb = held.has(String(b.id));
      if (ca !== cb) return ca ? 1 : -1;
      return (Number(a.threshold) || 0) - (Number(b.threshold) || 0);
    });
    rows.forEach((c) => grid.appendChild(ticket(c)));
  }

  function ticket(c) {
    const mine = user ? listWallet(user.id).filter((w) => String(w.couponId) === String(c.id)) : [];
    // 只要还有一张未使用的就算已领取（与网关判重口径一致）；用掉之后可以再领一次
    const claimed = mine.some((w) => w.state === 'unused');
    const heldExpiry = claimed ? mine.find((w) => w.state === 'unused').expiresAt : 0;
    const isDiscount = c.kind === 'discount';
    const btn = el('button', {
      class: `cp-claim${claimed ? ' is-claimed' : ''}`,
      type: 'button',
      disabled: claimed,
      'aria-label': claimed ? `${c.title} 已领取` : `领取 ${c.title}`,
    }, claimed ? '已领取' : (user ? '立即领取' : '登录后领取'));

    btn.addEventListener('click', async () => {
      if (claimed || btn.disabled) return;
      if (!user) {
        toast('登录后即可领取', 'warn');
        navigate(`#/login?redirect=${encodeURIComponent('/coupons')}`);
        return;
      }
      btn.disabled = true;
      const res = await claimCoupon(user.id, c.id);
      if (!res.ok) {
        btn.disabled = false;
        toast(res.error || '领取失败', res.error === '该券已在卡包中' ? 'warn' : 'err');
        paintGrid();
        paintWallet();
        return;
      }
      toast('已存入我的券包', 'ok');
      paintGrid();
      paintWallet();
    });

    return el('article', {
      class: `cp-ticket${claimed ? ' is-claimed' : ''}${isDiscount ? ' is-discount' : ''}`,
      'data-coupon': c.id,
    }, [
      el('div', { class: 'cp-ticket-val' }, [
        el('span', { class: 'cp-ticket-num num' }, [
          isDiscount ? null : el('span', { class: 'cp-ticket-cur' }, '¥'),
          el('b', {}, String(isDiscount ? 10 - Number(c.amount) / 10 : c.amount).replace(/\.0$/, '')),
          isDiscount ? el('span', { class: 'cp-ticket-unit' }, '折') : null,
        ]),
        el('span', { class: 'cp-ticket-cond' }, `满 ${fmtCouponValue({ kind: 'cash', amount: c.threshold })} 可用`),
      ]),
      el('div', { class: 'cp-ticket-line', 'aria-hidden': 'true' }),
      el('div', { class: 'cp-ticket-body' }, [
        el('h3', { class: 'cp-ticket-title' }, c.title),
        el('ul', { class: 'cp-ticket-meta' }, [
          claimed && heldExpiry
            ? el('li', { class: 'is-held' }, `已领取 · ${fmtDay(heldExpiry)} 到期`)
            : el('li', {}, `有效期：领取后 ${c.validDays} 天`),
          el('li', {}, `适用范围：${c.scopeText || '全场通用'}`),
          c.note ? el('li', { class: 'is-note' }, c.note) : null,
        ]),
        el('div', { class: 'cp-ticket-foot' }, [
          el('span', { class: 'cp-ticket-val-text num' },
            isDiscount
              ? `下单立减 ${trimPct(c.amount)}%`
              : `可抵 ${fmtCouponValue(c)}`),
          btn,
        ]),
      ]),
    ]);
  }

  paintWallet();
  paintGrid();

  // 领券 / 核销 / 返还都走同一份券包：其他页面（结算、订单详情）动了券，这里自动跟随
  const off = onWalletChange((uid) => {
    if (!user || String(uid) !== String(user.id)) return;
    paintWallet();
    paintGrid();
  });

  // 联网时先对齐券目录（运营配置以服务端为准）再同步券包；
  // 静态托管下两个请求都 404，安静回落到本地，不刷屏也不报错。
  if (user) {
    Promise.all([fetchCatalog(), syncWallet(user.id)])
      .then(([, res]) => {
        paintWallet();
        paintGrid();
        if (res && res.online && res.adopted) {
          toast(`已与本账号同步 ${res.adopted} 张券的变更`, 'ok');
        }
      })
      .catch((e) => console.warn('[coupons] 同步失败', e && e.message));
  } else {
    fetchCatalog().then(() => paintGrid()).catch(() => {});
  }

  // 离开页面时退订，避免多次进入叠加回调
  const clean = () => {
    off();
    window.removeEventListener('hashchange', clean);
  };
  window.addEventListener('hashchange', clean);

  return page;
}
