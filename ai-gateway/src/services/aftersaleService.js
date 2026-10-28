// 售后单服务：退款 / 退货申请的落库与查询。
//
// 边界（写在这里是因为前端也要按同一套规则显示可申请/不可申请）：
//   1) 只有「已发货 / 已完成」的订单能申请——没发货的单直接取消就行，走售后反而绕远；
//   2) 同一笔订单同时只能有一条「待处理」的申请（部分唯一索引兜底），
//      否则连点几次提交就堆出一串重复工单；
//   3) 提交后订单状态置为 refunding（售后中），但履约阶段不受影响：
//      前端画流转条看的是 shipped_at / completed_at 时间戳，不是 status。
//
// 本轮不接真实退款：没有资金流，也没有审核后台。售后单只记录「用户提了什么」，
// 处理说明写的是客服受理话术，不假装已经审核通过。
import { getDb } from '../db/connection.js';

export const AFTERSALE_TYPES = [
  { code: 'refund', label: '仅退款' },
  { code: 'return', label: '退货退款' },
];

export const AFTERSALE_REASONS = [
  { code: 'quality', label: '商品质量问题' },
  { code: 'wrong', label: '商品与描述不符' },
  { code: 'damaged', label: '运输破损 / 缺件' },
  { code: 'not_fit', label: '尺寸或款式不合适' },
  { code: 'other', label: '其他原因' },
];

export const AFTERSALE_STATUS = [
  { code: 'reviewing', label: '待处理' },
  { code: 'approved', label: '已同意' },
  { code: 'rejected', label: '已拒绝' },
];

/** 可申请售后的订单状态：已发货 / 已完成 */
export const APPLICABLE_ORDER_STATUS = ['shipped', 'completed'];

const TYPE_MAP = new Map(AFTERSALE_TYPES.map((t) => [t.code, t.label]));
const REASON_MAP = new Map(AFTERSALE_REASONS.map((r) => [r.code, r.label]));
const STATUS_MAP = new Map(AFTERSALE_STATUS.map((s) => [s.code, s.label]));

const MAX_EVIDENCE = 5;
const MAX_NOTE = 200;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** 售后单号：AS + 日期 + 6 位随机（冲突重试，别让「下单成功但售后单建不出来」） */
function makeAftersaleId(db) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const exists = db.prepare('SELECT id FROM aftersales WHERE id = ?');
  for (let i = 0; i < 8; i += 1) {
    const id = `AS${day}${String(Math.floor(Math.random() * 900000) + 100000)}`;
    if (!exists.get(id)) return id;
  }
  throw new Error('生成售后单号失败，请重试');
}

/**
 * 凭证只存文件名与大小，不存图片内容。
 * 演示环境没有对象存储，也没有审核人员去看图；存个名字足以表达「这里有一份凭证」，
 * 同时避免把几 MB 的 base64 塞进业务表（买家秀那条路已经证明这会把库撑大）。
 */
function normalizeEvidence(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, MAX_EVIDENCE).map((f) => ({
    name: String((f && f.name) || '凭证').slice(0, 60),
    size: Math.max(0, Number((f && f.size) || 0)),
  }));
}

function mapRow(row) {
  let evidence = [];
  try {
    evidence = JSON.parse(row.evidence || '[]');
  } catch {
    evidence = [];
  }
  return {
    id: row.id,
    orderId: row.order_id,
    type: row.type,
    typeLabel: TYPE_MAP.get(row.type) || row.type,
    reason: row.reason,
    reasonLabel: REASON_MAP.get(row.reason) || row.reason,
    note: row.note || '',
    evidence,
    status: row.status,
    statusLabel: STATUS_MAP.get(row.status) || row.status,
    handleNote: row.handle_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAftersales(orderId, db = getDb()) {
  return db
    .prepare('SELECT * FROM aftersales WHERE order_id = ? ORDER BY created_at DESC, id DESC')
    .all(orderId)
    .map(mapRow);
}

export function getAftersale(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM aftersales WHERE id = ?').get(id);
  return row ? mapRow(row) : null;
}

/**
 * 提交售后申请（事务）：落售后单 + 订单置「售后中」。
 *
 * 两步同生共死：只落单不改状态，详情页顶部还挂着「已完成」，用户以为申请没生效；
 * 只改状态不落单，售后入口就变成了一颗只改标签的按钮。
 */
export function createAftersale({ orderId, userId, type, reason, note = '', evidence = [] }) {
  const db = getDb();

  const typeCode = String(type || '');
  if (!TYPE_MAP.has(typeCode)) throw bad('请选择售后类型');
  const reasonCode = String(reason || '');
  if (!REASON_MAP.has(reasonCode)) throw bad('请选择售后原因');
  const text = String(note || '').trim();
  if (text.length > MAX_NOTE) throw bad(`问题说明不能超过 ${MAX_NOTE} 字`);

  db.exec('BEGIN');
  try {
    const order = db
      .prepare('SELECT id, status FROM orders WHERE id = ? AND user_id = ?')
      .get(orderId, userId);
    if (!order) throw bad('订单不存在', 404);
    if (!APPLICABLE_ORDER_STATUS.includes(order.status)) {
      throw bad(
        order.status === 'refunding'
          ? '这笔订单已有售后在处理中'
          : '当前订单状态不支持申请售后（仅已发货 / 已完成可申请）',
        409,
      );
    }
    const open = db
      .prepare("SELECT id FROM aftersales WHERE order_id = ? AND status = 'reviewing'")
      .get(orderId);
    if (open) throw bad('这笔订单已有待处理的售后申请', 409);

    const id = makeAftersaleId(db);
    db.prepare(`
      INSERT INTO aftersales (id, order_id, user_id, type, reason, note, evidence, status, handle_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewing', ?)
    `).run(
      id, orderId, userId, typeCode, reasonCode, text,
      JSON.stringify(normalizeEvidence(evidence)),
      '已收到申请，客服会在 24 小时内联系你确认处理方式',
    );
    db.prepare("UPDATE orders SET status = 'refunding' WHERE id = ?").run(orderId);
    db.exec('COMMIT');
    return getAftersale(id, db);
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
}
