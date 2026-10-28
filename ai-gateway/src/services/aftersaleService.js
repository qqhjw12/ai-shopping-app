// 售后单服务：退款 / 退货 / 换货申请的落库、审核与查询。
//
// 边界（写在这里是因为前端也要按同一套规则显示可申请/不可申请）：
//   1) 只有「已发货 / 已完成」的订单能申请——没发货的单直接取消就行，走售后反而绕远；
//   2) 同一笔订单同时只能有一条「待处理」的申请（部分唯一索引兜底），
//      否则连点几次提交就堆出一串重复工单；
//   3) 提交后订单状态置为 refunding（售后中），但履约阶段不受影响：
//      前端画流转条看的是 shipped_at / completed_at 时间戳，不是 status。
//
// 审核（本轮新增）：approved / rejected 之前只是两个词，现在它们真的会搬动订单——
//   同意退款 → 订单入终态 refunded（已退款）；
//   同意换货 → 订单回到 shipped（新货要重新发一趟，时间戳与运单号都换新的）；
//   驳回     → 订单退回 origin_status（申请那一刻的状态，单独存了一列）。
// 三步都在同一个事务里：只改售后单不改订单，详情页会「工单显示已退款、顶部还挂着售后中」。
import { getDb } from '../db/connection.js';
import { appendEvents, dbTime, lastEventMs, newShipment } from './logisticsService.js';
import { refundableBalance, recordRefund } from './ledgerService.js';
import { isObjectKey, resolveMedia } from '../storage/index.js';

export const AFTERSALE_TYPES = [
  { code: 'refund', label: '仅退款' },
  { code: 'return', label: '退货退款' },
  { code: 'exchange', label: '换货' },
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
  { code: 'rejected', label: '已驳回' },
];

export const REVIEW_ACTIONS = ['approve', 'reject'];

/**
 * 审核通过后订单落到哪。
 *
 * 退款类入终态 refunded：用户看到的应该是「钱回来了」，显示「已完成」会让人以为这笔交易成了。
 * 换货回到 shipped：新商品要重新发一趟，收货流程从头再走一遍。
 */
const APPROVE_TARGET = { refund: 'refunded', return: 'refunded', exchange: 'shipped' };

/** 只有退款类产生退款金额；换货没有，存 NULL 而不是 0（0 会被当成「全额用券抵扣」） */
const REFUNDABLE = new Set(['refund', 'return']);

/** 可申请售后的订单状态：已发货 / 已完成 */
export const APPLICABLE_ORDER_STATUS = ['shipped', 'completed'];

const TYPE_MAP = new Map(AFTERSALE_TYPES.map((t) => [t.code, t.label]));
const REASON_MAP = new Map(AFTERSALE_REASONS.map((r) => [r.code, r.label]));
const STATUS_MAP = new Map(AFTERSALE_STATUS.map((s) => [s.code, s.label]));

const MAX_EVIDENCE = 5;
const MAX_NOTE = 200;
const MAX_REVIEW_NOTE = 200;
const MAX_PAGE_SIZE = 50;

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
 * 凭证：存对象键，不存图片内容。
 *
 * 只存 {name,size} 的前一代已经暴露了问题：对账时要拿它看图，而它只有文件名。
 * 现在存 key（图片本体在对象存储里，local 或 s3 由 STORAGE_DRIVER 决定）。
 *
 * key 必须是本系统签发的合法对象键，不信客户端传来的任何字符串——
 * 否则一句话就能让工单指向别人买家秀的图片。认不出的 key 直接丢掉，
 * 宁可这份凭证没有图，也不让库里存一个指向未知位置的指针。
 */
function normalizeEvidence(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, MAX_EVIDENCE)
    .map((f) => {
      const key = f && typeof f === 'object' && isObjectKey(f.key) ? String(f.key) : '';
      return {
        name: String((f && f.name) || '凭证').slice(0, 60),
        size: Math.max(0, Number((f && f.size) || 0)),
        key,
      };
    })
    .filter((f) => f.name || f.key);
}

