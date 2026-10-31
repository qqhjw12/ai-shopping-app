// 商家入驻申请：校验 + 规范化 + 幂等提交 + 凭证查询。
//
// 校验一律在服务端做一遍（前端那遍只是为了少一次往返，不能当防线）。
// 错误按字段返回 { code: message }，前端据此把提示挂到对应输入框并跳到对应步骤——
// 只回一句「参数有误」的表单，等于让商家自己从头再找一遍哪个格子填错了。
import { createHash, createHmac } from 'node:crypto';
import { CATEGORIES } from '../data/catalog.js';
import { getSecret } from '../auth/keys.js';
import * as merchantRepo from '../repositories/merchantRepo.js';
import * as noticeTemplateService from './noticeTemplateService.js';

export const ENTITY_KINDS = ['brand', 'factory', 'studio', 'food', 'other'];
export const BRAND_SOURCES = ['owned', 'exclusive', 'authorized'];
export const SKU_RANGES = ['lt50', '50-200', '200-1000', 'gt1000'];
export const PRICE_RANGES = ['lt100', '100-500', '500-2000', 'gt2000'];
// 平台对退货政策有底线：只接受 7 天或 15 天无理由，没有「不支持」这个选项。
// 与其让商家填完再被驳回，不如在枚举里就不给这个值。
export const RETURN_POLICIES = ['7days', '15days'];
export const SHIP_WITHIN = ['24h', '48h', '72h'];

/**
 * 资质材料类型。收着这四类是因为审核要看的东西就这几样：
 *   license     营业执照（必有，主体是谁全靠它）
 *   brand_auth  品牌授权（代理/独家时必须有，自有品牌可没有）
 *   inspection  质检报告（食品、母婴、电器类目会被要求）
 *   other       其他（专利、产地证明等）
 * 白名单而不是自由文本：前端传什么就存什么的话，运营会在一堆
 * 「营业执照.png」「License」「license 」里挑，筛选和统计全部作废。
 */
export const MATERIAL_KINDS = ['license', 'brand_auth', 'inspection', 'other'];
export const MATERIAL_LABEL = {
  license: '营业执照',
  brand_auth: '品牌授权',
  inspection: '质检报告',
  other: '其他材料',
};
/** 单份材料在清单里的上限；总份数上限 8 —— 超过说明商家在批量塞截图。 */
const MAX_MATERIALS = 8;
const MAX_MATERIAL_NAME = 100;
const MAX_MATERIAL_SIZE = 20 * 1024 * 1024;

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const clamp = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const bad = (fields) => Object.assign(new Error('请检查填写内容'), { status: 400, fields });
/** 记一条字段错误并返回 undefined（规则表里就写 `return fail(f, 'x', '…')`，比逗号表达式好读） */
const fail = (f, name, msg) => { f[name] = msg; return undefined; };

/** 统一社会信用代码：18 位，字符集不含 I / O / S / V / Z（国标规定，避免与数字混淆） */
const CREDIT_RE = /^[0-9A-HJ-NPQRTUWXY]{18}$/;

/**
 * 字段规则表：**一个字段一处规则**。
 *
 * 为什么要拆成表而不是继续写在 normalize 里：
 * 商家在「审核中」可以只改一两个字段（revise），如果校验只有「全量」一个入口，
 * 修订就只能要求他把 17 个字段全填一遍——而其中银行账号我们根本回显不出来
 * （库里只有前 4 后 4）。那样最省事的实现会变成「把打码串当新卡号存回去」，
 * 于是每次改个手机号都会把结算账号覆盖成一串星号。
 *
 * 所以：normalize() 走全表，normalizePatch() 只走传进来的那几个字段，同一套规则。
 */
