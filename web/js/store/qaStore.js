// 商品 Q&A 数据层：问题列表 + mock 提问 + 商家自动回复。
//
// 数据口径：
//   - 单键 maison_pdp_qa_v1，按商品 id 分组 { [pid]: QaItem[] }，每商品上限 50 条
//   - QaItem = { id, question, answer, answeredBy, createdAt, mine }
//   - 内置 MOCK_QA 作为每个商品的基础问答（发货 / 材质 / 退换三件套），
//     用户提问后由 mock 模板池即时生成「商家回复」并持久化到 localStorage
//
// 后续接真实 /api/qa 时，只需替换 listQuestions / submitQuestion 的实现，
// 页面层（views.js 的问答区块）不感知数据来源。
const QA_KEY = 'maison_pdp_qa_v1';
const MAX_PER_PRODUCT = 50;

function readAll() {
  try {
    const raw = localStorage.getItem(QA_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(QA_KEY, JSON.stringify(all));
  } catch { /* 隐私模式 / 配额满：问答退化为内存态，不阻塞页面 */ }
}

/** 内置基础问答：所有商品通用（发货 / 材质品质 / 退换），mine=false 便于区分展示 */
export const MOCK_QA = [
  {
    id: 'qa-ship',
    question: '下单后多久能发货？',
    answer: '现货商品付款后 48 小时内发出，顺丰包邮；预售商品以详情页标注的发货时间为准。',
    answeredBy: '官方客服',
    createdAt: '2026-09-12T10:20:00.000Z',
    mine: false,
  },
  {
    id: 'qa-quality',
    question: '材质和描述一致吗？有色差吗？',
    answer: '材质与详情页描述一致。商品图为实物拍摄，但不同屏幕存在轻微色差，介意的话可以收货后 7 天无理由退换。',
    answeredBy: '官方客服',
    createdAt: '2026-09-18T14:05:00.000Z',
    mine: false,
  },
  {
    id: 'qa-return',
    question: '不合适可以退换吗？运费谁出？',
    answer: '支持 7 天无理由退换，未拆吊牌不影响二次销售即可。质量问题运费我们承担，个人原因退回运费需自行支付哦。',
    answeredBy: '官方客服',
    createdAt: '2026-09-25T09:42:00.000Z',
    mine: false,
  },
];

/** 商家自动回复模板池：按问题命中的关键词挑一条，都不命中就走兜底 */
const AUTO_ANSWERS = [
  { match: /尺码|大小|尺寸|码数/, text: '建议按详情页的尺码表选择；拿不准的话可以把身高体重发给我，我帮你推荐合适的码数。' },
  { match: /发货|物流|快递|多久|几天/, text: '现货付款后 48 小时内由顺丰发出，江浙沪隔天到，其他地区 2–4 天送达。' },
  { match: /材质|面料|成分|真|皮质/, text: '材质与详情页描述完全一致，支持验货；收到后有任何不符，7 天内可无理由退换。' },
  { match: /退|换|售后|保修/, text: '支持 7 天无理由退换，质量问题运费我们承担；超过 7 天可联系在线客服协商售后。' },
  { match: /色差|颜色|偏/, text: '商品为实物拍摄，仅不同屏幕会有轻微色差；对颜色敏感的话建议到「买家秀」里看真实上身图。' },
  { match: /优惠|券|便宜|活动|价格/, text: '可以领取结算页的优惠券叠加使用；大促期间价格更低，可先加入购物袋关注。' },
  { match: null, text: '感谢咨询！这一问题已同步给品牌顾问，通常 2 小时内回复；也可以直接点击「问我这件商品」由 AI 先行解答。' },
];

function makeId() {
  return `qa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 读取某商品的问题列表：我的提问按时间倒序排最前（刚提的先被看到），
 * 内置基础问答固定在后（时间正序）。
 */
export function listQuestions(productId) {
  const all = readAll();
  const mine = Array.isArray(all[String(productId)]) ? all[String(productId)] : [];
  return [...mine, ...MOCK_QA.map((q) => ({ ...q }))];
}

/** 某商品的问题总数（含内置） */
export function countQuestions(productId) {
  return listQuestions(productId).length;
}

/**
 * mock 提问：立即生成一条「商家回复」并持久化。
 * 返回新建的 QaItem（mine=true），调用方负责把它追加进视图。
 */
export function submitQuestion(productId, text) {
  const q = String(text || '').trim();
  if (!q) throw new Error('问题内容不能为空');
  if (q.length > 200) throw new Error('问题请控制在 200 字以内');
  const hit = AUTO_ANSWERS.find((a) => a.match && a.match.test(q));
  const item = {
    id: makeId(),
    question: q,
    answer: hit ? hit.text : AUTO_ANSWERS[AUTO_ANSWERS.length - 1].text,
    answeredBy: '官方客服',
    createdAt: new Date().toISOString(),
    mine: true,
  };
  const all = readAll();
  const key = String(productId);
  const mine = Array.isArray(all[key]) ? all[key] : [];
  mine.unshift(item);
  all[key] = mine.slice(0, MAX_PER_PRODUCT);
  writeAll(all);
  return item;
}
