// 售后单本地仓（按用户隔离）。
//
// 服务端有 aftersales 表，本地也要能落一份：
//   - 无网关（纯静态托管 / 断网）时申请售后不能直接失败，否则「已发货」的订单永远没有售后入口；
//   - 有网关时它同时是镜像——详情页刷新先读服务端，读不到时用本地这份兜底，
//     用户至少能看到「我提过这单售后」。
//
// 状态词表、原因词表与服务端 ai-gateway/src/services/aftersaleService.js 同构，
// 两边 code 不一致会导致「提交成功但详情里显示原始 code」。
const KEY_PREFIX = 'maison_aftersales::';
const MAX_RECORDS = 40;

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

export const AFTERSALE_STATUS_TEXT = {
  reviewing: '待处理',
  approved: '已同意',
  rejected: '已拒绝',
};

export const MAX_EVIDENCE = 5;
export const MAX_NOTE = 200;

const TYPE_LABEL = new Map(AFTERSALE_TYPES.map((t) => [t.code, t.label]));
const REASON_LABEL = new Map(AFTERSALE_REASONS.map((r) => [r.code, r.label]));

function key(userId) {
  return `${KEY_PREFIX}${userId || 'anonymous'}`;
}

function read(userId) {
  try {
    const arr = JSON.parse(localStorage.getItem(key(userId)) || '[]');
    return Array.isArray(arr) ? arr.filter((r) => r && r.id) : [];
  } catch {
    return [];
  }
}

const listeners = new Set();

export function onAftersalesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function write(userId, list) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(list.slice(0, MAX_RECORDS)));
  } catch {
    /* 配额写满时内存里仍有记录，刷新后才丢——不该让「提交售后」直接失败 */
  }
  // 快照遍历：订阅者回调里可能再次写入并注册新订阅者（券包那次踩过）
  [...listeners].forEach((fn) => {
    try {
      fn(userId);
    } catch {
      /* 单个订阅者异常不影响其他订阅者 */
    }
  });
}

/** 售后单号：AS + 日期 + 4 位序号，与服务端同前缀便于一眼区分来源 */
export function nextAftersaleId(userId, existing = null) {
  const list = existing || read(userId);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const taken = new Set(list.map((r) => String(r.id)));
  let seq = list.filter((r) => String(r.id).startsWith(`AS${day}`)).length + 1;
  let id = `AS${day}${String(seq).padStart(4, '0')}`;
  let guard = 0;
  while (taken.has(id) && guard < 200) {
    seq += 1;
    id = `AS${day}${String(seq).padStart(4, '0')}`;
    guard += 1;
  }
  return id;
}

/** 补上展示用文案：库里只存 code，标签由词表给，改文案不用改数据 */
export function decorate(record) {
  if (!record) return null;
  return {
    ...record,
    typeLabel: record.typeLabel || TYPE_LABEL.get(record.type) || record.type || '',
    reasonLabel: record.reasonLabel || REASON_LABEL.get(record.reason) || record.reason || '',
    statusLabel: record.statusLabel || AFTERSALE_STATUS_TEXT[record.status] || record.status || '',
  };
}

export function listAftersales(userId) {
  return read(userId).map(decorate);
}

export function listByOrder(userId, orderId) {
  const target = String(orderId || '');
  return read(userId).filter((r) => String(r.orderId) === target).map(decorate);
}

/** 新增或按 id 覆盖（服务端结果回写时用同一条路径） */
export function saveAftersale(userId, record = {}) {
  const list = read(userId);
  const item = decorate({
    id: record.id || nextAftersaleId(userId, list),
    orderId: String(record.orderId || ''),
    type: record.type || 'refund',
    reason: record.reason || 'other',
    note: String(record.note || '').slice(0, MAX_NOTE),
    evidence: Array.isArray(record.evidence) ? record.evidence.slice(0, MAX_EVIDENCE) : [],
    status: record.status || 'reviewing',
    handleNote: record.handleNote || '',
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || '',
  });
  const next = [item, ...list.filter((r) => String(r.id) !== String(item.id))];
  write(userId, next);
  return item;
}

/**
 * 与服务端记录合并：同 id 以服务端为准（状态/处理说明只有服务端会变），
 * 本地独有的保留（离线提交、还没推上去）。
 */
export function mergeAftersales(local = [], remote = []) {
  const seen = new Map();
  [...local, ...remote].forEach((r) => {
    if (!r || !r.id) return;
    const prev = seen.get(String(r.id));
    seen.set(String(r.id), prev ? { ...prev, ...r } : decorate(r));
  });
  return [...seen.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/**
 * 能不能申请售后。
 * 规则与服务端 aftersaleService 一致：只有已发货 / 已完成可申请；
 * 售后中不能再提；已取消 / 未发货的订单本来就没有可退的东西。
 * @returns {{ok:boolean, reason?:string}}
 */
export function canApply(order) {
  const status = (order && order.status) || '';
  if (status === 'shipped' || status === 'completed') return { ok: true };
  if (status === 'refunding') return { ok: false, reason: '这笔订单已有售后在处理中' };
  if (status === 'closed') return { ok: false, reason: '订单已取消，无需申请售后' };
  return { ok: false, reason: '订单发货后可申请售后' };
}

/** 校验表单：返回错误文案或 null（前端先拦一道，别把明显不对的请求发给服务端） */
export function validateAftersale({ type, reason, note, evidence } = {}) {
  if (!TYPE_LABEL.has(String(type))) return '请选择售后类型';
  if (!REASON_LABEL.has(String(reason))) return '请选择售后原因';
  if (String(note || '').trim().length > MAX_NOTE) return `问题说明不能超过 ${MAX_NOTE} 字`;
  if (Array.isArray(evidence) && evidence.length > MAX_EVIDENCE) return `最多上传 ${MAX_EVIDENCE} 张凭证`;
  return null;
}