const RULES = {
  entityKind: (v, f) => {
    const x = String(v || '').trim();
    if (!ENTITY_KINDS.includes(x)) return fail(f, 'entityKind', '请选择商家主体类型');
    return x;
  },
  company: (v, f) => {
    const x = clamp(v, 60);
    if (x.length < 2) return fail(f, 'company', '请填写营业执照上的主体名称（至少 2 个字）');
    return x;
  },
  creditCode: (v, f) => {
    const x = clamp(v, 32).toUpperCase().replace(/\s+/g, '');
    if (!CREDIT_RE.test(x)) return fail(f, 'creditCode', '统一社会信用代码为 18 位（数字与大写字母）');
    return x;
  },
  contact: (v, f) => {
    const x = clamp(v, 20);
    if (x.length < 2) return fail(f, 'contact', '请填写联系人姓名');
    return x;
  },
  phone: (v, f) => {
    const x = clamp(v, 20).replace(/[\s-]/g, '');
    if (!/^1[3-9]\d{9}$/.test(x)) return fail(f, 'phone', '请填写 11 位手机号');
    return x;
  },
  email: (v, f) => {
    const x = clamp(v, 80);
    if (x && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)) return fail(f, 'email', '邮箱格式不正确');
    return x;
  },
  brand: (v, f) => {
    const x = clamp(v, 40);
    if (x.length < 1) return fail(f, 'brand', '请填写品牌名称');
    return x;
  },
  brandSource: (v, f) => {
    const x = String(v || '').trim();
    if (!BRAND_SOURCES.includes(x)) return fail(f, 'brandSource', '请选择品牌来源');
    return x;
  },
  categories: (v, f) => {
    // 主营类目：1–3 个，必须是平台真实存在的一级类目（拒绝前端传上来的野字符串）
    const raw = Array.isArray(v) ? v : [];
    const list = [...new Set(raw.map((c) => String(c || '').trim()))].filter((c) => CATEGORY_IDS.has(c));
    if (!list.length) return fail(f, 'categories', '请至少选择一个主营类目');
    if (list.length > 3) return fail(f, 'categories', '主营类目最多选 3 个');
    return list;
  },
  /**
   * 资质材料清单：只收清单（类型/文件名/大小），不收文件本体。
   * 每一项都过一遍规范化，未知类型整体拒绝——半接受的清单会让运营
   * 看到「3 份材料」而其中一份根本不知道是什么。
   */
  materials: (v, f) => {
    const raw = Array.isArray(v) ? v : [];
    if (raw.length > MAX_MATERIALS) return fail(f, 'materials', `材料最多 ${MAX_MATERIALS} 份`);
    const list = [];
    for (const item of raw) {
      const kind = String((item && item.kind) || '').trim();
      if (!MATERIAL_KINDS.includes(kind)) return fail(f, 'materials', '材料类型不在可选范围内');
      const name = clamp(item && item.name, MAX_MATERIAL_NAME);
      if (name.length < 1) return fail(f, 'materials', '材料文件名不能为空');
      const size = Math.max(0, Math.min(MAX_MATERIAL_SIZE, Number(item && item.size) || 0));
      list.push({ kind, name, size });
    }
    return list;
  },
  skuRange: (v, f) => {
    const x = String(v || '').trim();
    if (!SKU_RANGES.includes(x)) return fail(f, 'skuRange', '请选择预估 SKU 数量');
    return x;
  },
  priceRange: (v, f) => {
    const x = String(v || '').trim();
    if (!PRICE_RANGES.includes(x)) return fail(f, 'priceRange', '请选择主力价格带');
    return x;
  },
  dropship: (v) => Boolean(v),
  bankAccount: (v, f) => {
    const x = clamp(v, 60);
    if (x.length < 2) return fail(f, 'bankAccount', '请填写开户名（与营业执照一致）');
    return x;
  },
  bankBranch: (v) => clamp(v, 60),
  // 写库用的字段名是 bankNoMasked（完整卡号不落库）；规则返回的也是它
  bankNo: (v, f) => {
    const x = clamp(v, 32).replace(/\s/g, '');
    if (!/^\d{12,24}$/.test(x)) return fail(f, 'bankNo', '银行卡号为 12–24 位数字');
    return `${x.slice(0, 4)}${'*'.repeat(Math.max(4, x.length - 8))}${x.slice(-4)}`;
  },
  returnPolicy: (v, f) => {
    const x = String(v || '').trim();
    if (!RETURN_POLICIES.includes(x)) return fail(f, 'returnPolicy', '请选择退货政策（平台要求至少 7 天无理由）');
    return x;
  },
  shipWithin: (v, f) => {
    const x = String(v || '').trim();
    if (!SHIP_WITHIN.includes(x)) return fail(f, 'shipWithin', '请选择发货时效');
    return x;
  },
  note: (v) => clamp(v, 200),
};

/** 入库字段名与规则名的差异（bankNo 校验完要存成打码串） */
const RULE_TO_COLUMN = { bankNo: 'bankNoMasked' };

export const EDITABLE_FIELDS = Object.keys(RULES);

