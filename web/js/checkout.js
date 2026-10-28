// 结算页：购物车 → 收货信息 → 优惠券 → 金额明细 → 提交订单（并可继续支付）。
//
// 本轮迭代点：
//   1. 收货地址不再只能「选」——新增/保存走网关 POST /api/addresses，离线时落本地，保证演示链路不断
//   2. 商品清单内可直接改数量、删除（旧版必须退回购物袋抽屉），改完即时刷新金额与预览
//   3. 优惠券自动选中「省得最多」的那张，不可用券明确给出「差 ¥X 可用」
//   4. 金额明细补充包邮差额提示；提交按钮防重复点击
// 金额规则一律来自 store/checkoutStore.js，页面不另写一份，避免与网关算得不一样。
import { api } from './api.js';
import { el, fmtPrice, loading, banner, toast, updateCartBadge, productThumb } from './ui.js';
import { getCart, getUserId, clearCart, setQty, removeFromCart } from './state.js';
import { navigate } from './router.js';
import { isDemoMode, setDemoMode } from './demo.js';
import { maxQty } from './views.js';
import {
  loadAddresses,
  saveAddress,
  validateAddress,
  loadCoupons,
  pickBestCoupon,
  couponGap,
  estimatePreview,
  isUnreachable,
} from './store/checkoutStore.js';

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

  if (!getCart().length) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, '购物袋是空的'),
        el('p', { class: 'sub' }, '挑几件心仪好物，再来结算吧'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      ]),
    );
    return;
  }

  const userId = getUserId();
  const addrBox = el('div', { class: 'panel' });
  const couponBox = el('div', { class: 'panel' });
  const itemsBox = el('div', { class: 'panel' });
  const sumBox = el('div', { class: 'panel sum' });
  const remarkInput = el('input', { placeholder: '备注：如「工作日送达」', class: 'remark' });

  const state = {
    addresses: [],
    coupons: [],
    addressId: null,
    couponId: null,
    autoCouponId: null,   // 自动选中的最优券，用于打「已为你选最优」标
    preview: null,
    submitting: false,
    showAddrForm: false,
  };

  const selectedCoupon = () => state.coupons.find((c) => c.couponId === state.couponId) || null;
  const selectedAddress = () => state.addresses.find((a) => a.id === state.addressId) || state.addresses[0] || null;

  /** 本地口径的商品小计（用于在请求服务端报价前先加载优惠券） */
  const localProductAmount = () =>
    getCart().reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);

  /* ---------------- 商品清单（支持行内改数量 / 删除） ---------------- */
  function paintItems() {
    itemsBox.innerHTML = '';
    const cart = getCart();
    if (!cart.length) {
      itemsBox.appendChild(el('div', { class: 'cart-empty' }, '购物袋已清空。'));
      return;
    }
    itemsBox.appendChild(el('h3', {}, `商品清单（${cart.length} 种）`));
    cart.forEach((it) => {
      const key = it.__key || it.id;
      const max = maxQty(it);
      const step = (delta) => {
        const cur = getCart().find((x) => (x.__key || x.id) === key);
        if (!cur) return;
        const next = Math.min(maxQty(cur), Math.max(1, cur.qty + delta));
        if (next === cur.qty) return;
        setQty(key, next);
        updateCartBadge();
        paintItems();
        refreshPreview(); // 数量变化直接影响运费与优惠，必须重算金额
      };
      itemsBox.appendChild(
        el('div', { class: 'co-item' + (it.insufficient ? ' is-insufficient' : '') }, [
          el('div', { class: 'thumb' }, productThumb(it)),
          el('div', { class: 'info' }, [
            el('div', { class: 'nm' }, it.name),
            it.spec ? el('div', { class: 'spec' }, it.spec) : null,
            el('div', { class: 'price-line' }, [el('span', {}, fmtPrice(it.price)), el('span', { class: 'cnt' }, `× ${it.qty}`)]),
            it.insufficient ? el('div', { class: 'warn-line' }, `库存不足，仅剩 ${it.stock} 件`) : null,
            el('div', { class: 'co-qty' }, [
              el('button', { class: 'cart-step', type: 'button', 'aria-label': '减少数量', disabled: it.qty <= 1, onclick: () => step(-1) }, '−'),
              el('span', { class: 'cart-qty-num' }, String(it.qty)),
              el('button', { class: 'cart-step', type: 'button', 'aria-label': '增加数量', disabled: it.qty >= max, onclick: () => step(1) }, '+'),
              el('button', {
                class: 'ghost cart-del',
                type: 'button',
                onclick: () => {
                  removeFromCart(key);
                  updateCartBadge();
                  paintItems();
                  refreshPreview();
                },
              }, '删除'),
            ]),
          ]),
          el('div', { class: 'subtotal' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
        ]),
      );
    });
  }

  /* ---------------- 收货地址（可选、可新增） ---------------- */
  function paintAddresses() {
    addrBox.innerHTML = '';
    addrBox.appendChild(el('h3', {}, '收货信息'));
    if (!state.addresses.length) {
      addrBox.appendChild(el('div', { class: 'cart-empty' }, '还没有收货地址，请新增一个以便配送'));
    }
    state.addresses.forEach((a) => {
      addrBox.appendChild(
        el('div', {
          class: 'addr' + (a.id === state.addressId ? ' active' : ''),
          onclick: () => { state.addressId = a.id; paintAddresses(); refreshPreview(); },
        }, [
          el('div', {}, [el('b', {}, a.receiver), el('span', { class: 'cnt' }, ` ${a.phone || '—'}`)]),
          el('div', { class: 'cnt' }, `${a.region} ${a.detail || ''}`),
          el('div', { class: 'addr-tags' }, [
            a.isDefault ? el('span', { class: 'badge-def' }, '默认') : null,
            a.demo ? el('span', { class: 'badge-demo' }, '演示地址') : null,
            a.local ? el('span', { class: 'badge-demo' }, '离线保存') : null,
          ]),
        ]),
      );
    });

    const toggle = el('button', {
      class: 'ghost addr-add-toggle',
      type: 'button',
      onclick: () => { state.showAddrForm = !state.showAddrForm; paintAddresses(); },
    }, state.showAddrForm ? '取消新增' : '＋ 新增收货地址');
    addrBox.appendChild(toggle);
    if (state.showAddrForm) addrBox.appendChild(buildAddressForm());
  }

  function buildAddressForm() {
    const fReceiver = el('input', { placeholder: '收货人姓名', class: 'addr-input' });
    const fPhone = el('input', { placeholder: '手机号（选填）', class: 'addr-input' });
    const fRegion = el('input', { placeholder: '所在地区，如「上海市 浦东新区」', class: 'addr-input' });
    const fDetail = el('input', { placeholder: '详细地址', class: 'addr-input' });
    const fDefault = el('input', { type: 'checkbox', class: 'addr-check' });

    return el('div', { class: 'addr-form' }, [
      fReceiver, fPhone, fRegion, fDetail,
      el('label', { class: 'addr-check-row' }, [fDefault, '设为默认地址']),
      el('div', { class: 'addr-form-actions' }, [
        el('button', {
          class: 'buy',
          type: 'button',
          onclick: async () => {
            const payload = {
              receiver: fReceiver.value, phone: fPhone.value,
              region: fRegion.value, detail: fDetail.value, isDefault: !!fDefault.checked,
            };
            const err = validateAddress(payload);
            if (err) { toast(err, 'warn'); return; }
            try {
              const res = await saveAddress(userId, payload);
              state.addresses = res.addresses;
              state.addressId = res.id || state.addressId;
              state.showAddrForm = false;
              toast(res.online ? '收货地址已保存' : '演示模式：地址已保存在本机', 'ok');
              paintAddresses();
              refreshPreview();
            } catch (e) {
              toast(e.message || '地址保存失败', 'err');
            }
          },
        }, '保存并使用'),
      ]),
    ]);
  }

  /* ---------------- 优惠券 ---------------- */
  function paintCoupons() {
    couponBox.innerHTML = '';
    couponBox.appendChild(el('h3', {}, '优惠券'));
    if (!state.coupons.length) {
      couponBox.appendChild(el('div', { class: 'cnt' }, '暂无可用优惠券'));
      return;
    }
    const amount = localProductAmount();
    const mk = (c) => {
      const gap = couponGap(c, amount);
      return el('div', {
        class: 'coupon' + (c.couponId === state.couponId ? ' active' : '') + (c.usable ? '' : ' disabled'),
        onclick: () => {
          if (!c.usable) { toast(`还差 ${fmtPrice(gap)} 可用`, 'warn'); return; }
          state.couponId = state.couponId === c.couponId ? null : c.couponId;
          paintCoupons();
          refreshPreview();
        },
      }, [
        el('div', { class: 'cp-left' }, [
          el('div', { class: 'cp-amt' }, c.kind === 'discount' ? `${c.amount}% OFF` : `¥${c.amount}`),
          el('div', { class: 'cnt' }, c.threshold ? `满 ${c.threshold} 可用` : '无门槛'),
        ]),
        el('div', { class: 'cp-right' }, [
          el('div', {}, [
            c.title,
            c.demo ? el('span', { class: 'badge-demo' }, '演示券') : null,
          ]),
          el('div', { class: 'cnt' }, c.usable ? `可省 ¥${c.worth}` : (gap ? `差 ${fmtPrice(gap)} 可用` : '当前不可用')),
          c.usable && c.couponId === state.autoCouponId
            ? el('span', { class: 'cp-auto' }, '已自动为你选最优')
            : null,
        ]),
      ]);
    };
    state.coupons.filter((c) => c.usable).forEach((c) => couponBox.appendChild(mk(c)));
    state.coupons.filter((c) => !c.usable).forEach((c) => couponBox.appendChild(mk(c)));
  }

  /* ---------------- 金额预览 ---------------- */
  async function refreshPreview() {
    const cart = getCart();
    if (!cart.length) {
      sumBox.innerHTML = '';
      sumBox.appendChild(el('h3', {}, '金额明细'));
      sumBox.appendChild(el('div', { class: 'cart-empty' }, '购物袋已清空。'));
      state.preview = null;
      return;
    }
    const body = {
      userId,
      items: cart.map((i) => ({ productId: i.productId, skuId: i.skuId, qty: i.qty })),
      addressId: state.addressId,
      couponId: state.couponId,
    };
    try {
      state.preview = await api('/api/orders/preview', { method: 'POST', body });
    } catch (e) {
      // 网关不可达：本地按同规则估算，保证「金额明细 + 提交按钮」都在，
      // 否则用户会卡在「商品有价却看不到合计、也没有下单入口」的死路上。
      if (isUnreachable(e)) setDemoMode(true);
      // 服务端校验失败（如库存不足）也要给出本地估算，让用户能改数量重试
      state.preview = estimatePreview(cart, selectedCoupon(), selectedAddress());
      if (!isUnreachable(e)) banner(sumBox, e.message || '服务端报价失败，以下为本地估算', 'warn');
    }
    paintSum();
  }

  function paintSum() {
    sumBox.innerHTML = '';
    sumBox.appendChild(el('h3', {}, '金额明细'));
    if (!state.preview) return;
    const p = state.preview;
    const rows = [
      ['商品小计', fmtPrice(p.productAmount)],
      ['优惠减免', p.discountAmount ? `- ${fmtPrice(p.discountAmount)}` : fmtPrice(0)],
      ['运费', p.shippingFee ? fmtPrice(p.shippingFee) : '免运费'],
    ];
    rows.forEach(([k, v]) => sumBox.appendChild(el('div', { class: 'sum-row' }, [el('span', {}, k), el('span', {}, v)])));
    if (p.freeShippingGap) {
      sumBox.appendChild(el('div', { class: 'cart-ship-hint' }, `再买 ${fmtPrice(p.freeShippingGap)} 即可包邮`));
    }
    sumBox.appendChild(
      el('div', { class: 'sum-row total' }, [
        el('span', {}, '应付总额'),
        el('span', { class: 'money' }, fmtPrice(p.payAmount)),
      ]),
    );
    const submitBtn = el('button', {
      class: 'buy submit',
      type: 'button',
      disabled: state.submitting,
      onclick: submit,
    }, state.submitting ? '提交中…' : `提交订单 · ${fmtPrice(p.payAmount)}`);
    sumBox.appendChild(submitBtn);
    if (isDemoMode()) {
      sumBox.appendChild(
        el('div', { class: 'demo-note' },
          p.local
            ? '演示模式：金额为本地估算（满 ¥99 包邮，否则 ¥10 运费）；提交后模拟下单，不产生真实交易'
            : '演示模式：提交后将模拟下单，不产生真实交易'),
      );
    }
  }

  /* ---------------- 提交订单 ---------------- */
  async function submit() {
    if (state.submitting || !state.preview) {
      toast('请稍候，结算信息尚未就绪', 'warn');
      return;
    }
    const cart = getCart();
    const payload = {
      userId,
      items: cart.map((i) => ({ productId: i.productId, skuId: i.skuId, qty: i.qty })),
      addressId: state.addressId || (selectedAddress() && selectedAddress().id) || null,
      couponId: state.couponId,
      remark: remarkInput.value.trim(),
    };
    state.submitting = true;  // 防重复下单：同一份单据被点两次会生成两个订单
    paintSum();
    let order;
    try {
      const d = await api('/api/orders', { method: 'POST', body: payload });
      order = d.order;
      clearCart();
      updateCartBadge();
    } catch (e) {
      if (!isUnreachable(e) && !isDemoMode()) {
        state.submitting = false;
        paintSum();
        toast(e.message || '下单失败', 'err');
        return;
      }
      setDemoMode(true);
      order = {
        orderId: 'SO' + Date.now(),
        status: 'pending',
        payAmount: state.preview.payAmount,
        productAmount: state.preview.productAmount,
        shippingFee: state.preview.shippingFee,
        discountAmount: state.preview.discountAmount,
        items: cart.map((i) => ({ name: i.name, qty: i.qty, price: i.price })),
        address: selectedAddress() ? `${selectedAddress().region} ${selectedAddress().detail || ''}` : '',
      };
      clearCart();
      updateCartBadge();
    }
    renderResult(order);
  }

  function renderResult(order) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', { class: 'result' }, [
        el('div', { class: 'ok-icon' }, 'M'),
        el('span', { class: 'eyebrow' }, 'THE ORDER IS PLACED'),
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
      toast('支付成功', 'ok');
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

  /* ---------------- 初始加载 ---------------- */
  const productAmount = localProductAmount();
  const [addrRes, couponRes] = await Promise.all([
    loadAddresses(userId),
    loadCoupons(userId, productAmount),
  ]);
  state.addresses = addrRes.addresses;
  state.coupons = couponRes.coupons;
  const def = state.addresses.find((a) => a.isDefault) || state.addresses[0];
  if (def) state.addressId = def.id;
  // 自动选中省得最多的那张；用户随后的选择会覆盖它，对应的「已为你选最优」标记也会消失
  const best = pickBestCoupon(state.coupons);
  if (best) {
    state.couponId = best.couponId;
    state.autoCouponId = best.couponId;
  }

  wrap.innerHTML = '';
  wrap.appendChild(el('div', { class: 'checkout-heading' }, [
    el('span', { class: 'eyebrow' }, 'CHECKOUT'),
    el('h1', { class: 'page-display' }, '确认订单'),
  ]));
  wrap.appendChild(el('div', { class: 'co-grid' }, [el('div', {}, [addrBox, itemsBox]), el('div', {}, [couponBox, sumBox])]));
  wrap.appendChild(el('div', { class: 'panel' }, [el('h3', {}, '订单备注'), remarkInput]));

  paintItems();
  paintAddresses();
  paintCoupons();
  await refreshPreview();
}

export { STATUS_TEXT };
