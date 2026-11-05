// AI 助手浮窗：导购 / 客服 / 问答 三个 tab。导购与问答可带商品上下文。
// 面板与反馈已升级为 Deep Space Command 规格触发器：
// 全局圆形触发器 + 上浮面板 + 一次性扫线 + 扫描过程系统消息 + MATCH 商品卡。
import { streamApi, ApiError } from './api.js';
import { el, productThumb, fmtPrice } from './ui.js';
import { addToCart, getUserId } from './state.js';
import { isDemoMode } from './demo.js';
import { trackEvent } from './track.js';
import { recordBehavior } from './store/pointsStore.js';
import { getProducts } from './views.js';

const messagesEl = () => document.getElementById('ai-messages');
const inputEl = () => document.getElementById('ai-input');
const contextEl = () => document.getElementById('ai-context');
const panelEl = () => document.getElementById('ai-panel');
const fabEl = () => document.getElementById('ai-fab');

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

/* ---------------- 读数口径 ---------------- */

/** 稳定哈希：与首页扫描结果流同口径，同一商品永远拿到同一个 MATCH 分 */
function stableHash(id) {
  let h = 0;
  for (const ch of String(id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

/** 匹配度锁在 88–99：真实推荐不会给出 100%，留一点不确定性 */
function aiMatch(p) {
  return 88 + (stableHash(p.id) % 12);
}

/** 目录规模：优先真实商品库，网关不可达时回退演示口径 */
let catalogCount = null;
function catalogSize() {
  if (catalogCount == null) {
    catalogCount = 1240;
    getProducts()
      .then((list) => {
        if (Array.isArray(list) && list.length) catalogCount = list.length;
      })
      .catch(() => { /* 演示模式保持回退值 */ });
  }
  return catalogCount;
}

/* ---------------- 消息渲染 ---------------- */

function say(toTab, text, who = 'user') {
  const node = el('div', { class: `ai-msg ${who}` }, text);
  if (who === 'bot') monoNumbers(node);
  containers[toTab].appendChild(node);
  if (toTab === tab) scrollBottom();
}

/** 数字等宽化：把文本里的数字段包进 .mono-num（等宽 + tabular-nums），安全转义 */
function monoNumbers(node) {
  const text = node.textContent || '';
  if (!/\d/.test(text)) return;
  node.textContent = '';
  text.split(/(\d[\d,]*(?:\.\d+)?)/).forEach((seg) => {
    if (!seg) return;
    if (/^\d[\d,]*(?:\.\d+)?$/.test(seg)) node.appendChild(el('span', { class: 'mono-num' }, seg));
    else node.appendChild(document.createTextNode(seg));
  });
}

function miniCard(p, kind) {
  let qty = 1;
  const qtyEl = el('span', { class: 'mc-qty' }, '1');
  const setQty = (n) => {
    qty = Math.min(9, Math.max(1, n));
    qtyEl.textContent = String(qty);
  };
  const addBtn = el('button', { type: 'button', class: 'mc-add' }, '加购');
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addToCart(p, qty);
    trackEvent({ event: kind === 'guide' ? 'guide_card_add' : 'qa_card_add', source: kind, productId: p.id });
    addBtn.textContent = '已加入 ✓';
    addBtn.classList.add('is-added');
    setTimeout(() => {
      addBtn.textContent = '加购';
      addBtn.classList.remove('is-added');
    }, 1400);
  });
  return el('div', {
    class: 'mini-card',
    onclick: () => {
      // 导购/问答推荐卡片点击打点（渠道归因）
      const event = kind === 'guide' ? 'guide_recommend_click' : 'qa_recommend_click';
      trackEvent({ event, source: kind, productId: p.id });
      productDetailHandler(p);
    },
  }, [
    el('div', { class: 'mc-match' }, `AI MATCH ${aiMatch(p)}%`),
    el('div', { class: 'mc-body' }, [
      el('div', { class: 'thumb' }, productThumb(p)),
      el('div', { class: 'mc-info' }, [
        el('div', { class: 'nm' }, p.name),
        el('div', { class: 'pr' }, fmtPrice(p.price)),
      ]),
    ]),
    el('div', { class: 'mc-ops' }, [
      el('div', { class: 'mc-stepper' }, [
        el('button', { type: 'button', 'aria-label': '减少数量', onclick: (e) => { e.stopPropagation(); setQty(qty - 1); } }, '−'),
        qtyEl,
        el('button', { type: 'button', 'aria-label': '增加数量', onclick: (e) => { e.stopPropagation(); setQty(qty + 1); } }, '+'),
      ]),
      addBtn,
    ]),
  ]);
}

/** AI 工作过程可见化：提交后先插一条系统消息，三行读数逐条出现，
 *  总时长 750ms（600–900ms 区间内）；旋转指示器只转一轮后隐藏，绝不无限转圈。 */
function scanFeedback(toTab) {
  const spin = el('span', { class: 'ai-sys-spin', 'aria-hidden': 'true' });
  const lines = el('div', { class: 'ai-sys-lines' });
  const wrap = el('div', { class: 'ai-sys' }, [spin, lines]);
  containers[toTab].appendChild(wrap);
  if (toTab === tab) scrollBottom();
  const items = [
    `扫描 ${catalogSize().toLocaleString('en-US')} 件商品`,
    '交叉比价中',
    '过滤 3 个维度',
  ];
  const step = 300; // 3 × 300 = 900ms，落在 600–900ms 规格区间
  items.forEach((text, i) => {
    setTimeout(() => {
      lines.appendChild(el('div', { class: 'ai-sys-line' }, text));
      if (toTab === tab) scrollBottom();
    }, i * step);
  });
  const total = step * items.length;
  setTimeout(() => spin.classList.add('is-done'), total);
  return new Promise((resolve) => setTimeout(resolve, total));
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
    // 积分任务埋点：三个 tab 的流式回复成功结束都算完成一轮 AI 对话
    recordBehavior('ai_chat');
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
  await scanFeedback('guide');
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
        monoNumbers(tn);
      }
      if (ev.products && !wrap._cards) {
        wrap._cards = true;
        wrap.appendChild(el('div', { class: 'mini-cards' }, ev.products.map((p) => miniCard(p, 'guide'))));
      }
    },
  });
}

