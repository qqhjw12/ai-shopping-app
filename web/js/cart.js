// 购物袋整页（#/cart）：抽屉之外的第二入口，也是结算页「返回购物袋修改」的落点。
//
// 与抽屉的差异：整页用两栏（清单 + 金额），改数量即时重算，去结算按钮在视线右侧；
// 抽屉保留给「随手加购后继续逛」的场景，两者共用 state.js 的同一份购物车数据。
import { el, fmtPrice, toast, updateCartBadge, productThumb } from './ui.js';
import { getCart, removeFromCart, setQty } from './state.js';
import { navigate } from './router.js';
import { maxQty } from './views.js';

export function renderCart(view) {
  view.innerHTML = '';

  const paint = () => {
    view.innerHTML = '';
    const cart = getCart();
    const count = cart.reduce((n, i) => n + (Number(i.qty) || 0), 0);
    const productAmount = cart.reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);

    view.appendChild(
      el('header', { class: 'bag-heading' }, [
        el('div', {}, [
          el('span', { class: 'eyebrow' }, 'YOUR BAG'),
          el('h1', { class: 'page-display' }, '购物袋'),
        ]),
        el('span', { class: 'bag-count' }, `${count} 件`),
      ]),
    );

    if (!cart.length) {
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

    const list = el('div', { class: 'bag-list' });
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
        paint();
      };
      list.appendChild(
        el('article', { class: 'bag-row' }, [
          el('div', { class: 'bag-thumb' }, productThumb(it)),
          el('div', { class: 'bag-info' }, [
            el('div', { class: 'bag-name' }, it.name),
            el('div', { class: 'bag-sku' }, it.spec ? `SKU：${it.spec}` : 'SKU：默认规格'),
            el('div', { class: 'bag-unit num' }, fmtPrice(it.price)),
          ]),
          el('div', { class: 'bag-qty' }, [
            el('button', {
              class: 'cart-step',
              type: 'button',
              'aria-label': '减少数量',
              disabled: it.qty <= 1,
              onclick: () => step(-1),
            }, '−'),
            el('span', { class: 'cart-qty-num num' }, String(it.qty)),
            el('button', {
              class: 'cart-step',
              type: 'button',
              'aria-label': '增加数量',
              disabled: it.qty >= max,
              onclick: () => step(1),
            }, '+'),
          ]),
          el('div', { class: 'bag-sub num' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
          el('button', {
            class: 'bag-del',
            type: 'button',
            'aria-label': `移除 ${it.name}`,
            onclick: () => {
              removeFromCart(key);
              updateCartBadge();
              toast('已从购物袋移除', 'ok');
              paint();
            },
          }, '移除'),
        ]),
      );
    });

    const sumCard = el('aside', { class: 'bag-sum' }, [
      el('h2', {}, '金额小计'),
      el('div', { class: 'bag-sum-row' }, [
        el('span', {}, '商品总额'),
        el('span', { class: 'num' }, fmtPrice(productAmount)),
      ]),
      el('div', { class: 'bag-sum-row is-total' }, [
        el('span', {}, '合计'),
        el('span', { class: 'num bag-sum-money' }, fmtPrice(productAmount)),
      ]),
      el('p', { class: 'bag-sum-note' }, '运费、优惠券与配送方式在结算页确认'),
      el('button', {
        class: 'bag-checkout',
        type: 'button',
        onclick: () => navigate('#/checkout'),
      }, '去结算'),
      el('a', { class: 'bag-continue', href: '#/products' }, '继续购物'),
    ]);

    view.appendChild(el('div', { class: 'bag-grid' }, [list, sumCard]));
  };

  paint();
}
