// 本地对话引擎：意图识别 → SQLite 检索 → 组织答案（可选交给 LLM 润色）。
// 设计要点：
//  1) 结构化数据（价格/库存/物流/政策）一律来自 SQLite，不交给模型编造；
//  2) 未配置 LLM_API_KEY 时用规则模板直接产出答案，保证零外部依赖也能正常对话；
//  3) 配置了 LLM 则把检索到的事实作为上下文喂给模型，只让它负责组织语言；
//  4) 多轮上下文（预算/类目/上次商品）持久化在 conversations.context，支持指代与追问。
import { config, llmEnabled } from '../config.js';
import { getDb } from '../db/connection.js';
import * as productRepo from '../repositories/productRepo.js';
import * as orderRepo from '../repositories/orderRepo.js';
import * as convRepo from '../repositories/conversationRepo.js';
import { chatComplete, chatStream } from './llmClient.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 解析工具 ---------------- */

// 类目同义词：把口语映射到类目 id（「耳机」→ audio，「笔记本」→ computer）
const CATEGORY_SYNONYMS = {
  audio: ['耳机', '蓝牙耳机', '降噪', '音响', '音箱', '耳麦', '听歌'],
  phone: ['手机', '平板', '手表', '充电器', '移动电源', '数码'],
  computer: ['笔记本', '电脑', '显示器', '键盘', '鼠标', '办公本', '游戏本'],
  appliance: ['空调', '净化器', '净水器', '咖啡机', '料理机', '除湿机', '电水壶', '取暖器', '家电'],
  apparel: ['羽绒服', '冲锋衣', 't恤', '牛仔裤', '针织衫', '鞋', '背包', '家居服', '衣服'],
  food: ['咖啡豆', '挂耳', '大米', '橄榄油', '坚果', '杂粮', '亚麻籽油', '吃的', '食品'],
  home: ['椅子', '办公椅', '书桌', '床垫', '沙发', '电热毯', '枕头', '扫地机器人', '落地灯', '家具'],
  sports: ['帐篷', '登山杖', '露营', '徒步', '运动', '水壶', '营地灯', '户外'],
};

function parseBudget(text) {
  const t = String(text || '');
  const patterns = [
    /预算[^\d]{0,6}(\d{2,6})/,
    /(\d{2,6})\s*(?:元|块|rmb|人民币)/i,
    /(\d{2,6})\s*(?:以内|以下|之内|左右)/,
    /不超过\s*(\d{2,6})/,
    /(\d{2,6})\s*预算/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n >= 10 && n <= 200000) return n;
    }
  }
  return null;
}

function parseCategoryId(text) {
  const t = String(text || '');
  const direct = productRepo.resolveCategoryId(t);
  if (direct) return direct;
  for (const [id, words] of Object.entries(CATEGORY_SYNONYMS)) {
    if (words.some((w) => t.includes(w))) return id;
  }
  return null;
}

// 去掉预算表达与口水词，留下真正的诉求内容
const QUERY_NOISE = /(预算|我要|我想|帮我|给我|推荐|一款|一个|一些|哪些|有没有|有什么|怎么样|怎么选|适合|想要|需要|看看|能不能|可以|的|吗|呢|吧|了|啊|呀|和|或|在|是|我)/g;

