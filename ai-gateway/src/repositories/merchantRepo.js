// 商家入驻申请仓储：只负责读写表，不做业务校验（校验在 services/merchantService.js）。
//
// 出库视图分两种，别混用：
//   - toPublic  给「商家凭编号 + 凭证自查」，手机号与邮箱打码、不含 query_key_hash；
//   - toAdmin   给运营审核台，字段完整（银行账号本来就是打码存的，这里没有更多可给）。
// 两个视图分开写而不是「拼一个全量对象再删字段」，是因为后者总会漏删一个字段。
import { getDb } from '../db/connection.js';

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

const STATUS_LABEL = {
  reviewing: '审核中',
  approved: '已通过',
  rejected: '未通过',
};

/** 打码：保留首尾，中间用 * 顶替。长度不足时整体打码，不泄露原文长度。 */
export function maskMiddle(text, head = 3, tail = 4) {
  const s = String(text || '');
  if (!s) return '';
  // tail<=0 时必须单独分支：slice(-0) 等于 slice(0) 会返回整串，
  // 之前邮件就是这么把完整地址漏出去的——打码函数的边界比它看起来危险。
  if (tail <= 0) return `${s.slice(0, head)}${'*'.repeat(Math.max(2, s.length - head))}`;
  if (s.length <= head + tail) return '*'.repeat(Math.max(4, s.length));
  return `${s.slice(0, head)}${'*'.repeat(s.length - head - tail)}${s.slice(-tail)}`;
}

/** 邮箱打码：本地部分只留首字母，域名保留（商家自己认得出，别人拼不出完整地址） */
function maskEmail(text) {
  const s = String(text || '');
  const at = s.indexOf('@');
  if (at <= 0) return maskMiddle(s, 1, 0);
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    statusLabel: STATUS_LABEL[row.status] || row.status,
    company: row.company,
    brand: row.brand,
    contact: row.contact,
    phoneMasked: maskMiddle(row.phone, 3, 4),
    emailMasked: maskEmail(row.email),
    categories: safeJson(row.categories, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewNote: row.status === 'reviewing' ? '' : row.review_note || '',
    reviewedAt: row.reviewed_at || null,
  };
}

function toAdmin(row) {
  const base = toPublic(row);
  if (!base) return null;
  return {
    ...base,
    userId: row.user_id,
    entityKind: row.entity_kind,
    creditCode: row.credit_code,
    phone: row.phone,
    email: row.email,
    brandSource: row.brand_source,
    skuRange: row.sku_range,
    priceRange: row.price_range,
    dropship: Boolean(row.dropship),
    bankAccount: row.bank_account,
    bankBranch: row.bank_branch,
    bankNoMasked: row.bank_no_masked,
    returnPolicy: row.return_policy,
    shipWithin: row.ship_within,
    note: row.note,
  };
}

/** MA + YYYYMMDD + 4 位当日序号。取当日最大值 +1，删过单也不会撞号（比 COUNT 安全）。 */
function nextApplicationId(db, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const prefix = `MA${stamp}`;
  const row = db
    .prepare('SELECT MAX(CAST(substr(id, 11) AS INTEGER)) AS n FROM merchant_applications WHERE id LIKE ?')
    .get(`${prefix}%`);
  const seq = (Number(row && row.n) || 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

/**
 * 写入一条申请。调用方保证字段已规范化、校验已通过。
 * @param {string} userId
 * @param {object} p  规范化后的申请字段（snake_case 之外的都由 service 给出）
 * @param {{submitKey:string, queryKeyHash:string}} keys
 */
export function createApplication(userId, p, { submitKey, queryKeyHash }) {
  const db = getDb();
  const id = nextApplicationId(db);
  db.prepare(`
    INSERT INTO merchant_applications
      (id, user_id, entity_kind, company, credit_code, contact, phone, email,
       brand, brand_source, categories, sku_range, price_range, dropship,
       bank_account, bank_branch, bank_no_masked, return_policy, ship_within, note,
       status, submit_key, query_key_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reviewing',?,?)
  `).run(
    id,
    userId,
    p.entityKind,
    p.company,
    p.creditCode,
    p.contact,
    p.phone,
    p.email,
    p.brand,
    p.brandSource,
    JSON.stringify(p.categories),
    p.skuRange,
    p.priceRange,
    p.dropship ? 1 : 0,
    p.bankAccount,
    p.bankBranch,
    p.bankNoMasked,
    p.returnPolicy,
    p.shipWithin,
    p.note,
    submitKey,
    queryKeyHash,
  );
  const row = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(id);
  return toPublic(row);
}

/** 幂等命中：同一用户同一 submit_key 的既有申请（返回 public 视图 + 是否命中） */
export function findBySubmitKey(userId, submitKey) {
  const row = getDb()
    .prepare('SELECT * FROM merchant_applications WHERE user_id = ? AND submit_key = ?')
    .get(userId, submitKey);
  return row ? toPublic(row) : null;
}

export function findByIdForPublic(id) {
  const row = getDb().prepare('SELECT * FROM merchant_applications WHERE id = ?').get(String(id || ''));
  return row ? toPublic(row) : null;
}

export function findById(id) {
  const row = getDb().prepare('SELECT * FROM merchant_applications WHERE id = ?').get(String(id || ''));
  return row ? toAdmin(row) : null;
}

/**
 * 凭查询凭证取申请。入参是凭证的 sha256（明文只在提交响应里出现一次，库里不留）。
 * 一处细节：凭证不对与编号不存在返回同一个 null，调用方统一回 404 —
 * 否则「这个编号存在但你没凭证」和「这个编号不存在」的差异就是一个枚举接口。
 */
export function findByQueryKeyHash(hash) {
  if (!hash) return null;
  const row = getDb().prepare('SELECT * FROM merchant_applications WHERE query_key_hash = ?').get(hash);
  return row ? toPublic(row) : null;
}

/** 运营列表：按状态筛选 + 分页，附全库状态计数（不随筛选变） */
export function listApplications({ status = '', page = 1, size = 20 } = {}) {
  const db = getDb();
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM merchant_applications ${where}`).get(...args).n;
  const safeSize = Math.min(100, Math.max(1, Number(size) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const rows = db
    .prepare(`SELECT * FROM merchant_applications ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, safeSize, (safePage - 1) * safeSize);
  return {
    items: rows.map(toAdmin),
    total,
    page: safePage,
    size: safeSize,
    status,
    stats: countByStatus(),
  };
}

export function countByStatus() {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM merchant_applications GROUP BY status')
    .all();
  const out = { reviewing: 0, approved: 0, rejected: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}