async function sendChat(text) {
  say('chat', text, 'user');
  await scanFeedback('chat');
  await streamRun('chat', {
    path: '/api/ai/chat',
    body: { message: text, userId: getUserId(), conversationId: conversationId || undefined, stream: true },
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
        monoNumbers(tn);
      }
      if (ev.products && ev.products.length && !wrap._cards) {
        wrap._cards = true;
        wrap.appendChild(el('div', { class: 'mini-cards' }, ev.products.map((p) => miniCard(p, 'guide'))));
      }
      if (ev.conversationId) conversationId = ev.conversationId;
    },
  });
}

async function sendQA(text) {
  say('qa', text, 'user');
  await scanFeedback('qa');
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
        monoNumbers(tn);
      }
      if (ev.results && ev.results.length && !wrap._cards) {
        wrap._cards = true;
        wrap.appendChild(el('div', { class: 'mini-cards' }, ev.results.map((p) => miniCard(p, 'qa'))));
      }
    },
  });
}

/* ---------------- UI 状态 ---------------- */
function seedWelcome(t) {
  if (containers[t].children.length) return;
  const copy = {
    guide: {
      hint: '告诉我一个场景、预算，或只是某种感觉。',
      prompts: [
        ['1000 元内的礼物', '预算 1000 元以内、有质感的通勤礼物'],
        ['通勤降噪', '推荐一款适合长时间办公的降噪耳机'],
        ['居家氛围', '帮我挑一件能提升居家氛围的单品'],
      ],
      send: (text) => sendGuide(text),
    },
    chat: {
      hint: '订单、物流、退换货，都由我替你处理。',
      prompts: [
        ['查询物流', '帮我查询一下最近的订单物流'],
        ['退换货', '你们的退换货政策是什么？'],
        ['优惠信息', '最近有什么优惠活动？'],
      ],
      send: (text) => sendChat(text),
    },
    qa: {
      hint: '想了解材质、保养或适用人群，都可以问我。',
      prompts: [
        ['适合谁', '这件商品适合什么人群和场景？'],
        ['材质细节', '这件商品的材质和工艺有什么特点？'],
        ['如何保养', '这件商品平时应该怎么保养？'],
      ],
      send: (text) => sendQA(text),
    },
  }[t];
  const welcome = el('div', { class: 'ai-welcome' }, [
    el('span', { class: 'eyebrow' }, t === 'guide' ? 'AI MATCH READY' : t === 'chat' ? 'AT YOUR SERVICE' : 'ABOUT THE OBJECT'),
    el('h3', {}, t === 'guide' ? '说需求，我来扫描全站' : t === 'chat' ? '需要我替你处理什么？' : '关于这件物件，想知道什么？'),
    el('p', {}, copy.hint),
    el('div', { class: 'ai-chips' }, copy.prompts.map(([label, text]) =>
      el('button', { type: 'button', onclick: () => copy.send(text) }, label))),
  ]);
  containers[t].appendChild(welcome);
}

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
  seedWelcome(t);
  messagesEl().appendChild(containers[t]);
  scrollBottom();
}

/* ---------------- 开关与降级 ---------------- */
function isOpen() {
  return !panelEl().classList.contains('hidden');
}

function openPanel() {
  panelEl().classList.remove('hidden');
  document.getElementById('ai-widget').classList.add('is-open');
  fabEl().setAttribute('aria-label', '关闭 AI 助手');
  // 锁背景滚动（面板关闭时恢复）；html 才是真正的滚动元素，两处都要锁
  document.body.classList.add('no-scroll');
  document.documentElement.classList.add('no-scroll');
}

function closePanel() {
  panelEl().classList.add('hidden');
  document.getElementById('ai-widget').classList.remove('is-open');
  fabEl().setAttribute('aria-label', '打开 AI 助手');
  document.body.classList.remove('no-scroll');
  document.documentElement.classList.remove('no-scroll');
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
  catalogSize(); // 预热目录规模读数，首次发送即可显示真实件数
  // 触发器为开关：打开面板 / 再次点击关闭
  fabEl().addEventListener('click', () => (isOpen() ? closePanel() : openPanel()));
  document.getElementById('ai-close').addEventListener('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) closePanel();
  });
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
