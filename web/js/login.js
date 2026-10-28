// 登录 / 注册页（#/login）：手机号或邮箱 + 验证码 / 密码的 mock 登录。
//
// 为什么要 mock：网关的认证是「userId 即身份」的演示实现，没有短信网关与密码库。
// 所以这里把「校验规则 + 会话落盘 + 跳转回流」按真实系统的形状写全，
// 只把「发码」和「核对凭证」两步换成固定演示值；将来接真后端只需替换这两个函数。
import { el, toast } from './ui.js';
import { navigate } from './router.js';
import { login as openSession } from './auth.js';
import { sanitizeRedirect } from './guard.js';
import {
  DEMO_ACCOUNT, DEMO_CODE, identifierKind, isLoggedIn,
  nicknameOf, setCurrentUser, userIdOf,
} from './user.js';

const RESEND_SECONDS = 60;

function renderShell() {
  const errorBox = el('p', { class: 'auth-error', hidden: true });
  const idInput = el('input', {
    class: 'auth-id',
    type: 'text',
    placeholder: '手机号或邮箱',
    autocomplete: 'username',
    inputmode: 'text',
  });
  const codeInput = el('input', {
    class: 'auth-code',
    type: 'text',
    placeholder: '6 位验证码',
    inputmode: 'numeric',
    maxlength: '6',
    autocomplete: 'one-time-code',
  });
  const passInput = el('input', {
    class: 'auth-pass',
    type: 'password',
    placeholder: '密码（≥6 位）',
    autocomplete: 'current-password',
  });

  const codeBtn = el('button', { class: 'auth-code-btn', type: 'button' }, '获取验证码');
  const codeRow = el('div', { class: 'auth-code-row' }, [codeInput, codeBtn]);
  const passField = el('div', { class: 'auth-field' }, [
    el('span', { class: 'auth-label' }, '密码'),
    passInput,
  ]);
  passField.setAttribute('hidden', '');

  const tabs = el('div', { class: 'auth-tabs', role: 'tablist' }, [
    el('button', { class: 'auth-tab is-on', type: 'button', role: 'tab' }, '验证码登录'),
    el('button', { class: 'auth-tab', type: 'button', role: 'tab' }, '密码登录'),
  ]);

  const submit = el('button', { class: 'auth-submit', type: 'submit' }, '登录 / 注册');
  const demoBtn = el('button', { class: 'auth-demo', type: 'button' }, '演示账号一键登录');

  const form = el('form', { class: 'auth-form', novalidate: 'novalidate' }, [
    el('div', { class: 'auth-field' }, [
      el('span', { class: 'auth-label' }, '账号'),
      idInput,
    ]),
    codeRow,
    passField,
    errorBox,
    submit,
    demoBtn,
    el('p', { class: 'auth-hint' }, `演示环境：验证码固定 ${DEMO_CODE} · 任意手机号 / 邮箱均可注册`),
  ]);

  const card = el('div', { class: 'auth-card' }, [
    el('span', { class: 'auth-glow', 'aria-hidden': 'true' }),
    el('div', { class: 'auth-head' }, [
      el('span', { class: 'eyebrow' }, 'MEMBER ACCESS'),
      el('h2', {}, '登录 MAISON AI'),
      el('p', {}, '登录后订单、地址与优惠券都会归到你的名下。'),
    ]),
    tabs,
    form,
  ]);

  return { card, form, tabs, idInput, codeInput, passInput, codeBtn, codeRow, passField, errorBox, submit, demoBtn };
}

