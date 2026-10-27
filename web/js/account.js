// 我的订单 + 收藏夹：交易链路的结果页，数据来自 SQLite（网关）/ 本地（演示模式）。
import { api } from './api.js';
import { el, fmtPrice, loading, banner, toast, updateCartBadge, productCard, productThumb } from './ui.js';
import { getUserId, addToCart } from './state.js';
import { navigate } from './router.js';
import { openProductDetail } from './views.js';
import { trackEvent } from './track.js';
import { isDemoMode } from './demo.js';

const STATUS_TEXT = {
  pending: '待支付', paid: '已支付', shipped: '已发货',
  completed: '已完成', refunding: '退款中', closed: '已关闭',
};

/* ---------------- 我的订单 ---------------- */

/** 订单 / 收藏 切换导航 */
function accountTabs(current) {
  return el('div', { class: 'sub-tabs' }, [
    el('a', { href: '#/orders', class: current === 'orders' ? 'active' : '' }, '我的订单'),
    el('a', { href: '#/favorites', class: current === 'fav' ? 'active' : '' }, '我的收藏'),
  ]);
}

export async function renderOrders(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro compact-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'YOUR ARCHIVE'),
      el('h1', { class: 'page-display' }, '我的订单'),
    ]),
  ]));
  view.appendChild(accountTabs('orders'));
  const wrap = el('div', { class: 'orders' });
  view.appendChild(wrap);
  loading(wrap, '加载订单中…');

  const userId = getUserId();
  let orders = [];
  try {
    const d = await api(`/api/orders?userId=${encodeURIComponent(userId)}`, { retries: 0 });
    orders = d.orders || [];
  } catch {
    orders = null;
  }

  wrap.innerHTML = '';
  if (!orders) {
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, isDemoMode() ? '演示模式暂无订单数据' : '订单加载失败'),
        el('p', { class: 'sub' }, isDemoMode()
          ? '连接网关后下单，即可在此查看完整订单流转'
          : '请稍后重试，或检查网关是否正常运行'),
        el('button', { onclick: () => renderOrders(view) }, '重新加载'),
      ]),
    );
    return;
  }
  if (!orders.length) {
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, '还没有订单'),
        el('p', { class: 'sub' }, '去买点好物，订单会出现在这里'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      ]),
    );
    return;
  }

  orders.forEach((o) => wrap.appendChild(orderCard(o, view)));
}

function orderCard(o, view) {
  const again = () => {
    o.items.forEach((i) => addToCart({ id: i.productId, name: i.name, price: i.price }, i.qty, i.skuId));
    updateCartBadge();
    toast('已加入购物车', 'ok');
  };
  const pay = async () => {
    try {
      await api(`/api/orders/${o.orderId}/pay?userId=${encodeURIComponent(getUserId())}`, { method: 'POST' });
      toast('支付成功', 'ok');
      renderOrders(view);
    } catch (e) {
      toast(e.message || '支付失败', 'err');
    }
  };
  return el('div', { class: 'order' }, [
    el('div', { class: 'order-head' }, [
      el('span', { class: 'order-id' }, `订单号 ${o.orderId}`),
      el('span', { class: `status s-${o.status}` }, STATUS_TEXT[o.status] || o.status),
      el('span', { class: 'cnt' }, String(o.createdAt || '').slice(0, 16)),
    ]),
    el('div', { class: 'order-body' }, o.items.map((i) =>
      el('div', { class: 'order-item' }, [
        el('div', { class: 'thumb' }, productThumb({ id: i.productId, name: i.name, categoryId: '', coverColor: '' })),
        el('div', { class: 'info' }, [
          el('div', { class: 'nm' }, i.name),
          el('div', { class: 'cnt' }, `${fmtPrice(i.price)} × ${i.qty}`),
        ]),
        el('div', { class: 'subtotal' }, fmtPrice(i.subtotal != null ? i.subtotal : i.price * i.qty)),
      ]),
    )),
    (o.logisticsCompany || o.trackingNo)
      ? el('div', { class: 'logistics' }, `${o.logisticsCompany || '物流'} · ${o.trackingNo || '待揽收'}`)
      : null,
    el('div', { class: 'order-foot' }, [
      el('div', { class: 'amounts' }, [
        o.discountAmount ? el('span', { class: 'cnt' }, `已优惠 ${fmtPrice(o.discountAmount)} · `) : null,
        el('span', {}, '实付 '),
        el('b', { class: 'money' }, fmtPrice(o.payAmount)),
      ]),
      el('div', { class: 'btns' }, [
        o.status === 'pending' ? el('button', { class: 'buy', onclick: pay }, '去支付') : null,
        el('button', { class: 'ghost', onclick: again }, '再次购买'),
        o.status === 'shipped' || o.status === 'paid'
          ? el('button', { class: 'ghost', onclick: () => toast('AI 客服正在为你查询物流 💬', 'ok') }, '查物流')
          : null,
      ]),
    ]),
  ]);
}

/* ---------------- 收藏夹 ---------------- */

export async function renderFavorites(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro compact-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'YOUR ARCHIVE'),
      el('h1', { class: 'page-display' }, '我的收藏'),
    ]),
  ]));
  view.appendChild(accountTabs('fav'));
  const wrap = el('div', { class: 'fav-page' });
  view.appendChild(wrap);
  loading(wrap, '加载收藏中…');

  const userId = getUserId();
  let favorites = null;
  try {
    const d = await api(`/api/favorites?userId=${encodeURIComponent(userId)}`, { retries: 0 });
    favorites = d.favorites || [];
  } catch {
    favorites = null;
  }

  wrap.innerHTML = '';
  if (!favorites) {
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, isDemoMode() ? '演示模式暂无收藏数据' : '收藏加载失败'),
        el('p', { class: 'sub' }, '连接网关后，收藏会保存在服务端'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛商品'),
      ]),
    );
    return;
  }
  if (!favorites.length) {
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, '收藏夹是空的'),
        el('p', { class: 'sub' }, '在商品详情页点「收藏」，心仪好物会存在这里'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      ]),
    );
    return;
  }

  const grid = el('div', { class: 'grid' });
  wrap.appendChild(grid);
  favorites.forEach((p) => {
    grid.appendChild(productCard(p, {
      onDetail: (p) => openProductDetail(p, 'fav'),
      onAddCart: (p) => {
        trackEvent({ event: 'add_to_cart', source: 'fav', productId: p.id });
        addToCart(p, 1);
        updateCartBadge();
        toast(`已加入购物车：${p.name}`, 'ok');
      },
      extra: (p) => el('button', {
        class: 'ghost unfav',
        onclick: async () => {
          try {
            await api(`/api/favorites?userId=${encodeURIComponent(userId)}&productId=${encodeURIComponent(p.productId)}`,
              { method: 'DELETE', retries: 0 });
            renderFavorites(view);
          } catch {
            toast('取消收藏失败', 'warn');
          }
        },
      }, '取消收藏'),
    }));
  });
}
