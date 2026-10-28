// 个人中心（#/account）：Bento 栅格 + 三个 Tab（订单 / 地址 / 优惠券）。
//
// 数据归属约定：
//   - 订单：网关按 userId 返回，userId 来自当前登录用户（state.getUserId 登录优先），
//     所以「登录后下的单」天然挂在这个账户名下；网关不可达时给出可行动的提示。
//   - 地址：服务端为准 + 本地缓存（store/addressStore.js），同一账号换设备自动跟随；
//     与结算页共用同一份存储，默认地址会被结算页优先选中。
//   - 优惠券：本步骤只做占位，下一步接 /api/coupons。
import { api } from './api.js';
import { el, fmtPrice, loading, toast, productThumb } from './ui.js';
import { navigate } from './router.js';
import { logout as closeSession } from './auth.js';
import {
  clearCurrentUser, displayName, getCurrentUser, initials, maskIdentifier, onUserChange,
} from './user.js';
import {
  PROVINCES, getDefaultAddress, hydrateAddresses, listAddresses, removeAddress,
  saveAddress, setDefaultAddress, validateAddress,
} from './store/addressStore.js';
import {
  getOrder, listOrders, mergeOrders, normalizeRemote, statusText,
} from './store/orderStore.js';

const TABS = [
  { key: 'orders', label: '我的订单' },
  { key: 'address', label: '收货地址' },
  { key: 'coupons', label: '我的优惠券' },
];

function fmtDate(iso) {
  const s = String(iso || '');
  if (!s) return '';
  return s.slice(0, 16).replace('T', ' ');
}

/* ============================================================
   入口
   ============================================================ */

export function renderAccount(view, { tab = 'orders' } = {}) {
  const user = getCurrentUser();
  // 兜底守卫：正常由 app.js 的 dispatch 拦下，这里再防一次直接调用的情况
  if (!user) {
    navigate(`#/login?redirect=${encodeURIComponent('/account')}`);
    return;
  }
  const active = TABS.some((t) => t.key === tab) ? tab : 'orders';

  const addresses = listAddresses(user.id);

  view.innerHTML = '';
  const page = el('section', { class: 'acct-page' });
  const bento = buildBento(user, { addresses });
  page.appendChild(bento.node);
  page.appendChild(buildTabs(active));

  const panel = el('div', { class: 'acct-panel' });
  page.appendChild(panel);
  view.appendChild(page);

  if (active === 'orders') paintOrders(panel, user, bento);
  else if (active === 'address') {
    const addrPanel = paintAddresses(panel, user, addresses, bento);
    // 服务端校准：先用缓存秒开，拉回最新地址后再刷一次（表单正在编辑时不打断）
    hydrateAddresses(user.id).then(({ addresses: fresh, online }) => {
      bento.setAddresses(fresh);
      if (!addrPanel || !addrPanel.isEditing()) addrPanel.repaint(fresh);
      if (!online) return;
    }).catch((e) => {
      // 校准失败不该影响已渲染的缓存内容，但要在控制台留下线索便于排查
      console.warn('[addresses] 服务端校准失败', e && e.message);
    });
  } else paintCoupons(panel);

  // 登录态变化（退出 / 换号）时重绘本页，避免停在一份过期资料上
  const off = onUserChange((u) => {
    off();
    if (u) renderAccount(view, { tab: active });
    else navigate('#/');
  });
  return page;
}

/* ============================================================
   Bento 头部：用户信息卡（玻璃 + 顶部微光）+ 3 个数据块
   ============================================================ */

