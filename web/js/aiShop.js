// AI 导购抽屉 + 图片搜索（占位）。
//
// 设计取舍：这两处都不依赖 AI 网关也能给出可用结果。
// ─ 抽屉：把需求文本做本地关键词 + 预算解析，从当前商品库里打分挑 3 件，
//   全程标注「演示数据」，让静态演示站（无后端）也能展示完整的选购闭环；
//   推荐卡直接复用 ui.js 的 productCard，不另起一套卡片样式。
// ─ 图片搜索：只做上传交互与结果占位，明确写出「不上传、不识别」，
//   避免用户误以为真的做了视觉检索。
//
// views.js 依赖本模块的 askGuide（首页 hero / 空态按钮都走它），
// 而本模块需要 views 的 getProducts / openProductDetail —— 用动态 import 断开循环依赖。
import {
  el, productCard, toast, openModal, updateCartBadge,
} from './ui.js';
import { addToCart } from './state.js';
import { trackEvent } from './track.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   一、AI 导购抽屉
   ============================================================ */

let drawer = null;
let overlay = null;
let logEl = null;
let inputEl = null;
let esckeyBound = false;

function isOpen() {
  return Boolean(drawer) && !drawer.classList.contains('hidden');
}

function scrollLog() {
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

function seedWelcome() {
  if (logEl.children.length) return;
  const chips = [
    ['1000 元以内的礼物', '预算 1000 元以内、有质感的通勤礼物'],
    ['通勤降噪', '推荐一款适合长时间办公的降噪耳机'],
    ['居家氛围', '帮我挑一件能提升居家氛围的单品'],
    ['送长辈', '想给爸妈挑一件实用又体面的礼物'],
  ];
  logEl.appendChild(el('div', { class: 'gd-welcome' }, [
    el('span', { class: 'eyebrow' }, 'CURATED FOR YOU'),
    el('h3', {}, '想找点什么？'),
    el('p', {}, '给我一个场景、一个预算，或者一句模糊的感觉都行。'),
    el('div', { class: 'gd-chips' }, chips.map(([label, text]) =>
      el('button', { type: 'button', onclick: () => ask(text) }, label))),
  ]));
}

function buildDrawer() {
  if (drawer) return;
  inputEl = el('input', {
    id: 'gd-input',
    type: 'text',
    placeholder: '例如：1000 元以内的通勤礼物',
    autocomplete: 'off',
    'aria-label': '描述你的选购需求',
  });
  logEl = el('div', { class: 'gd-log', id: 'gd-log', 'aria-live': 'polite' });

  const form = el('form', {
    class: 'gd-form',
    onsubmit: (e) => {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) {
        inputEl.focus();
        return;
      }
      inputEl.value = '';
      ask(text);
    },
  }, [
    el('span', { class: 'gd-form-star', 'aria-hidden': 'true' }, '✦'),
    inputEl,
    el('button', { type: 'submit', class: 'gd-send', 'aria-label': '发送需求' }, '→'),
  ]);

  drawer = el('aside', {
    class: 'guide-drawer hidden',
    id: 'guide-drawer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'AI 导购',
  }, [
    el('div', { class: 'gd-glow', 'aria-hidden': 'true' }),
    el('header', { class: 'gd-head' }, [
      el('div', { class: 'gd-heading' }, [
        el('span', { class: 'eyebrow' }, 'AI SHOPPING CONCIERGE'),
        el('h2', {}, 'AI 导购'),
      ]),
      el('button', { type: 'button', class: 'gd-close', 'aria-label': '关闭 AI 导购', onclick: () => closeGuide() }, '×'),
    ]),
    el('p', { class: 'gd-sub' }, '说出场景、预算或只是一种感觉，我从本季甄选里替你挑几件。'),
    el('div', { class: 'gd-demo' }, [
      el('b', {}, '演示数据'),
      el('span', {}, '推荐由本地关键词规则生成，未接入真实模型；不代表真实库存与价格承诺。'),
    ]),
    logEl,
    form,
  ]);

  overlay = el('div', { class: 'overlay hidden', id: 'guide-overlay' });
  overlay.addEventListener('click', () => closeGuide());

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  seedWelcome();

  if (!esckeyBound) {
    esckeyBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) closeGuide();
    });
  }
}

function pushBubble(html) {
  const bubble = el('div', { class: 'gd-msg user' });
  bubble.textContent = html;
  logEl.appendChild(bubble);
  scrollLog();
  return bubble;
}

/**
 * 打开导购抽屉。
 * @param {string} [seedText] 带初始需求时直接开问（首页 hero 表单、详情页入口都这么用）
 */