/** 字段的人话名字：写进轨迹摘要，运营才看得懂「商家改了什么」 */
export const FIELD_LABEL = {
  entityKind: '主体类型',
  company: '主体名称',
  creditCode: '信用代码',
  contact: '联系人',
  phone: '手机号',
  email: '邮箱',
  brand: '品牌名称',
  brandSource: '品牌来源',
  categories: '主营类目',
  materials: '资质材料',
  skuRange: 'SKU 数量',
  priceRange: '价格带',
  dropship: '一件代发',
  bankAccount: '开户名',
  bankBranch: '开户行',
  bankNo: '结算账号',
  returnPolicy: '退货政策',
  shipWithin: '发货时效',
  note: '补充说明',
};

/**
 * 字段规范化 + 校验。返回可直接入库的对象，或抛带 fields 的 400。
 * 注意银行账号：这里把完整卡号压成「前 4 + 后 4」，完整号码不进入任何后续环节
 * （不入库、不进日志、不进返回值）。理由见 schema.js 迁移 17 的注释。
 */
export function normalize(payload = {}) {
  const fields = {};
  const out = {};
  for (const [name, rule] of Object.entries(RULES)) {
    const v = rule(payload[name], fields);
    if (v !== undefined) out[RULE_TO_COLUMN[name] || name] = v;
  }
  if (Object.keys(fields).length) throw bad(fields);
  return out;
}

/**
 * 部分修订：只认传进来的字段，未传的保持原值。
 *
 * 三条硬规则：
 *   1) 不认识的字段直接拒绝（400），而不是忽略——前端拼错一个字段名却「保存成功」，
 *      商家会以为改好了，而审核看到的是旧值；
 *   2) 值没变就不算变更（否则每点一次保存，revision_count 都 +1，
 *      运营会看到一堆没有意义的「改过 8 次」）；
 *   3) 银行账号必须重新输入完整卡号才能改（打码串不可回填）——所以没有任何
 *      「原样保留」的捷径：没传 bankNo 就是没改结算账号。
 *
 * @returns {{patch:object, changes:string[]}} changes 是字段名（人话标签在 FIELD_LABEL）
 */
export function normalizePatch(payload = {}, current = {}) {
  const fields = {};
  const unknown = Object.keys(payload).filter((k) => !RULES[k]);
  if (unknown.length) {
    throw bad({ __all: `不支持修改这些字段：${unknown.join('、')}` });
  }

  const patch = {};
  const changes = [];
  for (const [name, rule] of Object.entries(RULES)) {
    if (!(name in payload)) continue;
    const v = rule(payload[name], fields);
    if (v === undefined) continue;
    const column = RULE_TO_COLUMN[name] || name;
    const before = current[column];
    // 数组列（类目、材料）按序列化比较：引用永远不相等，逐项比又漏掉顺序差异
    const same = Array.isArray(v)
      ? JSON.stringify(Array.isArray(before) ? before : []) === JSON.stringify(v)
      : (typeof v === 'boolean' ? Boolean(before) === v : String(before ?? '') === String(v));
    if (same) continue;
    patch[column] = v;
    changes.push(name);
  }
  if (Object.keys(fields).length) throw bad(fields);
  return { patch, changes };
}

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * 查询凭证：由 (userId, submitKey) 经服务端密钥 HMAC 派生，而不是随机生成后存明文。
 * 好处是「提交成功但响应丢了」时，客户端带同一个 submitKey 重试能拿到**同一个**查询链接，
 * 库里依然只有它的 sha256。
 * 代价：密钥轮换后旧链接失效——本地演示用临时密钥重启即失效（可接受）；
 * 生产必须配置固定 AUTH_JWT_SECRET（AUTH_REQUIRED=true 时启动就会强制要求）。
 */
function deriveQueryKey(userId, submitKey) {
  return createHmac('sha256', getSecret())
    .update(`merchant-query-key:v1:${userId}:${submitKey}`)
    .digest('base64url')
    .slice(0, 22);
}

/**
 * 提交申请。
 * @param {object} payload 原始请求体
 * @param {{userId?:string, submitKey?:string}} ctx
 * @returns {{application:object, queryKey:string, existed:boolean}}
 */
export function submit(payload = {}, { userId = 'anonymous', submitKey = '' } = {}) {
  const key = String(submitKey || '').trim().slice(0, 64);
  if (key.length < 8) {
    throw Object.assign(new Error('缺少提交凭证（submitKey）'), { status: 400 });
  }

  // 幂等：同一用户同一 submitKey 已经写过 → 直接返回既有申请，不再新建
  const existing = merchantRepo.findBySubmitKey(userId, key);
  if (existing) {
    return { application: existing, queryKey: deriveQueryKey(userId, key), existed: true };
  }

  const data = normalize(payload);
  const queryKey = deriveQueryKey(userId, key);
  const application = merchantRepo.createApplication(userId, data, {
    submitKey: key,
    queryKeyHash: sha256(queryKey),
  });
  return { application, queryKey, existed: false };
}