function buildBento(user, { addresses }) {
  const name = displayName(user);
  const def = getDefaultAddress(user.id);

  const heroNote = el('div', { class: 'acct-hero-note' },
    def
      ? `默认收货：${def.receiver} ${maskIdentifier(def.phone)} · ${def.region}`
      : '还没有收货地址，新增一个即可带到结算页');

  const hero = el('article', { class: 'acct-hero' }, [
    el('span', { class: 'acct-glow', 'aria-hidden': 'true' }),
    el('div', { class: 'acct-avatar', 'aria-hidden': 'true' }, initials(user)),
    el('div', { class: 'acct-ident' }, [
      el('span', { class: 'eyebrow' }, 'MEMBER · MAISON AI'),
      el('h1', { class: 'acct-name' }, name),
      el('p', { class: 'acct-meta' }, [
        user.identifier ? maskIdentifier(user.identifier) : '演示账号',
        el('span', { class: 'acct-dot' }, '·'),
        `加入于 ${fmtDate(user.loginAt).slice(0, 10) || '今天'}`,
      ]),
    ]),
    el('div', { class: 'acct-hero-foot' }, [
      heroNote,
      el('div', { class: 'acct-hero-actions' }, [
        el('a', { class: 'acct-ghost-link', href: '#/products' }, '继续逛逛'),
        el('button', { class: 'acct-logout', type: 'button', onclick: doLogout }, '退出登录'),
      ]),
    ]),
  ]);

  const stat = (label, value, hint) => {
    const valueNode = el('strong', { class: 'acct-stat-value' }, String(value));
    const hintNode = el('span', { class: 'acct-stat-hint' }, hint);
    const node = el('article', { class: 'acct-stat' }, [
      el('span', { class: 'acct-stat-label' }, label),
      valueNode,
      hintNode,
    ]);
    return { node, valueNode, hintNode };
  };

  const addrStat = stat('收货地址', addresses.length, addresses.length ? '按账户隔离存储' : '新增后自动带默认');
  // 订单计数由 paintOrders 在数据取回后回填；其他 Tab 不发请求，保持安静占位
  const orderStat = stat('我的订单', '—', '下单后在此留档');
  const couponStat = stat('优惠券', 0, '优惠券中心即将上线');

  const node = el('div', { class: 'acct-bento' }, [hero, addrStat.node, orderStat.node, couponStat.node]);

  return {
    node,
    /** 订单取回后回填计数，避免顶部数字长期停在占位符 */
    setOrders: (n) => {
      orderStat.valueNode.textContent = String(n);
      orderStat.hintNode.textContent = n ? '点击下方「我的订单」查看' : '下单后在此留档';
    },
    /** 地址增删后同步回填：数据块 + 信息卡里的默认地址一行 */
    setAddresses: (list) => {
      addrStat.valueNode.textContent = String(list.length);
      addrStat.hintNode.textContent = list.length ? '按账户隔离存储' : '新增后自动带默认';
      const def2 = list.find((a) => a.isDefault) || list[0] || null;
      heroNote.textContent = def2
        ? `默认收货：${def2.receiver} ${maskIdentifier(def2.phone)} · ${def2.region}`
        : '还没有收货地址，新增一个即可带到结算页';
    },
  };
}

function doLogout() {
  closeSession().catch(() => {});
  clearCurrentUser();
  toast('已退出登录', 'ok');
  navigate('#/');
}

/* ============================================================
   Tab 胶囊
   ============================================================ */

function buildTabs(active) {
  const nav = el('nav', { class: 'acct-tabs', role: 'tablist' });
  TABS.forEach((t) => {
    const btn = el('button', {
      class: `acct-tab${t.key === active ? ' is-on' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': t.key === active ? 'true' : 'false',
      onclick: () => navigate(`#/account?tab=${t.key}`),
    }, t.label);
    nav.appendChild(btn);
  });
  return nav;
}

/* ============================================================
   Tab 1：我的订单
   ============================================================ */

async function paintOrders(box, user, bento) {
  box.innerHTML = '';
  loading(box, '正在取回订单…');

  // 本地订单（本步骤的结算链路落地在 localStorage）先读，网关联通时再合并远端订单。
  // 顺序很关键：断网时也必须能看到自己刚下的单，否则「下了单却看不到」会被当成丢单。
  const local = listOrders(user.id);
  let remote = null;
  try {
    const d = await api(`/api/orders?userId=${encodeURIComponent(user.id)}`, { retries: 0 });
    remote = (Array.isArray(d && d.orders) ? d.orders : []).map(normalizeRemote);
  } catch {
    remote = null;
  }
  const orders = remote ? mergeOrders(local, remote) : local;
  if (bento && bento.setOrders) bento.setOrders(orders.length);

  box.innerHTML = '';
  if (!orders.length) {
    box.appendChild(remote === null
      ? emptyCard({
          title: '还没有订单',
          text: '本机还没有下单记录，网关也没连通。挑件喜欢的东西结算一次，订单会归到这个账户名下。',
          primary: '去选购',
          onPrimary: () => navigate('#/products'),
        })
      : emptyCard({
          title: '还没有订单',
          text: '挑一件喜欢的东西下单，订单会自动归到这个账户名下。',
          primary: '去选购',
          onPrimary: () => navigate('#/products'),
        }));
    return;
  }

  const list = el('div', { class: 'acct-orders' });
  orders.forEach((o) => list.appendChild(orderCard(o)));
  box.appendChild(list);

  box.appendChild(el('div', { class: 'acct-more' }, [
    el('a', { href: '#/orders', class: 'acct-ghost-link' }, '查看完整订单页（支付 / 再买 / 物流）→'),
  ]));
}