export function askGuide(seedText) {
  buildDrawer();
  overlay.classList.remove('hidden');
  drawer.classList.remove('hidden');
  document.body.classList.add('no-scroll');
  if (seedText) {
    ask(seedText);
  } else {
    setTimeout(() => inputEl.focus(), 60);
    scrollLog();
  }
}

export function closeGuide() {
  if (!drawer) return;
  drawer.classList.add('hidden');
  overlay.classList.add('hidden');
  document.body.classList.remove('no-scroll');
}

/* ---------------- 推荐引擎（本地规则，非模型） ---------------- */

let catalogCache = null;

async function loadCatalog() {
  if (catalogCache && catalogCache.length) return catalogCache;
  let list = [];
  try {
    const views = await import('./views.js');
    list = await views.getProducts();
  } catch {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) {
    try {
      const demo = await import('./demo-data.js');
      list = demo.demoProducts || [];
    } catch {
      list = [];
    }
  }
  catalogCache = Array.isArray(list) ? list : [];
  return catalogCache;
}

/** 从文本里取预算（第一个 30–200000 之间的数字） */
function parseBudget(text) {
  const m = String(text || '').match(/(\d{2,6})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 30 && n <= 200000 ? n : null;
}

/** 关键词切片：中文按二元组切，英文/数字按空格切 —— 不做分词也能命中「降噪」「耳机」 */
function keywords(text) {
  const norm = String(text || '')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:：'"“”（）()【】\s]+/g, ' ')
    .trim();
  const grams = new Set();
  norm.split(' ').filter(Boolean).forEach((part) => {
    if (part.length >= 2) grams.add(part);
    if (/^[\u4e00-\u9fa5]+$/.test(part) && part.length > 4) {
      for (let i = 0; i < part.length - 1; i += 1) grams.add(part.slice(i, i + 2));
    }
  });
  return [...grams];
}

function scoreProduct(p, grams, budget) {
  const hay = `${p.name || ''} ${p.brand || ''} ${p.category || ''} ${p.highlight || ''} ${p.spec || ''}`.toLowerCase();
  let score = 0;
  grams.forEach((g) => {
    if (g.length >= 2 && hay.includes(g)) score += 3;
  });
  const price = Number(p.price) || 0;
  if (budget && price) {
    if (price <= budget) score += 4 + (1 - price / budget) * 2;
    else if (price <= budget * 1.2) score += 1;
    else score -= 5;
  }
  score += (Number(p.rating) || 0) * 0.8;
  if (Number(p.totalStock) > 0) score += 1;
  return score;
}

function introFor(text, budget, items, total, matched) {
  const q = String(text || '').trim().slice(0, 18);
  if (!items.length) return `「${q}」暂时没找到合适的在售单品，换个说法，或者直接告诉我预算？`;
  if (!matched) return `没有完全贴合「${q}」的单品，先按评分与现货挑了这 ${items.length} 件。`;
  const b = budget ? `预算 ${budget} 元、` : '';
  return `按「${b}${q}」的口径，我从 ${total} 件在售单品里挑出这 ${items.length} 件。`;
}

async function recommend(text) {
  const all = await loadCatalog();
  const budget = parseBudget(text);
  const grams = keywords(text);
  const scored = all
    .map((p) => ({ p, s: scoreProduct(p, grams, budget) }))
    .sort((a, b) => b.s - a.s);
  const matched = scored.some((x) => x.s > 0);
  const picked = (matched ? scored.filter((x) => x.s > 0) : scored)
    .slice(0, 3)
    .map((x) => x.p);
  return {
    intro: introFor(text, budget, picked, all.length, matched),
    products: picked,
    matched,
  };
}

async function openDetail(product) {
  closeGuide();
  const views = await import('./views.js');
  views.openProductDetail(product, 'guide');
}

function addFromGuide(product) {
  trackEvent({ event: 'add_to_cart', source: 'guide', productId: product.id });
  addToCart(product, 1);
  updateCartBadge();
  toast(`已加入购物袋：${product.name}`, 'ok');
}

/** 一次问答：用户气泡 → 思考态 → 结论 + 推荐卡 */
async function ask(text) {
  buildDrawer();
  pushBubble(text);
  const typing = el('div', { class: 'gd-msg bot typing' }, '正在挑选…');
  logEl.appendChild(typing);
  scrollLog();

  const started = Date.now();
  const result = await recommend(text);
  // 留一点「思考」时间：瞬间出结果会让人以为是写死的静态列表
  await sleep(Math.max(0, 380 - (Date.now() - started)));
  typing.remove();

  logEl.appendChild(el('div', { class: 'gd-msg bot gd-answer' }, [
    el('p', { class: 'gd-say' }, result.intro),
    result.products.length
      ? el('div', { class: 'gd-cards' }, result.products.map((p) => productCard(p, {
        aiPick: true,
        onDetail: (prod) => {
          trackEvent({ event: 'guide_recommend_click', source: 'guide', productId: prod.id });
          openDetail(prod);
        },
        onAddCart: addFromGuide,
      })))
      : null,
    el('p', { class: 'gd-note' }, '演示数据 · 本地规则匹配结果，非真实模型推荐'),
  ]));
  scrollLog();
  trackEvent({ event: 'search', source: 'guide', productId: null });
}

/* ============================================================
   二、图片搜索（占位）
   ============================================================ */

/** 用文件名做稳定散列，保证同一张图每次得到同一组「结果」 */
function hashSeed(text) {
  let h = 0;
  for (let i = 0; i < String(text).length; i += 1) {
    h = (h * 31 + String(text).charCodeAt(i)) % 100000;
  }
  return h;
}

async function pickForImage(seed) {
  const all = await loadCatalog();
  const sorted = all
    .slice()
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));
  if (!sorted.length) return [];
  const offset = hashSeed(seed) % sorted.length;
  const out = [];
  for (let i = 0; i < Math.min(4, sorted.length); i += 1) {
    out.push(sorted[(offset + i) % sorted.length]);
  }
  return out;
}

