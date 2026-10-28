// 订单详情（#/account/order/:id）：状态流转 + 物流时间线 + 售后申请/记录。
//
// 从 accountCenter.js 抽出来的原因：这一页现在有五个区块（流转条 / 物流 / 清单 / 金额 / 售后）
// 和两套动作（服务端事务与本地降级），继续挂在个人中心里会让那个文件同时承担
// 「列表、地址、券包、详情」四件事。页面职责单一之后，改详情不会碰到券包。
//
// 数据来源的优先级（每一层都有理由）：
//   1) 服务端单号（SO…）→ 直接 GET /api/orders/:id，它带回物流事件与售后记录；
//   2) 本地镜像 → 服务端不可达时的兜底（断网也要能看自己刚下的单）；
//   3) 都没有 → 「没有找到这笔订单」。
// 拿到服务端结果后顺手写回本地镜像，下一次断网打开还是完整的。
import { api, isMissingEndpoint } from './api.js';
import { el, fmtPrice, loading, toast, openModal, productThumb } from './ui.js';
import { navigate } from './router.js';
import { getCurrentUser } from './user.js';
import {
  applyDelivery, applyShipment, getOrder, markRefunding, normalizeRemote, orderStage,
  statusText, upsertOrder,
} from './store/orderStore.js';
import { fmtWhen, logisticsOf } from './store/logistics.js';
import {
  AFTERSALE_REASONS, AFTERSALE_TYPES, MAX_EVIDENCE, MAX_NOTE, canApply, listByOrder,
  mergeAftersales, saveAftersale, validateAftersale,
} from './store/aftersaleStore.js';
import { refundCouponsByOrder, syncWallet } from './store/couponStore.js';

/** 服务端订单：单号前缀 SO，或本地镜像上带 remote 标记 */
function isServerOrder(order) {
  return /^SO/i.test(String((order && order.id) || '')) || Boolean(order && order.remote);
}

function fmtDate(iso) {
  const s = String(iso || '');
  return s ? s.slice(0, 16).replace('T', ' ') : '';
}

/* ============================================================
   取数
   ============================================================ */

/**
 * 取订单：服务端优先，本地兜底。
 * 服务端返回的物流/售后是权威数据，本地镜像只负责「断网时别白屏」。
 */
