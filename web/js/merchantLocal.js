// 商家入驻的「本地演示模式」。
//
// 为什么要有：静态演示站（GitHub Pages / 纯前端预览）没有网关，`/api/*` 一律 404。
// 这种部署下让表单走到最后一步再报「提交失败」，等于把商家两分钟填的东西
// 全丢在屏幕上——演示的人只会记住「这站坏了」。
//
// 三条自我约束：
//   1) **绝不冒充成真提交**。记录里带 local:true，页面必须显示「本地演示数据」，
//      并且没有任何一处能把它说成「已提交给平台」。演示可以，骗人不行。
//   2) **不给假成功文案**。状态是「审核中」，但旁边写的是「本机记录，未提交平台」。
//   3) **本机也不存完整银行卡号**。浏览器配置同步会把 localStorage 带到别的设备，
//      而卡号在我们的真链路里连库都不进——本机演示没理由比生产更宽松。
//
// 数据形状与服务端 public 视图保持一致（company / phoneMasked / categories / materials …），
// 这样状态页、工作台只认一个视图，不必满篇判断「这单是本地还是真的」。

const STORE_KEY = 'maison_merchant_local_v1';
/** 最多留 12 条：演示时反复提交很容易堆几十条，超出后按时间丢最旧的 */
const MAX_RECORDS = 12;

const STATUS_LABEL = { reviewing: '审核中', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };

const maskPhone = (v) => {
  const s = String(v || '').replace(/[\s-]/g, '');
  return s.length >= 7 ? `${s.slice(0, 3)}****${s.slice(-4)}` : s;
};
const maskEmail = (v) => {
  const s = String(v || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? `${s.slice(0, 1)}***` : '';
  return `${s.slice(0, 1)}***${s.slice(at)}`;
};
const maskCard = (v) => {
  const s = String(v || '').replace(/\s/g, '');
  return s.length >= 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '';
};

function readAll() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && r.id) : [];
  } catch {
    return [];
  }
}

/** 写失败（隐私模式 / 配额满）必须让调用方知道，否则页面会「提交成功但刷新就没了」 */
function writeAll(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_RECORDS)));
    return true;
  } catch {
    return false;
  }
}

/** ML + 日期 + 4 位序号。前缀与真单号（MA…）不同，一眼能看出这是本机记录 */
function nextId(list, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const prefix = `ML${stamp}`;
  const max = list
    .filter((r) => String(r.id).startsWith(prefix))
    .reduce((n, r) => Math.max(n, Number(String(r.id).slice(-4)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

const newKey = () =>
  (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

/** 记录 → 页面视图（字段名与网关的 public 视图对齐） */
function toView(rec) {
  return {
    id: rec.id,
    status: rec.status,
    statusLabel: STATUS_LABEL[rec.status] || rec.status,
    company: rec.company,
    brand: rec.brand,
    contact: rec.contact,
    phoneMasked: rec.phoneMasked,
    emailMasked: rec.emailMasked,
    categories: Array.isArray(rec.categories) ? rec.categories : [],
    materials: Array.isArray(rec.materials) ? rec.materials : [],
    entityKind: rec.entityKind,
    brandSource: rec.brandSource,
    skuRange: rec.skuRange,
    priceRange: rec.priceRange,
    dropship: Boolean(rec.dropship),
    bankAccount: rec.bankAccount,
    bankBranch: rec.bankBranch,
    bankNoMasked: rec.bankNoMasked,
    returnPolicy: rec.returnPolicy,
    shipWithin: rec.shipWithin,
    note: rec.note,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    reviewNote: rec.status === 'reviewing' ? '' : rec.reviewNote || '',
    reviewedAt: rec.reviewedAt || null,
    revisionCount: Number(rec.revisionCount) || 0,
    lastRevisedAt: rec.lastRevisedAt || null,
    withdrawnAt: rec.withdrawnAt || null,
    notices: [],
    local: true,
  };
}

export const isLocalId = (id) => /^ML\d{12}$/.test(String(id || '').trim());

/**
 * 本机建一条申请（状态固定为审核中）。
 * @param {object} d 表单数据（原始输入，未打码）
 * @returns {{application:object, queryKey:string}}
 */
export function create(d = {}) {
  const list = readAll();
  const id = nextId(list);
  const key = newKey();
  const now = new Date().toISOString();
  const rec = {
    id,
    key,
    status: 'reviewing',
    reviewNote: '',
    createdAt: now,
    updatedAt: now,
    company: d.company || '',
    brand: d.brand || '',
    contact: d.contact || '',
    phoneMasked: maskPhone(d.phone),
    emailMasked: maskEmail(d.email),
    categories: Array.isArray(d.categories) ? d.categories : [],
    materials: (Array.isArray(d.materials) ? d.materials : []).map((m) => ({
      kind: String(m.kind || ''),
      name: String(m.name || ''),
      size: Number(m.size) || 0,
    })),
    entityKind: d.entityKind || '',
    brandSource: d.brandSource || '',
    skuRange: d.skuRange || '',
    priceRange: d.priceRange || '',
    dropship: Boolean(d.dropship),
    bankAccount: d.bankAccount || '',
    bankBranch: d.bankBranch || '',
    bankNoMasked: maskCard(d.bankNo),
    returnPolicy: d.returnPolicy || '',
    shipWithin: d.shipWithin || '',
    note: d.note || '',
    revisionCount: 0,
  };
  list.unshift(rec);
  if (!writeAll(list)) {
    throw Object.assign(new Error('这台浏览器不允许本地存储（隐私模式？），演示记录存不下来'), { code: 'storage' });
  }
  return { application: toView(rec), queryKey: key };
}

/** 凭编号 + 凭证取本机记录；凭证不匹配一律当查不到（与真接口同口径） */
export function get(id, key) {
  const rec = readAll().find((r) => r.id === String(id || '').trim());
  if (!rec || rec.key !== String(key || '').trim()) return null;
  return toView(rec);
}

/**
 * 演示用：把本机记录改成任意状态（页面上的「模拟审核通过 / 模拟驳回」）。
 * 只对本机记录生效——真网关的记录没有这个入口，审核结论只能由运营台给。
 */
export function setStatus(id, status, note = '') {
  if (!['reviewing', 'approved', 'rejected'].includes(status)) return null;
  const list = readAll();
  const i = list.findIndex((r) => r.id === String(id || '').trim());
  if (i < 0) return null;
  const now = new Date().toISOString();
  list[i] = {
    ...list[i],
    status,
    reviewNote: status === 'reviewing' ? '' : String(note || ''),
    reviewedAt: status === 'reviewing' ? null : now,
    updatedAt: now,
  };
  if (!writeAll(list)) return null;
  return toView(list[i]);
}

/** 最近一条本机记录（含凭证）：工作台没带参数时用来兜底 */
export function latest() {
  const rec = readAll()[0];
  return rec ? { application: toView(rec), key: rec.key } : null;
}

/** 本机记录列表（不含凭证，只给展示用） */
export function list() {
  return readAll().map(toView);
}

/** 仅清除演示数据（不影响草稿） */
export function clearAll() {
  try {
    localStorage.removeItem(STORE_KEY);
    return true;
  } catch {
    return false;
  }
}

export const STATUS_LABELS = STATUS_LABEL;
