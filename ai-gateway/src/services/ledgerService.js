// 资金流水账本：订单维度的收款与退款记录。
//
// 为什么单独建一张表，而不是在 aftersales 上加个数：
// aftersales 上那一列 refund_amount 回答的是「这笔工单退多少」，不是「这笔订单还能退多少」。
// 没有账本，对账就得翻工单自己加——而工单之间还有驳回/重提的关系，加错一次就是钱。
//
// 边界（写清楚是为了别对它抱有不该有的期待）：
//   这是**记账**，不是支付。本站没有接任何支付渠道，账本不会真的把钱打回去。
//   同意退款时写一条 pending（待打款），运营线下转账后再点「确认已打款」转 settled。
//   刻意不做「自动调支付渠道退款」——本站没有渠道可调，写一个假的客户端等于
//   用 mock 假装发生了资金移动，比不做更误导。
//
// 记账口径：
//   - 金额一律存**正数**，方向由 kind 决定（payment 入账 / refund 出账）。
//     存负数的话，求和时符号写反就是两倍的账，而这类错误对账时看不出来。
//   - 剩余可退额度 = 实付 −（pending + settled 的退款合计）。
//     待打款的也算占掉额度：一笔已同意但还没转出去的退款，额度已经被承诺了，
//     不因为「还没打款」就允许再退一次。
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';

export const LEDGER_KINDS = [
  { code: 'payment', label: '收款' },
  { code: 'refund', label: '退款' },
];

/** 打款状态：退款专属。收款一入账就是 settled（钱已经到了） */
export const PAYOUT_STATUS = [
  { code: 'pending', label: '待打款' },
  { code: 'settled', label: '已打款' },
];