/** 凭编号 + 查询凭证取申请；凭证不对与编号不存在都返回 null（对外统一 404，不给枚举留口子） */
export function getByCredential(id, queryKey) {
  const key = String(queryKey || '').trim();
  if (!key) return null;
  const hit = merchantRepo.findByQueryKeyHash(sha256(key));
  if (!hit) return null;
  // 哈希能查出来就说明凭证对；再做一次编号比对，防止拿 A 的凭证看 B 的单
  if (hit.id !== String(id || '').trim()) return null;
  // 通知渠道带给商家自己看：「审核通过了」和「通知已经发到你手机上了」是两件事，
  // 只显示前者的话，商家会说「我没收到短信」，而我们无法判断是真没发还是他没看。
  return { ...hit, notices: merchantRepo.listNotices(hit.id).map(publicNotice) };
}

const publicNotice = (n) => ({
  channel: n.channel,
  channelLabel: n.channelLabel,
  status: n.status,
  statusLabel: n.statusLabel,
  targetMasked: n.targetMasked,
  sentAt: n.sentAt,
});

export function listForAdmin(query = {}) {
  const status = ['reviewing', 'approved', 'rejected', 'withdrawn'].includes(query.status) ? query.status : '';
  return merchantRepo.listApplications({
    status,
    page: Number(query.page) || 1,
    size: Number(query.size) || 20,
  });
}

export function stats() {
  return merchantRepo.countByStatus();
}

/** 运营详情：申请 + 审核轨迹 + 通知队列（列表不必带轨迹，详情才需要） */
export function detailForAdmin(id) {
  const app = merchantRepo.findById(id);
  if (!app) return null;
  return {
    application: app,
    events: merchantRepo.listEvents(id),
    notices: merchantRepo.listNotices(id),
  };
}

/* ============================================================
   审核
   ============================================================ */

export const REVIEW_ACTIONS = ['approve', 'reject'];
const MAX_REVIEW_NOTE = 200;

const STATUS_OF_ACTION = { approve: 'approved', reject: 'rejected' };

/**
 * 审核结果通知的文案，现在由「通知模板」渲染（运营可在后台改，见 noticeTemplateService）。
 *
 * 模板化之后仍然守着两条硬约束，写在默认文案里（改模板的人也不该破坏它们）：
 *   1) 通知里**不放查询链接**。查询链接要带上查询凭证（明文只在提交响应里出现一次），
 *      把它塞进短信等于让凭证跟着短信转发、留在运营商和手机里；
 *      编号已经足够商家在「他自己保存的那条链接」上回看。
 *   2) 驳回必须带上理由。商家看到「未通过」而不知道为什么，下一通就是投诉。
 */
const MASKERS = {
  phone: (p) => merchantRepo.maskMiddle(p, 3, 4),
  email: merchantRepo.maskEmail,
};

function buildNotices(app, status, note) {
  return noticeTemplateService.renderFor(status, app, note, MASKERS);
}

/**
 * 审核一条入驻申请。
 *
 * 三件事必须一起发生（交给仓储层的事务）：改状态、写轨迹、排通知。
 * 其中通知**只排队不发送**——审核这一步是运营的判断，不该被短信服务商的超时拖住，
 * 更不该因为对方 502 就把一次已经成立的审核回滚掉。发送由后台 worker 负责。
 *
 * @param {string} id
 * @param {{action:'approve'|'reject', note?:string}} payload
 * @param {{by?:string, keyFp?:string}} ctx 操作人自报 + 管理密钥指纹（都只用于追溯）
 */
export function review(id, { action, note } = {}, { by = 'admin', keyFp = 'none' } = {}) {
  const act = String(action || '').trim();
  if (!REVIEW_ACTIONS.includes(act)) {
    throw Object.assign(new Error('审核动作只能是 approve / reject'), { status: 400 });
  }
  const text = String(note || '').trim();
  if (text.length > MAX_REVIEW_NOTE) {
    throw Object.assign(new Error(`审核意见不能超过 ${MAX_REVIEW_NOTE} 字`), { status: 400 });
  }
  // 驳回必须给理由：「未通过」三个字对商家没有任何信息量，只能招来二次咨询
  if (act === 'reject' && !text) {
    throw Object.assign(new Error('驳回必须填写理由'), { status: 400 });
  }

  const before = merchantRepo.findById(id);
  if (!before) throw Object.assign(new Error('申请不存在'), { status: 404 });

  const status = STATUS_OF_ACTION[act];
  const application = merchantRepo.reviewApplication(id, {
    status,
    note: text,
    by: String(by || 'admin').slice(0, 40),
    keyFp: String(keyFp || 'none').slice(0, 32),
    notices: buildNotices(before, status, text),
  });
  return {
    application,
    events: merchantRepo.listEvents(id),
    notices: merchantRepo.listNotices(id),
  };
}

