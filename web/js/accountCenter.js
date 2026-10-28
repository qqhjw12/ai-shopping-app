// 个人中心（#/account）：Bento 栅格 + 三个 Tab（订单 / 地址 / 优惠券）。
//
// 数据归属约定：
//   - 订单：网关按 userId 返回，userId 来自当前登录用户（state.getUserId 登录优先），
//     所以「登录后下的单」天然挂在这个账户名下；网关不可达时给出可行动的提示。
//   - 地址：服务端为准 + 本地缓存（store/addressStore.js），同一账号换设备自动跟随；
//     与结算页共用同一份存储，默认地址会被结算页优先选中。
//   - 优惠券：本步骤只做占位，下一步接 /api/coupons。
//   - 优惠券：券包在本地按 userId 隔离（store/couponStore.js），领取/核销/返还都在那里改，
//     本页只做「按状态分栏 + 状态回显」，所以结算页用掉一张券，回到这里立刻是「已使用」。
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
  listOrders, mergeOrders, normalizeRemote, statusText,
} from './store/orderStore.js';
import {
  STATE_TEXT, fmtCouponValue, onWalletChange,
  syncWallet, walletByState, walletStats,
} from './store/couponStore.js';

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
  } else paintCoupons(panel, user, bento);

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
  // 券包是本地同步读，进页面就能给出真实张数，不用等接口
  const couponStat = stat('优惠券', walletStats(user.id).unused, '结算时可抵扣');

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
    /** 券包变化（领取 / 核销 / 取消订单返还）后同步顶部块 */
    setCoupons: (n) => {
      couponStat.valueNode.textContent = String(n);
      couponStat.hintNode.textContent = n ? '结算时可抵扣' : '去券中心领一张';
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
   Tab 3：我的优惠券（未使用 / 已使用 / 已过期）
   ============================================================ */

const COUPON_TABS = [
  { key: 'unused', label: '未使用' },
  { key: 'used', label: '已使用' },
  { key: 'expired', label: '已过期' },
];

const COUPON_EMPTY = {
  unused: {
    title: '还没有可用的优惠券',
    text: '去券中心领一张，结算时会在你的券包里自动挑出最省的那张。',
    primary: '去券中心',
    to: '#/coupons',
  },
  used: {
    title: '还没有用过优惠券',
    text: '下单抵扣过的券会留在这里，附上核销的那笔订单号，方便回看。',
    primary: '查看我的订单',
    to: '#/account?tab=orders',
  },
  expired: {
    title: '没有过期的券',
    text: '券到期后会落进这一栏，不占卡包用量，也不会被结算页选中。',
    primary: '去券中心逛逛',
    to: '#/coupons',
  },
};

function fmtDay(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function paintCoupons(box, user, bento) {
  box.innerHTML = '';
  let active = 'unused';

  const sub = el('span', { class: 'acct-panel-sub' }, '');
  box.appendChild(el('div', { class: 'acct-panel-head' }, [
    el('h2', {}, '我的优惠券'),
    sub,
    el('a', { class: 'acct-add', href: '#/coupons' }, '去券中心领取'),
  ]));

  const tabs = el('div', { class: 'mycp-tabs', role: 'tablist' });
  const listBox = el('div', { class: 'mycp-list' });
  box.appendChild(tabs);
  box.appendChild(listBox);

  function render() {
    const s = walletStats(user.id);
    sub.textContent = `${s.unused} 张可用 · ${s.used} 张已用 · ${s.expired} 张过期`;
    if (bento && bento.setCoupons) bento.setCoupons(s.unused);

    tabs.innerHTML = '';
    COUPON_TABS.forEach((t) => {
      const on = t.key === active;
      tabs.appendChild(el('button', {
        class: `mycp-tab${on ? ' is-on' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        onclick: () => {
          active = t.key;
          render();
        },
      }, [
        el('span', {}, t.label),
        el('span', { class: 'mycp-tab-n num' }, String(s[t.key])),
      ]));
    });

    listBox.innerHTML = '';
    const rows = walletByState(user.id, active);
    if (!rows.length) {
      const e = COUPON_EMPTY[active];
      listBox.appendChild(emptyCard({
        title: e.title,
        text: e.text,
        primary: e.primary,
        onPrimary: () => navigate(e.to),
      }));
      return;
    }
    rows.forEach((w) => listBox.appendChild(myCouponCard(w)));
  }

  render();

  // 结算页核销、取消订单返还都会改券包：停留在本页时自动跟随，不必手动刷新
  const off = onWalletChange((uid) => {
    if (String(uid) !== String(user.id)) return;
    render();
  });
  window.addEventListener('hashchange', off, { once: true });

  // 与账号同步：另一台设备领的/用掉的/返还顺延过的券，进这个 Tab 就能看到
  syncWallet(user.id).then(() => render())
    .catch((e) => console.warn('[coupons] 卡包同步失败', e && e.message));
}

function myCouponCard(w) {
  const state = w.state || 'unused';
  const isDiscount = w.kind === 'discount';
  const num = isDiscount ? String(10 - Number(w.amount) / 10).replace(/\.0$/, '') : String(w.amount);

  const stateLine = state === 'used'
    ? `已使用${w.orderId ? ` · 订单 ${w.orderId}` : ''}${w.usedAt ? ` · ${fmtDay(Date.parse(w.usedAt))}` : ''}`
    : state === 'expired'
      ? `${fmtDay(w.expiresAt)} 已过期`
      : `有效期至 ${fmtDay(w.expiresAt)}${w.extensionCount ? ` · 已顺延 ${w.extensionCount} 次` : ''}`;

  const act = state === 'unused'
    ? el('a', { class: 'mycp-act', href: '#/products' }, '去使用')
    : w.orderId
      ? el('a', { class: 'mycp-act', href: `#/account/order/${encodeURIComponent(w.orderId)}` }, '查看订单')
      : null;

  return el('article', { class: `mycp is-${state}`, 'data-coupon': w.couponId }, [
    el('div', { class: 'mycp-val' }, [
      el('span', { class: 'mycp-num num' }, [
        isDiscount ? null : el('span', { class: 'mycp-cur' }, '¥'),
        el('b', {}, num),
        isDiscount ? el('span', { class: 'mycp-unit' }, '折') : null,
      ]),
      el('span', { class: 'mycp-cond' }, `满 ${fmtCouponValue({ kind: 'cash', amount: w.threshold })} 可用`),
    ]),
    el('div', { class: 'mycp-line', 'aria-hidden': 'true' }),
    el('div', { class: 'mycp-body' }, [
      el('h3', { class: 'mycp-title' }, w.title),
      el('p', { class: 'mycp-meta' }, `${stateLine} · ${w.scopeText || '全场通用'}`),
      el('p', { class: 'mycp-state' }, STATE_TEXT[state] || ''),
      act,
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
