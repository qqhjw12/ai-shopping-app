import { config } from './config.js';
import { hybridSearch } from './search.js';
import { chatMessages, streamChatMessages, appEnabled } from './difyClient.js';

// AI 导购：对话式推荐出商品卡片。
// 卡片结构（id/name/price/pic...）始终由网关的混合检索产出，保证结构化、可点击；
// Dify（docker 模式）仅负责生成一段自然语言「导购话术」，缺失时回退模板。

function deriveReason(p, query) {
  const desc = (p.description || '').slice(0, 36);
  return `匹配「${query}」：${desc}${desc.length >= 36 ? '…' : ''}`;
}

function toCard(p, query) {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    pic: p.pic || '',
    brand: p.brand || '',
    category: p.category || '',
    reason: deriveReason(p, query),
  };
}

// 轻量约束解析：从自然语言里抽取预算与品类（docker 模式下由 Dify Agent 负责，
// 这里保证 local 演示也能正确过滤）。
const CATEGORY_HINTS = [
  ['耳机', '耳机'], ['手机', '手机'], ['笔记本', '笔记本'], ['电脑', '笔记本'],
  ['咖啡', '食品'], ['办公椅', '家具'], ['椅子', '家具'], ['榨汁', '小家电'],
  ['充电', '小家电'], ['羽绒', '服装'], ['衣服', '服装'], ['外套', '服装'],
];

function parseConstraints(message) {
  const out = {};
  const bm = message.match(/预算[^\d]*(\d{2,6})/i) || message.match(/(\d{2,6})\s*元/i);
  if (bm) out.budget = Number(bm[1]);
  for (const [kw, cat] of CATEGORY_HINTS) {
    if (message.includes(kw)) {
      out.category = cat;
      break;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 解析需求 → 候选商品卡片（显式参数优先，否则从自然语言解析；local 模式也能用）。
async function resolveCards({ message, budget, category, topK = 5 }) {
  const parsed = parseConstraints(message);
  const effBudget = budget ?? parsed.budget;
  const effCategory = category ?? parsed.category;

  let candidates = await hybridSearch(message, topK * 2);
  if (effBudget && Number(effBudget) > 0) {
    candidates = candidates.filter((p) => Number(p.price) <= Number(effBudget));
  }
  if (effCategory) {
    candidates = candidates.filter(
      (p) => (p.category || '').includes(effCategory) || (p.tags || []).includes(effCategory),
    );
  }
  const cards = candidates.slice(0, topK).map((p) => toCard(p, message));
  return { cards };
}

function buildLocalIntro(message, cards) {
  return cards.length
    ? `根据您的需求「${message}」，为您精选了 ${cards.length} 款商品，按相关度排序：`
    : `抱歉，暂时没有找到匹配「${message}」的商品，换个关键词或放宽预算试试？`;
}

export async function guideShopping({ message, userId, budget, category, topK = 5 }) {
  if (!message || !message.trim()) {
    const err = new Error('message required');
    err.status = 400;
    throw err;
  }

  const { cards } = await resolveCards({ message, budget, category, topK });

  // 让 Dify 生成导购话术（仅 docker 模式且配置了导购 App Key）
  let intro = null;
  if (appEnabled('shopping-guide')) {
    try {
      const ctx = cards.map((c) => `${c.name}（¥${c.price}）`).join('、');
      const r = await chatMessages(config.dify.shoppingGuideApiKey, {
        query: `用户需求：${message}${budget ? `，预算${budget}元` : ''}。候选商品：${ctx || '无'}`,
        userId,
      });
      intro = r.answer;
    } catch (e) {
      console.warn(`[guide] Dify 导购失败，回退模板: ${e.message}`);
    }
  }

  if (!intro) intro = buildLocalIntro(message, cards);

  return {
    intro,
    products: cards,
    mode: cards.length && appEnabled('shopping-guide') ? 'dify' : 'local',
  };
}

// 流式导购：逐段回传导购话术（onText 回调），最终返回商品卡片。
// - docker 且配置了导购 App：走 Dify chat-messages 流式（SSE 逐字）。
// - 否则：本地模板按字切片回传（演示也能看到打字机效果，且零外部依赖）。
export async function streamGuide({ message, userId, budget, category, topK = 5 }, onText) {
  if (!message || !message.trim()) {
    const err = new Error('message required');
    err.status = 400;
    throw err;
  }

  const { cards } = await resolveCards({ message, budget, category, topK });

  let usedDify = false;
  let mode = 'local';
  if (appEnabled('shopping-guide')) {
    try {
      const ctx = cards.map((c) => `${c.name}（¥${c.price}）`).join('、');
      await streamChatMessages(config.dify.shoppingGuideApiKey, {
        query: `用户需求：${message}${budget ? `，预算${budget}元` : ''}。候选商品：${ctx || '无'}`,
        userId,
        onDelta: (t) => onText(t),
      });
      usedDify = true;
      mode = 'dify';
    } catch (e) {
      console.warn(`[guide] Dify 导购流式失败，回退本地: ${e.message}`);
    }
  }

  if (!usedDify) {
    const intro = buildLocalIntro(message, cards);
    for (let i = 0; i < intro.length; i += 2) {
      onText(intro.slice(i, i + 2));
      await sleep(12);
    }
  }

  return { cards, mode };
}
