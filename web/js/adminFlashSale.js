// 运营侧「秒杀控制台」（#/admin/flash）。
//
// 首页顶部那块秒杀的每一个字、每一件货、每一个价格都从这里配。之所以单独开一台
// 而不是塞进商品审核台：秒杀是**有时效**的配置——改完要立刻看到倒计时和进度条
// 跟着变，而不是「提交后等下一次构建」。所以这一页的交互重心是三个动作：
//   1) 保存即开抢（不需要再点一次「上线」，保存的语义就是「按这版立刻开一场」）；
//   2) 暂停 / 开抢 / 延长，都是一键，且不用重新填表；
//   3) 顶部实时读数（状态 · 倒计时 · 已抢 / 共 N 件），改任何东西都就地反馈。
//
// 门禁：静态演示站没有后端可校验钥匙，改为「本机运营口令」——
// 首次进入自己设一个，之后必须一致（只存哈希）。它挡的是误触，不是攻击；
// 真正的写权限在生产环境由网关的 ADMIN_API_KEY 把关。
import { el, fmtPrice, toast, productThumb } from './ui.js';
import { adminTabs } from './adminShared.js';
import { getProducts } from './views.js';
import {
  getSale, ensureSale, saveSale, setStatus, extendSale, clearSale,
  phaseOf, hasOpsKey, setOpsKey, verifyOpsKey,
  SLOT_MINUTES, MAX_ITEMS,
} from './store/flashSaleStore.js';

