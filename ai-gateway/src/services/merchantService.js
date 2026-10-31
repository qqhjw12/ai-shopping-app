// 商家入驻申请：校验 + 规范化 + 幂等提交 + 凭证查询。
//
// 校验一律在服务端做一遍（前端那遍只是为了少一次往返，不能当防线）。
// 错误按字段返回 { code: message }，前端据此把提示挂到对应输入框并跳到对应步骤——
// 只回一句「参数有误」的表单，等于让商家自己从头再找一遍哪个格子填错了。
import { createHash, createHmac } from 'node:crypto';
import { CATEGORIES } from '../data/catalog.js';
import { getSecret } from '../auth/keys.js';
import * as merchantRepo from '../repositories/merchantRepo.js';

export const ENTITY_KINDS = ['brand', 'factory', 'studio', 'food', 'other'];
export const BRAND_SOURCES = ['owned', 'exclusive', 'authorized'];
export const SKU_RANGES = ['lt50', '50-200', '200-1000', 'gt1000'];
export const PRICE_RANGES = ['lt100', '100-500', '500-2000', 'gt2000'];
// 平台对退货政策有底线：只接受 7 天或 15 天无理由，没有「不支持」这个选项。
// 与其让商家填完再被驳回，不如在枚举里就不给这个值。
export const RETURN_POLICIES = ['7days', '15days'];
export const SHIP_WITHIN = ['24h', '48h', '72h'];

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

const clamp = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const bad = (fields) => Object.assign(new Error('请检查填写内容'), { status: 400, fields });

/** 统一社会信用代码：18 位，字符集不含 I / O / S / V / Z（国标规定，避免与数字混淆） */
const CREDIT_RE = /^[0-9A-HJ-NPQRTUWXY]{18}$/;

/**
 * 字段规范化 + 校验。返回可直接入库的对象，或抛带 fields 的 400。
 * 注意银行账号：这里把完整卡号压成「前 4 + 后 4」，完整号码不进入任何后续环节
 * （不入库、不进日志、不进返回值）。理由见 schema.js 迁移 17 的注释。
 */
export function normalize(payload = {}) {
  const fields = {};

  const entityKind = String(payload.entityKind || '').trim();
  if (!ENTITY_KINDS.includes(entityKind)) fields.entityKind = '请选择商家主体类型';

  const company = clamp(payload.company, 60);
  if (company.length < 2) fields.company = '请填写营业执照上的主体名称（至少 2 个字）';

  const creditCode = clamp(payload.creditCode, 32).toUpperCase().replace(/\s+/g, '');
  if (!CREDIT_RE.test(creditCode)) fields.creditCode = '统一社会信用代码为 18 位（数字与大写字母）';

  const contact = clamp(payload.contact, 20);
  if (contact.length < 2) fields.contact = '请填写联系人姓名';

  const phone = clamp(payload.phone, 20).replace(/[\s-]/g, '');
  if (!/^1[3-9]\d{9}$/.test(phone)) fields.phone = '请填写 11 位手机号';

  const email = clamp(payload.email, 80);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.email = '邮箱格式不正确';

  const brand = clamp(payload.brand, 40);
  if (brand.length < 1) fields.brand = '请填写品牌名称';

  const brandSource = String(payload.brandSource || '').trim();
  if (!BRAND_SOURCES.includes(brandSource)) fields.brandSource = '请选择品牌来源';

  // 主营类目：1–3 个，必须是平台真实存在的一级类目（拒绝前端传上来的野字符串）
  const rawCats = Array.isArray(payload.categories) ? payload.categories : [];
  const categories = [...new Set(rawCats.map((c) => String(c || '').trim()))].filter((c) => CATEGORY_IDS.has(c));
  if (!categories.length) fields.categories = '请至少选择一个主营类目';
  else if (categories.length > 3) fields.categories = '主营类目最多选 3 个';

  const skuRange = String(payload.skuRange || '').trim();
  if (!SKU_RANGES.includes(skuRange)) fields.skuRange = '请选择预估 SKU 数量';

  const priceRange = String(payload.priceRange || '').trim();
  if (!PRICE_RANGES.includes(priceRange)) fields.priceRange = '请选择主力价格带';

  const bankAccount = clamp(payload.bankAccount, 60);
  if (bankAccount.length < 2) fields.bankAccount = '请填写开户名（与营业执照一致）';

  const bankBranch = clamp(payload.bankBranch, 60);

  const bankNo = clamp(payload.bankNo, 32).replace(/\s/g, '');
  if (!/^\d{12,24}$/.test(bankNo)) fields.bankNo = '银行卡号为 12–24 位数字';

  const returnPolicy = String(payload.returnPolicy || '').trim();
  if (!RETURN_POLICIES.includes(returnPolicy)) fields.returnPolicy = '请选择退货政策（平台要求至少 7 天无理由）';

  const shipWithin = String(payload.shipWithin || '').trim();
  if (!SHIP_WITHIN.includes(shipWithin)) fields.shipWithin = '请选择发货时效';

  const note = clamp(payload.note, 200);

  if (Object.keys(fields).length) throw bad(fields);

  return {
    entityKind,
    company,
    creditCode,
    contact,
    phone,
    email,
    brand,
    brandSource,
    categories,
    skuRange,
    priceRange,
    bankAccount,
    bankBranch,
    // 只留前 4 后 4；中间的位数用 * 顶替，长度也不暴露
    bankNoMasked: `${bankNo.slice(0, 4)}${'*'.repeat(Math.max(4, bankNo.length - 8))}${bankNo.slice(-4)}`,
    returnPolicy,
    shipWithin,
    note,
  };
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
  return hit.id === String(id || '').trim() ? hit : null;
}

export function listForAdmin(query = {}) {
  const status = ['reviewing', 'approved', 'rejected'].includes(query.status) ? query.status : '';
  return merchantRepo.listApplications({
    status,
    page: Number(query.page) || 1,
    size: Number(query.size) || 20,
  });
}

export function stats() {
  return merchantRepo.countByStatus();
}