function normalizeQuery(text) {
  return String(text || '')
    .replace(/预算[^\d]{0,6}\d{2,6}/g, ' ')
    .replace(/\d{2,6}\s*(元|块|以内|以下|左右|之内)?/g, ' ')
    .replace(QUERY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中文关键词抽取：用商品词表在句子里做最长匹配（无需分词器） */
function extractKeywords(text) {
  const q = normalizeQuery(text);
  if (!q) return [];
  const hits = productRepo.searchVocabulary().filter((w) => q.includes(w));
  // 被更长关键词包含的短词去掉（命中「降噪耳机」就不必再留「耳机」）
  return hits
    .filter((w, i) => !hits.some((o, j) => j !== i && o.length > w.length && o.includes(w)))
    .slice(0, 3);
}

function parseOrderId(text) {
  const m = String(text || '').match(/SO\d{8,}/i);
  return m ? m[0].toUpperCase() : null;
}

/** 找出用户在问哪些商品（按关键词命中数量与长度打分） */
function findMentionedProducts(text, limit = 3) {
  const keywords = extractKeywords(text);
  if (!keywords.length) return [];
  const scored = new Map();
  for (const kw of keywords) {
    for (const p of productRepo.filterProducts({ keyword: kw, limit: 6 })) {
      const cur = scored.get(p.id) || { p, score: 0 };
      // 词越长越具体，权重越高；命中商品名再加分
      cur.score += kw.length + (p.name.includes(kw) ? 3 : 0);
      scored.set(p.id, cur);
    }
  }
  return [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.p);
}

/* ---------------- 意图识别 ---------------- */

const RULES = [
  ['greeting', /^(你好|您好|hi|hello|嗨|在吗|在么|有人吗)[!！。?？\s]*$/i],
  ['thanks', /(谢谢|多谢|感谢|辛苦了|好的谢谢)/],
  ['logistics', /(物流|快递|发货|到哪|运单|配送|几天到|什么时候到|签收|包裹|送到)/],
  ['aftersale', /(退货|退款|退换|换货|怎么退|能退|退吗|退了|退掉|保修|维修|售后|坏了|质量问题|发票|开发票|不满意|无理由)/],
  ['stock', /(有货|库存|现货|缺货|断货|还有吗|剩几)/],
  ['compare', /(对比|区别|哪个好|哪个更|还是|比较一下|怎么选|有什么不同)/],
  ['price', /(多少钱|价格|几块|几多|贵不贵|便宜点|最低价|优惠多少|打几折)/],
  ['recommend', /(推荐|买|选|想要|需要|有没有|有哪些|有什么|哪些|适合|预算|性价比|送礼|送人|挑|找|看看|来一)/],
];

function detectIntent(query, mode) {
  const q = String(query || '').trim();
  // 商品问答（详情页「问我这件商品」）已经锁定了商品，优先于通用意图规则，
  // 否则「续航怎么样」这类问法会被误判成「找商品」。
  if (mode === 'product-qa') return 'product-detail';
  for (const [intent, re] of RULES) {
    if (re.test(q)) return intent;
  }
  // 只要句子里带预算或类目，就当作「找商品」处理（避免「1500以内的耳机有哪些」掉进兜底）
  if (parseBudget(q) != null || parseCategoryId(q)) return 'recommend';
  // 提到了具体商品就走商品详情式回答
  if (findMentionedProducts(q, 1).length) return 'product-detail';
  return 'fallback';
}

/* ---------------- 数据 → 事实（供模板与 LLM 共用） ---------------- */

function productLine(p, idx) {
  const extra = [];
  if (p.rating) extra.push(`评分 ${p.rating}`);
  if (p.sales) extra.push(`已售 ${p.sales}`);
  if (p.originalPrice && p.originalPrice > p.price) extra.push(`原价 ¥${p.originalPrice}`);
  return `${idx ? `${idx}. ` : ''}${p.name}（${p.brand}）¥${p.price}${extra.length ? `｜${extra.join('｜')}` : ''}`;
}

/**
 * AI 推荐卡（导购 / 客服 / 问答共用）。
 * 字段必须与网关 /api/products 的 toSummary 保持一致——否则前端拿不到 coverColor，
 * 推荐卡会退化成无图的统一灰底，与商品列表的观感不一致。
 */
function toCard(p, reason) {
  return {
    id: p.id,
    name: p.name,
    price: p.price,
    originalPrice: p.originalPrice ?? null,
    pic: p.pic || '',
    coverColor: p.coverColor || '',
    highlight: p.highlight || '',
    brand: p.brand || '',
    category: p.category || '',
    categoryId: p.categoryId || '',
    subCategory: p.subCategory || '',
    subCategoryId: p.subCategoryId || '',
    rating: p.rating ?? 4.8,
    reviewsCount: p.reviewsCount ?? 0,
    sales: p.sales ?? 0,
    stock: p.totalStock ?? null,
    tags: p.tags || [],
    reason: reason || (p.description || '').slice(0, 40),
  };
}

function describeConditions({ budget, categoryId, keyword }) {
  const parts = [];
  if (categoryId) {
    const cat = productRepo.listCategories().find((c) => c.id === categoryId);
    if (cat) parts.push(cat.name);
  }
  if (keyword) parts.push(`关键词「${keyword}」`);
  if (budget) parts.push(`预算 ¥${budget} 以内`);
  return parts.length ? parts.join('、') : '全店热销';
}

/* ---------------- 各意图的检索 + 本地答案 ---------------- */

function answerGreeting(ctx) {
  const cats = productRepo.listCategories().map((c) => `${c.name}(${c.count})`).join('、');
  return {
    text:
      `你好，我是这家店的 AI 购物助手 👋\n` +
      `店里有 ${productRepo.countProducts()} 款在售商品，覆盖 ${cats}。\n` +
      `你可以这样问我：\n` +
      `• 「1500 以内的降噪耳机」——按预算和类目挑款\n` +
      `• 「声海降噪耳机多少钱 / 有货吗」——查价格与库存\n` +
      `• 「SO202610180001 到哪了」——查订单物流\n` +
      `• 「七天无理由怎么退」——查售后政策`,
    cards: [],
  };
}

function answerRecommend(ctx, msg) {
  const { budget, categoryId } = ctx;
  const kws = extractKeywords(msg).filter((k) => !/^\d+$/.test(k));

  // 逐个关键词尝试（词表已按具体度排序），第一个命中即采用；关键词都不中则退到只按预算+类目
  let list = [];
  let keyword = null;
  for (const kw of kws) {
    const r = productRepo.filterProducts({ maxPrice: budget, categoryId, keyword: kw, limit: 5 });
    if (r.length) {
      list = r;
      keyword = kw;
      break;
    }
  }
  if (!list.length) list = productRepo.filterProducts({ maxPrice: budget, categoryId, limit: 5 });

  let relaxed = null;
  if (!list.length) {
    // 预算内确实没有 → 只放宽预算，并明确告知
    list = productRepo.filterProducts({ categoryId, limit: 3 });
    if (list.length) relaxed = 'budget';
  }
  if (!list.length) {
    return {
      text: `没有找到符合「${describeConditions({ budget, categoryId, keyword })}」的商品。\n可以试试放宽预算或换个类目——比如${productRepo
        .listCategories()
        .slice(0, 3)
        .map((c) => c.name)
        .join('、')}都比较热销。`,
      cards: [],
    };
  }

  // 送礼场景：礼盒/送礼类商品优先（纯按销量排会把 T 恤排前面，不合语境）
  if (/(送礼|礼物|送人|送爸妈|给爸妈|给父母|给长辈|生日)/.test(msg)) {
    list = [...list].sort((a, b) => {
      const score = (p) => (/礼盒|送礼/.test(p.name) ? 2 : 0) + (p.tags.some((t) => /礼盒|送礼/.test(t)) ? 1 : 0);
      return score(b) - score(a);
    });
  }

  const lines = list.map((p, i) => productLine(p, i + 1));
  let text = `按「${describeConditions({ budget, categoryId, keyword })}」帮你筛出 ${list.length} 款：\n${lines.join('\n')}`;
  if (relaxed === 'budget') {
    text += `\n\n提示：这个预算内暂时没有匹配款，上面是同类里价位较低的，最低 ¥${list[list.length - 1].price}。`;
  }
  const top = list[0];
  text += `\n\n如果只能选一款，我建议「${top.name}」：${top.description.slice(0, 40)}…（评分 ${top.rating}，已售 ${top.sales}）`;

  return { text, cards: list.map((p) => toCard(p, p.description.slice(0, 40))) };
}

function answerPrice(ctx, msg) {
  const hits = findMentionedProducts(msg, 2);
  const pid = ctx.lastProductId;
  const target = hits[0] || (pid ? productRepo.getProductDetail(pid) : null);
  if (!target) {
    const cheap = productRepo.filterProducts({ limit: 3 });
    return {
      text:
        `你想问哪一款的价格？可以直接说商品名，例如「声海降噪耳机多少钱」。\n` +
        `先给你几个价位参考：\n${cheap.map((p, i) => productLine(p, i + 1)).join('\n')}`,
      cards: cheap.map((p) => toCard(p)),
    };
  }
  const d = target.skus ? target : productRepo.getProductDetail(target.id);
  const prices = d.skus.map((s) => s.price);
  const save = d.originalPrice && d.originalPrice > d.price ? d.originalPrice - d.price : 0;
  const text =
    `「${d.name}」现在 ¥${d.price}${save ? `（原价 ¥${d.originalPrice}，省 ¥${save}）` : ''}。\n` +
    (d.skus.length
      ? `共 ${d.skus.length} 个规格：${d.skus.map((s) => `${s.spec} ¥${s.price}`).join('；')}\n`
      : '') +
    `合计库存 ${d.totalStock} 件，评分 ${d.rating}，已售 ${d.sales}。\n` +
    (prices.length > 1 ? `价格区间 ¥${Math.min(...prices)} ~ ¥${Math.max(...prices)}，预算紧可以选低配版。` : '');
  return { text, cards: [toCard(d, `¥${d.price}，库存 ${d.totalStock}`)] };
}

function answerStock(ctx, msg) {
  const hits = findMentionedProducts(msg, 2);
  const target = hits[0] || (ctx.lastProductId ? productRepo.getProductById(ctx.lastProductId) : null);
  if (!target) {
    return { text: '你想查哪款商品的库存？告诉我商品名就行，比如「极光 Pro 有货吗」。', cards: [] };
  }
  const d = productRepo.getProductDetail(target.id);
  const inStock = d.skus.filter((s) => s.stock > 0);
  const text =
    `「${d.name}」当前总库存 ${d.totalStock} 件。\n` +
    d.skus
      .map((s) => `• ${s.spec}：${s.stock > 0 ? `有货 ${s.stock} 件` : '暂时缺货'}`)
      .join('\n') +
    (inStock.length ? `\n\n现货规格 ${inStock.length} 个，下单后 48 小时内发出。` : '\n\n当前全部规格缺货，建议关注补货通知。');
  return { text, cards: [toCard(d, `库存 ${d.totalStock} 件`)] };
}

function answerCompare(ctx, msg) {
  const hits = findMentionedProducts(msg, 2);
  if (hits.length < 2) {
    const cat = ctx.categoryId || parseCategoryId(msg);
    const pool = productRepo.filterProducts({ categoryId: cat, maxPrice: ctx.budget, limit: 3 });
    if (pool.length < 2) {
      return { text: '你想对比哪两款？可以说得具体一点，比如「声海降噪耳机和音悦骨传导哪个好」。', cards: [] };
    }
    hits.length = 0;
    hits.push(...pool.slice(0, 2));
  }
  const [a, b] = hits;
  const fmt = (p) =>
    `• ${p.name}｜¥${p.price}｜评分 ${p.rating}｜已售 ${p.sales}\n  标签：${p.tags.join('、')}\n  卖点：${p.description}`;
  const cheaper = a.price <= b.price ? a : b;
  const better = a.rating >= b.rating ? a : b;
  const text =
    `把这两款放在一起对比：\n${fmt(a)}\n${fmt(b)}\n\n` +
    `价格上「${cheaper.name}」更友好（¥${cheaper.price}）；口碑上「${better.name}」评分略高（${better.rating}）。\n` +
    `如果预算优先选前者，如果更看重体验选后者。`;
  return { text, cards: [toCard(a, '对比候选 1'), toCard(b, '对比候选 2')] };
}

function answerLogistics(ctx, msg, userId) {
  const orderId = parseOrderId(msg);
  let order = orderId ? orderRepo.getOrderById(orderId) : null;
  if (!order) {
    // 没给订单号时：优先找和用户提到的商品/类目相关的订单，否则取最近一单
    const kws = extractKeywords(msg).filter((k) => !/^(物流|快递|发货|配送|包裹)$/.test(k));
    const all = orderRepo.listOrdersForDemo(userId, 10);
    order = all.find((o) => kws.some((k) => o.items.some((i) => i.name.includes(k)))) || all[0] || null;
  }
  if (!order) {
    return {
      text:
        '没查到这个订单。可以把订单号发我（形如 SO202610180001），或者到「我的订单」里看一下。\n' +
        '一般情况下：付款后 48 小时内发货，默认顺丰 / 京东，江浙沪次日达。',
      cards: [],
    };
  }
  const items = order.items.map((i) => `${i.name} ×${i.qty}`).join('、');
  const text =
    `订单 ${order.id}\n` +
    `状态：${order.statusLabel}\n` +
    `商品：${items}（合计 ¥${order.totalAmount}）\n` +
    (order.logisticsCompany
      ? `物流：${order.logisticsCompany} ${order.trackingNo}\n最新：${trackingHint(order)}\n`
      : '物流：尚未发货\n') +
    `下单时间：${order.createdAt}` +
    (order.isSample ? '\n（当前展示的是演示订单，接入真实 mall 后为你本人的订单）' : '');
  return { text, cards: [] };
}

function trackingHint(order) {
  const map = {
    pending: '订单待支付，付款后会尽快安排发货',
    paid: '商家已接单，48 小时内发出',
    shipped: '包裹在途，可凭运单号在快递官网查看实时轨迹',
    completed: '已签收，如商品有问题可在 7 天内申请售后',
    refunding: '退款处理中，3-5 个工作日到账',
    refunded: '退款已完成，款项已退回原支付账户',
    closed: '订单已关闭',
  };
  return map[order.status] || '暂无轨迹';
}

function getPolicy(id) {
  const row = getDb().prepare('SELECT title, content FROM policies WHERE id = ?').get(id);
  return row || null;
}

function answerAftersale(ctx, msg, userId) {
  const q = String(msg || '');
  const orderId = parseOrderId(q);
  const order = orderId ? orderRepo.getOrderById(orderId) : null;

  if (/发票/.test(q)) {
    const p = getPolicy('invoice');
    return { text: `${p ? `${p.title}：${p.content}` : '支持电子普通发票。'}\n\n在「我的订单 - 申请发票」提交即可，开好后发送到你的邮箱。`, cards: [] };
  }
  if (/保修|质保|维修|坏了/.test(q)) {
    const p = getPolicy('warranty');
    return { text: `${p ? `${p.title}：${p.content}` : '电子类商品 1 年质保。'}\n\n如果是刚收到的商品有质量问题，可以直接申请退换，运费由商家承担。`, cards: [] };
  }
  const p = getPolicy('return');
  let text = `${p ? `${p.title}：${p.content}` : '签收后 7 天内支持无理由退换。'}`;
  if (order) {
    text += `\n\n订单 ${order.id} 当前状态：${order.statusLabel}。`;
    if (order.status === 'shipped' || order.status === 'completed') {
      text += '已发货 / 已签收的订单可以在订单详情点「申请售后」，选择退货退款即可。';
    } else {
      text += '订单还没发货，可以直接申请取消并退款。';
    }
  } else if (/退|换|退款/.test(q)) {
    text += '\n\n操作路径：我的订单 → 选中订单 → 申请售后 → 选择退货/换货 → 填写原因。审核通过后按提示寄回即可。';
  }
  return { text, cards: [] };
}

function answerFaq(msg) {
  const db = getDb();
  const rows = db.prepare('SELECT topic, question, answer, keywords FROM faqs').all();
  const q = String(msg || '');
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    const kws = JSON.parse(r.keywords || '[]');
    let score = 0;
    for (const k of kws) if (q.includes(k)) score += k.length;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best || bestScore === 0) return null;
  return { text: `${best.answer}`, cards: [], faq: best };
}

function answerProductDetail(ctx, msg) {
  const hits = findMentionedProducts(msg, 2);
  const target = hits[0] || (ctx.productId ? productRepo.getProductById(ctx.productId) : null) || (ctx.lastProductId ? productRepo.getProductById(ctx.lastProductId) : null);
  if (!target) return null;
  const d = productRepo.getProductDetail(target.id);

  const askReviews = /(评价|口碑|怎么样|好用|值得|真实)/.test(msg);
  const askStock = /(货|库存|现货)/.test(msg);
  const askPrice = /(价|钱|贵|便宜)/.test(msg);

  const parts = [`「${d.name}」（${d.brand}）现在 ¥${d.price}，评分 ${d.rating}，已售 ${d.sales}。`];
  if (!askReviews && !askStock && !askPrice) parts.push(d.description);
  if (askStock || !askPrice) parts.push(`共 ${d.skus.length} 个规格可选，合计库存 ${d.totalStock} 件。`);
  if (askPrice && d.originalPrice > d.price) parts.push(`比原价 ¥${d.originalPrice} 便宜 ¥${d.originalPrice - d.price}。`);
  if (d.reviews && d.reviews.length) {
    parts.push(
      `\n买家怎么说：\n${d.reviews.map((r) => `• ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} ${r.content}`).join('\n')}`,
    );
  }
  const similar = productRepo.similarProducts(d.id, 2);
  if (similar.length) parts.push(`\n同类还可以看看：${similar.map((s) => `${s.name}（¥${s.price}）`).join('、')}。`);

  return { text: parts.join('\n'), cards: [toCard(d, '你问的这款')] };
}

