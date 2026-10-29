// 我的订单 + 收藏夹：交易链路的结果页，数据来自 SQLite（网关）/ 本地（演示模式）。
import { api } from './api.js';
import { el, fmtPrice, loading, banner, toast, updateCartBadge, productCard, productThumb } from './ui.js';
import { getUserId, addToCart } from './state.js';
import { navigate } from './router.js';
import { openProductDetail, getProductById } from './views.js';
import { askGuide } from './aiShop.js';
import { trackEvent } from './track.js';
import { isDemoMode } from './demo.js';
import { listFavorites, addFavorite, isFavorite } from './store/favoriteStore.js';
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

/**
 * 把服务端收藏并回本地。
 * 本地是真相源（离线 / 演示站都能用），服务端只用来「换设备时补课」：
 * 只补本地没有的，绝不删除本地已有的——否则弱网下一次空响应就能清空收藏夹。
 */
async function mergeServerFavorites() {
  let ids = [];
  try {
    const d = await api(`/api/favorites?userId=${encodeURIComponent(getUserId())}`, { retries: 0 });
    if (Array.isArray(d.ids)) ids = d.ids;
    else if (Array.isArray(d.favorites)) ids = d.favorites.map((f) => f.id || f.productId);
  } catch {
    return; // 演示模式 / 离线：本地收藏已经够用
  }
  for (const id of ids) {
    if (!id || isFavorite(id)) continue;
    const p = await getProductById(id).catch(() => null);
    if (p) addFavorite(p, { silent: true });
  }
}

/** 老收藏只存了 id：渲染前补一次商品信息，补不到的丢弃（商品已下架） */
async function resolveFavorites() {
  const out = [];
  for (const item of listFavorites()) {
    if (item.name) {
      out.push(item);
      continue;
    }
    const p = await getProductById(item.id).catch(() => null);
    if (p) out.push({ ...p, addedAt: item.addedAt });
  }
  return out;
}

export async function renderFavorites(view) {
  view.innerHTML = '';
  view.appendChild(el('header', { class: 'page-intro compact-intro' }, [
    el('div', { class: 'page-intro-copy' }, [
      el('span', { class: 'eyebrow' }, 'YOUR ARCHIVE'),
      el('h1', { class: 'page-display' }, '我的收藏'),
      el('p', {}, '心动先存下，不必当下决定。取消收藏随时可以，数据按账号隔离保存在本机。'),
    ]),
  ]));
  view.appendChild(accountTabs('fav'));
  const wrap = el('div', { class: 'fav-page' });
  view.appendChild(wrap);
  loading(wrap, '加载收藏中…');

  await mergeServerFavorites();
  const items = await resolveFavorites();

  const emptyState = () => el('div', { class: 'empty-page' }, [
    el('div', { class: 'empty-mark' }, 'M'),
    el('p', { class: 'empty-title-sm' }, '收藏夹是空的'),
    el('p', { class: 'sub' }, '在商品卡或详情页点一下心形按钮，心动好物会出现在这里'),
    el('div', { class: 'empty-actions' }, [
      el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      el('button', { class: 'ghost', onclick: () => askGuide('') }, '让 AI 帮我挑'),
    ]),
  ]);

  wrap.innerHTML = '';
  if (!items.length) {
    wrap.appendChild(emptyState());
    return;
  }

  const countWord = el('span', { class: 'fav-count-word' }, `共 ${items.length} 件心意之物`);
  wrap.appendChild(el('div', { class: 'fav-toolbar' }, [
    countWord,
    el('span', { class: 'fav-tip' }, '点心形图标即可取消收藏'),
  ]));

  const grid = el('div', { class: 'grid' });
  wrap.appendChild(grid);

  items.forEach((p) => {
    let card = null;
    card = productCard(p, {
      onDetail: (prod) => openProductDetail(prod, 'fav'),
      onAddCart: (prod) => {
        trackEvent({ event: 'add_to_cart', source: 'fav', productId: prod.id });
        addToCart(prod, 1);
        updateCartBadge();
        toast(`已加入购物袋：${prod.name}`, 'ok');
      },
      onFavorite: (active) => {
        if (active) return;
        card.remove();
        const left = grid.querySelectorAll('.pcard').length;
        if (!left) {
          wrap.innerHTML = '';
          wrap.appendChild(emptyState());
        } else {
          countWord.textContent = `共 ${left} 件心意之物`;
        }
      },
    });
    grid.appendChild(card);
  });
}
