// 物流事件服务：把「订单发货」拆成一条可展示的事件流水。
//
// 为什么不再只存 logistics_company / tracking_no 两个字段：
// 详情页要画时间线（已揽收 / 运输中 / 派送中 / 已签收），而「一个运单号 + 一句描述」
// 是最新状态快照，画不出过程。事件一行一条，前端的渲染就是纯展示，不需要自己编时间。
//
// 谁写事件：真实系统由快递公司的推送（webhook）写，本演示由「模拟发货 / 模拟完成」写。
// 事件只追加不修改——物流是既成事实，改历史会让时间线自相矛盾。
//
// ⚠️ 阶段词表 STAGES 必须与前端 web/js/store/logistics.js 的同名常量保持一致：
//    两侧用不同 code，前端就认不出哪些节点走完了（与 shippingFeeOf 同理，属于同一类
//    刻意重复的实现，因为服务端要能独立跑、前端要能离线渲染）。
import { getDb } from '../db/connection.js';

/** 四个节点：前两个在发货时补，后两个在签收时补 */
export const STAGES = [
  { code: 'picked_up', title: '已揽收' },
  { code: 'in_transit', title: '运输中' },
  { code: 'out_for_delivery', title: '派送中' },
  { code: 'signed', title: '已签收' },
];

export const STAGE_CODES = STAGES.map((s) => s.code);

const COMPANIES = [
  { id: 'sf', name: '顺丰速运', prefix: 'SF' },
  { id: 'jd', name: '京东物流', prefix: 'JD' },
  { id: 'zto', name: '中通快递', prefix: 'ZT' },
];

/** mock 运单号：前缀 + 13 位数字（时间片 + 随机），够长到看起来像真的，且同单不会撞 */
function makeTrackingNo(prefix) {
  const digits = String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 100000)).padStart(5, '0');
  return `${prefix}${digits}`;
}

function pickCompany() {
  return COMPANIES[Math.floor(Math.random() * COMPANIES.length)];
}

