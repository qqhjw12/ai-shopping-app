// AI 导购抽屉 + 图片搜索（色彩特征检索）。
//
// 设计取舍：这两处都「服务端优先、本地回落」，任何部署形态都可用。
// ─ 抽屉：优先 POST /api/ai/recommend（网关检索引擎，配了 LLM 还会生成导购语），
//   失败 / 超时 / 静态演示站回落本地关键词 + 预算打分；推荐卡直接复用 ui.js 的
//   productCard，不另起一套卡片样式。
// ─ 图片搜索：图片只在本机缩样提取主色签名（原图永不上传），
//   POST /api/ai/image-search 做色彩特征最近邻检索；服务端不可用回落按文件名
//   散列的模拟结果。全程标注能力边界，避免用户误以为做了语义识别。
//
// views.js 依赖本模块的 askGuide（首页 hero / 空态按钮都走它），
// 而本模块需要 views 的 getProducts / openProductDetail —— 用动态 import 断开循环依赖。
import {
  el, productCard, toast, openModal, updateCartBadge,
} from './ui.js';
import { addToCart, getUserId } from './state.js';
import { api } from './api.js';
import { trackEvent } from './track.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 服务端 AI 请求的超时：抽屉是交互场景，等太久不如回落本地结果 */
const AI_TIMEOUT = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

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
      el('span', {}, '推荐来自店铺检索引擎（未配置 LLM 时为本地规则），结果按当前商品库生成；不代表真实库存与价格承诺。'),
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

/* ---------------- 推荐引擎：服务端优先，本地规则回落 ---------------- */

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

/**
 * 推荐：优先问网关（检索引擎；配了 LLM_API_KEY 时导购语是真实模型写的），
 * 失败 / 超时 / 静态演示站回落本地规则，保证抽屉在任何形态下都有结果。
 * source 用来在界面上如实标注能力边界。
 */
async function recommend(text) {
  try {
    const r = await withTimeout(api('/api/ai/recommend', {
      method: 'POST',
      body: { query: text, userId: getUserId() },
      retries: 0,
    }), AI_TIMEOUT);
    if (r && Array.isArray(r.products) && r.products.length) {
      return { intro: r.intro, products: r.products, matched: true, source: r.source || 'local' };
    }
    // 服务端明确没找到：不再本地兜底（同一份商品库，兜底也找不出更多），如实转述
    if (r && Array.isArray(r.products)) {
      return { intro: r.intro, products: [], matched: false, source: r.source || 'local' };
    }
  } catch {
    /* 网关不可用 → 本地规则 */
  }

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
    source: 'offline',
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

  // 能力边界如实标注：模型写的导购语 / 网关检索引擎 / 本地规则兜底，三种来源不说成一种
  const note = result.source === 'llm'
    ? '导购语由生成式模型撰写 · 推荐候选来自在售单品'
    : result.source === 'offline'
      ? '演示数据 · 本地规则匹配（未连接网关）'
      : '网关检索引擎结果 · 非生成式模型';

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
    el('p', { class: 'gd-note' }, note),
  ]));
  scrollLog();
  trackEvent({ event: 'search', source: 'guide', productId: null });
}

/* ============================================================
   二、图片搜索（色彩特征检索）
   ============================================================ */

/** 用文件名做稳定散列，保证同一张图每次得到同一组「结果」（离线兜底用） */
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

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

/**
 * 提取主色签名：图片缩到 48×48，按色相分 12 桶做加权直方图。
 * 权重 = 饱和度 × 明度居中度，灰 / 近黑 / 近白不参与主色（它们没有「色相」）。
 * 只在浏览器内存里完成，原图不离开本机。
 */