/* ============================================================
   商家自助：改资料 / 撤回
   ============================================================ */

const STATUS_TEXT = { reviewing: '审核中', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
const MAX_WITHDRAW_REASON = 100;

/** 凭证不对与编号不存在都返回 null（对外统一 404，不给枚举留口子） */
function requireMerchant(id, queryKey) {
  const key = String(queryKey || '').trim();
  if (!key) return null;
  return merchantRepo.findForMerchant(id, sha256(key));
}

function guardReviewing(app) {
  if (app.status !== 'reviewing') {
    throw Object.assign(
      new Error(`这份申请已经${STATUS_TEXT[app.status] || app.status}，不能再改动`),
      { status: 409 },
    );
  }
}

/**
 * 审核前修改资料（字段级）。
 *
 * 只允许在 reviewing 状态改：审核结论一旦落下，改资料就等于改一份已经被审过的证据。
 * 驳回后想再来的正确路径是**重新提交一份新申请**（编号会变，轨迹从头开始），
 * 而不是把旧单的内容换掉、让「这份是怎么被驳回的」无从追溯。
 *
 * @param {string} id
 * @param {string} queryKey 查询凭证（明文，只在比对时用）
 * @param {object} payload  只含要改的字段
 * @returns {{application:object, changes:string[], changesLabel:string[], events:Array}}
 */
export function revise(id, queryKey, payload = {}) {
  const app = requireMerchant(id, queryKey);
  if (!app) throw Object.assign(new Error('申请不存在，或查询凭证已失效'), { status: 404 });
  guardReviewing(app);

  const { patch, changes } = normalizePatch(payload, app);
  if (!changes.length) {
    throw Object.assign(new Error('没有需要更新的内容'), { status: 400 });
  }

  const labels = changes.map((k) => FIELD_LABEL[k] || k);
  merchantRepo.updateApplication(id, patch, { diff: `修改：${labels.join('、')}`, actor: 'merchant' });

  const fresh = merchantRepo.findByIdForPublic(id);
  return {
    application: { ...fresh, notices: merchantRepo.listNotices(id).map(publicNotice) },
    changes,
    changesLabel: labels,
    events: merchantRepo.listEvents(id),
  };
}

/**
 * 撤回申请。
 *
 * 不删除：运营列表要能看见「这家自己退了」，而不是一条申请凭空消失。
 * 撤回会排一条确认通知（模板可关），让商家手里留一份回执——
 * 撤回是商家的主动动作，但「我确实撤了」这件事同样值得有一条记录。
 */
export function withdraw(id, queryKey, { reason = '' } = {}) {
  const app = requireMerchant(id, queryKey);
  if (!app) throw Object.assign(new Error('申请不存在，或查询凭证已失效'), { status: 404 });
  guardReviewing(app);

  const text = String(reason || '').trim().slice(0, MAX_WITHDRAW_REASON);
  const notices = buildNotices(app, 'withdrawn', text);
  const updated = merchantRepo.withdrawApplication(id, { reason: text, notices, actor: 'merchant' });
  return {
    application: merchantRepo.findByIdForPublic(id),
    notices: merchantRepo.listNotices(id),
    withdrawnAt: updated.withdrawnAt,
  };
}

/* ============================================================
   运营侧：批量导出
   ============================================================ */

/**
 * 导出列。显式列出而不是「把对象字段全导出」：
 * 前者多一个字段就要改这里（有人会看一眼），后者新增一个内部字段就悄悄进了
 * 发给外部的表格。查询凭证哈希、submit_key 这类东西一次都不该出现。
 */
const EXPORT_COLUMNS = [
  ['id', '申请编号'],
  ['statusLabel', '状态'],
  ['entityKindLabel', '主体类型'],
  ['company', '主体名称'],
  ['creditCode', '统一社会信用代码'],
  ['contact', '联系人'],
  ['phone', '手机号'],
  ['email', '邮箱'],
  ['brand', '品牌'],
  ['brandSourceLabel', '品牌来源'],
  ['categoryLabel', '主营类目'],
  ['materialsLabel', '资质材料'],
  ['skuLabel', '预估 SKU'],
  ['priceLabel', '主力价格带'],
  ['dropshipLabel', '一件代发'],
  ['bankAccount', '开户名'],
  ['bankBranch', '开户行'],
  ['bankNoMasked', '结算账号（打码）'],
  ['returnPolicyLabel', '退货政策'],
  ['shipWithinLabel', '发货时效'],
  ['revisionCount', '修改次数'],
  ['note', '商家备注'],
  ['createdAt', '提交时间'],
  ['lastRevisedAt', '最后修改'],
  ['reviewedBy', '审核人'],
  ['reviewedAt', '审核时间'],
  ['reviewNote', '审核意见'],
  ['noticeLabel', '通知状态'],
  ['withdrawnAt', '撤回时间'],
];

const ENTITY_LABEL = { brand: '原创品牌', factory: '源头工厂', studio: '设计师工作室', food: '食品产地', other: '其他' };
const BRAND_SOURCE_LABEL = { owned: '自有品牌', exclusive: '独家代理', authorized: '授权代理' };
const SKU_LABEL = { lt50: '50 以内', '50-200': '50–200', '200-1000': '200–1000', gt1000: '1000 以上' };
const PRICE_LABEL = { lt100: '100 元以内', '100-500': '100–500 元', '500-2000': '500–2000 元', gt2000: '2000 元以上' };
const SHIP_LABEL = { '24h': '24 小时内', '48h': '48 小时内', '72h': '72 小时内' };

/**
 * SQLite 存的是 UTC 'YYYY-MM-DD HH:MM:SS'。导出是给人看的表格，必须换成本机时区——
 * 与前端 fmtStamp 同口径，否则运营在页面上看到 14:11、在表格里看到 06:11，
 * 会以为两条记录不是同一时刻（差 8 小时正好能把「当天提交」算成「前一天」）。
 */
function fmtLocal(v) {
  if (!v) return '';
  const d = new Date(`${String(v).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function exportRow(r, catLabel) {
  const notices = Array.isArray(r.notices) ? r.notices : [];
  return {
    ...r,
    entityKindLabel: ENTITY_LABEL[r.entityKind] || r.entityKind || '',
    brandSourceLabel: BRAND_SOURCE_LABEL[r.brandSource] || r.brandSource || '',
    categoryLabel: (r.categories || []).map((id) => catLabel.get(id) || id).join('、'),
    // 材料只导出「类型:文件名」：运营核对的是「有没有这份东西」，
    // 文件大小、登记时间对表格读者没有意义，反而把单元格撑得很宽
    materialsLabel: (Array.isArray(r.materials) ? r.materials : [])
      .map((m) => `${MATERIAL_LABEL[m.kind] || m.kind}:${m.name}`)
      .join('；'),
    skuLabel: SKU_LABEL[r.skuRange] || r.skuRange || '',
    priceLabel: PRICE_LABEL[r.priceRange] || r.priceRange || '',
    dropshipLabel: r.dropship ? '是' : '否',
    returnPolicyLabel: r.returnPolicy === '15days' ? '15 天无理由' : '7 天无理由',
    shipWithinLabel: SHIP_LABEL[r.shipWithin] || r.shipWithin || '',
    // 通知只导出「发没发出去」，不导出正文：正文里有商家联系方式与审核意见，
    // 而这份表格大概率会被下载到某个共享盘里
    noticeLabel: notices.length
      ? notices.map((n) => `${n.channelLabel}:${n.statusLabel}`).join(' ')
      : '无通知',
    revisionCount: Number(r.revisionCount) || 0,
    createdAt: fmtLocal(r.createdAt),
    lastRevisedAt: fmtLocal(r.lastRevisedAt),
    reviewedAt: fmtLocal(r.reviewedAt),
    withdrawnAt: fmtLocal(r.withdrawnAt),
  };
}

export function exportCsv(query = {}) {
  const status = ['reviewing', 'approved', 'rejected', 'withdrawn'].includes(query.status) ? query.status : '';
  const data = merchantRepo.listForExport({ status, limit: Number(query.limit) || 5000 });
  const catLabel = new Map(CATEGORIES.map((c) => [c.id, c.name]));
  const rows = data.items.map((r) => exportRow(r, catLabel));
  return { ...data, rows, columns: EXPORT_COLUMNS };
}