export function renderLogin(view, { redirect = '' } = {}) {
  // 已登录再进登录页：直接回到目标页，避免「登录了却停在登录页」
  if (isLoggedIn()) {
    navigate(sanitizeRedirect(redirect));
    return;
  }

  const ui = renderShell();
  let mode = 'sms';

  const showError = (msg) => {
    ui.errorBox.textContent = msg || '';
    if (msg) ui.errorBox.removeAttribute('hidden');
    else ui.errorBox.setAttribute('hidden', '');
  };

  const setMode = (next) => {
    mode = next;
    const isSms = mode === 'sms';
    [...ui.tabs.children].forEach((b, i) => b.classList.toggle('is-on', (i === 0) === isSms));
    if (isSms) {
      ui.codeRow.removeAttribute('hidden');
      ui.passField.setAttribute('hidden', '');
    } else {
      ui.codeRow.setAttribute('hidden', '');
      ui.passField.removeAttribute('hidden');
    }
    showError('');
    // 切模式时把校验错误清掉，避免「切过去还顶着上一条红字」
    ui.submit.textContent = isSms ? '登录 / 注册' : '登录';
  };

  [...ui.tabs.children].forEach((btn, i) => {
    btn.addEventListener('click', () => setMode(i === 0 ? 'sms' : 'password'));
  });

  /* ---- 获取验证码：mock，60 秒倒计时 ---- */
  let remain = 0;
  let timer = null;
  const tick = () => {
    remain -= 1;
    if (remain <= 0) {
      remain = 0;
      ui.codeBtn.textContent = '获取验证码';
      ui.codeBtn.removeAttribute('disabled');
      ui.codeBtn.disabled = false;
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    ui.codeBtn.textContent = `${remain}s 后重发`;
  };

  ui.codeBtn.addEventListener('click', () => {
    const id = String(ui.idInput.value || '').trim();
    if (!identifierKind(id)) {
      showError('请先填写有效的手机号或邮箱');
      return;
    }
    showError('');
    remain = RESEND_SECONDS;
    ui.codeBtn.textContent = `${remain}s 后重发`;
    ui.codeBtn.setAttribute('disabled', 'disabled');
    ui.codeBtn.disabled = true;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 1000);
    toast(`验证码已发送（演示：${DEMO_CODE}）`, 'ok');
  });

  /* ---- 登录落盘 ---- */
  const complete = async (user, welcome) => {
    try {
      setCurrentUser(user);
    } catch (e) {
      showError(e.message || '登录失败，请重试');
      return;
    }
    // 令牌会话要跟着页面身份走：先建好会话再跳转。
    // 否则跳转后的首个请求还带着上一层身份（匿名/旧账号）的令牌，
    // 服务端按令牌取身份 → 读到的是别人的地址簿。
    // 网关可达时必走；离线/静态演示下失败也不拦登录（静默跳过）。
    try {
      await openSession(user.id, user.nickname);
    } catch {
      /* 离线：仅保持页面登录态 */
    }
    toast(welcome, 'ok');
    navigate(sanitizeRedirect(redirect));
  };

  ui.form.addEventListener('submit', (e) => {
    if (e && e.preventDefault) e.preventDefault();
    const id = String(ui.idInput.value || '').trim();
    const kind = identifierKind(id);
    if (!kind) {
      showError('请输入有效的手机号（11 位）或邮箱');
      ui.idInput.focus && ui.idInput.focus();
      return;
    }
    if (mode === 'sms') {
      const code = String(ui.codeInput.value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        showError('请输入 6 位数字验证码');
        return;
      }
      if (code !== DEMO_CODE) {
        showError(`验证码不正确（演示环境固定 ${DEMO_CODE}）`);
        return;
      }
    } else {
      const pwd = String(ui.passInput.value || '');
      if (pwd.length < 6) {
        showError('密码至少 6 位');
        return;
      }
    }
    showError('');
    const nickname = nicknameOf(id);
    complete(
      { id: userIdOf(id), nickname, identifier: id, via: mode },
      `欢迎，${nickname}`,
    );
  });

  ui.demoBtn.addEventListener('click', () => {
    complete({ ...DEMO_ACCOUNT }, `已用演示账号登录：${DEMO_ACCOUNT.nickname}`);
  });

  /* ---- 页面装配 ---- */
  const aside = el('aside', { class: 'auth-aside' }, [
    el('span', { class: 'eyebrow' }, 'PRIVATE CLIENT'),
    el('h1', { class: 'auth-display' }, ['为你的', el('em', {}, '订单与地址'), '安个家']),
    el('p', { class: 'auth-lead' }, '登录只是让「买过什么、送到哪里」有归属。我们不发营销短信，也不把资料卖给任何人。'),
    el('ul', { class: 'auth-points' }, [
      el('li', {}, [el('b', {}, '订单可追溯'), el('span', {}, '每一单的流转都在个人中心留档')]),
      el('li', {}, [el('b', {}, '地址按账户隔离'), el('span', {}, '换设备登录，地址簿跟着你走')]),
      el('li', {}, [el('b', {}, '一处改，处处用'), el('span', {}, '默认地址直接带到结算页')]),
    ]),
  ]);

  view.innerHTML = '';
  view.appendChild(el('section', { class: 'auth-page' }, [
    el('div', { class: 'auth-grid' }, [aside, ui.card]),
  ]));

  setMode('sms');
  return ui;
}
