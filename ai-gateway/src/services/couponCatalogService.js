// 券目录的运营写入路径（PUT /api/coupons/catalog）。
//
// 为什么单独成一个服务而不是在 server.js 里写几段 SQL：
//   1) 券目录是「模板」，改一个数字会立刻改变**已经发出去**的券能抵扣多少——
//      这类写入必须逐项校验，散在路由里迟早漏一项；
//   2) 影响面判断（有多少张券在用户手里）是业务规则，不该出现在路由层。
//
// 三条硬约束：
//   - 只做 upsert，不做删除。删一张券会让已发出的券实例变成孤儿（外键级联会连带
//     删掉用户卡包里的券），运营点错一下就是用户券消失。要下线一张券，把它改成
//     amount=0 或换个 title 说明"已停用"，比物理删除可追溯。
//   - 面额 / 门槛 / 类型改动会立刻作用于所有未使用实例（worth 是按目录现算的，
//     不是领取时冻结的），所以有持券人时必须显式 force=true。
//   - 整批校验通过才写：不做"部分成功"，否则运营拿到 200 却不知道哪几张没进去。
import { getDb } from '../db/connection.js';
import { listCouponCatalog } from '../repositories/userRepo.js';

const COUPON_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/;
const KINDS = new Set(['cash', 'discount']);

/** 改动这些字段会立刻改变已发出券的价值（worth 现算，不冻结） */
const VALUE_FIELDS = ['kind', 'threshold', 'amount'];

const MAX_BATCH = 50;

class CatalogError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CatalogError';
    this.status = status;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new CatalogError(`${label} 必须是整数`);
  if (n < min || n > max) throw new CatalogError(`${label} 必须在 ${min}–${max} 之间`);
  return n;
}

/**
 * 单张券模板校验。
 * discount 券的 amount 是「减免百分比」：10 = 减 10% = 9 折，与网关 worth 公式
 * `floor(商品额 * amount / 100)` 和前端 `10 - amount/10 折` 的展示口径一致。
 */
export function validateCouponTemplate(input, index = 0) {
  const label = `coupons[${index}]`;
  if (!isPlainObject(input)) throw new CatalogError(`${label} 必须是对象`);
  const id = String(input.id || input.couponId || '');
  if (!COUPON_ID_RE.test(id)) throw new CatalogError(`${label}.id 只能字母数字开头、含字母数字/下划线/短横，2–32 位`);

  const kind = String(input.kind || 'cash');
  if (!KINDS.has(kind)) throw new CatalogError(`${label}.kind 只能是 cash 或 discount`);

  const title = String(input.title == null ? '' : input.title).trim();
  if (!title) throw new CatalogError(`${label}.title 不能为空`);
  if (title.length > 30) throw new CatalogError(`${label}.title 不能超过 30 字`);

  const threshold = intIn(input.threshold ?? 0, 0, 100000, `${label}.threshold`);
  // cash：直减金额；discount：减免百分比。两者的合理区间差别很大，混在一起校验会放过
  // 「折扣券直减 300 元」这种一眼错的配置。
  const amount = kind === 'cash'
    ? intIn(input.amount, 1, 100000, `${label}.amount（满减券为直减金额）`)
    : intIn(input.amount, 1, 95, `${label}.amount（折扣券为减免百分比，10 = 9 折）`);

  const expireDays = intIn(input.expireDays ?? input.validDays ?? 30, 1, 365, `${label}.expireDays`);
  const scopeText = String(input.scopeText == null ? '全场通用' : input.scopeText).trim().slice(0, 20) || '全场通用';

  return { id, title, kind, threshold, amount, expireDays, scopeText };
}

/** 该券还有多少张在用户卡包里「未使用」（已用/已过期的不算，它们不会再被抵扣） */
function unusedHolders(db, couponId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM user_coupons WHERE coupon_id = ? AND status = 'unused'")
    .get(couponId).n;
}

/**
 * 写入券目录（按 id upsert）。
 *
 * @param {object|object[]} input 单张或多张券模板
 * @param {{force?: boolean, by?: string}} opts force=true 才允许改动有持券人的券的面额/门槛/类型
 * @returns {{coupons: object[], changes: object[]}}
 */
export function upsertCouponCatalog(input, { force = false, by = '' } = {}) {
  const batch = Array.isArray(input) ? input : [input];
  if (!batch.length) throw new CatalogError('coupons 不能为空');
  if (batch.length > MAX_BATCH) throw new CatalogError(`一次最多提交 ${MAX_BATCH} 张券`);

  // 先整批校验：一条不合法就整批拒绝，避免「200 但有一半没写进去」
  const rows = batch.map((c, i) => validateCouponTemplate(c, i));
  const dup = new Set();
  for (const r of rows) {
    if (dup.has(r.id)) throw new CatalogError(`同一次提交里 id 重复：${r.id}`);
    dup.add(r.id);
  }

  const db = getDb();
  const changes = [];
  const blocked = [];

  for (const r of rows) {
    const old = db
      .prepare('SELECT id, kind, threshold, amount, expire_days FROM coupons WHERE id = ?')
      .get(r.id);
    if (!old) {
      changes.push({ id: r.id, action: 'created', holders: 0, changedFields: [] });
      continue;
    }
    const changedFields = VALUE_FIELDS.filter((k) => String(old[k]) !== String(r[k]));
    const holders = unusedHolders(db, r.id);
    // 只挡「影响钱」的改动：改 title / scopeText / expireDays 随时可以，
    // 它们要么是话术，要么只作用于之后领取的新券（expires_at 领取时就落库了）。
    if (changedFields.length && holders > 0 && !force) {
      blocked.push({ id: r.id, holders, changedFields });
      changes.push({ id: r.id, action: 'blocked', holders, changedFields });
      continue;
    }
    changes.push({
      id: r.id,
      action: changedFields.length ? 'updated' : 'unchanged',
      holders,
      changedFields,
    });
  }

  if (blocked.length && !force) {
    const detail = blocked
      .map((b) => `${b.id}（${b.holders} 张在用户卡包里，改动 ${b.changedFields.join('/')}）`)
      .join('；');
    throw new CatalogError(
      `修改面额/门槛/类型会立刻改变已发出的券能抵扣的金额，已拒绝：${detail}。`
      + '确认影响面后带 force=true 重试，或只改 title/scopeText。',
      409,
    );
  }

  const upsert = db.prepare(`
    INSERT INTO coupons (id, title, kind, threshold, amount, expire_days, scope_text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      kind = excluded.kind,
      threshold = excluded.threshold,
      amount = excluded.amount,
      expire_days = excluded.expire_days,
      scope_text = excluded.scope_text
  `);

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      upsert.run(r.id, r.title, r.kind, r.threshold, r.amount, r.expireDays, r.scopeText);
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

  return { coupons: listCouponCatalog(), changes, by: by || '' };
}

export { CatalogError };