const MAX_PAGE_SIZE = 50;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function money(n) {
  const v = Number(n || 0);
  return `¥${v.toFixed(2)}`;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function makeLedgerId(db) {
  const exists = db.prepare('SELECT id FROM order_ledger WHERE id = ?');
  for (let i = 0; i < 8; i += 1) {
    const id = `LG${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
    if (!exists.get(id)) return id;
  }
  throw new Error('生成流水号失败，请重试');
}

function mapRow(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    kind: r.kind,
    kindLabel: r.kind === 'payment' ? '收款' : '退款',
    amount: round2(r.amount),
    channel: r.channel,
    status: r.status,
    statusLabel: r.kind === 'payment'
      ? '已入账'
      : (r.status === 'pending' ? '待打款' : '已打款'),
    aftersaleId: r.aftersale_id || '',
    note: r.note || '',
    createdAt: r.created_at || '',
    settledAt: r.settled_at || '',
    settledBy: r.settled_by || '',
  };
}

/**
 * 收款入账。
 *
 * 幂等：同一订单重复支付会被订单状态挡在门外（payOrder 只允许 pending → paid），
 * 但账本这层还是加一道 unique 语义的检查——订单支付路径不止一条
 * （演示模式的本地单、webhook 的支付通知都可能在将来接入）。
 */
export function recordPayment({ orderId, amount, channel = 'online', note = '' }, db = getDb()) {
  const amt = round2(amount);
  if (!(amt > 0)) return null; // 0 元订单（全额券抵扣）不入账：账上多一笔 0 没有信息量
  const exists = db
    .prepare("SELECT id FROM order_ledger WHERE order_id = ? AND kind = 'payment'")
    .get(orderId);
  if (exists) return null;

  const id = makeLedgerId(db);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    INSERT INTO order_ledger (id, order_id, kind, amount, channel, status, note, created_at, settled_at)
    VALUES (?, ?, 'payment', ?, ?, 'settled', ?, ?, ?)
  `).run(id, orderId, amt, String(channel || 'online'), String(note || ''), now, now);
  return getEntry(id, db);
}

/**
 * 退款出账（pending）。
 *
 * 由审核同意时调用，与工单状态变更在同一个事务里（调用方负责开事务）——
 * 工单显示「已同意退款 ¥100」但账上没有这条，月末对账就会对不上。
 */
export function recordRefund({ orderId, aftersaleId = '', amount, note = '' }, db = getDb()) {
  const amt = round2(amount);
  if (!(amt > 0)) return null;
  const id = makeLedgerId(db);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    INSERT INTO order_ledger (id, order_id, kind, amount, channel, status, aftersale_id, note, created_at)
    VALUES (?, ?, 'refund', ?, 'manual', 'pending', ?, ?, ?)
  `).run(id, orderId, amt, aftersaleId || null, String(note || ''), now);
  return getEntry(id, db);
}

/**
 * 确认已打款：pending → settled。
 *
 * 这一步是账本诚实性的来源。少了它，账本上的「已退款」只是「客服说要退」，
 * 而用户真正关心的是钱到没到账。持钥匙的人点这一下，等于声明钱已经转出去了。
 */
export function settleRefund({ id, by = '' }, db = getDb()) {
  const row = db.prepare('SELECT * FROM order_ledger WHERE id = ?').get(id);
  if (!row) throw bad('流水不存在', 404);
  if (row.kind !== 'refund') throw bad('只有退款流水需要确认打款');
  if (row.status !== 'pending') throw bad('这笔退款已经确认过打款了', 409);

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`
    UPDATE order_ledger SET status = 'settled', settled_at = ?, settled_by = ? WHERE id = ?
  `).run(now, String(by || '').slice(0, 40), id);
  return getEntry(id, db);
}

export function getEntry(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM order_ledger WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/** 某订单的流水（时间正序：先收款后退款，看着就是这笔交易的一生） */
export function listByOrder(orderId, db = getDb()) {
  return db
    .prepare('SELECT * FROM order_ledger WHERE order_id = ? ORDER BY created_at, id')
    .all(orderId)
    .map(mapRow);
}

/**
 * 已退款合计（含待打款）。
 * 待打款的必须算进去：同意了但还没转出去，额度已经被承诺，
 * 不算进去就会出现在同一笔订单上同意两次退款的路径。
 */
export function refundedTotal(orderId, db = getDb()) {
  const row = db
    .prepare(`
      SELECT COALESCE(SUM(amount), 0) AS n FROM order_ledger
      WHERE order_id = ? AND kind = 'refund'
    `)
    .get(orderId);
  return round2(row.n);
}

/** 实付金额 */
export function paidTotal(orderId, db = getDb()) {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM order_ledger WHERE order_id = ? AND kind = 'payment'")
    .get(orderId);
  return round2(row.n);
}

/**
 * 剩余可退额度 = 收款合计 − 退款合计（含 pending）。
 *
 * 没有收款流水时（迁移前的老订单没补上、或 0 元订单）退回到订单实付：
 * 账本缺数据不该让退款功能直接不可用，否则一次迁移事故就锁死所有售后。
 */
export function refundableBalance(orderId, fallbackPaid = 0, db = getDb()) {
  const paid = paidTotal(orderId, db);
  const base = paid > 0 ? paid : round2(fallbackPaid);
  return Math.max(0, round2(base - refundedTotal(orderId, db)));
}

/** 订单账目概览：实付 / 已退 / 待打款 / 可退 */
export function balanceOf(orderId, fallbackPaid = 0, db = getDb()) {
  const rows = listByOrder(orderId, db);
  const paid = paidTotal(orderId, db);
  const refunds = rows.filter((r) => r.kind === 'refund');
  const settled = round2(refunds.filter((r) => r.status === 'settled').reduce((n, r) => n + r.amount, 0));
  const pending = round2(refunds.filter((r) => r.status === 'pending').reduce((n, r) => n + r.amount, 0));
  const base = paid > 0 ? paid : round2(fallbackPaid);
  return {
    paid: base,
    refunded: round2(settled + pending),
    refundSettled: settled,
    refundPending: pending,
    refundable: Math.max(0, round2(base - settled - pending)),
    // 账本缺收款记录时说清楚，别让对账的人以为实付真是 0
    ledgerMissing: paid <= 0,
  };
}

/**
 * 待打款清单：运营每天要先处理的就是这些。
 * 按创建时间正序（先申请的先处理），而不是倒序——倒序会把最老那笔压在最后。
 */
export function listPending({ page = 1, size = 20 } = {}, db = getDb()) {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(size) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM order_ledger WHERE kind = 'refund' AND status = 'pending'")
    .get().n;
  const rows = db
    .prepare(`
      SELECT l.*, o.user_id AS order_user, a.id AS as_id
      FROM order_ledger l
      JOIN orders o ON o.id = l.order_id
      LEFT JOIN aftersales a ON a.id = l.aftersale_id
      WHERE l.kind = 'refund' AND l.status = 'pending'
      ORDER BY l.created_at
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset);
  return {
    total,
    page: Math.max(1, Number(page) || 1),
    size: limit,
    totalAmount: round2(db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM order_ledger WHERE kind='refund' AND status='pending'")
      .get().n),
    items: rows.map((r) => ({
      ...mapRow(r),
      orderUser: r.order_user || '',
      aftersaleId: r.as_id || '',
    })),
  };
}

/** 全库资金概览：给运营台顶部的汇总条 */
export function summary(db = getDb()) {
  const row = db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'payment' THEN amount ELSE 0 END), 0) AS in_total,
        COALESCE(SUM(CASE WHEN kind = 'refund' AND status = 'settled' THEN amount ELSE 0 END), 0) AS out_settled,
        COALESCE(SUM(CASE WHEN kind = 'refund' AND status = 'pending' THEN amount ELSE 0 END), 0) AS out_pending,
        COUNT(CASE WHEN kind = 'refund' AND status = 'pending' THEN 1 END) AS pending_count
      FROM order_ledger
    `)
    .get();
  return {
    paidTotal: round2(row.in_total),
    refundSettled: round2(row.out_settled),
    refundPending: round2(row.out_pending),
    pendingCount: Number(row.pending_count || 0),
  };
}

export { money };
