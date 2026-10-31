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
  withdrawn: '已撤回',
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
export function maskEmail(text) {
  const s = String(text || '');
  const at = s.indexOf('@');
  if (at <= 0) return maskMiddle(s, 1, 0);
  return `${s.slice(0, 1)}***${s.slice(at)}`;
}

const NOTICE_STATUS_LABEL = {
  queued: '待发送',
  sent: '已发送',
  skipped: '未配置通道',
  failed: '发送失败',
};
const NOTICE_CHANNEL_LABEL = { sms: '短信', email: '邮件' };

function toNotice(row) {
  return {
    id: row.id,
    channel: row.channel,
    channelLabel: NOTICE_CHANNEL_LABEL[row.channel] || row.channel,
    targetMasked: row.target_masked,
    subject: row.subject,
    // 正文给运营核验文案用；对外（商家自查）会在 service 层剥掉
    body: row.body,
    // 渠道未配置时把原因带出去：运营看到「未配置通道」应该知道要配哪个变量
    status: row.status,
    statusLabel: NOTICE_STATUS_LABEL[row.status] || row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at || null,
  };
}

function toEvent(row) {
  return {
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    note: row.note,
    actor: row.actor,
    createdAt: row.created_at,
  };
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
    // 材料清单是「申报了什么」，不是文件本体。老库（v21 之前）默认 '[]'，
    // safeJson 再兜一层：坏 JSON 不该让整条申请查不出来
    materials: (() => {
      const list = safeJson(row.materials, []);
      return Array.isArray(list) ? list : [];
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewNote: row.status === 'reviewing' ? '' : row.review_note || '',
    reviewedAt: row.reviewed_at || null,
    // 商家自己看得到「我改过几次、什么时候改的」；撤回时间用来解释为什么这条不再进入审核
    revisionCount: Number(row.revision_count) || 0,
    lastRevisedAt: row.last_revised_at || null,
    withdrawnAt: row.withdrawn_at || null,
    // 自查页要能进入「修改资料」，得知道哪些字段当前是什么值（手机/邮箱仍是打码的，
    // 改的时候必须重新输入：回填打码串再提交等于把一份没变的资料伪装成变更）
    entityKind: row.entity_kind,
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
    reviewedBy: row.reviewed_by || '',
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
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO merchant_applications
        (id, user_id, entity_kind, company, credit_code, contact, phone, email,
         brand, brand_source, categories, sku_range, price_range, dropship,
         bank_account, bank_branch, bank_no_masked, return_policy, ship_within, note,
         materials, status, submit_key, query_key_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reviewing',?,?)
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
      JSON.stringify(p.materials || []),
      submitKey,
      queryKeyHash,
    );
    // 提交事件与申请行同事务：轨迹从第一天起就是完整的，
    // 不会出现「有申请、没提交记录」的孤儿行
    db
      .prepare(`
        INSERT INTO merchant_application_events
          (application_id, action, from_status, to_status, note, actor)
        VALUES (?, 'submitted', '', 'reviewing', '', 'merchant')
      `)
      .run(id);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
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
 * 商家自助（改资料 / 撤回）用：凭查询凭证取**运营口径**的行。
 *
 * 为什么给商家运营字段：他要改的字段（开户名、类目、时效）必须先看到当前值，
 * 否则「修改」就是个盲填表单。可见范围仍由凭证决定——凭证是提交时一次性下发的，
 * 且库里只存 sha256。真正的强 PII（完整卡号）从来没有落库，所以这里也给不出来。
 */
export function findForMerchant(id, queryKeyHash) {
  if (!queryKeyHash) return null;
  const row = getDb()
    .prepare('SELECT * FROM merchant_applications WHERE query_key_hash = ?')
    .get(queryKeyHash);
  if (!row) return null;
  if (row.id !== String(id || '').trim()) return null;
  return toAdmin(row);
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
  const items = rows.map(toAdmin);
  // 通知状态一次批量挂上去，而不是每行一条查询：一页 20 条就是 20 次往返，
  // 而且每次都是一模一样的 SQL（N+1 的典型长相）。
  const byApp = listNoticesForApplications(items.map((it) => it.id));
  for (const it of items) it.notices = byApp.get(it.id) || [];
  return {
    items,
    total,
    page: safePage,
    size: safeSize,
    status,
    stats: countByStatus(),
  };
}

/** 批量取通知（按申请分组），给列表用；单条详情用 listNotices */
export function listNoticesForApplications(ids = []) {
  const out = new Map();
  const list = (ids || []).filter(Boolean);
  if (!list.length) return out;
  const holes = list.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM merchant_notices WHERE application_id IN (${holes}) ORDER BY id ASC`)
    .all(...list);
  for (const row of rows) {
    if (!out.has(row.application_id)) out.set(row.application_id, []);
    out.get(row.application_id).push(toNotice(row));
  }
  return out;
}

export function listNotices(applicationId) {
  const rows = getDb()
    .prepare('SELECT * FROM merchant_notices WHERE application_id = ? ORDER BY id ASC')
    .all(String(applicationId || ''));
  return rows.map(toNotice);
}

export function listEvents(applicationId) {
  const rows = getDb()
    .prepare('SELECT * FROM merchant_application_events WHERE application_id = ? ORDER BY id ASC')
    .all(String(applicationId || ''));
  return rows.map(toEvent);
}

/**
 * 写审核结果。申请行、轨迹、通知队列三样同事务：
 * 只改状态不写轨迹 → 事后查不到是谁审的；
 * 改了状态却没排通知 → 商家永远等不到结果，而我们以为通知过了。
 *
 * @param {string} id
 * @param {{status:'approved'|'rejected', note:string, by:string, keyFp:string, notices:Array}} p
 */
export function reviewApplication(id, { status, note, by, keyFp, notices = [] }) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT * FROM merchant_applications WHERE id = ?').get(String(id || ''));
    if (!row) throw Object.assign(new Error('申请不存在'), { status: 404 });
    // 终态守卫放在事务里读：两个运营同时点「通过」，第二个必须看到已经变过的状态，
    // 否则会覆盖第一个人的结论，轨迹里还会留下两条互相矛盾的记录。
    if (row.status !== 'reviewing') {
      throw Object.assign(
        new Error(`这份申请已经审核过了（${STATUS_LABEL[row.status] || row.status}）`),
        { status: 409 },
      );
    }

    db
      .prepare(`
        UPDATE merchant_applications
        SET status = ?, review_note = ?, reviewed_by = ?, review_key_fp = ?,
            reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(status, note, by, keyFp, row.id);

    db
      .prepare(`
        INSERT INTO merchant_application_events
          (application_id, action, from_status, to_status, note, actor, key_fp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(row.id, status === 'approved' ? 'approved' : 'rejected', row.status, status, note, by, keyFp);

    const insertNotice = db.prepare(`
      INSERT INTO merchant_notices
        (application_id, channel, target_masked, subject, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const n of notices) {
      insertNotice.run(row.id, n.channel, n.targetMasked || '', n.subject || '', n.body || '');
    }

    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
  return findById(id);
}

/* ---------------- 商家自助：改资料 / 撤回 / 导出 ---------------- */

/** camelCase 字段 → 列名。只有这里列出的字段可被商家改（白名单，不是黑名单）。 */
const COLUMN_OF = {
  entityKind: 'entity_kind',
  company: 'company',
  creditCode: 'credit_code',
  contact: 'contact',
  phone: 'phone',
  email: 'email',
  brand: 'brand',
  brandSource: 'brand_source',
  categories: 'categories',
  materials: 'materials',
  skuRange: 'sku_range',
  priceRange: 'price_range',
  dropship: 'dropship',
  bankAccount: 'bank_account',
  bankBranch: 'bank_branch',
  bankNoMasked: 'bank_no_masked',
  returnPolicy: 'return_policy',
  shipWithin: 'ship_within',
  note: 'note',
};

/**
 * 商家修改资料。改字段、计数、写轨迹三件同事务。
 *
 * 状态守卫写在 UPDATE 的 WHERE 里（`AND status = 'reviewing'`），而不是先 SELECT 再判断：
 * 商家点「保存」和运营点「通过」可能就差几十毫秒，先查后改等于留一个覆盖窗口——
 * 审核结论已经成立，商家却能再把资料改掉，运营看到的就是他没审过的那份。
 * changes === 0 说明这份申请已经不是「审核中」，抛 409 让页面重拉。
 *
 * @param {string} id
 * @param {object} patch 只含变更字段（已规范化）
 * @param {{diff:string, actor?:string}} ctx diff 是给人读的变更摘要，写进轨迹
 */
export function updateApplication(id, patch, { diff = '', actor = 'merchant' } = {}) {
  const entries = Object.entries(patch).filter(([k]) => COLUMN_OF[k]);
  if (!entries.length) throw Object.assign(new Error('没有需要更新的内容'), { status: 400 });
  const sets = entries.map(([k]) => `${COLUMN_OF[k]} = ?`).join(', ');
  // 两个 JSON 列：categories 是 id 数组，materials 是对象数组。布尔值统一转 0/1，
  // 否则 SQLite 存 "true" 字符串，读回来 safeJson 解析不了（早期 update 就踩过这个）
  const values = entries.map(([k, v]) => (
    k === 'categories' || k === 'materials'
      ? JSON.stringify(v ?? [])
      : (typeof v === 'boolean' ? (v ? 1 : 0) : v)
  ));

  const db = getDb();
  db.exec('BEGIN');
  try {
    const r = db
      .prepare(`
        UPDATE merchant_applications
        SET ${sets},
            revision_count = revision_count + 1,
            last_revised_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ? AND status = 'reviewing'
      `)
      .run(...values, String(id || ''));
    if (!r.changes) {
      throw Object.assign(new Error('这份申请已经不在审核中了，不能修改'), { status: 409 });
    }
    db.prepare(`
      INSERT INTO merchant_application_events
        (application_id, action, from_status, to_status, note, actor)
      VALUES (?, 'revised', 'reviewing', 'reviewing', ?, ?)
    `).run(String(id || ''), diff, actor);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
  return findById(id);
}

/**
 * 商家撤回申请。撤回不是删除：运营列表里要看得到「这家自己退了」，
 * 否则一条申请凭空消失，谁也不知道是撤了还是被删了。
 * 撤回会排一条「已撤回」确认通知（模板可关），让商家手里有一份回执。
 */
export function withdrawApplication(id, { reason = '', notices = [], actor = 'merchant' } = {}) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const r = db
      .prepare(`
        UPDATE merchant_applications
        SET status = 'withdrawn', withdrawn_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND status = 'reviewing'
      `)
      .run(String(id || ''));
    if (!r.changes) {
      throw Object.assign(new Error('这份申请已经不在审核中了，不能撤回'), { status: 409 });
    }
    db.prepare(`
      INSERT INTO merchant_application_events
        (application_id, action, from_status, to_status, note, actor)
      VALUES (?, 'withdrawn', 'reviewing', 'withdrawn', ?, ?)
    `).run(String(id || ''), reason, actor);
    const insertNotice = db.prepare(`
      INSERT INTO merchant_notices (application_id, channel, target_masked, subject, body)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const n of notices) {
      insertNotice.run(String(id || ''), n.channel, n.targetMasked || '', n.subject || '', n.body || '');
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
  return findById(id);
}

/**
 * 导出用：一次取全（最多 limit 行），不做分页。
 * 导出必须自带上限：一次拉十万行会把网关内存和 Excel 一起拖死，
 * 而上限撞到时宁可明说「只导了前 N 条」，也不能悄悄截断。
 */
export function listForExport({ status = '', limit = 5000 } = {}) {
  const db = getDb();
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM merchant_applications ${where}`).get(...args).n;
  const capped = Math.min(20000, Math.max(1, Number(limit) || 5000));
  const rows = db
    .prepare(`SELECT * FROM merchant_applications ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, capped);
  const items = rows.map(toAdmin);
  const byApp = listNoticesForApplications(items.map((it) => it.id));
  for (const it of items) it.notices = byApp.get(it.id) || [];
  return { items, total, exported: items.length, truncated: total > items.length, status };
}

/* ---------------- 通知队列（投递侧） ---------------- */

export function takeQueuedNotices(limit = 20) {
  return getDb()
    .prepare("SELECT * FROM merchant_notices WHERE status = 'queued' ORDER BY id ASC LIMIT ?")
    .all(Math.min(100, Math.max(1, Number(limit) || 20)));
}

export function markNoticeSent(id) {
  getDb()
    .prepare(`
      UPDATE merchant_notices
      SET status = 'sent', attempts = attempts + 1, last_error = '', sent_at = datetime('now')
      WHERE id = ?
    `)
    .run(id);
}

/**
 * 投递失败：还有重试机会就留在 queued 等下一轮，用完就进 failed（死信）。
 * 不把「重试耗尽」也写成 queued——队列里躺着一堆永远发不出去的消息，
 * 比明确标成失败更难排查。
 */
export function markNoticeAttemptFailed(id, error, maxAttempts = 3) {
  const db = getDb();
  const row = db.prepare('SELECT attempts FROM merchant_notices WHERE id = ?').get(id);
  const attempts = (Number(row && row.attempts) || 0) + 1;
  const dead = attempts >= maxAttempts;
  db
    .prepare(`
      UPDATE merchant_notices
      SET status = ?, attempts = ?, last_error = ?
      WHERE id = ?
    `)
    .run(dead ? 'failed' : 'queued', attempts, String(error || '').slice(0, 200), id);
  return dead;
}

/** 通道没配置：既不重试也不算失败，如实标成 skipped（不是「发过了」） */
export function markNoticeSkipped(id, reason) {
  getDb()
    .prepare("UPDATE merchant_notices SET status = 'skipped', last_error = ? WHERE id = ?")
    .run(String(reason || '').slice(0, 200), id);
}

export function countNotices() {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM merchant_notices GROUP BY status')
    .all();
  const out = { queued: 0, sent: 0, skipped: 0, failed: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

export function countByStatus() {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM merchant_applications GROUP BY status')
    .all();
  const out = { reviewing: 0, approved: 0, rejected: 0, withdrawn: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}