function orderCard(o) {
  const items = Array.isArray(o.items) ? o.items : [];
  const thumbs = items.slice(0, 4);
  const qty = items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  const open = () => navigate(`#/account/order/${encodeURIComponent(o.id)}`);
  const pay = (o.amounts && o.amounts.payAmount) ?? o.payAmount ?? 0;

  return el('article', { class: 'acct-order', onclick: open, role: 'button', tabindex: '0' }, [
    el('div', { class: 'acct-order-head' }, [
      el('span', { class: 'acct-order-id' }, `订单号 ${o.id}`),
      el('span', { class: 'acct-order-date' }, fmtDate(o.createdAt)),
      el('span', { class: `acct-status s-${o.status}` }, statusText(o.status)),
    ]),
    el('div', { class: 'acct-order-body' }, [
      el('div', { class: 'acct-order-thumbs' }, thumbs.map((i) => el('div', { class: 'acct-thumb' },
        productThumb({ id: i.productId, name: i.name, categoryId: '', coverColor: '' }, { fade: false })))),
      el('div', { class: 'acct-order-info' }, [
        el('div', { class: 'acct-order-title' }, items[0] ? items[0].name : '订单商品'),
        el('div', { class: 'acct-order-sub' }, items.length > 1 ? `等 ${items.length} 种商品 · 共 ${qty} 件` : `共 ${qty} 件`),
      ]),
      el('div', { class: 'acct-order-amount' }, [
        el('span', { class: 'acct-order-amount-label' }, '应付'),
        el('b', { class: 'num' }, fmtPrice(pay)),
      ]),
      el('span', { class: 'acct-order-arrow', 'aria-hidden': 'true' }, '→'),
    ]),
  ]);
}

/* ============================================================
   Tab 2：收货地址
   ============================================================ */

function paintAddresses(box, user, addresses, bento) {
  box.innerHTML = '';

  const grid = el('div', { class: 'acct-addr-grid' });
  const subNode = el('span', { class: 'acct-panel-sub' }, `${addresses.length} 个 · 按账户隔离`);
  const head = el('div', { class: 'acct-panel-head' }, [
    el('h2', {}, '收货地址'),
    subNode,
  ]);
  const addBtn = el('button', { class: 'acct-add', type: 'button' }, '+ 新增地址');
  head.appendChild(addBtn);
  box.appendChild(head);

  const formHost = el('div', { class: 'acct-form-host' });
  box.appendChild(formHost);
  box.appendChild(grid);

  const repaint = (given) => {
    const next = Array.isArray(given) ? given : listAddresses(user.id);
    // 顶部数据块、面板计数与默认地址提示随地址增删同步，避免停在进入页面时的快照
    if (bento && bento.setAddresses) bento.setAddresses(next);
    subNode.textContent = `${next.length} 个 · 跨设备同步`;
    grid.innerHTML = '';
    if (!next.length) {
      grid.appendChild(emptyCard({
        title: '地址簿还是空的',
        text: '新增一个收货地址，结算时会自动带出默认地址。',
        primary: '新增地址',
        onPrimary: () => openForm(),
      }));
      return;
    }
    next.forEach((a) => grid.appendChild(addressCard(a, { user, repaint, openForm })));
  };

  function openForm(editing = null) {
    formHost.innerHTML = '';
    formHost.appendChild(addressForm({ user, editing, onDone: () => { formHost.innerHTML = ''; repaint(); } }));
  }

  addBtn.addEventListener('click', () => {
    if (listAddresses(user.id).length >= 20) {
      toast('最多保存 20 个地址', 'warn');
      return;
    }
    openForm();
  });

  repaint();

  return {
    repaint,
    /** 表单开着时不要被服务端回刷打断，否则用户正在填的内容会被清掉 */
    isEditing: () => Boolean(formHost.firstChild),
  };
}