function answerFallback(msg) {
  const top = productRepo.filterProducts({ limit: 3 });
  const faq = answerFaq(msg);
  if (faq) return faq;
  return {
    text:
      `我还不太确定你想了解什么，可以再具体一点吗？\n` +
      `比如：\n• 「1000 以内推荐一款耳机」\n• 「声海降噪耳机有货吗」\n• 「SO202610180001 到哪了」\n\n` +
      `先看看店里卖得最好的几款：\n${top.map((p, i) => productLine(p, i + 1)).join('\n')}`,
    cards: top.map((p) => toCard(p)),
  };
}

/* ---------------- 检索总入口 ---------------- */

function retrieve({ intent, query, ctx, userId }) {
  switch (intent) {
    case 'greeting':
      return answerGreeting(ctx);
    case 'thanks':
      return { text: '不客气～还有想了解的随时问我，祝购物愉快！', cards: [] };
    case 'recommend':
      return answerRecommend(ctx, query);
    case 'price':
      return answerPrice(ctx, query);
    case 'stock':
      return answerStock(ctx, query);
    case 'compare':
      return answerCompare(ctx, query);
    case 'logistics':
      return answerLogistics(ctx, query, userId);
    case 'aftersale':
      return answerAftersale(ctx, query, userId);
    case 'product-detail': {
      const r = answerProductDetail(ctx, query);
      if (r) return r;
      return answerFallback(query);
    }
    default:
      return answerFallback(query);
  }
}

