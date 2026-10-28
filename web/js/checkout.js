// 结算页（#/checkout）：购物袋 → 收货地址 → 配送方式 → 支付方式 → 备注 → 提交订单。
//
// 本步骤的链路约定：
//   1) 地址来自「步骤 2」的地址簿（store/addressStore.js，服务端为准 + 本地缓存），
//     所以个人中心里维护的默认地址，进结算页就是已选中的那一条；
//   2) 金额只在 store/orderStore.js 里算一次，页面不再另写一套，避免「预览一个价、下单另一个价」；
//   3) 提交优先走网关 POST /api/orders —— 服务端在**一个事务里**完成
//      校验 → 算钱 → 扣库存 → 建单 → 核销优惠券，前端只落一份本地镜像；
//      无网关（纯静态托管 / 离线）时降级本地下单 + 券核销发件箱补推；
//   4) 提交后跳 #/order-success/:id —— 成功页只认这个 id，刷新也能靠订单簿复原。
//
// 未登录由 app.js 的路由守卫拦下并带 redirect；这里再兜一次，防止被直接调用绕过。
import { el, fmtPrice, toast, updateCartBadge, productThumb } from './ui.js';
import { getCart, removeFromCart, setQty } from './state.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import { api, isMissingEndpoint } from './api.js';
import {
  PAYMENT_METHODS, computeAmounts, createOrder, getShippingMethods, normalizeRemote, paymentById,
  shippingById,
} from './store/orderStore.js';
import { loadRuntimeConfig, shippingFeeOf } from './store/config.js';
import {
  getAddress, hydrateAddresses, listAddresses, saveAddress, validateAddress,
} from './store/addressStore.js';
import {
  bestCouponId, decorateMine, fmtCouponValue, hydrateWallet, listWallet, markCouponUsed, sortForCheckout,
  syncWallet,
} from './store/couponStore.js';

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
    // 配送方式来自运营配置（服务端 app_settings.shipping，离线用内置默认）
    shippingId: getShippingMethods()[0].id,
    paymentId: PAYMENT_METHODS[0].id,
    remark: '',
    submitting: false,
    showForm: false,
    error: '',
    couponRaw: [], // 我的券包快照（未使用 / 已使用 / 已过期都在里面，可用性按当前金额实时算）
    couponId: null, // 选中的券 couponId；null = 不使用优惠券
    couponAuto: false, // 是否已做过「自动选最优」
    couponShowAll: false, // 不可用券默认折叠，券多时不把商品清单顶到屏幕外
  };
  // 默认地址预选：没有默认地址时退化为第一条（订单必须挂一个真实地址）
  const def = state.addresses.find((a) => a.isDefault) || state.addresses[0] || null;
  state.addressId = def ? def.id : null;

  // 券包先用本地同步读：首屏就能看到券（不闪一下「券包是空的」），
  // 网关卡包随后在底部 hydrate 里合并进来。选券留给初始化时的 reconcileCoupon()。
  state.couponRaw = listWallet(user.id);
  state.couponAuto = true;

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
  const couponCard = el('section', { class: 'co2-card' });
  const itemCard = el('section', { class: 'co2-card' });
  const remarkCard = el('section', { class: 'co2-card' });
  const sumCard = el('aside', { class: 'co2-card co2-sum' });

  const grid = el('div', { class: 'co2-grid' }, [
    el('div', { class: 'co2-main' }, [addrCard, shipCard, payCard, couponCard, itemCard, remarkCard]),
    el('div', { class: 'co2-side' }, [sumCard]),
  ]);

  view.appendChild(el('div', { class: 'co2' }, [heading, grid]));

  const selectedAddress = () => getAddress(user.id, state.addressId);
  const productAmount = () => getCart().reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);
  // 券可用性、worth、不可用原因每次按当前商品总额本地重算（改数量立即生效，无需重新请求）
  const couponsNow = () => sortForCheckout(decorateMine(state.couponRaw, productAmount()));
  const pickedCoupon = () => couponsNow()
    .find((c) => String(c.id) === String(state.couponId) && c.usable) || null;
  const amounts = () => {
    const c = pickedCoupon();
    const goods = productAmount();
    const discount = c ? c.worth : 0;
    return computeAmounts({
      productAmount: goods,
      // 运费按配置算，包邮门槛看「券后商品金额」——与服务端 settingsService.shippingFeeOf 同公式
      shippingFee: shippingFeeOf(shippingById(state.shippingId), Math.max(0, goods - discount)),
      couponDiscount: discount,
      couponTitle: c ? c.title : '',
      couponId: c ? c.couponId : '',
    });
  };
  /**
   * 券与金额对账：
   *   - 还在自动模式（用户没手动干预）→ 按新金额重选最优；
   *   - 手动选过 → 保留用户选择，但那张券因金额下降变得不可用时必须撤掉，
   *     否则会出现「选着一张用不了的券、抵扣却是 0」的自相矛盾界面。
   */
  function reconcileCoupon() {
    const coupons = couponsNow();
    if (state.couponAuto) {
      state.couponId = bestCouponId(coupons);
      return;
    }
    const cur = coupons.find((c) => String(c.id) === String(state.couponId));
    if (state.couponId && (!cur || !cur.usable)) state.couponId = null;
  }
  // 数量变化后的统一刷新：清单 → 券（worth/可用性随金额变）→ 金额。
  // 仍处于「自动选最优」模式（用户没手动干预过）时，按新金额重选最优券——
  // 比如删掉一件后总额从 820 降到 640，满 599 减 80 就会反超 9 折。
  function repaintAfterQty() {
    if (!getCart().length) {
      navigate('#/cart');
      return;
    }
    reconcileCoupon();
    paintItems();
    paintCoupon();
    paintSum();
  }

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
    shipCard.appendChild(cardHead('配送方式', '运费与时效由运营配置'));
    const box = el('div', { class: 'co2-picks' });
    getShippingMethods().forEach((m) => {
      const on = m.id === state.shippingId;
      // 展示「本单实收运费」而不是标价：配了满额包邮时，标价 ¥18 的加急也可能免运费
      const fee = shippingFeeOf(m, Math.max(0, productAmount() - (pickedCoupon() || { worth: 0 }).worth));
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
          el('span', { class: 'co2-pick-fee num' }, fee ? fmtPrice(fee) : '免运费'),
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

  /* ---------------- 4. 优惠券（券包 → 自动选最优 / 手动切换） ---------------- */
  // 这里只展示「我卡包里的券」，不再是从券目录临时拼的——没领就是没有，
  // 否则券中心的领取动作毫无意义。不可用的券也留在列表里，并写明原因（差多少钱 / 已过期 / 已使用）。
  function paintCoupon() {
    couponCard.innerHTML = '';
    // 只列「还没用掉」的券：已使用 / 已过期的券在券包里看就行，
    // 混进结算页只会让「这张为什么点不动」变成噪音。
    const coupons = couponsNow().filter((c) => c.state === 'unused');
    const usable = coupons.filter((c) => c.usable);
    const picked = pickedCoupon();
    const autoOn = state.couponAuto && usable.length > 0;

    couponCard.appendChild(cardHead(
      '优惠券',
      autoOn
        ? '已自动为你选中最优的一张，可点选更换'
        : (usable.length ? '点选使用 · 再点一次取消' : '暂无可用优惠券'),
    ));

    if (!coupons.length) {
      couponCard.appendChild(el('div', { class: 'co2-coupon-empty' }, [
        el('p', { class: 'co2-empty' }, '券包还是空的，去券中心领一张再来结算。'),
        el('a', { class: 'co2-coupon-link', href: '#/coupons' }, '去优惠券中心 →'),
      ]));
      return;
    }

    const box = el('div', { class: 'co2-coupons' });
    // 可用券全列；不可用券默认只露 3 张，其余折叠——券多时十几张灰卡会把商品清单推到屏幕外，
    // 但「不可用」这件事本身不能被藏起来，所以每张都写明原因，只是分批展示。
    const offs = coupons.filter((c) => !c.usable);
    const shown = [...usable, ...(state.couponShowAll ? offs : offs.slice(0, 3))];
    shown.forEach((c) => {
      const on = Boolean(picked) && String(picked.couponId) === String(c.couponId);
      const worthText = fmtCouponValue(c);
      const meta = `满 ${fmtCouponValue({ kind: 'cash', amount: c.threshold })} 可用 · ${expiryText(c)}`;

      if (c.usable) {
        box.appendChild(
          el('button', {
            class: `co2-cp${on ? ' is-on' : ''}`,
            type: 'button',
            role: 'checkbox',
            'aria-checked': on ? 'true' : 'false',
            'data-coupon': c.couponId,
            onclick: () => {
              // 再点一次已选中的 = 取消使用；任何手动点选都接管自动模式
              state.couponAuto = false;
              state.couponId = on ? null : c.couponId;
              paintCoupon();
              paintSum();
            },
          }, [
            el('span', { class: 'co2-cp-worth num' }, worthText),
            el('span', { class: 'co2-cp-body' }, [
              el('span', { class: 'co2-cp-title' }, c.title),
              el('span', { class: 'co2-cp-sub num' }, on ? `已抵扣 ${fmtPrice(c.worth)}` : `本单可省 ${fmtPrice(c.worth)}`),
              el('span', { class: 'co2-cp-meta' }, meta),
            ]),
            el('span', { class: 'co2-cp-check', 'aria-hidden': 'true' }, on ? '✓' : ''),
          ]),
        );
        return;
      }

      // 不可用：把「为什么不能用」说清楚，用户才知道是去凑单还是换一张
      const why = c.state === 'used'
        ? '已使用'
        : c.state === 'expired'
          ? '已过期'
          : `${c.reason} · 还差 ${fmtPrice(c.gap)}`;
      box.appendChild(
        el('div', {
          class: `co2-cp is-off${c.state === 'expired' ? ' is-expired' : ''}`,
          'aria-disabled': 'true',
          'data-coupon': c.couponId,
        }, [
          el('span', { class: 'co2-cp-worth num' }, worthText),
          el('span', { class: 'co2-cp-body' }, [
            el('span', { class: 'co2-cp-title' }, c.title),
            el('span', { class: 'co2-cp-sub' }, why),
            el('span', { class: 'co2-cp-meta' }, meta),
          ]),
        ]),
      );
    });
    couponCard.appendChild(box);

    if (offs.length > 3) {
      const hidden = offs.length - 3;
      couponCard.appendChild(el('button', {
        class: 'co2-coupon-toggle',
        type: 'button',
        onclick: () => {
          state.couponShowAll = !state.couponShowAll;
          paintCoupon();
        },
      }, state.couponShowAll ? '收起不可用券' : `展开其余 ${hidden} 张不可用券`));
    }

    const off = coupons.filter((c) => c.state !== 'unused').length;
    if (off) {
      couponCard.appendChild(el('p', { class: 'co2-coupon-note' }, [
        `另有 ${off} 张已使用或已过期的券不参与本单 · `,
        el('a', { class: 'co2-coupon-link', href: '#/account?tab=coupons' }, '查看券包'),
      ]));
    }
  }

  /** 券有效期一句话：7 天内到期要说「即将到期」，别让用户临门一脚才发现过期 */
  function expiryText(c) {
    const ms = Number(c.expiresAt) || 0;
    if (!ms) return '长期有效';
    const days = Math.ceil((ms - Date.now()) / 86400000);
    if (days <= 0) return '已过期';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
    return days <= 7 ? `${day} 到期 · 仅剩 ${days} 天` : `${day} 到期`;
  }

  /* ---------------- 5. 商品清单（行内改数量 / 删除） ---------------- */
  function paintItems() {
    itemCard.innerHTML = '';
    const cart = getCart();
    itemCard.appendChild(cardHead('商品清单', `${cart.reduce((n, i) => n + (Number(i.qty) || 0), 0)} 件 · 可直接调整`));
    cart.forEach((it) => {
      const key = it.__key || it.id;
      // 库存夹逼上限：无库存信息的商品不设限（服务端下单仍会兜底校验）
      const maxQty = Number(it.stock) > 0 ? Number(it.stock) : Infinity;
      const qtyBox = el('div', { class: 'co2-qty' }, [
        el('button', {
          class: 'co2-step', type: 'button', 'aria-label': `减少 ${it.name} 数量`,
          disabled: it.qty <= 1,
          onclick: () => { setQty(key, Number(it.qty) - 1); repaintAfterQty(); },
        }, '−'),
        el('span', { class: 'co2-qty-n num', 'aria-live': 'polite' }, String(it.qty)),
        el('button', {
          class: 'co2-step', type: 'button', 'aria-label': `增加 ${it.name} 数量`,
          disabled: it.qty >= maxQty,
          onclick: () => { setQty(key, Math.min(maxQty, Number(it.qty) + 1)); repaintAfterQty(); },
        }, '+'),
      ]);
      itemCard.appendChild(
        el('div', { class: 'co2-item' }, [
          el('div', { class: 'co2-item-thumb' }, productThumb(it)),
          el('div', { class: 'co2-item-info' }, [
            el('div', { class: 'co2-item-name' }, it.name),
            el('div', { class: 'co2-item-sku' }, it.spec ? `SKU：${it.spec}` : 'SKU：默认规格'),
            el('div', { class: 'co2-item-ops' }, [
              el('span', { class: 'co2-item-price num' }, fmtPrice(it.price)),
              qtyBox,
              el('button', {
                class: 'co2-item-del', type: 'button',
                onclick: () => { removeFromCart(key); repaintAfterQty(); },
              }, '删除'),
            ]),
          ]),
          el('div', { class: 'co2-item-sub num' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
        ]),
      );
    });
    itemCard.appendChild(
      el('a', { class: 'co2-item-edit', href: '#/cart' }, '去购物袋整体调整 →'),
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
      el('span', {}, a.couponTitle ? `优惠券（${a.couponTitle}）` : '优惠券'),
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
  /**
   * 提交入口：只做前置校验，真正的下单是异步的。
   * 校验与网络分开，是因为「没选地址」属于用户可改的错误，不该把按钮卡在「提交中…」。
   */
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
    void placeOrder(cart, address);
  }

  /** 下单成功后的统一收尾：清购物袋 → 同步券 → 跳成功页 */
  function finish(order) {
    // 只清掉已结算的商品：结算期间在别处新加的东西不该被一起清空
    getCart().forEach((i) => removeFromCart(i.__key || i.id));
    updateCartBadge();
    state.submitting = false;
    // 服务端订单的券是在事务里核销的：拉一次卡包让本机立刻显示「已使用」。
    // 失败不影响下单结果——下次进券包还会再同步一次。
    if (order && order.remote) syncWallet(user.id).catch(() => {});
    toast(`订单 ${order.id} 已提交`, 'ok');
    navigate(`#/order-success/${encodeURIComponent(order.id)}`);
  }

  /**
   * 下单：优先服务端事务，失败降级本地。
   *
   * 为什么优先走服务端：券核销必须与建单原子。客户端「先建单、再补一条核销请求」的做法
   * 中间只要断一次网，就会出现「单建成了、券还在手里」或者「券花掉了、单没建成」，
   * 而这两件事用户都能感知到。服务端一个事务做完，客户端不再自己动券。
   *
   * 降级条件只认「这个部署没有后端」（404/405/501）与离线——
   * 业务拒绝（库存不足 409、券不可用 400）必须如实显示，不能偷偷改成本地单，
   * 否则用户以为下了一单，服务端其实没有。
   *
   * 取舍：网络中途断开（请求可能已到达服务端）时也降级本地单，
   * 理论上可能同时存在一张服务端单和一张本地单。演示站选「宁可重复也不要丢单」，
   * 真实系统应带幂等键（IDEMPOTENCY-KEY）由服务端去重。
   */
  async function placeOrder(cart, address) {
    const amt = amounts();
    const draft = {
      items: cart,
      address,
      shippingMethod: shippingById(state.shippingId),
      paymentMethod: paymentById(state.paymentId),
      remark: state.remark,
      amounts: amt,
    };

    try {
      const d = await api('/api/orders', {
        method: 'POST',
        // 下单不重试：重试可能重复建单（服务端没有幂等去重）
        retries: 0,
        body: {
          userId: user.id,
          items: cart.map((i) => ({
            productId: i.productId || i.id,
            skuId: i.skuId ?? null,
            qty: Math.max(1, Number(i.qty) || 1),
          })),
          addressId: address.id || null,
          couponId: amt.couponId || null,
          shippingMethodId: state.shippingId,
          paymentMethodId: state.paymentId,
          remark: state.remark,
        },
      });
      const remote = normalizeRemote({ ...(d && d.order), userId: user.id });
      if (!remote.id) throw new Error('服务端未返回订单号');

      // 本地只落一份镜像：编号/金额/状态全部用服务端的值，
      // 名称与 SKU 也用服务端返回的（按服务端库里现查的价格，比购物袋里的旧快照可信）。
      const mirror = createOrder(user.id, {
        id: remote.id,
        items: remote.items.length ? remote.items : cart,
        address,
        shippingMethod: remote.shippingMethod,
        paymentMethod: remote.paymentMethod,
        remark: state.remark,
        amounts: remote.amounts,
        status: remote.status,
        createdAt: remote.createdAt,
        remote: true,
      });

      // 服务端金额与页面预览不一致（价格更新、库存档位变化）：以服务端为准，并明确告知
      const gap = Number(remote.amounts.payAmount) - Number(amt.payAmount);
      if (Math.abs(gap) >= 0.01) {
        toast(`订单已提交，金额按最新价格调整为 ${fmtPrice(remote.amounts.payAmount)}`, 'warn');
        finish(mirror);
        return;
      }
      finish(mirror);
    } catch (e) {
      const noBackend = isMissingEndpoint(e) || e.kind === 'offline' || !e.status;
      if (!noBackend) {
        state.submitting = false;
        state.error = (e && e.message) || '提交失败，请重试';
        paintSum();
        return;
      }
      // 降级：本地单 + 券核销进发件箱，联网后由 syncWallet 补推
      try {
        const order = createOrder(user.id, draft);
        if (order.amounts && order.amounts.couponId) {
          markCouponUsed(user.id, order.amounts.couponId, order.id);
        }
        finish(order);
      } catch (err) {
        state.submitting = false;
        state.error = (err && err.message) || '提交失败，请重试';
        paintSum();
      }
    }
  }

  paintAddress();
  paintShipping();
  paintPayment();
  reconcileCoupon(); // 自动选中当前金额下最省的一张（无可用券则保持不使用）
  paintCoupon();
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

  // 券包：拉一次卡包（本地 + 网关卡包合并），之后可用性/worth 全部本地按当前金额重算。
  // 首次进入自动选最优券（省得最多），用户可手动更换或取消。
  hydrateWallet(user.id).then(({ list }) => {
    state.couponRaw = Array.isArray(list) ? list : [];
    // 网关卡包可能带回本地没有的券：重选一次最优，但不覆盖用户已经手动做的选择
    reconcileCoupon();
    paintCoupon();
    paintSum();
  }).catch((e) => {
    console.warn('[checkout] 券包加载失败', e && e.message);
  });

  // 运营配置（配送方式 / 运费 / 券顺延规则）：拉到新值就重绘配送与金额。
  // 这里用 force 绕过缓存 TTL —— 结算页是「按下单金额收钱」的页面，
  // 多一个 GET 换「展示的运费就是实收的运费」很值：缓存里的旧运费会让用户
  // 看到 104、实际被收 114，这种事一次都不能有。
  loadRuntimeConfig({ force: true }).then(({ changed }) => {
    if (!changed) return;
    // 配送方式整份被换掉时，原来选的 id 可能已不存在
    if (!getShippingMethods().some((m) => m.id === state.shippingId)) {
      state.shippingId = getShippingMethods()[0].id;
    }
    paintShipping();
    paintSum();
  }).catch(() => {
    /* 配置拉不到就用离线默认，不打断结算 */
  });
}
