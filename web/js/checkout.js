// 结算页：购物车 → 收货信息 → 优惠券 → 金额明细 → 提交订单（并可继续支付）。
import { api } from './api.js';
import { el, fmtPrice, loading, banner, toast, updateCartBadge, productThumb } from './ui.js';
import { getCart, getUserId, clearCart } from './state.js';
import { navigate } from './router.js';
import { isDemoMode } from './demo.js';

const STATUS_TEXT = {
  pending: '待支付', paid: '已支付', shipped: '已发货',
  completed: '已完成', refunding: '退款中', closed: '已关闭',
};

export async function renderCheckout(view) {
  view.innerHTML = '';
  view.appendChild(el('a', { class: 'back-link', href: '#/products' }, '← 继续购物'));
  const wrap = el('div', { class: 'checkout' });
  view.appendChild(wrap);
  loading(wrap, '正在准备结算…');

  const cart = getCart();
  if (!cart.length) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'emoji' }, '🧺'),
        el('p', {}, '购物车是空的'),
        el('p', { class: 'sub' }, '挑几件心仪好物，再来结算吧'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      ]),
    );
    return;
  }

  const userId = getUserId();
  let addresses = [];
  let coupons = [];
  let addressId = null;
  let couponId = null;
  let preview = null;

  const addrBox = el('div', { class: 'panel' });
  const couponBox = el('div', { class: 'panel' });
  const itemsBox = el('div', { class: 'panel' });
  const sumBox = el('div', { class: 'panel sum' });

  function renderItems() {
    itemsBox.innerHTML = '';
    itemsBox.appendChild(el('h3', {}, `商品清单（${cart.length} 种）`));
    cart.forEach((it) => {
      itemsBox.appendChild(
        el('div', { class: 'co-item' }, [
          el('div', { class: 'thumb' }, productThumb(it)),
          el('div', { class: 'info' }, [
            el('div', { class: 'nm' }, it.name),
            it.spec ? el('div', { class: 'spec' }, it.spec) : null,
            el('div', { class: 'price-line' }, [el('span', {}, fmtPrice(it.price)), el('span', { class: 'cnt' }, `× ${it.qty}`)]),
          ]),
          el('div', { class: 'subtotal' }, fmtPrice(it.price * it.qty)),
        ]),
      );
    });
  }

  // 与服务端 orderService 保持一致：满 99 包邮，否则 10 元运费
  const FREE_SHIPPING_THRESHOLD = 99;
  const SHIPPING_FEE = 10;

  // 演示模式（网关不可达）下本地估算金额：规则与服务端一致，只是没有优惠券
  function localPreview() {
    const productAmount = cart.reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);
    const discountAmount = 0;
    const shippingFee = productAmount - discountAmount >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FEE;
    return {
      items: cart.map((i) => ({ productId: i.productId, skuId: i.skuId, qty: i.qty, price: i.price, name: i.name })),
      productAmount,
      shippingFee,
      discountAmount,
      payAmount: productAmount - discountAmount + shippingFee,
      address: { full: '演示模式：使用默认收货地址' },
      coupon: null,
      local: true,
    };
  }

  async function refreshPreview() {
    try {
      preview = await api('/api/orders/preview', {
        method: 'POST',
        body: { userId, items: cart.map((i) => ({ productId: i.productId, skuId: i.skuId, qty: i.qty })), addressId, couponId },
      });
    } catch (e) {
      // 演示模式：拿不到服务端报价就本地估算，保证金额明细与提交按钮都在，
      // 否则用户会卡在「商品有价但看不到合计、也没有下单按钮」的死路上
      if (isDemoMode()) {
        preview = localPreview();
        renderSum();
        return true;
      }
      preview = null;
      banner(sumBox, e.message || '结算信息获取失败', 'warn');
      return false;
    }
    renderSum();
    return true;
  }

  function renderSum() {
    sumBox.innerHTML = '';
    sumBox.appendChild(el('h3', {}, '金额明细'));
    if (!preview) return;
    const rows = [
      ['商品小计', fmtPrice(preview.productAmount)],
      ['优惠减免', preview.discountAmount ? `- ${fmtPrice(preview.discountAmount)}` : fmtPrice(0)],
      ['运费', preview.shippingFee ? fmtPrice(preview.shippingFee) : '免运费'],
    ];
    rows.forEach(([k, v]) => sumBox.appendChild(el('div', { class: 'sum-row' }, [el('span', {}, k), el('span', {}, v)])));
    sumBox.appendChild(
      el('div', { class: 'sum-row total' }, [
        el('span', {}, '应付总额'),
        el('span', { class: 'money' }, fmtPrice(preview.payAmount)),
      ]),
    );
    const submitBtn = el('button', { class: 'buy submit', onclick: submit }, `提交订单 · ${fmtPrice(preview.payAmount)}`);
    if (isDemoMode()) {
      sumBox.appendChild(
        el(
          'div',
          { class: 'demo-note' },
          preview.local
            ? '演示模式：金额为本地估算（满 ¥99 包邮，否则 ¥10 运费）；提交后模拟下单，不产生真实交易'
            : '演示模式：提交后将模拟下单，不产生真实交易',
        ),
      );
    }
    sumBox.appendChild(submitBtn);
  }

  function renderAddresses() {
    addrBox.innerHTML = '';
    addrBox.appendChild(el('h3', {}, '收货信息'));
    if (!addresses.length) {
      addrBox.appendChild(el('div', { class: 'cart-empty' }, '暂无收货地址，将使用默认地址'));
      return;
    }
    addresses.forEach((a) => {
      addrBox.appendChild(
        el('div', {
          class: 'addr' + (a.id === (addressId || addresses[0].id) ? ' active' : ''),
          onclick: () => { addressId = a.id; renderAddresses(); refreshPreview(); },
        }, [
          el('div', {}, [el('b', {}, a.receiver), el('span', { class: 'cnt' }, ` ${a.phone}`)]),
          el('div', { class: 'cnt' }, a.full),
          a.isDefault ? el('span', { class: 'badge-def' }, '默认') : null,
        ]),
      );
    });
  }

  function renderCoupons() {
    couponBox.innerHTML = '';
    couponBox.appendChild(el('h3', {}, '优惠券'));
    const usable = coupons.filter((c) => c.usable);
    const unusable = coupons.filter((c) => !c.usable);
    if (!coupons.length) {
      couponBox.appendChild(el('div', { class: 'cnt' }, '暂无可用优惠券'));
      return;
    }
    const mk = (c) =>
      el('div', {
        class: 'coupon' + (c.couponId === couponId ? ' active' : '') + (c.usable ? '' : ' disabled'),
        onclick: () => {
          if (!c.usable) return;
          couponId = couponId === c.couponId ? null : c.couponId;
          renderCoupons();
          refreshPreview();
        },
      }, [
        el('div', { class: 'cp-left' }, [
          el('div', { class: 'cp-amt' }, c.kind === 'discount' ? `${c.amount}% OFF` : `¥${c.amount}`),
          el('div', { class: 'cnt' }, c.threshold ? `满 ${c.threshold} 可用` : '无门槛'),
        ]),
        el('div', { class: 'cp-right' }, [
          el('div', {}, c.title),
          el('div', { class: 'cnt' }, c.usable ? `可省 ¥${c.worth}` : '未达使用门槛'),
        ]),
      ]);
    usable.forEach((c) => couponBox.appendChild(mk(c)));
    unusable.forEach((c) => couponBox.appendChild(mk(c)));
  }

  async function submit() {
    if (!preview) {
      toast('请稍候，结算信息尚未就绪', 'warn');
      return;
    }
    const payload = {
      userId,
      items: cart.map((i) => ({ productId: i.productId, skuId: i.skuId, qty: i.qty })),
      addressId: addressId || (addresses[0] && addresses[0].id) || null,
      couponId,
      remark: remarkInput.value.trim(),
    };
    let order;
    try {
      const d = await api('/api/orders', { method: 'POST', body: payload });
      order = d.order;
      clearCart();
      updateCartBadge();
    } catch (e) {
      // 演示模式：网关不可达时模拟下单结果，保证演示链路完整
      if (!isDemoMode()) {
        toast(e.message || '下单失败', 'err');
        return;
      }
      order = {
        orderId: 'SO' + Date.now(),
        status: 'pending',
        payAmount: preview.payAmount,
        productAmount: preview.productAmount,
        shippingFee: preview.shippingFee,
        discountAmount: preview.discountAmount,
        items: cart.map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
        address: (addresses[0] && addresses[0].full) || '',
      };
      clearCart();
      updateCartBadge();
    }
    renderResult(order);
  }

  const remarkInput = el('input', { placeholder: '备注：如「工作日送达」', class: 'remark' });

  function renderResult(order) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', { class: 'result' }, [
        el('div', { class: 'ok-icon' }, order.status === 'pending' ? '🧾' : '🎉'),
        el('h2', {}, order.status === 'pending' ? '订单已提交' : '支付成功'),
        el('div', { class: 'cnt' }, `订单号 ${order.orderId}`),
        el('div', { class: 'result-amount' }, fmtPrice(order.payAmount)),
        el('div', { class: 'cnt' }, `收货地址：${order.address || '默认地址'}`),
        el('div', { class: 'result-actions' }, [
          order.status === 'pending'
            ? el('button', { class: 'buy', onclick: () => payNow(order) }, '立即支付')
            : null,
          el('button', { class: 'ghost', onclick: () => navigate('#/orders') }, '查看我的订单'),
          el('button', { class: 'ghost', onclick: () => navigate('#/products') }, '继续购物'),
        ]),
      ]),
    );
  }

  async function payNow(order) {
    try {
      await api(`/api/orders/${order.orderId}/pay?userId=${encodeURIComponent(userId)}`, { method: 'POST' });
      toast('支付成功 🎉', 'ok');
      navigate('#/orders');
    } catch (e) {
      if (isDemoMode()) {
        toast('演示模式：已模拟支付成功', 'ok');
        navigate('#/orders');
      } else {
        toast(e.message || '支付失败', 'err');
      }
    }
  }

  // ---- 初始加载 ----
  try {
    [{ addresses }, { coupons }] = await Promise.all([
      api(`/api/addresses?userId=${encodeURIComponent(userId)}`, { retries: 0 }).catch(() => ({ addresses: [] })),
      api(`/api/coupons?userId=${encodeURIComponent(userId)}`, { retries: 0 }).catch(() => ({ coupons: [] })),
    ]);
  } catch {
    addresses = [];
    coupons = [];
  }
  if (addresses[0]) addressId = addresses[0].id;

  wrap.innerHTML = '';
  wrap.appendChild(el('h2', { class: 'page-title' }, '🧾 确认订单'));
  const cols = el('div', { class: 'co-grid' }, [el('div', {}, [addrBox, itemsBox]), el('div', {}, [couponBox, sumBox])]);
  wrap.appendChild(cols);
  wrap.appendChild(el('div', { class: 'panel' }, [el('h3', {}, '订单备注'), remarkInput]));

  renderItems();
  renderAddresses();
  renderCoupons();
  await refreshPreview();
}

export { STATUS_TEXT };