const pad2 = (n) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`;
}

const PHASE_WORD = { pending: '未开场', live: '进行中', paused: '已暂停', ended: '已结束' };

/* 本次会话内验过就不重复问：口令门挡的是误触，不是敌意 */
const SESSION_FLAG = 'maison_flash_ops_session';
function sessionVerified() {
  try {
    return sessionStorage.getItem(SESSION_FLAG) === '1';
  } catch {
    return false;
  }
}
function markSession() {
  try {
    sessionStorage.setItem(SESSION_FLAG, '1');
  } catch {
    /* 隐私模式：每次进后台都验一次，符合预期 */
  }
}

/* ============================================================
   口令门（首次 = 设置，之后 = 验证）
   ============================================================ */

function opsGate(onPass) {
  const first = !hasOpsKey();
  const input = el('input', {
    class: 'fs-input',
    type: 'password',
    placeholder: first ? '设置一个本机运营口令（≥ 4 位）' : '本机运营口令',
    'aria-label': '运营口令',
    autocomplete: 'off',
  });
  const err = el('p', { class: 'fs-gate-err', role: 'alert' });

  const form = el('form', { class: 'fs-gate' }, [
    el('span', { class: 'fs-ops-eyebrow' }, 'FLASH CONTROL'),
    el('h1', { class: 'fs-gate-title' }, '秒杀控制台'),
    el('p', { class: 'fs-gate-sub' }, first
      ? '这台控制台改的是首页顶部正在发生的活动。先设一个只属于本机的口令，下次进来要输同一串。'
      : '输入本机运营口令。它存在这台机器上，清掉站点数据会一并失效。'),
    input,
    err,
    el('button', { class: 'fs-ops-btn is-primary', type: 'submit' }, first ? '设置并进入' : '进入控制台'),
    el('p', { class: 'fs-gate-hint' }, '演示环境的口令只做误触拦截；生产环境的写权限由网关的 ADMIN_API_KEY 校验。'),
  ]);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    if (v.length < 4) {
      err.textContent = '至少 4 位字符';
      input.focus();
      return;
    }
    if (first) {
      if (!setOpsKey(v)) {
        err.textContent = '写入失败，检查浏览器是否禁用了本地存储';
        return;
      }
      toast('已设置本机运营口令', 'ok');
      markSession();
      onPass();
      return;
    }
    if (!verifyOpsKey(v)) {
      err.textContent = '口令不对';
      input.value = '';
      input.focus();
      return;
    }
    markSession();
    onPass();
  });

  return el('section', { class: 'fs-ops is-gate' }, [
    el('div', { class: 'fs-ops-topbar' }, [el('a', { class: 'fs-back', href: '#/' }, '← 回到商店')]),
    adminTabs('flash'),
    form,
  ]);
}

/* ============================================================
   对外入口
   ============================================================ */

export async function renderAdminFlashSale(view) {
  view.innerHTML = '';

  const boot = async () => {
    const products = await getProducts().catch(() => []);
    const sale = ensureSale(products);
    view.innerHTML = '';
    if (!sale) {
      view.appendChild(el('section', { class: 'fs-ops' }, [
        el('div', { class: 'fs-ops-topbar' }, [el('a', { class: 'fs-back', href: '#/' }, '← 回到商店')]),
        adminTabs('flash'),
        el('p', { class: 'fs-empty' }, '商品池为空，无法生成场次。先让商城连上商品数据再来。'),
      ]));
      return;
    }
    view.appendChild(consolePage(sale, products));
  };

  if (!hasOpsKey() || !sessionVerified()) {
    view.appendChild(opsGate(() => { boot(); }));
    return;
  }
  await boot();
}

/* ============================================================
   控制台
   ============================================================ */

function consolePage(sale, products) {
  const byId = new Map(products.map((p) => [String(p.id), p]));

  // 草稿：所有编辑都改这份，点保存才落到 store ——
  // 改到一半刷新、或改错了直接走人，都不该影响正在进行的线上活动
  const draft = {
    items: sale.items.map((it) => ({ ...it })),
  };

  /* ---- 顶部读数 ---- */
  const stateDot = el('i', { class: 'fs-dot', 'aria-hidden': 'true' });
  const stateWord = el('strong', { class: 'fs-read-state' });
  const clockNode = el('strong', { class: 'fs-read-clock' });
  const soldNode = el('strong', { class: 'fs-read-sold' });
  const stampNode = el('span', { class: 'fs-read-stamp' });

  const reader = el('div', { class: 'fs-readbar' }, [
    el('div', { class: 'fs-read' }, [stateDot, el('span', { class: 'fs-read-label' }, '状态'), stateWord]),
    el('div', { class: 'fs-read' }, [el('span', { class: 'fs-read-label' }, '倒计时'), clockNode]),
    el('div', { class: 'fs-read' }, [el('span', { class: 'fs-read-label' }, '已抢 / 库存'), soldNode]),
    stampNode,
  ]);

  const paintRead = () => {
    const cur = getSale() || sale;
    const phase = phaseOf(cur);
    stateWord.textContent = PHASE_WORD[phase] || phase;
    stateDot.classList.toggle('is-live', phase === 'live');
    clockNode.textContent = phase === 'pending'
      ? clockText(cur.startAt - Date.now())
      : clockText(cur.endAt - Date.now());
    const stock = cur.items.reduce((s, i) => s + i.stock, 0);
    const sold = cur.items.reduce((s, i) => s + i.sold, 0);
    soldNode.textContent = `${sold} / ${stock}`;
    stampNode.textContent = `${cur.updatedBy} · ${new Date(cur.updatedAt).toLocaleString('zh-CN', { hour12: false })}`;
  };
  paintRead();
  const tick = setInterval(() => {
    if (!reader.isConnected) {
      clearInterval(tick);
      return;
    }
    paintRead();
  }, 1000);

  /* ---- 场次字段 ---- */
  const titleInput = el('input', { class: 'fs-input', type: 'text', maxlength: '24', value: sale.title });
  const protoInput = el('input', { class: 'fs-input', type: 'text', maxlength: '28', value: sale.protocol });
  const noteInput = el('input', { class: 'fs-input', type: 'text', maxlength: '48', value: sale.note });
  const minInput = el('input', {
    class: 'fs-input',
    type: 'number',
    min: '5',
    max: '1440',
    value: String(Math.max(1, Math.round((sale.endAt - sale.startAt) / 60000))),
  });

  const fields = el('section', { class: 'fs-panel' }, [
    el('div', { class: 'fs-panel-head' }, [
      el('h2', { class: 'fs-panel-title' }, '场次'),
      el('span', { class: 'fs-panel-hint' }, '保存即按这版立刻开一场，起点是现在'),
    ]),
    el('div', { class: 'fs-fields' }, [
      field('场次标题', titleInput, '顶部那行大字，控制在 12 字以内最好看'),
      field('场次代号', protoInput, 'HUD 左上角那行等宽小字，形如 FLASH PROTOCOL 07'),
      field('说明行', noteInput, '限购、时长、抢完即止之类的一句话'),
      field('场次时长（分钟）', minInput, `默认 ${SLOT_MINUTES} 分钟；结束后前台显示「本场结束」`),
    ]),
  ]);

  /* ---- 商品清单 ---- */
  const list = el('div', { class: 'fs-list' });
  const countNode = el('h2', { class: 'fs-panel-title' }, '');
  const picker = el('select', { class: 'fs-input fs-picker', 'aria-label': '选择要加入秒杀的商品' });

  const rebuildPicker = () => {
    const used = new Set(draft.items.map((i) => String(i.productId)));
    picker.innerHTML = '';
    picker.appendChild(el('option', { value: '' }, '＋ 添加一件商品…'));
    products
      .filter((p) => !used.has(String(p.id)))
      .slice(0, 200)
      .forEach((p) => {
        picker.appendChild(el('option', { value: String(p.id) }, `${p.name}${p.price ? ` · ${fmtPrice(p.price)}` : ''}`));
      });
  };

  const paintItems = () => {
    countNode.textContent = `商品清单 · ${draft.items.length}/${MAX_ITEMS}`;
    list.innerHTML = '';
    if (!draft.items.length) {
      list.appendChild(el('p', { class: 'fs-empty' }, '还没有商品。从上面选一件加入。'));
      return;
    }

    draft.items.forEach((it, idx) => {
      const p = byId.get(String(it.productId));
      const listPrice = p
        ? (Number(p.originalPrice) > Number(p.price) ? Number(p.originalPrice) : Number(p.price))
        : 0;

      const priceInput = el('input', { class: 'fs-input fs-num', type: 'number', min: '1', value: String(it.price) });
      const stockInput = el('input', { class: 'fs-input fs-num', type: 'number', min: '1', max: '9999', value: String(it.stock) });
      const limitInput = el('input', { class: 'fs-input fs-num', type: 'number', min: '1', max: '9', value: String(it.limit) });
      const offNode = el('em', { class: 'fs-item-off' });
      const warn = el('span', { class: 'fs-item-warn' });

      const validate = () => {
        it.price = Math.max(1, Math.round(Number(priceInput.value) || 1));
        it.stock = Math.max(1, Math.min(9999, Math.round(Number(stockInput.value) || 1)));
        it.limit = Math.max(1, Math.min(9, Math.round(Number(limitInput.value) || 1)));
        // 秒杀价不低于原价就没有「抢」的理由。这里只提醒不拦截：
        // 运营有时确实要挂一件 9.5 折的清仓款占位
        const bad = listPrice > 0 && it.price >= listPrice;
        warn.textContent = bad ? '秒杀价 ≥ 原价，前台不会有折扣角标' : '';
        priceInput.classList.toggle('is-warn', bad);
        offNode.textContent = listPrice
          ? ` · ${Math.max(0, Math.round((1 - it.price / listPrice) * 100))}% off`
          : '';
      };
      [priceInput, stockInput, limitInput].forEach((i) => i.addEventListener('input', validate));
      validate();

      list.appendChild(el('div', { class: 'fs-item' }, [
        el('span', { class: 'fs-item-thumb' }, p ? productThumb(p, { fade: false }) : null),
        el('div', { class: 'fs-item-copy' }, [
          el('span', { class: 'fs-item-name' }, p ? p.name : `商品 ${it.productId} 已不存在`),
          el('span', { class: 'fs-item-meta' }, [
            listPrice ? `原价 ${fmtPrice(listPrice)}` : '无原价锚点',
            offNode,
          ]),
          warn,
        ]),
        el('label', { class: 'fs-mini' }, ['秒杀价', priceInput]),
        el('label', { class: 'fs-mini' }, ['库存', stockInput]),
        el('label', { class: 'fs-mini' }, ['限购', limitInput]),
        el('button', {
          class: 'fs-item-del',
          type: 'button',
          'aria-label': `移除 ${p ? p.name : it.productId}`,
          onclick: () => {
            draft.items.splice(idx, 1);
            paintItems();
            rebuildPicker();
          },
        }, '移除'),
      ]));
    });
  };

  picker.addEventListener('change', () => {
    const id = picker.value;
    picker.value = '';
    if (!id) return;
    if (draft.items.length >= MAX_ITEMS) {
      toast(`一场最多 ${MAX_ITEMS} 件，先移掉一件再加`, 'warn');
      return;
    }
    const p = byId.get(id);
    const listPrice = p
      ? (Number(p.originalPrice) > Number(p.price) ? Number(p.originalPrice) : Number(p.price))
      : 100;
    draft.items.push({
      productId: id,
      // 新加入的默认 7 折：运营大概率要改，但给个空输入框更烦
      price: Math.max(1, Math.round(listPrice * 0.7)),
      stock: 30,
      sold: 0,
      limit: 1,
    });
    paintItems();
    rebuildPicker();
  });

  rebuildPicker();
  paintItems();

  const goodsPanel = el('section', { class: 'fs-panel' }, [
    el('div', { class: 'fs-panel-head' }, [
      countNode,
      el('span', { class: 'fs-panel-hint' }, '已抢数量随成交累加，保存配置不会把进度清零'),
    ]),
    el('div', { class: 'fs-picker-row' }, [picker]),
    list,
  ]);

  /* ---- 动作 ---- */
  const save = () => {
    const live = getSale();
    const items = draft.items.map((it) => ({
      productId: it.productId,
      price: it.price,
      stock: it.stock,
      limit: it.limit,
      // 进度跟着线上走：改价改库存不该把「已抢 128 件」重置成 0
      sold: live?.items.find((x) => String(x.productId) === String(it.productId))?.sold ?? it.sold,
    }));
    const res = saveSale({
      title: titleInput.value,
      protocol: protoInput.value,
      note: noteInput.value,
      minutes: Number(minInput.value) || SLOT_MINUTES,
      items,
      actor: 'ops',
    });
    if (!res.ok) {
      toast(res.error || '保存失败', 'warn');
      return;
    }
    toast('已保存，首页立刻按这版开抢', 'ok');
    paintRead();
  };

  const actions = el('div', { class: 'fs-ops-actions' }, [
    el('a', { class: 'fs-ops-btn', href: '#/', target: '_blank', rel: 'noopener' }, '看前台 ↗'),
    el('button', {
      class: 'fs-ops-btn',
      type: 'button',
      onclick: () => {
        const next = setStatus(phaseOf(getSale()) === 'paused' ? 'live' : 'paused');
        if (next) toast(next.status === 'paused' ? '已暂停接单，倒计时继续' : '已恢复开抢', 'ok');
        paintRead();
      },
    }, '开抢 / 暂停'),
    el('button', {
      class: 'fs-ops-btn',
      type: 'button',
      onclick: () => {
        extendSale(30, 'ops');
        toast('本场已延长 30 分钟', 'ok');
        paintRead();
      },
    }, '+30 分钟'),
    el('button', { class: 'fs-ops-btn is-primary', type: 'button', onclick: save }, '保存并开抢'),
  ]);

  return el('section', { class: 'fs-ops' }, [
    el('div', { class: 'fs-ops-topbar' }, [
      el('a', { class: 'fs-back', href: '#/' }, '← 回到商店'),
      el('button', {
        class: 'fs-ops-reset',
        type: 'button',
        onclick: () => {
          clearSale();
          toast('配置已清空，回首页会按当前商品池重新生成一场', 'ok');
          location.hash = '#/';
        },
      }, '重置本场'),
    ]),
    adminTabs('flash'),
    el('header', { class: 'fs-ops-head' }, [
      el('div', {}, [
        el('span', { class: 'fs-ops-eyebrow' }, 'FLASH CONTROL · 秒杀作战台'),
        el('h1', { class: 'fs-ops-title' }, '配置首页顶部这场秒杀'),
        el('p', { class: 'fs-ops-sub' }, '改完点「保存并开抢」，前台刷新即生效；同一浏览器里另一个标签页会自动更新，不必手动刷新。'),
      ]),
      actions,
    ]),
    reader,
    el('div', { class: 'fs-ops-grid' }, [el('div', { class: 'fs-ops-col' }, [fields, goodsPanel])]),
    el('p', { class: 'fs-ops-foot' }, [
      '数据存在本机 localStorage（键 maison_flash_sale_v1）。',
      '接真实交易网关时，成交价会由服务端重新核价——这一版为了让演示可跑，秒杀价以本机场次配置为准。',
    ]),
  ]);

  function field(label, input, hint) {
    return el('label', { class: 'fs-field' }, [
      el('span', { class: 'fs-field-label' }, label),
      input,
      hint ? el('span', { class: 'fs-field-hint' }, hint) : null,
    ]);
  }
}
