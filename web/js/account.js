// 我的订单 + 收藏夹：交易链路的结果页，数据来自 SQLite（网关）/ 本地（演示模式）。
import { api } from './api.js';
import { el, fmtPrice, loading, banner, toast, updateCartBadge, productCard, productThumb } from './ui.js';
import { getUserId, addToCart } from './state.js';
import { navigate } from './router.js';
import { openProductDetail } from './views.js';
import { trackEvent } from './track.js';
import { isDemoMode } from './demo.js';
import {
  listOrders, mergeOrders, normalizeRemote, statusText, updateOrderStatus,
} from './store/orderStore.js';

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
  const local = listOrders(userId);
  let orders = [];
  try {
    const d = await api(`/api/orders?userId=${encodeURIComponent(userId)}`, { retries: 0 });
    orders = mergeOrders(local, (d.orders || []).map(normalizeRemote));
  } catch {
    orders = local; // 网关不可达时仍要能看到本机下的单
  }

  wrap.innerHTML = '';
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
  const id = o.id;
  const again = () => {
    o.items.forEach((i) => addToCart({ id: i.productId, name: i.name, price: i.price }, i.qty, i.skuId));
    updateCartBadge();
    toast('已加入购物车', 'ok');
  };
  const pay = async () => {
    // 本地下单（演示环境）没有服务端订单可支付：直接把状态推进到已付款，
    // 让「待付款 → 已付款」的流转在纯静态站点也看得见。
    if (o.remote === false) {
      updateOrderStatus(getUserId(), id, 'paid');
      toast('演示模式：已模拟支付成功', 'ok');
      renderOrders(view);
      return;
    }
    try {
      await api(`/api/orders/${id}/pay?userId=${encodeURIComponent(getUserId())}`, { method: 'POST' });
      toast('支付成功', 'ok');
      renderOrders(view);
    } catch (e) {
      toast(e.message || '支付失败', 'err');
    }
  };
  const total = (o.amounts && o.amounts.payAmount) != null ? o.amounts.payAmount : o.payAmount;
  const discount = (o.amounts && o.amounts.couponDiscount) || o.discountAmount || 0;
  return el('div', { class: 'order' }, [
    el('div', { class: 'order-head' }, [
      el('span', { class: 'order-id' }, `订单号 ${id}`),
      el('span', { class: `status s-${o.status}` }, statusText(o.status)),
      el('span', { class: 'cnt' }, String(o.createdAt || '').slice(0, 16).replace('T', ' ')),
    ]),
    el('div', { class: 'order-body' }, o.items.map((i) =>
      el('div', { class: 'order-item' }, [
        el('div', { class: 'thumb' }, productThumb({ id: i.productId, name: i.name, categoryId: '', coverColor: i.coverColor })),
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
        discount ? el('span', { class: 'cnt' }, `已优惠 ${fmtPrice(discount)} · `) : null,
        el('span', {}, '应付 '),
        el('b', { class: 'money' }, fmtPrice(total)),
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