export function openImageSearch() {
  openModal((modal, close) => {
    modal.classList.add('img-search-modal');

    const preview = el('div', { class: 'img-preview' }, [
      el('span', { class: 'img-preview-ph' }, '尚未选择图片'),
    ]);
    const results = el('div', { class: 'img-results' });
    let busy = false;

    const runMock = async (label) => {
      if (busy) return;
      busy = true;
      results.innerHTML = '';
      results.appendChild(el('div', { class: 'img-scanning' }, [
        el('span', { class: 'spinner' }),
        `正在识别（模拟）：${label}`,
      ]));
      const list = await pickForImage(label);
      await sleep(520);
      results.innerHTML = '';
      results.appendChild(el('div', { class: 'img-result-note' }, [
        el('b', {}, '演示结果'),
        el('span', {}, '未做真实图像识别，以下按品类相似度从内置商品中模拟匹配。'),
      ]));
      if (!list.length) {
        results.appendChild(el('p', { class: 'sub' }, '商品库暂时不可用，稍后再试。'));
        busy = false;
        return;
      }
      results.appendChild(el('div', { class: 'img-result-grid' }, list.map((p) => productCard(p, {
        onDetail: (prod) => {
          close();
          openDetail(prod);
        },
        onAddCart: addFromGuide,
      }))));
      busy = false;
    };

    const fileInput = el('input', {
      type: 'file',
      class: 'img-file',
      id: 'img-search-file',
      accept: 'image/*',
      onchange: (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        preview.innerHTML = '';
        preview.appendChild(el('img', {
          src: URL.createObjectURL(file),
          alt: file.name || '已选择的图片',
          class: 'img-preview-img',
        }));
        runMock(file.name || '本地图片');
      },
    });

    const dropzone = el('label', { class: 'img-drop', for: 'img-search-file' }, [
      el('span', { class: 'img-drop-icon', 'aria-hidden': 'true' }, '↑'),
      el('b', {}, '拖入或选择一张图片'),
      el('span', { class: 'img-drop-sub' }, '支持 JPG / PNG / WebP · 仅为交互占位，图片不会上传'),
      fileInput,
    ]);

    modal.appendChild(el('div', { class: 'modal-head' }, [
      el('h3', {}, '图片搜索'),
      el('button', { type: 'button', class: 'modal-close', 'aria-label': '关闭', onclick: close }, '×'),
    ]));
    modal.appendChild(el('div', { class: 'img-demo' }, [
      el('b', {}, '演示功能'),
      el('span', {}, '不做真实图像识别：图片只在本机预览，不会上传，也不会调用任何视觉模型。'),
    ]));
    modal.appendChild(el('div', { class: 'img-search-body' }, [dropzone, preview]));
    modal.appendChild(el('div', { class: 'img-search-actions' }, [
      el('button', {
        type: 'button',
        class: 'ghost',
        onclick: () => {
          preview.innerHTML = '';
          preview.appendChild(el('div', { class: 'img-preview-sample' }, [
            el('span', { class: 'img-preview-tag' }, '示例图片'),
            el('b', {}, '米白色针织开衫'),
            el('span', {}, 'sample-knitwear.jpg'),
          ]));
          runMock('sample-knitwear.jpg');
        },
      }, '用示例图片试试'),
      el('button', { type: 'button', onclick: close }, '关闭'),
    ]));
    modal.appendChild(results);
  });
}