function addressCard(a, { user, repaint, openForm }) {
  const delBtn = el('button', { class: 'acct-addr-act del', type: 'button' }, '删除');
  let confirming = false;
  let resetTimer = null;

  delBtn.addEventListener('click', async () => {
    if (!confirming) {
      confirming = true;
      delBtn.textContent = '确认删除?';
      delBtn.classList.add('is-confirm');
      resetTimer = setTimeout(() => {
        confirming = false;
        delBtn.textContent = '删除';
        delBtn.classList.remove('is-confirm');
      }, 3000);
      return;
    }
    if (resetTimer) clearTimeout(resetTimer);
    delBtn.disabled = true;
    const res = await removeAddress(user.id, a.id);
    delBtn.disabled = false;
    if (!res.ok) {
      toast(res.error || '删除失败', 'err');
      // 失败要复位按钮，否则停在「确认删除?」上让人以为没点上
      confirming = false;
      delBtn.textContent = '删除';
      delBtn.classList.remove('is-confirm');
      return;
    }
    toast(res.online === false ? '地址已删除（仅本机）' : '地址已删除', 'ok');
    repaint(res.addresses);
  });

  const actions = el('div', { class: 'acct-addr-actions' }, [
    el('button', { class: 'acct-addr-act', type: 'button', onclick: () => openForm(a) }, '编辑'),
    a.isDefault
      ? el('span', { class: 'acct-addr-act is-static' }, '默认地址')
      : el('button', {
        class: 'acct-addr-act',
        type: 'button',
        onclick: async (e) => {
          const btn = e && e.currentTarget;
          if (btn) btn.disabled = true;
          const res = await setDefaultAddress(user.id, a.id);
          if (btn) btn.disabled = false;
          if (!res.ok) toast(res.error || '设置失败', 'err');
          else {
            toast(res.online === false ? '已设为默认（仅本机）' : '已设为默认地址', 'ok');
            repaint(res.addresses);
          }
        },
      }, '设为默认'),
    delBtn,
  ]);

  return el('article', { class: `acct-addr${a.isDefault ? ' is-default' : ''}` }, [
    el('div', { class: 'acct-addr-top' }, [
      el('strong', { class: 'acct-addr-name' }, a.receiver),
      el('span', { class: 'acct-addr-phone' }, maskIdentifier(a.phone)),
      a.isDefault ? el('span', { class: 'acct-addr-badge' }, '默认') : null,
      a.pending ? el('span', { class: 'acct-addr-badge is-pending' }, '仅本机') : null,
    ]),
    el('p', { class: 'acct-addr-line' }, `${a.region} ${a.detail}`.trim()),
    a.postal ? el('p', { class: 'acct-addr-postal' }, `邮编 ${a.postal}`) : null,
    actions,
  ]);
}