async function colorSignature(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('image decode failed'));
      image.src = url;
    });
    const N = 48;
    const canvas = document.createElement('canvas');
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const { data } = ctx.getImageData(0, 0, N, N);
    const bins = Array.from({ length: 12 }, () => ({ w: 0, hs: 0, s: 0, l: 0 }));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // 透明像素不算
      const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (s < 0.12 || l < 0.08 || l > 0.92) continue; // 灰黑白不参与主色
      const bin = Math.floor(h / 30) % 12;
      const w = s * (1 - Math.abs(l - 0.5));
      bins[bin].w += w;
      bins[bin].hs += h * w;
      bins[bin].s += s * w;
      bins[bin].l += l * w;
    }
    const total = bins.reduce((a, b) => a + b.w, 0);
    if (total <= 0) return [];
    return bins
      .filter((b) => b.w > 0)
      .map((b) => ({ h: ((b.hs / b.w) % 360 + 360) % 360, s: b.s / b.w, l: b.l / b.w, weight: b.w / total }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function openImageSearch() {
  openModal((modal, close) => {
    modal.classList.add('img-search-modal');

    const preview = el('div', { class: 'img-preview' }, [
      el('span', { class: 'img-preview-ph' }, '尚未选择图片'),
    ]);
    const results = el('div', { class: 'img-results' });
    let busy = false;

    const run = async (file, label) => {
      if (busy) return;
      busy = true;
      results.innerHTML = '';
      results.appendChild(el('div', { class: 'img-scanning' }, [
        el('span', { class: 'spinner' }),
        `正在按主色调检索：${label}`,
      ]));

      let list = [];
      let noteTag = '演示结果';
      let noteText = '未能提取可用主色（示例图片 / 离线模式 / 全灰图片），以下为模拟匹配结果。';
      if (file) {
        // 真实路径：本机提取主色 → 服务端色彩特征最近邻。原图不离开浏览器。
        const sig = await colorSignature(file).catch(() => []);
        if (sig.length) {
          try {
            const r = await withTimeout(api('/api/ai/image-search', {
              method: 'POST',
              body: { colors: sig },
              retries: 0,
            }), AI_TIMEOUT);
            if (r && Array.isArray(r.products) && r.products.length) {
              list = r.products;
              noteTag = '色彩特征检索';
              noteText = r.matched
                ? '按图片主色调在在售商品中做最近邻匹配（色彩特征，非语义识别），图片未上传。'
                : '没有找到主色调接近的商品，以下为店内评分最高的单品。图片未上传。';
              if (!r.matched) list = await pickForImage(label);
            }
          } catch {
            /* 服务端不可用 → 离线兜底 */
          }
        }
      }
      if (!list.length) list = await pickForImage(label);

      await sleep(420);
      results.innerHTML = '';
      results.appendChild(el('div', { class: 'img-result-note' }, [
        el('b', {}, noteTag),
        el('span', {}, noteText),
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
        run(file, file.name || '本地图片');
      },
    });

    const dropzone = el('label', { class: 'img-drop', for: 'img-search-file' }, [
      el('span', { class: 'img-drop-icon', 'aria-hidden': 'true' }, '↑'),
      el('b', {}, '拖入或选择一张图片'),
      el('span', { class: 'img-drop-sub' }, '支持 JPG / PNG / WebP · 图片只在本机提取主色，不会上传'),
      fileInput,
    ]);

    modal.appendChild(el('div', { class: 'modal-head' }, [
      el('h3', {}, '图片搜索'),
      el('button', { type: 'button', class: 'modal-close', 'aria-label': '关闭', onclick: close }, '×'),
    ]));
    modal.appendChild(el('div', { class: 'img-demo' }, [
      el('b', {}, '能力边界'),
      el('span', {}, '不做语义识别：图片只在本机缩样提取主色调，再按色彩特征匹配在售商品。未连接网关时退化为演示结果。'),
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
          run(null, 'sample-knitwear.jpg');
        },
      }, '用示例图片试试'),
      el('button', { type: 'button', onclick: close }, '关闭'),
    ]));
    modal.appendChild(results);
  });
}