async function loadOrder(userId, id) {
  const local = getOrder(userId, id);
  const remoteish = /^SO/i.test(id) || Boolean(local && local.remote);

  if (remoteish || !local) {
    try {
      const d = await api(
        `/api/orders/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,
        { retries: 0 },
      );
      if (d && d.order) {
        const fresh = normalizeRemote(d.order);
        // 写回镜像：镜像里的物流事件与售后记录跟着服务端走，
        // 下次断网打开详情仍然能看到完整时间线，而不是退回「待发货」。
        return upsertOrder(userId, { ...(local || {}), ...fresh, remote: true });
      }
    } catch {
      /* 404 / 网络失败：落到本地镜像 */
    }
  }

  if (local) {
    // 服务端不可达时，用本地售后记录补齐（离线提交的申请只存在本地）
    const mine = listByOrder(userId, id);
    return mine.length
      ? { ...local, aftersales: mergeAftersales(mine, local.aftersales || []) }
      : local;
  }
  return null;
}

/* ============================================================
   页面
   ============================================================ */

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

  const order = await loadOrder(user.id, id);

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

  host.appendChild(orderDetailCard(order, {
    user,
    // 状态变更后整页重绘：流转条、物流卡、售后入口的可见性都要跟着变，局部改容易漏
    repaint: () => renderOrderDetail(view, id),
  }));
}

/* ============================================================
   动作
   ============================================================ */

/**
 * 取消订单：服务端单走服务端事务，本地镜像单走本地返还。
 *
 * 为什么要分两条路：服务端订单的券是在下单事务里核销的，本地券包没有「已使用」记录，
 * 本地返还会找不到可退的券 → 用户看到「订单已取消」但券一直不回来。
 * 反过来，无网关时的本地单服务端没有这笔订单，调 cancel 只会 404。
 *
 * 服务端不可达时降级本地处理：取消是用户已经点下的动作，不能因为网络抖一下就变成「请重试」。
 */
async function cancelOrderEverywhere(userId, order) {
  const oid = String(order.id || '');
  const doLocal = () => {
    const hit = upsertOrder(userId, { ...order, status: 'closed' });
    return { ok: true, order: hit, refund: refundCouponsByOrder(userId, oid) };
  };

  if (!isServerOrder(order)) return doLocal();

  try {
    const d = await api(
      `/api/orders/${encodeURIComponent(oid)}/cancel?userId=${encodeURIComponent(userId)}`,
      { method: 'POST', retries: 0 },
    );
    const status = (d && d.order && d.order.status) || 'closed';
    upsertOrder(userId, { ...order, status });
    return {
      ok: true,
      refund: (d && d.coupon) || { restored: 0, extended: 0, graceDays: 0 },
      sync: () => syncWallet(userId),
    };
  } catch (e) {
    // 业务拒绝（已发货 409 / 订单不存在 404）要如实告诉用户，不能偷偷本地关掉
    if (!isMissingEndpoint(e) && e.kind !== 'offline' && e.status !== 404) {
      return { ok: false, error: (e && e.message) || '取消失败，请稍后重试' };
    }
    return doLocal();
  }
}

/** 支付：服务端单走 payOrder，本地单直接推进状态（纯静态站点也要走完这条流程） */
async function payOrderEverywhere(userId, order) {
  if (!isServerOrder(order)) {
    upsertOrder(userId, { ...order, status: 'paid', paidAt: new Date().toISOString() });
    return { ok: true };
  }
  try {
    const d = await api(
      `/api/orders/${encodeURIComponent(order.id)}/pay?userId=${encodeURIComponent(userId)}`,
      { method: 'POST', retries: 0 },
    );
    if (d && d.order) upsertOrder(userId, { ...order, ...normalizeRemote(d.order), remote: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || '支付失败，请重试' };
  }
}

/**
 * 演示推进：模拟发货 / 模拟签收。
 *
 * 服务端单调接口（状态在服务端事务里改，物流事件也在服务端生成），
 * 本地单直接改本地状态并生成同一套事件——纯静态站点没有服务端可以改。
 * 两条路都返回「成功」，但只有服务端那条会被别的设备看到，这是数据归属决定的，不是 bug。
 */
async function advanceEverywhere(userId, order, kind) {
  if (!isServerOrder(order)) {
    const hit = kind === 'ship' ? applyShipment(userId, order.id) : applyDelivery(userId, order.id);
    return hit ? { ok: true } : { ok: false, error: '订单状态不支持该操作' };
  }
  try {
    const d = await api(
      `/api/orders/${encodeURIComponent(order.id)}/${kind}?userId=${encodeURIComponent(userId)}`,
      { method: 'POST', retries: 0 },
    );
    if (d && d.order) upsertOrder(userId, { ...order, ...normalizeRemote(d.order), remote: true });
    return { ok: true };
  } catch (e) {
    if (isMissingEndpoint(e)) {
      // 演示端点被关掉（DEMO_ACTIONS=false）时不要假装成功：按钮就是不该出现
      return { ok: false, error: '演示接口未开启' };
    }
    return { ok: false, error: (e && e.message) || '操作失败，请重试' };
  }
}

/** 提交售后：服务端优先，离线/无后端落本地并置「售后中」 */
async function submitAftersale(userId, order, payload) {
  const invalid = validateAftersale(payload);
  if (invalid) return { ok: false, error: invalid };

  if (isServerOrder(order)) {
    try {
      const d = await api(
        `/api/orders/${encodeURIComponent(order.id)}/aftersale`,
        { method: 'POST', retries: 0, body: { userId, ...payload } },
      );
      if (d && d.aftersale) saveAftersale(userId, { ...d.aftersale, orderId: order.id });
      if (d && d.order) {
        upsertOrder(userId, { ...order, ...normalizeRemote(d.order), remote: true });
      } else {
        markRefunding(userId, order.id, listByOrder(userId, order.id));
      }
      return { ok: true, remote: true };
    } catch (e) {
      // 业务拒绝（已有售后 409 / 状态不支持 400）如实显示，不偷偷改成本地记录——
      // 否则用户以为申请成功了，客服那边根本没有这条工单
      if (!isMissingEndpoint(e) && e.kind !== 'offline') {
        return { ok: false, error: (e && e.message) || '提交失败，请重试' };
      }
    }
  }

  saveAftersale(userId, {
    orderId: order.id,
    ...payload,
    status: 'reviewing',
    handleNote: '已收到申请，客服会在 24 小时内联系你确认处理方式',
  });
  markRefunding(userId, order.id, listByOrder(userId, order.id));
  return { ok: true, remote: false };
}

/* ============================================================
   渲染
   ============================================================ */

function orderDetailCard(o, { user, repaint } = {}) {
  const addr = o.address;
  const a = o.amounts || {};
  const logistics = logisticsOf(o);
  const aftersales = mergeAftersales(listByOrder(user.id, o.id), o.aftersales || []);

  const infoRow = (label, value) => el('div', { class: 'od-info-row' }, [
    el('span', { class: 'od-info-label' }, label),
    el('span', { class: 'od-info-value' }, value || '—'),
  ]);

  return el('article', { class: 'od-card' }, [
    // 头部：单号 + 状态胶囊
    el('div', { class: 'od-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, 'ORDER DETAIL'),
        el('h1', { class: 'od-id num' }, o.id),
      ]),
      el('span', { class: `od-pill s-${o.status}` }, statusText(o.status)),
    ]),
    el('p', { class: 'od-date' }, `下单时间 ${fmtDate(o.createdAt) || '—'}`),

    flowBlock(o),
    logisticsBlock(logistics, o),

    el('div', { class: 'od-items' }, (o.items || []).map((it) => el('div', { class: 'od-item' }, [
      el('div', { class: 'od-item-thumb' }, productThumb(
        { id: it.productId, name: it.name, coverColor: it.coverColor, pic: it.pic },
        { fade: false },
      )),
      el('div', { class: 'od-item-info' }, [
        el('div', { class: 'od-item-name' }, it.name),
        // 规格单独存了才显示：历史订单把规格拼在名称里（spec 为空），
        // 这里再补一行「默认规格」只会制造噪音。
        it.spec ? el('div', { class: 'od-item-sku' }, `SKU：${it.spec}`) : null,
        el('div', { class: 'od-item-price num' }, `${fmtPrice(it.price)} × ${it.qty}`),
      ]),
      el('span', { class: 'od-item-sub num' }, fmtPrice(Number(it.price || 0) * Number(it.qty || 0))),
    ]))),

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

    el('div', { class: 'od-amounts' }, [
      el('div', { class: 'od-sum-row' }, [el('span', {}, '商品总额'), el('span', { class: 'num' }, fmtPrice(a.productAmount))]),
      el('div', { class: 'od-sum-row' }, [el('span', {}, '运费'), el('span', { class: 'num' }, a.shippingFee ? fmtPrice(a.shippingFee) : '免运费')]),
      el('div', { class: 'od-sum-row' }, [
        el('span', {}, `优惠券${a.couponTitle ? `（${a.couponTitle}）` : ''}`),
        el('span', { class: 'num' }, a.couponDiscount ? `- ${fmtPrice(a.couponDiscount)}` : '- ¥0'),
      ]),
      el('div', { class: 'od-sum-row is-total' }, [
        el('span', {}, '应付金额'),
        el('span', { class: 'num od-total' }, fmtPrice(a.payAmount)),
      ]),
    ]),

    aftersaleBlock(aftersales),
    actionsBlock(o, { user, repaint }),
    demoBlock(o, { user, repaint }),
  ]);
}

/* ---------------- 状态流转 ---------------- */

/**
 * 四步流转条。
 * 已取消的订单不画进度（走到一半停了，画出来会让「停在哪」变成误导），
 * 只留一行说明。
 */
function flowBlock(o) {
  const stage = orderStage(o);
  if (stage.cancelled) {
    return el('div', { class: 'od-flow is-cancelled' }, [
      el('span', { class: 'od-flow-cancel' }, '订单已取消'),
      el('span', { class: 'od-flow-note' }, stage.steps[0].at ? `${fmtDate(stage.steps[0].at)} 下单` : ''),
    ]);
  }
  const current = stage.index;
  return el('ol', { class: 'od-steps' }, stage.steps.map((s, i) => el('li', {
    class: `od-step${s.done ? ' is-done' : ''}${i === current ? ' is-current' : ''}`,
  }, [
    el('span', { class: 'od-step-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'od-step-label' }, s.label),
    el('span', { class: 'od-step-at num' }, s.at ? fmtWhen(s.at) : ''),
  ])));
}

/* ---------------- 物流 ---------------- */

/**
 * 物流块。
 * 未发货显示「待发货」而不是一条空时间线：空时间线看起来像数据没加载出来。
 * 已发货则四个节点全画，未到达的灰显——用户能看到「还剩两步」，而不是以为物流停住了。
 */
function logisticsBlock(logi, o) {
  if (!logi.shipped) {
    return el('section', { class: 'od-logi' }, [
      el('div', { class: 'od-sec-head' }, [
        el('h3', {}, '物流信息'),
        el('span', { class: 'od-sec-tag' }, '待发货'),
      ]),
      el('p', { class: 'od-logi-empty' }, o.status === 'pending'
        ? '付款后仓库会在 48 小时内发出，物流信息会在这里更新。'
        : '商家正在打包，尚未交给快递，物流信息会在这里更新。'),
    ]);
  }

  return el('section', { class: 'od-logi' }, [
    el('div', { class: 'od-sec-head' }, [
      el('h3', {}, '物流信息'),
      el('span', { class: 'od-sec-meta' }, [
        el('span', {}, logi.company || '物流'),
        logi.trackingNo ? el('span', { class: 'num od-waybill' }, logi.trackingNo) : null,
      ]),
    ]),
    el('ol', { class: 'od-track' }, logi.stages.map((s) => el('li', {
      class: `od-track-item${s.done ? ' is-done' : ''}`,
    }, [
      el('span', { class: 'od-track-dot', 'aria-hidden': 'true' }),
      el('div', { class: 'od-track-body' }, [
        el('div', { class: 'od-track-head' }, [
          el('span', { class: 'od-track-title' }, s.title),
          el('span', { class: 'od-track-at num' }, s.done ? fmtWhen(s.at) : '待更新'),
        ]),
        s.detail ? el('p', { class: 'od-track-detail' }, s.detail) : null,
      ]),
    ]))),
  ]);
}

/* ---------------- 售后记录 ---------------- */

function aftersaleBlock(list) {
  if (!list.length) return null;
  return el('section', { class: 'od-as' }, [
    el('div', { class: 'od-sec-head' }, [
      el('h3', {}, '售后记录'),
      el('span', { class: 'od-sec-meta' }, `${list.length} 条`),
    ]),
    ...list.map((r) => el('article', { class: `od-as-item is-${r.status}`, 'data-aftersale': r.id }, [
      el('div', { class: 'od-as-head' }, [
        el('span', { class: 'od-as-type' }, `${r.typeLabel} · ${r.reasonLabel}`),
        el('span', { class: `od-as-status s-${r.status}` }, r.statusLabel),
      ]),
      r.note ? el('p', { class: 'od-as-note' }, r.note) : null,
      r.evidence && r.evidence.length
        ? el('p', { class: 'od-as-ev' }, `凭证 ${r.evidence.length} 份：${r.evidence.map((f) => f.name).join('、')}`)
        : null,
      el('p', { class: 'od-as-handle' }, `处理说明：${r.handleNote || '客服处理中'}`),
      el('p', { class: 'od-as-meta' }, `申请单 ${r.id} · ${fmtDate(r.createdAt)}`),
    ])),
  ]);
}

/* ---------------- 动作区 ---------------- */

function actionsBlock(o, { user, repaint }) {
  const nodes = [];

  // 待付款：去支付。这是主路径上的动作，给实心按钮
  if (o.status === 'pending') {
    nodes.push(el('button', {
      class: 'od-main-btn',
      type: 'button',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = '支付中…';
        const done = await payOrderEverywhere(user.id, o);
        if (!done.ok) {
          btn.disabled = false;
          btn.textContent = '去支付';
          toast(done.error || '支付失败，请重试', 'warn');
          return;
        }
        toast('支付成功，等待商家发货', 'ok');
        repaint();
      },
    }, '去支付'));
  }

  // 已发货 / 已完成：申请售后。细线按钮，刻意比主按钮轻——
  // 它不是大多数用户要做的事，抢主视觉会误导
  if (canApply(o).ok) {
    nodes.push(el('button', {
      class: 'od-line-btn',
      type: 'button',
      onclick: () => openAftersaleSheet({ order: o, user, onDone: repaint }),
    }, '申请退款 / 退换货'));
  }

  // 取消订单：仅待付款。两步确认，避免误触把单关掉
  if (o.status === 'pending') {
    const cancelBtn = el('button', { class: 'od-cancel', type: 'button' }, '取消订单');
    let armed = false;
    let timer = null;
    cancelBtn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        cancelBtn.textContent = '确认取消？';
        cancelBtn.classList.add('is-confirm');
        timer = setTimeout(() => {
          armed = false;
          cancelBtn.textContent = '取消订单';
          cancelBtn.classList.remove('is-confirm');
        }, 3000);
        return;
      }
      if (timer) clearTimeout(timer);
      cancelBtn.disabled = true;
      cancelBtn.textContent = '取消中…';
      const done = await cancelOrderEverywhere(user.id, o);
      if (!done.ok) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = '取消订单';
        cancelBtn.classList.remove('is-confirm');
        toast(done.error || '取消失败，请稍后重试', 'warn');
        return;
      }
      const refund = done.refund || { restored: 0, extended: 0, graceDays: 0 };
      toast(
        refund.restored
          ? `订单已取消，${refund.restored} 张优惠券已退回券包${refund.extended ? `（有效期顺延 ${refund.graceDays} 天）` : ''}`
          : '订单已取消',
        'ok',
      );
      if (typeof done.sync === 'function') await done.sync();
      repaint();
    });
    nodes.push(cancelBtn);
  }

  nodes.push(el('a', { class: 'od-line-btn is-link', href: '#/account?tab=orders' }, '回到订单列表'));
  nodes.push(el('a', { class: 'od-line-btn is-link', href: '#/products' }, '继续购物'));

  return el('div', { class: 'od-actions' }, nodes);
}

/**
 * 演示动作：模拟发货 / 模拟签收。
 * 放在卡片最底部、低对比文字按钮里，不占主视觉——它不属于买家该做的事。
 * 只在「这一步确实可推进」时出现，其它状态整块不渲染。
 */
function demoBlock(o, { user, repaint }) {
  const kind = o.status === 'paid' ? 'ship' : o.status === 'shipped' ? 'complete' : '';
  if (!kind) return null;
  const label = kind === 'ship' ? '模拟发货' : '模拟签收';

  return el('div', { class: 'od-demo' }, [
    el('span', { class: 'od-demo-note' }, '演示用'),
    el('button', {
      class: 'od-demo-btn',
      type: 'button',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = '处理中…';
        const done = await advanceEverywhere(user.id, o, kind);
        if (!done.ok) {
          btn.disabled = false;
          btn.textContent = label;
          toast(done.error || '操作失败', 'warn');
          return;
        }
        toast(kind === 'ship' ? '已模拟发货，物流时间线已生成' : '已模拟签收，订单完成', 'ok');
        repaint();
      },
    }, label),
  ]);
}

/* ---------------- 售后弹层 ---------------- */

/**
 * 售后申请弹层：类型 / 原因 / 说明 / 凭证占位。
 *
 * 凭证只记文件名不传图：这个演示站没有对象存储与审核后台，
 * 假装上传只会让人以为图真的到了客服那边。输入框下面的提示直接说明这一点。
 */
function openAftersaleSheet({ order, user, onDone }) {
  openModal((modal, close) => {
    // 弹窗默认 720px 宽（商品详情用的），这个表单只有一列字段，宽了会空出一大片
    modal.classList.add('is-narrow');
    let type = 'refund';
    let evidence = [];

    const typeRow = el('div', { class: 'as-types' });
    AFTERSALE_TYPES.forEach((t) => {
      const btn = el('button', {
        class: `as-type${t.code === type ? ' is-on' : ''}`,
        type: 'button',
        'data-type': t.code,
      }, t.label);
      btn.addEventListener('click', () => {
        type = t.code;
        typeRow.querySelectorAll('.as-type').forEach((n) => {
          n.classList.toggle('is-on', n.getAttribute('data-type') === type);
        });
      });
      typeRow.appendChild(btn);
    });

    const reasonSel = el('select', { class: 'as-reason', 'aria-label': '售后原因' }, [
      el('option', { value: '' }, '请选择原因'),
      ...AFTERSALE_REASONS.map((r) => el('option', { value: r.code }, r.label)),
    ]);

    const note = el('textarea', {
      class: 'as-note',
      rows: '4',
      maxlength: String(MAX_NOTE),
      placeholder: '描述一下遇到的问题（选填，200 字以内）',
    });

    const evList = el('div', { class: 'as-ev-list' });
    const fileInput = el('input', {
      class: 'as-file',
      type: 'file',
      accept: 'image/*',
      multiple: 'multiple',
    });
    fileInput.addEventListener('change', () => {
      const picked = [...fileInput.files].map((f) => ({ name: f.name, size: f.size }));
      evidence = [...evidence, ...picked].slice(0, MAX_EVIDENCE);
      evList.innerHTML = '';
      evidence.forEach((f) => evList.appendChild(el('span', { class: 'as-ev-tag' }, f.name)));
      if (picked.length && evidence.length >= MAX_EVIDENCE) toast(`最多 ${MAX_EVIDENCE} 份凭证`, 'warn');
    });

    const errorNode = el('p', { class: 'as-error', role: 'alert' });
    const submitBtn = el('button', { class: 'od-main-btn as-submit', type: 'submit' }, '提交申请');

    const form = el('form', { class: 'as-form' }, [
      el('h2', { class: 'as-title' }, '申请售后'),
      el('p', { class: 'as-sub' }, `订单 ${order.id}`),
      el('label', { class: 'as-label' }, '售后类型'),
      typeRow,
      el('label', { class: 'as-label' }, '售后原因'),
      reasonSel,
      el('label', { class: 'as-label' }, '问题说明'),
      note,
      el('label', { class: 'as-label' }, '上传凭证'),
      fileInput,
      el('p', { class: 'as-hint' }, `演示环境不上传图片，只记录文件名（最多 ${MAX_EVIDENCE} 份）。`),
      evList,
      errorNode,
      el('div', { class: 'as-actions' }, [
        submitBtn,
        el('button', { class: 'od-line-btn', type: 'button', onclick: close }, '取消'),
      ]),
    ]);

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errorNode.textContent = '';
      const invalid = validateAftersale({ type, reason: reasonSel.value, note: note.value, evidence });
      if (invalid) {
        errorNode.textContent = invalid;
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = '提交中…';
      const done = await submitAftersale(user.id, order, {
        type,
        reason: reasonSel.value,
        note: note.value.trim(),
        evidence,
      });
      if (!done.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = '提交申请';
        errorNode.textContent = done.error || '提交失败，请重试';
        return;
      }
      close();
      toast(done.remote ? '售后申请已提交，客服会在 24 小时内联系你' : '售后申请已记录（离线，联网后以服务端为准）', 'ok');
      if (onDone) onDone();
    });

    modal.appendChild(form);
  });
}

/* ---------------- 空状态 ---------------- */

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