function addressForm({ user, editing, onDone }) {
  const v = editing || {};
  const f = {};
  const field = (label, input, extra = '') => el('label', { class: `acct-field${extra}` }, [
    el('span', { class: 'acct-field-label' }, label),
    input,
  ]);

  f.receiver = el('input', { class: 'acct-input f-receiver', type: 'text', placeholder: '收货人姓名', value: v.receiver || '', maxlength: '20' });
  f.phone = el('input', { class: 'acct-input f-phone', type: 'tel', placeholder: '11 位手机号', value: v.phone || '', maxlength: '11', inputmode: 'numeric' });
  f.province = el('select', { class: 'acct-input f-province' },
    [el('option', { value: '' }, '选择省份'), ...PROVINCES.map((p) => el('option', { value: p }, p))]);
  if (v.province) f.province.value = v.province;
  f.city = el('input', { class: 'acct-input f-city', type: 'text', placeholder: '城市 / 区县，如 杭州市 西湖区', value: v.city || '' });
  f.detail = el('input', { class: 'acct-input f-detail', type: 'text', placeholder: '街道、门牌、楼层房号', value: v.detail || '' });
  f.postal = el('input', { class: 'acct-input f-postal', type: 'text', placeholder: '邮编（选填）', value: v.postal || '', maxlength: '6', inputmode: 'numeric' });
  f.isDefault = el('input', { class: 'acct-check f-default', type: 'checkbox', checked: Boolean(v.isDefault) });

  const err = el('p', { class: 'acct-form-err', hidden: true });

  const showErr = (msg) => {
    err.textContent = msg || '';
    if (msg) err.removeAttribute('hidden');
    else err.setAttribute('hidden', '');
  };

  const submit = el('button', { class: 'acct-save', type: 'submit' }, editing ? '保存修改' : '保存地址');
  const cancel = el('button', { class: 'acct-cancel', type: 'button' }, '取消');

  const form = el('form', { class: 'acct-addr-form', novalidate: 'novalidate' }, [
    el('div', { class: 'acct-form-head' }, [
      el('h3', {}, editing ? '编辑收货地址' : '新增收货地址'),
      el('span', { class: 'acct-panel-sub' }, '手机号用于快递联系，邮编可留空'),
    ]),
    el('div', { class: 'acct-form-grid' }, [
      field('收货人', f.receiver),
      field('手机号', f.phone),
      field('省份', f.province),
      field('城市 / 区县', f.city),
      field('详细地址', f.detail, ' span-2'),
      field('邮编（选填）', f.postal),
    ]),
    el('label', { class: 'acct-check-row' }, [f.isDefault, '设为默认地址']),
    err,
    el('div', { class: 'acct-form-actions' }, [submit, cancel]),
  ]);

  const collect = () => ({
    id: editing ? editing.id : undefined,
    receiver: String(f.receiver.value || '').trim(),
    phone: String(f.phone.value || '').trim(),
    province: String(f.province.value || '').trim(),
    city: String(f.city.value || '').trim(),
    detail: String(f.detail.value || '').trim(),
    postal: String(f.postal.value || '').trim(),
    isDefault: Boolean(f.isDefault.checked),
  });

  form.addEventListener('submit', async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const payload = collect();
    const invalid = validateAddress(payload);
    if (invalid) {
      showErr(invalid);
      return;
    }
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    const res = await saveAddress(user.id, payload);
    if (submitBtn) submitBtn.disabled = false;
    if (!res.ok) {
      showErr(res.error || '保存失败');
      return;
    }
    showErr('');
    const offline = res.online === false;
    toast(
      offline
        ? (editing ? '地址已更新（仅本机，联网后自动同步）' : '地址已添加（仅本机，联网后自动同步）')
        : (editing ? '地址已更新' : '地址已添加'),
      'ok',
    );
    onDone();
  });

  cancel.addEventListener('click', () => onDone());

  return form;
}

/* ============================================================
   Tab 3：我的优惠券（占位）
   ============================================================ */

function paintCoupons(box) {
  box.innerHTML = '';
  box.appendChild(el('div', { class: 'acct-panel-head' }, [
    el('h2', {}, '我的优惠券'),
    el('span', { class: 'acct-panel-sub' }, '即将上线'),
  ]));
  box.appendChild(el('div', { class: 'acct-coupon-wrap' }, [
    emptyCard({
      title: '优惠券中心在建',
      text: '下一步接入 /api/coupons：可用 / 已用 / 已过期分栏，结算页自动挑最省的那张。',
      primary: '去结算试试',
      onPrimary: () => navigate('#/checkout'),
    }),
  ]));
}

/* ============================================================
   订单详情（#/account/order/:id）
   ============================================================ */

/**
 * 订单详情：本地订单优先（结算页刚下的单就在这儿），查不到再问网关。
 * 成功页 →「查看订单」的落点就是这里，所以不能是占位页。
 */
export async function renderOrderDetail(view, orderId) {
  const user = getCurrentUser();
  const id = decodeURIComponent(String(orderId || ''));
  if (!user) {
    navigate(`#/login?redirect=${encodeURIComponent(`/account/order/${id}`)}`);
    return;
  }
  view.innerHTML = '';
  const host = el('div', { class: 'od-host' });
  view.appendChild(el('section', { class: 'acct-page' }, [
    el('div', { class: 'acct-crumb' }, [
      el('a', { href: '#/account?tab=orders' }, '← 返回我的订单'),
    ]),
    host,
  ]));
  loading(host, '正在取回订单…');

  let order = getOrder(user.id, id);
  if (!order) {
    try {
      const d = await api(`/api/orders?userId=${encodeURIComponent(user.id)}`, { retries: 0 });
      const hit = (Array.isArray(d && d.orders) ? d.orders : [])
        .find((o) => String(o.orderId || o.id) === id);
      if (hit) order = normalizeRemote(hit);
    } catch {
      /* 网关不可达：下面走「找不到订单」分支 */
    }
  }

  host.innerHTML = '';
  if (!order) {
    host.appendChild(emptyCard({
      title: '没有找到这笔订单',
      text: `订单号 ${id || '（空）'} 不属于当前账户，或已被清理。`,
      primary: '回到订单列表',
      onPrimary: () => navigate('#/account?tab=orders'),
      secondary: '继续购物',
      onSecondary: () => navigate('#/products'),
    }));
    return;
  }
  host.appendChild(orderDetailCard(order));
}