/* ---------------- LLM 上下文组装 ---------------- */

function buildLlmMessages({ query, intent, facts, cards, ctx, userId, history }) {
  const productBlock = cards.length
    ? cards.map((c) => `- ${c.name}（${c.brand}）¥${c.price}｜${c.reason}`).join('\n')
    : '（本次没有检索到匹配商品）';

  const policies = getDb().prepare('SELECT title, content FROM policies').all();
  const policyBlock = policies.map((p) => `- ${p.title}：${p.content}`).join('\n');

  const orders = orderRepo.listOrdersForDemo(userId, 3);
  const orderBlock = orders.length
    ? orders
        .map(
          (o) =>
            `- ${o.id}｜${o.statusLabel}｜¥${o.totalAmount}｜${o.items.map((i) => i.name).join('、')}` +
            (o.logisticsCompany ? `｜${o.logisticsCompany} ${o.trackingNo}` : ''),
        )
        .join('\n')
    : '（无订单）';

  const system = [
    '你是一家名为「好物商城」的中文电商店铺的 AI 购物助手。',
    '回答要求：',
    '1. 只使用下面【事实】里的信息回答，不要编造商品、价格、库存、物流或政策；信息不足时直接说明并追问。',
    '2. 语气自然、简洁，控制在 2-5 句话；需要推荐时最多列 3 款，写清名称与价格。',
    '3. 不要输出 Markdown 表格、代码块或 HTML，纯文本即可。',
    '4. 用中文回答，可以适度使用「～」「👋」这类轻松语气，但不要过度卖萌。',
    '',
    '【识别到的意图】',
    intent,
    '',
    '【本次检索到的商品】',
    productBlock,
    '',
    '【店铺政策】',
    policyBlock,
    '',
    '【用户近期的订单】',
    orderBlock,
    '',
    '【已生成的事实性草稿（可改写，但数字与结论必须一致）】',
    facts,
    '',
    ctx.budget ? `【用户预算】¥${ctx.budget} 以内` : '',
    ctx.lastProductId ? `【上一轮讨论的商品 ID】${ctx.lastProductId}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: query },
  ];
}

/* ---------------- 上下文合并（多轮指代） ---------------- */

function mergeContext(prev, query) {
  const budget = parseBudget(query);
  const categoryId = parseCategoryId(query);
  const ctx = {
    budget: budget ?? prev.budget ?? null,
    categoryId: categoryId ?? prev.categoryId ?? null,
    lastProductId: prev.lastProductId ?? null,
    lastIntent: prev.lastIntent ?? null,
  };
  return ctx;
}

/* ---------------- 对外入口 ---------------- */

/**
 * 单轮对话（非流式）。
 * @returns {Promise<{answer:string, cards:Array, conversationId:string, mode:string, intent:string}>}
 */
export async function chatReply({ mode = 'chat', query, userId = 'anonymous', conversationId, productId }) {
  if (!query || !query.trim()) {
    const err = new Error('query required');
    err.status = 400;
    throw err;
  }
  const conv = convRepo.ensureConversation({ id: conversationId, userId, mode });
  const prevCtx = { ...conv.context, productId: productId || conv.context.productId };
  const intent = detectIntent(query, mode);
  const ctx = mergeContext(prevCtx, query);
  ctx.productId = productId || prevCtx.productId;

  const history = convRepo.history(conv.id, 6);
  const facts = retrieve({ intent, query, ctx, userId });

  let answer = facts.text;
  let usedMode = 'local';

  if (llmEnabled()) {
    try {
      answer = await chatComplete(buildLlmMessages({ query, intent, facts: facts.text, cards: facts.cards, ctx, userId, history }));
      usedMode = 'llm';
    } catch (e) {
      console.warn(`[chatEngine] LLM 失败，回退本地引擎: ${e.message}`);
      usedMode = 'local-fallback';
    }
  }

  // 落库：用户消息 + 助手消息 + 上下文
  convRepo.appendMessage(conv.id, 'user', query);
  convRepo.appendMessage(conv.id, 'assistant', answer, { intent, mode: usedMode, cards: facts.cards.map((c) => c.id) });
  convRepo.patchContext(conv.id, {
    ...ctx,
    lastProductId: facts.cards.length ? facts.cards[0].id : ctx.lastProductId,
    lastIntent: intent,
  });

  return { answer, cards: facts.cards, conversationId: conv.id, mode: usedMode, intent };
}

/**
 * 流式对话：逐段回调 onDelta，返回与 chatReply 相同结构。
 */
export async function chatReplyStream(input, onDelta) {
  const { mode = 'chat', query, userId = 'anonymous', conversationId, productId } = input;
  if (!query || !query.trim()) {
    const err = new Error('query required');
    err.status = 400;
    throw err;
  }
  const conv = convRepo.ensureConversation({ id: conversationId, userId, mode });
  const prevCtx = { ...conv.context, productId: productId || conv.context.productId };
  const intent = detectIntent(query, mode);
  const ctx = mergeContext(prevCtx, query);
  ctx.productId = productId || prevCtx.productId;

  const history = convRepo.history(conv.id, 6);
  const facts = retrieve({ intent, query, ctx, userId });

  let answer = facts.text;
  let usedMode = 'local';

  if (llmEnabled()) {
    try {
      answer = await chatStream(
        buildLlmMessages({ query, intent, facts: facts.text, cards: facts.cards, ctx, userId, history }),
        onDelta,
      );
      usedMode = 'llm';
    } catch (e) {
      console.warn(`[chatEngine] LLM 流式失败，回退本地引擎: ${e.message}`);
      usedMode = 'local-fallback';
      answer = facts.text;
      await streamLocal(answer, onDelta);
    }
  } else {
    await streamLocal(answer, onDelta);
  }

  convRepo.appendMessage(conv.id, 'user', query);
  convRepo.appendMessage(conv.id, 'assistant', answer, { intent, mode: usedMode, cards: facts.cards.map((c) => c.id) });
  convRepo.patchContext(conv.id, {
    ...ctx,
    lastProductId: facts.cards.length ? facts.cards[0].id : ctx.lastProductId,
    lastIntent: intent,
  });

  return { answer, cards: facts.cards, conversationId: conv.id, mode: usedMode, intent };
}

async function streamLocal(text, onDelta, { chunkSize = 3, delayMs = 18 } = {}) {
  for (let i = 0; i < text.length; i += chunkSize) {
    onDelta(text.slice(i, i + chunkSize));
    await sleep(delayMs);
  }
}

export { detectIntent, parseBudget, parseCategoryId };
