// 结算页（#/checkout）：购物袋 → 收货地址 → 配送方式 → 支付方式 → 备注 → 提交订单。
//
// 本步骤的链路约定：
//   1) 地址来自「步骤 2」的地址簿（store/addressStore.js，服务端为准 + 本地缓存），
//     所以个人中心里维护的默认地址，进结算页就是已选中的那一条；
//   2) 金额只在 store/orderStore.js 里算一次，页面不再另写一套，避免「预览一个价、下单另一个价」；
//   3) 提交后订单写入 orderStore（localStorage，按 userId 隔离），并清掉已结算的商品，
//      然后跳 #/order-success/:id —— 成功页只认这个 id，刷新也能靠本地订单复原。
//
// 未登录由 app.js 的路由守卫拦下并带 redirect；这里再兜一次，防止被直接调用绕过。
import { el, fmtPrice, toast, updateCartBadge, productThumb } from './ui.js';
import { getCart, removeFromCart } from './state.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import {
  PAYMENT_METHODS, SHIPPING_METHODS, computeAmounts, createOrder, paymentById, shippingById,
} from './store/orderStore.js';
import {
  getAddress, hydrateAddresses, listAddresses, saveAddress, validateAddress,
} from './store/addressStore.js';

export async function renderCheckout(view) {
  const user = getCurrentUser();
  if (!user) {
    navigate(`#/login?redirect=${encodeURIComponent('/checkout')}`);
    return;
  }

  view.innerHTML = '';
  view.appendChild(el('a', { class: 'back-link', href: '#/cart' }, '← 返回购物袋'));

  if (!getCart().length) {
    view.appendChild(
      el('div', { class: 'empty-page' }, [
        el('div', { class: 'empty-mark' }, 'M'),
        el('p', { class: 'empty-title-sm' }, '购物袋是空的'),
        el('p', { class: 'sub' }, '挑几件心仪好物，再来结算吧'),
        el('button', { onclick: () => navigate('#/products') }, '去逛逛'),
      ]),
    );
    return;
  }

  const state = {
    addresses: listAddresses(user.id),
    addressId: null,
    shippingId: SHIPPING_METHODS[0].id,
    paymentId: PAYMENT_METHODS[0].id,
    remark: '',
    submitting: false,
    showForm: false,
    error: '',
  };
  // 默认地址预选：没有默认地址时退化为第一条（订单必须挂一个真实地址）
  const def = state.addresses.find((a) => a.isDefault) || state.addresses[0] || null;
  state.addressId = def ? def.id : null;

  /* ---------------- 骨架 ---------------- */
  const heading = el('header', { class: 'co2-heading' }, [
    el('div', {}, [
      el('span', { class: 'eyebrow' }, 'CHECKOUT'),
      el('h1', { class: 'page-display' }, '确认订单'),
    ]),
    el('p', { class: 'co2-heading-note' }, '核对收货信息与商品，确认后提交订单'),
  ]);

  const addrCard = el('section', { class: 'co2-card' });
  const shipCard = el('section', { class: 'co2-card' });
  const payCard = el('section', { class: 'co2-card' });
  const itemCard = el('section', { class: 'co2-card' });
  const remarkCard = el('section', { class: 'co2-card' });
  const sumCard = el('aside', { class: 'co2-card co2-sum' });

  const grid = el('div', { class: 'co2-grid' }, [
    el('div', { class: 'co2-main' }, [addrCard, shipCard, payCard, itemCard, remarkCard]),
    el('div', { class: 'co2-side' }, [sumCard]),
  ]);

  view.appendChild(el('div', { class: 'co2' }, [heading, grid]));

  const selectedAddress = () => getAddress(user.id, state.addressId);
  const productAmount = () => getCart().reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);
  const amounts = () => computeAmounts({
    productAmount: productAmount(),
    shippingFee: shippingById(state.shippingId).fee,
    couponDiscount: 0, // 优惠券抵扣占位：本步恒为 0
  });

  function cardHead(title, hint) {
    return el('div', { class: 'co2-card-head' }, [
      el('h2', {}, title),
      hint ? el('span', { class: 'co2-card-hint' }, hint) : null,
    ]);
  }

  /* ---------------- 1. 收货地址 ---------------- */
  function paintAddress() {
    addrCard.innerHTML = '';
    addrCard.appendChild(cardHead('收货地址', state.addresses.length ? `${state.addresses.length} 个可选` : '还没有地址'));
    const listBox = el('div', { class: 'co2-addr-list' });

    if (!state.addresses.length) {
      listBox.appendChild(
        el('p', { class: 'co2-empty' }, '还没有收货地址，先新增一个才能提交订单。'),
      );
    }

    state.addresses.forEach((a) => {
      const on = String(a.id) === String(state.addressId);
      listBox.appendChild(
        el('button', {
          class: `co2-addr${on ? ' is-on' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': on ? 'true' : 'false',
          onclick: () => {
            state.addressId = a.id;
            state.error = '';
            paintAddress();
            paintSum();
          },
        }, [
          el('span', { class: 'co2-addr-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'co2-addr-body' }, [
            el('span', { class: 'co2-addr-line' }, [
              el('b', {}, a.receiver || '未填写'),
              a.phone ? el('span', { class: 'co2-addr-phone' }, a.phone) : null,
              a.isDefault ? el('span', { class: 'co2-tag' }, '默认') : null,
              a.pending ? el('span', { class: 'co2-tag is-soft' }, '仅本机') : null,
            ]),
            el('span', { class: 'co2-addr-line sub' }, `${a.region || ''} ${a.detail || ''}`.trim() || '地址信息不完整'),
          ]),
        ]),
      );
    });
    addrCard.appendChild(listBox);

    addrCard.appendChild(
      el('button', {
        class: 'co2-addr-add',
        type: 'button',
        onclick: () => {
          state.showForm = !state.showForm;
          paintAddress();
        },
      }, state.showForm ? '取消新增' : '＋ 新增收货地址'),
    );

    if (state.showForm) addrCard.appendChild(buildAddressForm());
  }

  function buildAddressForm() {
    const f = {
      receiver: el('input', { class: 'co2-input f-receiver', type: 'text', placeholder: '收货人姓名' }),
      phone: el('input', { class: 'co2-input f-phone', type: 'tel', placeholder: '手机号（选填）', inputmode: 'numeric' }),
      region: el('input', { class: 'co2-input f-region', type: 'text', placeholder: '省 / 市 / 区，如「上海市 浦东新区」' }),
      detail: el('input', { class: 'co2-input f-detail', type: 'text', placeholder: '详细地址：街道、门牌、楼层房号' }),
      postal: el('input', { class: 'co2-input f-postal', type: 'text', placeholder: '邮编（选填）', maxlength: '6', inputmode: 'numeric' }),
      isDefault: el('input', { class: 'co2-check f-default', type: 'checkbox', checked: state.addresses.length === 0 }),
    };
    const err = el('p', { class: 'co2-form-err', hidden: true });
    const saveBtn = el('button', { class: 'co2-save', type: 'submit' }, '保存并使用');

    const form = el('form', { class: 'co2-addr-form', novalidate: 'novalidate' }, [
      el('div', { class: 'co2-form-grid' }, [
        f.receiver, f.phone, f.region, f.detail, f.postal,
      ]),
      el('label', { class: 'co2-check-row' }, [f.isDefault, '设为默认地址']),
      err,
      el('div', { class: 'co2-form-actions' }, [saveBtn]),
    ]);

    form.addEventListener('submit', async (e) => {
      if (e && e.preventDefault) e.preventDefault();
      const payload = {
        receiver: String(f.receiver.value || '').trim(),
        phone: String(f.phone.value || '').trim(),
        region: String(f.region.value || '').trim(),
        detail: String(f.detail.value || '').trim(),
        postal: String(f.postal.value || '').trim(),
        isDefault: Boolean(f.isDefault.checked),
      };
      const invalid = validateAddress(payload);
      if (invalid) {
        err.textContent = invalid;
        err.removeAttribute('hidden');
        return;
      }
      saveBtn.disabled = true;
      const res = await saveAddress(user.id, payload);
      saveBtn.disabled = false;
      if (!res.ok) {
        err.textContent = res.error || '保存失败';
        err.removeAttribute('hidden');
        return;
      }
      err.setAttribute('hidden', '');
      state.addresses = res.addresses && res.addresses.length ? res.addresses : listAddresses(user.id);
      const createdId = (res.address && res.address.id) || (res.id || '');
      const pick = state.addresses.find((a) => String(a.id) === String(createdId))
        || state.addresses.find((a) => a.receiver === payload.receiver && a.region === payload.region)
        || state.addresses[state.addresses.length - 1];
      state.addressId = pick ? pick.id : state.addressId;
      state.showForm = false;
      state.error = '';
      toast(res.online === false ? '地址已保存（仅本机，联网后自动同步）' : '地址已保存并选中', 'ok');
      paintAddress();
      paintSum();
    });

    return form;
  }

  /* ---------------- 2. 配送方式 ---------------- */
  function paintShipping() {
    shipCard.innerHTML = '';
    shipCard.appendChild(cardHead('配送方式', '运费与时效为演示数据'));
    const box = el('div', { class: 'co2-picks' });
    SHIPPING_METHODS.forEach((m) => {
      const on = m.id === state.shippingId;
      box.appendChild(
        el('button', {
          class: `co2-pick${on ? ' is-on' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': on ? 'true' : 'false',
          onclick: () => {
            state.shippingId = m.id;
            paintShipping();
            paintSum();
          },
        }, [
          el('span', { class: 'co2-pick-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'co2-pick-body' }, [
            el('span', { class: 'co2-pick-title' }, m.name),
            el('span', { class: 'co2-pick-note' }, `${m.eta} · ${m.note}`),
          ]),
          el('span', { class: 'co2-pick-fee num' }, m.fee ? fmtPrice(m.fee) : '免运费'),
        ]),
      );
    });
    shipCard.appendChild(box);
  }

  /* ---------------- 3. 支付方式 ---------------- */
  function paintPayment() {
    payCard.innerHTML = '';
    payCard.appendChild(cardHead('支付方式', 'mock 支付，不会真实扣款'));
    const box = el('div', { class: 'co2-picks' });
    PAYMENT_METHODS.forEach((m) => {
      const on = m.id === state.paymentId;
      box.appendChild(
        el('button', {
          class: `co2-pick${on ? ' is-on' : ''}`,
          type: 'button',
          role: 'radio',
          'aria-checked': on ? 'true' : 'false',
          onclick: () => {
            state.paymentId = m.id;
            paintPayment();
            paintSum();
          },
        }, [
          el('span', { class: 'co2-pick-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'co2-pick-body' }, [
            el('span', { class: 'co2-pick-title' }, m.name),
            el('span', { class: 'co2-pick-note' }, m.note),
          ]),
        ]),
      );
    });
    payCard.appendChild(box);
  }

  /* ---------------- 4. 商品清单 ---------------- */
  function paintItems() {
    itemCard.innerHTML = '';
    const cart = getCart();
    itemCard.appendChild(cardHead('商品清单', `${cart.reduce((n, i) => n + (Number(i.qty) || 0), 0)} 件`));
    cart.forEach((it) => {
      itemCard.appendChild(
        el('div', { class: 'co2-item' }, [
          el('div', { class: 'co2-item-thumb' }, productThumb(it)),
          el('div', { class: 'co2-item-info' }, [
            el('div', { class: 'co2-item-name' }, it.name),
            el('div', { class: 'co2-item-sku' }, it.spec ? `SKU：${it.spec}` : 'SKU：默认规格'),
            el('div', { class: 'co2-item-price num' }, `${fmtPrice(it.price)} × ${it.qty}`),
          ]),
          el('div', { class: 'co2-item-sub num' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
        ]),
      );
    });
    itemCard.appendChild(
      el('a', { class: 'co2-item-edit', href: '#/cart' }, '返回购物袋修改数量 →'),
    );
  }

  /* ---------------- 5. 订单备注 ---------------- */
  function paintRemark() {
    remarkCard.innerHTML = '';
    remarkCard.appendChild(cardHead('订单备注', '选填'));
    const input = el('textarea', {
      class: 'co2-remark',
      rows: '2',
      maxlength: '120',
      placeholder: '如「工作日送达」「放在门口即可」',
    });
    input.value = state.remark;
    input.addEventListener('input', () => {
      state.remark = input.value;
    });
    remarkCard.appendChild(input);
  }

  /* ---------------- 6. 金额汇总 + 提交 ---------------- */
  function paintSum() {
    sumCard.innerHTML = '';
    const a = amounts();
    const shipping = shippingById(state.shippingId);

    sumCard.appendChild(cardHead('金额汇总'));
    const row = (label, value, extra = '') =>
      el('div', { class: `co2-sum-row${extra ? ` ${extra}` : ''}` }, [
        el('span', {}, label),
        el('span', { class: 'num' }, value),
      ]);

    sumCard.appendChild(row('商品总额', fmtPrice(a.productAmount)));
    sumCard.appendChild(row('运费', a.shippingFee ? fmtPrice(a.shippingFee) : '免运费'));
    sumCard.appendChild(el('div', { class: 'co2-sum-row' }, [
      el('span', {}, ['优惠券抵扣', el('span', { class: 'co2-sum-soon' }, '占位')]),
      el('span', { class: 'num' }, a.couponDiscount ? `- ${fmtPrice(a.couponDiscount)}` : '- ¥0'),
    ]));
    sumCard.appendChild(
      el('div', { class: 'co2-sum-row is-total' }, [
        el('span', {}, '应付金额'),
        el('span', { class: 'num co2-sum-money' }, fmtPrice(a.payAmount)),
      ]),
    );
    sumCard.appendChild(
      el('p', { class: 'co2-sum-note' }, `${shipping.name} · ${shipping.eta} · ${paymentById(state.paymentId).name}`),
    );

    const noAddress = !selectedAddress();
    if (noAddress) {
      sumCard.appendChild(el('p', { class: 'co2-sum-hint' }, '请先选择或新增收货地址'));
    }
    if (state.error) sumCard.appendChild(el('p', { class: 'co2-sum-error' }, state.error));

    sumCard.appendChild(
      el('button', {
        class: 'co2-submit',
        type: 'button',
        disabled: noAddress || state.submitting,
        onclick: submit,
      }, state.submitting ? '提交中…' : '提交订单'),
    );
    sumCard.appendChild(el('p', { class: 'co2-terms' }, '提交即表示同意《服务条款》与《隐私政策》（演示文案）'));
  }

  /* ---------------- 7. 提交 ---------------- */
  function submit() {
    if (state.submitting) return;
    const cart = getCart();
    if (!cart.length) {
      toast('购物袋是空的', 'warn');
      navigate('#/cart');
      return;
    }
    const address = selectedAddress();
    if (!address) {
      state.error = '请先选择收货地址';
      paintSum();
      toast('请先选择收货地址', 'warn');
      return;
    }
    state.submitting = true;
    state.error = '';
    paintSum();
    try {
      const order = createOrder(user.id, {
        items: cart,
        address,
        shippingMethod: shippingById(state.shippingId),
        paymentMethod: paymentById(state.paymentId),
        remark: state.remark,
        amounts: amounts(),
      });
      // 只清掉已结算的商品：结算期间在别处新加的东西不该被一起清空
      cart.forEach((i) => removeFromCart(i.__key || i.id));
      updateCartBadge();
      toast(`订单 ${order.id} 已提交`, 'ok');
      navigate(`#/order-success/${encodeURIComponent(order.id)}`);
    } catch (e) {
      state.submitting = false;
      state.error = e.message || '提交失败，请重试';
      paintSum();
    }
  }

  paintAddress();
  paintShipping();
  paintPayment();
  paintItems();
  paintRemark();
  paintSum();

  // 服务端校准地址簿：缓存先出（秒开），拉回最新后再刷一次，不打断正在填的表单
  hydrateAddresses(user.id).then(({ addresses }) => {
    if (!addresses || !addresses.length) return;
    state.addresses = addresses;
    if (!selectedAddress()) {
      const next = addresses.find((x) => x.isDefault) || addresses[0];
      state.addressId = next ? next.id : null;
    }
    if (!state.showForm) paintAddress();
    paintSum();
  }).catch((e) => {
    console.warn('[checkout] 地址校准失败', e && e.message);
  });
}