function orderDetailCard(o) {
  const addr = o.address;
  const a = o.amounts || {};
  const infoRow = (label, value) => el('div', { class: 'od-info-row' }, [
    el('span', { class: 'od-info-label' }, label),
    el('span', { class: 'od-info-value' }, value || '—'),
  ]);

  const items = el('div', { class: 'od-items' });
  (o.items || []).forEach((it) => {
    items.appendChild(el('div', { class: 'od-item' }, [
      el('div', { class: 'od-item-thumb' }, productThumb({ id: it.productId, name: it.name, coverColor: it.coverColor, pic: it.pic }, { fade: false })),
      el('div', { class: 'od-item-info' }, [
        el('div', { class: 'od-item-name' }, it.name),
        el('div', { class: 'od-item-sku' }, it.spec ? `SKU：${it.spec}` : 'SKU：默认规格'),
        el('div', { class: 'od-item-price num' }, `${fmtPrice(it.price)} × ${it.qty}`),
      ]),
      el('span', { class: 'od-item-sub num' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
    ]));
  });

  const sumRows = [
    ['商品总额', fmtPrice(a.productAmount)],
    ['运费', a.shippingFee ? fmtPrice(a.shippingFee) : '免运费'],
    ['优惠券' + (a.couponTitle ? `（${a.couponTitle}）` : ''),
      a.couponDiscount ? `- ${fmtPrice(a.couponDiscount)}` : '- ¥0'],
  ];

  return el('article', { class: 'od-card' }, [
    el('div', { class: 'od-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'ORDER DETAIL'),
        el('h1', { class: 'od-id num' }, o.id),
      ]),
      el('span', { class: `acct-status s-${o.status}` }, statusText(o.status)),
    ]),
    el('p', { class: 'od-date' }, `下单时间 ${fmtDate(o.createdAt) || '—'}`),
    items,
    el('div', { class: 'od-grid' }, [
      el('div', { class: 'od-block' }, [
        el('h3', {}, '收货信息'),
        infoRow('收货人', addr ? `${addr.receiver || ''}${addr.phone ? ` · ${addr.phone}` : ''}` : ''),
        infoRow('地址', addr ? `${addr.region || ''} ${addr.detail || ''}`.trim() : ''),
        infoRow('邮编', addr ? addr.postal : ''),
      ]),
      el('div', { class: 'od-block' }, [
        el('h3', {}, '配送与支付'),
        infoRow('配送方式', `${o.shippingMethod.name} · ${o.shippingMethod.eta || ''}`.trim()),
        infoRow('支付方式', o.paymentMethod.name),
        infoRow('订单备注', o.remark),
      ]),
    ]),
    el('div', { class: 'od-amounts' }, sumRows.map(([k, v]) => el('div', { class: 'od-sum-row' }, [
      el('span', {}, k), el('span', { class: 'num' }, v),
    ])).concat([
      el('div', { class: 'od-sum-row is-total' }, [
        el('span', {}, '应付金额'),
        el('span', { class: 'num od-total' }, fmtPrice(a.payAmount)),
      ]),
    ])),
    el('div', { class: 'od-actions' }, [
      el('a', { class: 'acct-save', href: '#/account?tab=orders' }, '回到订单列表'),
      el('a', { class: 'acct-cancel', href: '#/products' }, '继续购物'),
    ]),
  ]);
}

/* ============================================================
   通用空状态
   ============================================================ */

function emptyCard({ title, text, primary, onPrimary, secondary, onSecondary }) {
  return el('div', { class: 'acct-empty' }, [
    el('span', { class: 'acct-empty-mark', 'aria-hidden': 'true' }, 'M'),
    el('h3', { class: 'acct-empty-title' }, title),
    text ? el('p', { class: 'acct-empty-text' }, text) : null,
    el('div', { class: 'acct-empty-actions' }, [
      primary ? el('button', { class: 'acct-save', type: 'button', onclick: onPrimary }, primary) : null,
      secondary ? el('button', { class: 'acct-cancel', type: 'button', onclick: onSecondary }, secondary) : null,
    ]),
  ]);
}
