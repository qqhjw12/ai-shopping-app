// 订单成功页（#/order-success/:orderId）：下单后的落地页。
//
// 只认 id，不认「上一页传过来的状态」——刷新、分享、从历史回退都能靠本地订单复原。
// 订单找不到时给可行动的出口，而不是一片空白。
import { el, fmtPrice } from './ui.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import { getOrder, statusText } from './store/orderStore.js';

function fmtTime(iso) {
  const s = String(iso || '');
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderOrderSuccess(view, orderId) {
  const user = getCurrentUser();
  if (!user) {
    navigate(`#/login?redirect=${encodeURIComponent(`/order-success/${orderId}`)}`);
    return;
  }
  const id = decodeURIComponent(String(orderId || ''));
  const order = getOrder(user.id, id);

  view.innerHTML = '';

  if (!order) {
    view.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, '没有找到这笔订单'),
        el('p', { class: 'sub' }, `订单号 ${id || '（空）'} 不在当前账户名下，可能已被清理或属于其他账号。`),
        el('div', { class: 'os-actions' }, [
          el('a', { class: 'os-btn', href: '#/account?tab=orders' }, '查看我的订单'),
          el('a', { class: 'os-btn ghost', href: '#/products' }, '继续购物'),
        ]),
      ]),
    );
    return;
  }

  const a = order.amounts || {};
  const addr = order.address;
  const meta = [
    ['订单状态', statusText(order.status)],
    ['下单时间', fmtTime(order.createdAt)],
    ['配送方式', `${order.shippingMethod.name} · ${order.shippingMethod.eta || ''}`.trim()],
    ['支付方式', order.paymentMethod.name],
    ...(a.couponDiscount
      ? [['优惠券', `${a.couponTitle ? `${a.couponTitle} ` : ''}- ${fmtPrice(a.couponDiscount)}`]]
      : []),
    ['收货信息', addr ? `${addr.receiver} ${addr.phone || ''} · ${addr.region} ${addr.detail || ''}` : '—'],
    ['商品件数', `${order.items.reduce((n, i) => n + (Number(i.qty) || 0), 0)} 件`],
  ];

  view.appendChild(
    el('section', { class: 'os-page' }, [
      el('a', { class: 'back-link', href: '#/products' }, '← 继续购物'),
      el('div', { class: 'os-card' }, [
        el('div', { class: 'os-seal', 'aria-hidden': 'true' }, '✓'),
        el('span', { class: 'eyebrow' }, 'THE ORDER IS PLACED'),
        el('h1', { class: 'os-title' }, '订单已提交'),
        el('p', { class: 'os-sub' }, order.status === 'pending'
          ? '我们已为你锁定库存，请在 24 小时内完成付款。'
          : '订单已进入处理流程，可在「我的订单」里跟进。'),
        el('div', { class: 'os-id' }, [
          el('span', { class: 'os-id-label' }, '订单号'),
          el('strong', { class: 'os-id-value num' }, order.id),
        ]),
        el('div', { class: 'os-amount' }, [
          el('span', { class: 'os-amount-label' }, '应付金额'),
          el('span', { class: 'os-amount-value num' }, fmtPrice(a.payAmount)),
        ]),
        el('dl', { class: 'os-meta' }, meta.map(([k, v]) => el('div', { class: 'os-meta-row' }, [
          el('dt', {}, k),
          el('dd', {}, v || '—'),
        ]))),
        el('div', { class: 'os-actions' }, [
          el('a', { class: 'os-btn', href: `#/account/order/${encodeURIComponent(order.id)}` }, '查看订单'),
          el('a', { class: 'os-btn ghost', href: '#/products' }, '继续购物'),
        ]),
        el('p', { class: 'os-note' }, '订单已保存到本机账户，刷新页面也不会丢失。'),
      ]),
    ]),
  );
}
