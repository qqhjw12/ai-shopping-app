// 运营台共用件：管理密钥、操作人署名、请求头、两个台子的切换。
//
// 三个运营台（售后审核 / 商家入驻审核 / 商品审核）共用同一把钥匙和同一个署名，
// 所以这里刻意用**同一组 sessionStorage 槽位**：运营在售后台输过一次，
// 切到商家审核台就不用再输——同一班人、同一把钥匙，没理由让人输两遍。
//
// 为什么是 sessionStorage 而不是 localStorage：写进 localStorage 的凭据会一直
// 躺在硬盘上，谁打开这台电脑谁就是管理员。关掉标签页即失效。
import { el } from './ui.js';

export const ADMIN_KEY_SLOT = 'maison_admin_key';
export const ADMIN_ACTOR_SLOT = 'maison_admin_actor';
export const ACTOR_MAX = 20;

export function readAdminKey() {
  try {
    return sessionStorage.getItem(ADMIN_KEY_SLOT) || '';
  } catch {
    return '';
  }
}

export function writeAdminKey(v) {
  try {
    if (v) sessionStorage.setItem(ADMIN_KEY_SLOT, v);
    else sessionStorage.removeItem(ADMIN_KEY_SLOT);
  } catch {
    /* 隐私模式下写不了：钥匙只活在当前页面内存里，这一次能用就行 */
  }
}

/** 操作人必填：一条没有署名的处理记录等于没记，出了事谁都能说不是自己干的 */
export function readAdminActor() {
  try {
    return sessionStorage.getItem(ADMIN_ACTOR_SLOT) || '';
  } catch {
    return '';
  }
}

export function writeAdminActor(v) {
  try {
    if (v) sessionStorage.setItem(ADMIN_ACTOR_SLOT, v);
    else sessionStorage.removeItem(ADMIN_ACTOR_SLOT);
  } catch {
    /* 同上 */
  }
}

export function clearAdminIdentity() {
  writeAdminKey('');
  writeAdminActor('');
}

/**
 * 管理接口请求头。
 *
 * 操作人**必须编码后再放进 HTTP 头**：HTTP 头值只允许可打印 ASCII，
 * 直接塞中文会让 fetch 在构造 Request 时就抛 TypeError——连请求都发不出去，
 * 页面只能看到一句「网络异常」。这个名字偏偏大概率就是中文，
 * 用 ASCII 名字测试会完美掩盖这个问题。
 */
export function adminHeaders() {
  const actor = readAdminActor();
  return {
    'X-Admin-Key': readAdminKey(),
    'X-Admin-Actor': actor ? encodeURIComponent(actor) : '',
  };
}

/** 401 / 403 都当作「钥匙不对或没启用」：两者对运营都是同一件事——拿不到数据 */
export function isKeyRejected(e) {
  return e && (e.status === 401 || e.status === 403);
}

/** 运营台之间的切换。当前台高亮，其他可点 */
export function adminTabs(active) {
  const tabs = [
    { code: 'aftersales', label: '售后审核', href: '#/admin/aftersales?status=reviewing' },
    { code: 'merchants', label: '商家入驻审核', href: '#/admin/merchants?status=reviewing' },
    { code: 'products', label: '商品审核', href: '#/admin/products?reviewStatus=pending' },
    { code: 'templates', label: '通知模板', href: '#/admin/notice-templates' },
  ];
  return el('nav', { class: 'adm-tabs', 'aria-label': '运营台切换' },
    tabs.map((t) => el('a', {
      class: `adm-tab${t.code === active ? ' is-on' : ''}`,
      href: t.href,
      'aria-current': t.code === active ? 'page' : null,
    }, t.label)));
}

/**
 * 钥匙门：管理密钥 + 操作人双必填。
 *
 * 两样都必填：只有密钥的话，处理记录里全是无署名的操作。
 * 两个值都只写 sessionStorage，关标签页即失效。
 */
export function adminKeyGate({ title, sub, hint, onPass }) {
  const input = el('input', {
    class: 'adm-key-input',
    type: 'password',
    placeholder: 'ADMIN_API_KEY',
    'aria-label': '管理员密钥',
  });
  const actorInput = el('input', {
    class: 'adm-key-input',
    type: 'text',
    maxlength: String(ACTOR_MAX),
    placeholder: '你的名字或工号',
    'aria-label': '操作人',
    autocomplete: 'off',
  });
  const err = el('p', { class: 'adm-error', role: 'alert' });

  const form = el('form', { class: 'adm-key-form' }, [
    el('h1', { class: 'adm-title' }, title),
    el('p', { class: 'adm-sub' }, sub),
    el('label', { class: 'adm-label' }, '管理密钥'),
    input,
    el('label', { class: 'adm-label' }, '操作人'),
    actorInput,
    err,
    el('div', { class: 'adm-actions' }, [
      el('button', { class: 'adm-btn', type: 'submit' }, '进入'),
    ]),
    el('p', { class: 'adm-hint' }, hint || []),
  ]);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = input.value.trim();
    const actor = actorInput.value.trim();
    if (!v) {
      err.textContent = '请输入管理密钥';
      input.focus();
      return;
    }
    if (actor.length < 2) {
      err.textContent = '请填写操作人（至少 2 个字），处理记录要署名';
      actorInput.focus();
      return;
    }
    writeAdminKey(v);
    writeAdminActor(actor.slice(0, ACTOR_MAX));
    onPass();
  });

  return el('section', { class: 'adm-page' }, [
    el('div', { class: 'adm-crumb' }, [el('a', { href: '#/' }, '← 回到商店')]),
    adminTabs(''),
    el('div', { class: 'adm-key-card' }, [form]),
  ]);
}

/**
 * SQLite 存的是 UTC 'YYYY-MM-DD HH:MM:SS'，页面要按本地时间显示。
 * 直接 slice 会差 8 小时——运营看到「3 分钟前提交」其实是 8 小时前，
 * 排优先级时会判断错。
 */
export function fmtStamp(value) {
  if (!value) return '—';
  const raw = String(value);
  const d = new Date(raw.includes('T') || raw.includes('Z') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