function money(n) {
  const v = Number(n || 0);
  return `¥${v.toFixed(2)}`;
}

/**
 * 凭证卡片：把对象键解析成可访问地址，键缺失时只留文件名。
 *
 * url 是**现签**的，不落库：s3 的预签名 URL 默认 15 分钟有效，
 * 存下来第二天点开就是一片死图。旧工单只有 {name,size} 没有 key，
 * 照旧只显示文件名——它们是升级前提交的，当时确实没上传图片。
 */
function evidenceCards(row) {
  let list = [];
  try {
    list = JSON.parse(row.evidence || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  return list.map((f) => {
    const key = (f && typeof f === 'object' && isObjectKey(f.key)) ? f.key : '';
    return {
      name: String((f && f.name) || '凭证').slice(0, 60),
      size: Math.max(0, Number((f && f.size) || 0)),
      key,
      // 无 key 时给空串而不是假 URL：前端据此显示「仅文件名」而不是一张裂图
      url: key ? resolveMedia(key) : '',
    };
  });
}

function mapRow(row) {
  const evidence = evidenceCards(row);
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
    originStatus: row.origin_status || '',
    // 退款金额对换货是 null：前端据此决定「要不要显示退款金额」这一行
    refundAmount: row.refund_amount == null ? null : Number(row.refund_amount),
    reviewNote: row.review_note || '',
    reviewer: row.reviewer || '',
    reviewedAt: row.reviewed_at || null,
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
 * 运营侧工单列表。
 *
 * 待处理的排在前面：审核台打开就该先看到要做的事；已处理的按**处理时间**倒序——
 * 操作记录要回答的是「最近处理了什么」，按提交时间排会把一早提交、下午才处理的
 * 工单混在三天前那批里。COALESCE 一并解决两种语义：待处理的 reviewed_at 是 NULL，
 * 落到 created_at；已处理的落到 reviewed_at。
 *
 * 商品摘要单独一次 IN 查询取回，不为每单再查一次明细（列表页的 N+1 与订单列表同理）。
 *
 * @param {{status?: string, reviewed?: boolean|null, page?: number, size?: number}} opts
 *        reviewed=true 只看已处理，false 只看待处理，null 不额外过滤。
 */
export function listForAdmin({ status = '', reviewed = null, page = 1, size = 20 } = {}, db = getDb()) {
  const code = String(status || '').trim();
  const filtered = STATUS_MAP.has(code);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(size) || 20));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;

  const conds = [];
  const args = [];
  if (filtered) {
    conds.push('a.status = ?');
    args.push(code);
  }
  if (typeof reviewed === 'boolean') {
    conds.push(reviewed ? "a.status <> 'reviewing'" : "a.status = 'reviewing'");
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM aftersales a ${where}`)
    .get(...args).n;

  const rows = db
    .prepare(`
      SELECT a.*, o.total_amount AS order_total, o.status AS order_status
      FROM aftersales a
      JOIN orders o ON o.id = a.order_id
      ${where}
      ORDER BY CASE a.status WHEN 'reviewing' THEN 0 ELSE 1 END,
               COALESCE(a.reviewed_at, a.created_at) DESC
      LIMIT ? OFFSET ?
    `)
    .all(...args, limit, offset);

  const ids = rows.map((r) => r.order_id);
  const byOrder = new Map();
  if (ids.length) {
    const items = db
      .prepare(`SELECT order_id, name, qty FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
    items.forEach((i) => {
      const list = byOrder.get(i.order_id) || [];
      list.push({ name: i.name, qty: i.qty });
      byOrder.set(i.order_id, list);
    });
  }

  // 总览不受筛选影响：它是「现在还有多少没处理、一共退了多少钱」，
  // 切到「已驳回」标签时数字跟着变只会让人怀疑是不是漏看了。
  const stat = db
    .prepare(`
      SELECT
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) AS reviewing,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        COALESCE(SUM(refund_amount), 0) AS refund_total,
        SUM(CASE WHEN refund_amount IS NOT NULL THEN 1 ELSE 0 END) AS refund_count
      FROM aftersales
    `)
    .get();

  // 打款状态一次 IN 查询带出：审核台的每张退款卡都要回答「钱出去了没有」，
  // 逐单再查一次就是 N+1（与订单列表、商品摘要同理）。
  const asIds = rows.map((r) => r.id);
  const payoutByAs = new Map();
  if (asIds.length) {
    const payouts = db
      .prepare(`
        SELECT aftersale_id, id, amount, status, settled_at
        FROM order_ledger
        WHERE kind = 'refund' AND aftersale_id IN (${asIds.map(() => '?').join(',')})
      `)
      .all(...asIds);
    payouts.forEach((p) => payoutByAs.set(p.aftersale_id, {
      ledgerId: p.id,
      amount: Number(p.amount),
      status: p.status,
      settledAt: p.settled_at || null,
    }));
  }

  return {
    total,
    page: Math.max(1, Number(page) || 1),
    size: limit,
    summary: {
      reviewing: Number(stat.reviewing || 0),
      approved: Number(stat.approved || 0),
      rejected: Number(stat.rejected || 0),
      refundTotal: Math.round(Number(stat.refund_total || 0) * 100) / 100,
      refundCount: Number(stat.refund_count || 0),
    },
    items: rows.map((r) => {
      const mapped = mapRow(r);
      const goods = byOrder.get(r.order_id) || [];
      return {
        ...mapped,
        orderTotal: Number(r.order_total || 0),
        orderStatus: r.order_status,
        // 只带前两件：审核台要的是「这单买的是什么」，不是完整清单
        items: goods.slice(0, 2),
        itemCount: goods.reduce((n, i) => n + Number(i.qty || 0), 0),
        payout: payoutByAs.get(r.id) || null,
      };
    }),
  };
}

/**
 * 提交售后申请（事务）：落售后单 + 订单置「售后中」。
 *
 * 两步同生共死：只落单不改状态，详情页顶部还挂着「已完成」，用户以为申请没生效；
 * 只改状态不落单，售后入口就变成了一颗只改标签的按钮。
 *
 * origin_status 在这一刻存下来：等审核驳回时订单已经是 refunding，
 * 原状态在库里查不到了（后面还有没有第二次申请，不该影响这次能不能退回去）。
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
      INSERT INTO aftersales (id, order_id, user_id, type, reason, note, evidence, status, handle_note, origin_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewing', ?, ?)
    `).run(
      id, orderId, userId, typeCode, reasonCode, text,
      JSON.stringify(normalizeEvidence(evidence)),
      '已收到申请，客服会在 24 小时内联系你确认处理方式',
      order.status,
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

/**
 * 审核售后单（事务）：改工单状态 + 搬动订单，两件事一起成或一起败。
 *
 * 三道守卫，缺一道都会出现「数据看起来对但流程是坏的」：
 *   1) 工单必须还在 reviewing——连点两次「同意」不该产生两条审核记录；
 *   2) 订单必须还在 refunding——否则说明有人绕过了工单直接改了订单状态，
 *      这时候审核就不是「处理申请」而是「覆盖别人的结果」；
 *   3) 金额必须不超过订单实付——手滑多打一个 0 就是真实损失，且没有资金流可以兜。
 *
 * @param {object} p
 * @param {string} p.id        售后单号
 * @param {'approve'|'reject'} p.action
 * @param {string} [p.note]    审核意见（驳回必填，会作为给用户看的理由）
 * @param {number} [p.refundAmount] 退款金额，不给则按订单实付
 * @param {string} [p.by]      操作人（只进日志与审计字段，不参与鉴权）
 */
export function reviewAftersale({ id, action, note = '', refundAmount = null, by = 'admin' }) {
  const db = getDb();

  const act = String(action || '').trim();
  if (!REVIEW_ACTIONS.includes(act)) throw bad('审核动作只能是 approve / reject');
  const text = String(note || '').trim();
  if (text.length > MAX_REVIEW_NOTE) throw bad(`审核意见不能超过 ${MAX_REVIEW_NOTE} 字`);
  // 驳回必须给理由：「已驳回」三个字对用户没有任何信息量，只能招来二次投诉。
  if (act === 'reject' && !text) throw bad('驳回必须填写理由');

  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT * FROM aftersales WHERE id = ?').get(id);
    if (!row) throw bad('售后单不存在', 404);
    if (row.status !== 'reviewing') {
      throw bad(`这笔售后已经处理过了（${STATUS_MAP.get(row.status) || row.status}）`, 409);
    }

    const order = db
      .prepare('SELECT id, status, total_amount FROM orders WHERE id = ?')
      .get(row.order_id);
    if (!order) throw bad('关联订单不存在', 404);
    if (order.status !== 'refunding') {
      throw bad('订单当前不在售后中，无法审核', 409);
    }

    const typeLabel = TYPE_MAP.get(row.type) || row.type;
    let handleNote = '';
    let amount = null;
    const now = dbTime(new Date());

    if (act === 'reject') {
      // 退回申请那一刻的状态。origin_status 为空是迁移前就存在的老工单，
      // 迁移已按 completed_at 补过，这里再兜一层 completed（宁可退回终态，也别退回「待发货」）。
      const back = row.origin_status || 'completed';
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(back, order.id);
      handleNote = `很抱歉，您的${typeLabel}申请未通过：${text}`;
    } else {
      const target = APPROVE_TARGET[row.type] || 'refunded';
      if (target === 'shipped') {
        // 换货：新货重新发一趟。运单号换成新的，已签收的时间清掉——
        // 留着旧的会让详情页显示「已签收」，而新货其实刚从仓库出来。
        // 时间线是**追加**而不是改写：上一趟的物流是既成事实，擦掉它等于篡改历史。
        // 新事件的下限是「最后一条事件 + 1 分钟」：同日换货时若简单用「现在」，
        // 揽收可能落在原签收之前（时间线倒流），同一秒还会撞去重唯一索引。
        const base = Math.max(Date.now(), (lastEventMs(db, order.id) || 0) + 60000);
        const shipment = newShipment(new Date(base));
        db
          .prepare(`
            UPDATE orders
            SET status = ?, shipped_at = ?, completed_at = NULL,
                logistics_company = ?, tracking_no = ?
            WHERE id = ?
          `)
          .run('shipped', now, shipment.company, shipment.trackingNo, order.id);
        appendEvents(db, order.id, shipment.events);
        handleNote = `已同意换货，新商品已通过${shipment.company}发出（${shipment.trackingNo}），请注意查收`;
      } else {
        const paid = Number(order.total_amount || 0);
        const raw = refundAmount == null || refundAmount === '' ? paid : Number(refundAmount);
        if (!Number.isFinite(raw) || raw < 0) throw bad('退款金额不合法');
        // 上限是「剩余可退额度」而不是实付：退款后订单进 refunded 终态，目前确实
        // 到不了「同一单退两次」的路径，但换货同意会让订单回到 shipped 从而允许
        // 再申请一次——那时按实付夹就能退两遍。额度从账本算，不靠「终态挡着」这种
        // 依赖别处不改动才能成立的推理。
        const room = refundableBalance(order.id, paid, db);
        amount = Math.round(Math.min(raw, room) * 100) / 100;
        if (amount <= 0 && raw > 0) throw bad('这笔订单的可退额度已经用完了', 409);
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', order.id);
        // 退款流水与工单、订单同事务：账上没有这条，月末对账就会平白少一笔支出
        recordRefund({
          orderId: order.id,
          aftersaleId: id,
          amount,
          note: `${typeLabel}退款`,
        }, db);
        handleNote = `已同意${typeLabel}，退款 ${money(amount)} 待财务打款，到账后订单会更新为已处理`;
      }
    }

    db
      .prepare(`
        UPDATE aftersales
        SET status = ?, handle_note = ?, review_note = ?, reviewer = ?,
            reviewed_at = ?, refund_amount = ?, updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(
        act === 'approve' ? 'approved' : 'rejected',
        handleNote,
        text,
        String(by || 'admin').slice(0, 40),
        now,
        amount,
        id,
      );

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