/** DB 里统一用 'YYYY-MM-DD HH:mm:ss'（UTC，与 SQLite datetime('now') 同格式） */
export function dbTime(date) {
  return new Date(date).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 转成库里的时间格式，且**对已格式化的输入保持不变**（幂等）。
 *
 * 幂等不是洁癖：dbTime("2026-10-28 17:43:22") 里的这串没有时区标记，
 * new Date() 会按**进程本地时区**解析，UTC+8 的机器上再转回 UTC 就凭空少了 8 小时。
 * 同一个字段被格式化两次，表里就会出现两种时间口径——时间线看起来是通的，
 * 实际每条都差一个时区。这类问题在开发机上（TZ 同为 UTC）完全看不出来。
 */
export function toDbTime(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
  return dbTime(value || new Date());
}

/** 'YYYY-MM-DD HH:mm:ss'(UTC) → 毫秒。解析不了返回 NaN，调用方据此判非法 */
export function parseDbTime(value) {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return Number.NaN;
  return Date.parse(`${s.slice(0, 10)}T${s.slice(11)}Z`);
}

/**
 * 生成发货事件。
 *
 * 时间戳刻意往前挪 1 分钟：一次「模拟发货」同时产生「已揽收」和「运输中」两条，
 * 两条同秒会让人以为是重复记录；放到未来又会出现「14:32 已揽收，14:32 运输中」这种
 * 自相矛盾的时间线。往前错开一分钟，两条都在过去、顺序单调。
 */
export function eventsOnShip(company, at = new Date()) {
  const t = new Date(at).getTime();
  return [
    {
      code: 'picked_up',
      title: '已揽收',
      detail: `${company} 已揽收，发往始发分拨中心`,
      happenedAt: dbTime(t - 60000),
    },
    {
      code: 'in_transit',
      title: '运输中',
      detail: '包裹已离开始发分拨中心，正在运往收货城市',
      happenedAt: dbTime(t),
    },
  ];
}

/** 生成签收事件（派送中 + 已签收），同样错开一分钟 */
export function eventsOnDeliver(at = new Date()) {
  const t = new Date(at).getTime();
  return [
    {
      code: 'out_for_delivery',
      title: '派送中',
      detail: '快件已到达收货城市网点，快递员正在派送',
      happenedAt: dbTime(t - 60000),
    },
    {
      code: 'signed',
      title: '已签收',
      detail: '包裹已签收，签收人：本人',
      happenedAt: dbTime(t),
    },
  ];
}

/** 随机挑一家快递并给出运单号（发货时调用一次，之后不再变） */
export function newShipment(at = new Date()) {
  const company = pickCompany();
  return {
    company: company.name,
    trackingNo: makeTrackingNo(company.prefix),
    events: eventsOnShip(company.name, at),
  };
}

/** 追加事件（seq 接在该单已有事件之后） */
export function appendEvents(db, orderId, events) {
  const start = db
    .prepare('SELECT COALESCE(MAX(seq), -1) AS last FROM order_logistics_events WHERE order_id = ?')
    .get(orderId).last;
  // OR IGNORE：(order_id, code, happened_at) 唯一索引兜底。内部推进天然不重复，
  // 但万一并发/时钟抖动撞上，跳过一条噪音远好过让整个审核事务 500。
  const ins = db.prepare(`
    INSERT OR IGNORE INTO order_logistics_events (order_id, code, title, detail, happened_at, seq)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  events.forEach((e, i) => ins.run(orderId, e.code, e.title, e.detail || '', e.happenedAt, start + 1 + i));
}

/** 该单最后一条事件的时间（毫秒）。没有事件返回 null。 */
export function lastEventMs(db, orderId) {
  const row = db
    .prepare('SELECT MAX(happened_at) AS last FROM order_logistics_events WHERE order_id = ?')
    .get(orderId);
  if (!row || !row.last) return null;
  const ms = parseDbTime(row.last);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 写入外部推送来的物流事件（webhook 专用）。
 *
 * 与 appendEvents 的区别是**去重**：appendEvents 服务于内部推进（发货/签收各写一批，
 * 天然不重复），这一条服务于外部推送——快递公司会重推，网络抖动时同一条能到三次。
 *
 * 去重交给 (order_id, code, happened_at) 唯一索引 + INSERT OR IGNORE，
 * 而不是「先 SELECT 查一遍再 INSERT」：那两步之间有窗口，并发下照样插重。
 * 唯一索引是数据库层面唯一能保证不发生的事情。
 *
 * seq 仍要递增，否则时间线排序会乱：忽略的事件也要拿到 seq，
 * 所以先取当前 max 再按顺序分配（忽略的序号空出来不影响排序）。
 *
 * @returns {{inserted: number, deduped: number, hasSigned: boolean}}
 */
export function ingestEvents(db, orderId, events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { inserted: 0, deduped: 0, hasSigned: false };

  let seq = db
    .prepare('SELECT COALESCE(MAX(seq), -1) AS last FROM order_logistics_events WHERE order_id = ?')
    .get(orderId).last;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO order_logistics_events (order_id, code, title, detail, happened_at, seq)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let attempted = 0;
  let inserted = 0;
  let hasSigned = false;
  for (const e of list) {
    const code = String((e && e.code) || '').trim();
    if (!STAGE_CODES.includes(code)) continue; // 不认识的阶段直接丢，不写脏数据
    const at = toDbTime(e.happenedAt);
    seq += 1;
    attempted += 1;
    const r = ins.run(orderId, code, e.title || stageTitle(code), e.detail || '', at, seq);
    if (r.changes) inserted += 1;
    if (code === 'signed') hasSigned = true;
  }
  return { inserted, deduped: attempted - inserted, hasSigned };
}

function stageTitle(code) {
  return (STAGES.find((s) => s.code === code) || { title: code }).title;
}

export function listEvents(db, orderId) {
  return db
    .prepare(`
      SELECT code, title, detail, happened_at FROM order_logistics_events
      WHERE order_id = ? ORDER BY seq ASC, id ASC
    `)
    .all(orderId)
    .map((r) => ({ code: r.code, title: r.title, detail: r.detail, at: r.happened_at }));
}

/**
 * 给历史订单补时间线（幂等）。
 *
 * 演示库里那 7 笔订单在本次迁移之前就有快递单号，但没有任何事件行——
 * 不补的话「已发货」的订单打开详情是一条空白时间线，看起来像功能坏了。
 * 这里按 created_at 推一个合理的过去时间，且只在**该单没有任何事件**时才写，
 * 重复启动不会重复插入。
 */
export function backfillMissing(db = getDb()) {
  const rows = db.prepare(`
    SELECT id, status, created_at, logistics_company, tracking_no
    FROM orders
    WHERE status IN ('shipped', 'completed')
      AND logistics_company IS NOT NULL AND logistics_company <> ''
  `).all();
  if (!rows.length) return 0;

  const hasEvent = db.prepare('SELECT 1 AS hit FROM order_logistics_events WHERE order_id = ? LIMIT 1');
  const setStamps = db.prepare(`
    UPDATE orders SET
      shipped_at   = COALESCE(shipped_at, datetime(created_at, '+2 hours')),
      completed_at = CASE WHEN status = 'completed'
                          THEN COALESCE(completed_at, datetime(created_at, '+2 days'))
                          ELSE completed_at END
    WHERE id = ?
  `);

  let filled = 0;
  for (const r of rows) {
    setStamps.run(r.id);
    if (hasEvent.get(r.id)) continue;
    const shipAt = new Date(`${r.created_at.replace(' ', 'T')}Z`);
    // 补出来的时间必须是过去：下单当天就发货的历史订单，created_at + 2h 可能还没到，
    // 时间线里出现未来时间会让人以为是 bug。夹到「一分钟前」。
    const cap = Date.now() - 60000;
    const shipTime = Math.min(shipAt.getTime() + 2 * 3600 * 1000, cap);
    appendEvents(db, r.id, eventsOnShip(r.logistics_company, new Date(shipTime)));
    if (r.status === 'completed') {
      const doneTime = Math.min(shipAt.getTime() + 2 * 86400 * 1000, cap);
      appendEvents(db, r.id, eventsOnDeliver(new Date(Math.max(doneTime, shipTime + 60000))));
    }
    filled += 1;
  }
  return filled;
}
