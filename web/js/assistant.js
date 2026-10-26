// AI 助手浮窗：导购 / 客服 / 问答 三个 tab。导购与问答可带商品上下文。
import { streamApi, ApiError } from './api.js';
import { el, productThumb, fmtPrice } from './ui.js';
import { getUserId } from './state.js';
import { isDemoMode } from './demo.js';

const messagesEl = () => document.getElementById('ai-messages');
const inputEl = () => document.getElementById('ai-input');
const contextEl = () => document.getElementById('ai-context');

let tab = 'guide';
let conversationId = null;
let qaProduct = null;
let productDetailHandler = (p) => console.warn('productDetailHandler 未设置', p);

const containers = {};
function ensureContainers() {
  ['guide', 'chat', 'qa'].forEach((t) => {
    if (!containers[t]) containers[t] = el('div', { class: 'ai-msg-list' });
  });
}

function scrollBottom() {
  const m = messagesEl();
  if (m) m.scrollTop = m.scrollHeight;
}

function say(toTab, text, who = 'user') {
  containers[toTab].appendChild(el('div', { class: `ai-msg ${who}` }, text));
  if (toTab === tab) scrollBottom();
}

function miniCard(p) {
  return el('div', { class: 'mini-card', onclick: () => productDetailHandler(p) }, [
    el('div', { class: 'thumb' }, productThumb(p)),
    el('div', {}, [
      el('div', { class: 'nm' }, p.name),
      el('div', { class: 'pr' }, fmtPrice(p.price)),
    ]),
  ]);
}

function friendly(err) {
  return err instanceof ApiError ? err.message : '出错了，请稍后重试';
}

// 流式发送：先显示「正在输入」，首个事件到达后替换为真实气泡并逐字渲染。
// onEvent(wrap, ev) 负责把 ev.text 追加到气泡、把 ev.products 渲染为卡片。
async function streamRun(toTab, { path, body, makeWrap, onEvent }) {
  const typing = el('div', { class: 'ai-msg bot typing' }, '正在输入…');
  containers[toTab].appendChild(typing);
  if (toTab === tab) scrollBottom();
  let wrap = null;
  try {
    await streamApi(path, body, (ev) => {
      if (!wrap) {
        typing.remove();
        wrap = makeWrap();
        containers[toTab].appendChild(wrap);
      }
      onEvent(wrap, ev);
      if (toTab === tab) scrollBottom();
    });
    if (!wrap) typing.remove(); // 流结束但无内容
  } catch (e) {
    typing.remove();
    if (wrap) wrap.remove();
    if (isDemoMode()) {
      say(toTab, '演示模式：当前未连接 AI 网关，暂无法生成回复。本地启动 ai-gateway 后刷新页面即可体验逐字 AI 能力。', 'bot');
    } else {
      say(toTab, friendly(e), 'bot');
    }
  }
}

/* ---------------- 三个能力 ---------------- */
async function sendGuide(text) {
  say('guide', text, 'user');
  await streamRun('guide', {
    path: '/api/ai/guide',
    body: { message: text, userId: getUserId(), stream: true },
    makeWrap: () => el('div', { class: 'ai-msg bot clickable-cards' }),
    onEvent: (wrap, ev) => {
      if (ev.text != null) {
        let tn = wrap._tn;
        if (!tn) {
          tn = el('div', {}, '');
          wrap._tn = tn;
          wrap.appendChild(tn);
        }
        tn.textContent += ev.text;
      }
      if (ev.products && !wrap._cards) {
        wrap._cards = true;
        wrap.appendChild(el('div', { class: 'mini-cards' }, ev.products.map(miniCard)));
      }
    },
  });
}

async function sendChat(text) {
  say('chat', text, 'user');
  await streamRun('chat', {
    path: '/api/ai/chat',
    body: { message: text, userId: getUserId(), conversationId: conversationId || undefined, stream: true },
    makeWrap: () => el('div', { class: 'ai-msg bot' }),
    onEvent: (wrap, ev) => {
      if (ev.text != null) {
        let tn = wrap._tn;
        if (!tn) {
          tn = el('div', {}, '');
          wrap._tn = tn;
          wrap.appendChild(tn);
        }
        tn.textContent += ev.text;
      }
      if (ev.conversationId) conversationId = ev.conversationId;
    },
  });
}

async function sendQA(text) {
  say('qa', text, 'user');
  await streamRun('qa', {
    path: '/api/ai/qa',
    body: { query: text, userId: getUserId(), productId: qaProduct ? qaProduct.id : undefined, stream: true },
    makeWrap: () => el('div', { class: 'ai-msg bot clickable-cards' }),
    onEvent: (wrap, ev) => {
      if (ev.text != null) {
        let tn = wrap._tn;
        if (!tn) {
          tn = el('div', {}, '');
          wrap._tn = tn;
          wrap.appendChild(tn);
        }
        tn.textContent += ev.text;
      }
      if (ev.results && ev.results.length && !wrap._cards) {
        wrap._cards = true;
        wrap.appendChild(el('div', { class: 'mini-cards' }, ev.results.map(miniCard)));
      }
    },
  });
}

/* ---------------- UI 状态 ---------------- */
function showTab(t) {
  tab = t;
  document.querySelectorAll('.ai-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  const ctx = contextEl();
  if (t === 'qa' && qaProduct) {
    ctx.classList.remove('hidden');
    ctx.innerHTML = '';
    ctx.appendChild(el('span', {}, '正在问：'));
    ctx.appendChild(el('b', {}, qaProduct.name));
  } else {
    ctx.classList.add('hidden');
  }
  const ph =
    t === 'guide' ? '描述你的需求，如：预算 1000 的办公耳机'
      : t === 'chat' ? '问我退换货、物流、优惠等'
        : qaProduct ? `关于「${qaProduct.name}」…` : '问我任意商品的问题（可在商品页点「问我这件商品」）';
  inputEl().placeholder = ph;
  messagesEl().innerHTML = '';
  ensureContainers();
  messagesEl().appendChild(containers[t]);
  scrollBottom();
}

function openPanel() {
  document.getElementById('ai-panel').classList.remove('hidden');
}
function closePanel() {
  document.getElementById('ai-panel').classList.add('hidden');
}

/* ---------------- 对外入口 ---------------- */
export function setProductDetailHandler(fn) {
  productDetailHandler = fn;
}

export function askGuide(text) {
  openPanel();
  showTab('guide');
  inputEl().value = text || '';
  if (text) sendGuide(text);
  else inputEl().focus();
}

export function askProductQA(product) {
  openPanel();
  qaProduct = product;
  showTab('qa');
  const starter = `介绍一下「${product.name}」，适合什么人群？`;
  sendQA(starter);
}

export function initAssistant() {
  ensureContainers();
  document.getElementById('ai-fab').addEventListener('click', openPanel);
  document.getElementById('ai-close').addEventListener('click', closePanel);
  document.querySelectorAll('.ai-tab').forEach((b) =>
    b.addEventListener('click', () => showTab(b.dataset.tab)),
  );
  document.getElementById('ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = inputEl().value.trim();
    if (!text) return;
    inputEl().value = '';
    if (tab === 'guide') sendGuide(text);
    else if (tab === 'chat') sendChat(text);
    else sendQA(text);
  });
  showTab('guide');
}
