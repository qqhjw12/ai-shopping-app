// 收货地址簿：按用户隔离存 localStorage。
//
// 为什么复用 checkoutStore 的 key 与结构（maison_addresses_v1 = { userId: [...] }）：
// 结算页的离线地址也写在这里，共用一份才不会出现「个人中心加了地址、结算页看不到」。
// 差异只在读取方式——账户中心读「原始清单」（空就是空，不塞演示地址），
// 结算页读 mergeAddresses（为空时兜底演示地址，保证演示链路不塌）。
import { getCurrentUser } from '../user.js';

const BOOK_KEY = 'maison_addresses_v1';
const MAX_PER_USER = 20;

/** 省级行政区（够用即可，含港澳台） */
export const PROVINCES = [
  '北京市', '天津市', '上海市', '重庆市',
  '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省',
  '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省',
  '河南省', '湖北省', '湖南省', '广东省', '海南省',
  '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省',
  '内蒙古自治区', '广西壮族自治区', '西藏自治区', '宁夏回族自治区', '新疆维吾尔自治区',
  '香港特别行政区', '澳门特别行政区', '台湾省',
];

function readAll() {
  try {
    const raw = localStorage.getItem(BOOK_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false; // 隐私模式 / 配额满
  }
}

/** 当前用户 ID：地址必须挂在账户上，未登录直接拒绝（避免写出一份无主数据） */
function currentId(userId) {
  return String(userId || (getCurrentUser() || {}).id || '');
}

export function listAddresses(userId) {
  const uid = currentId(userId);
  if (!uid) return [];
  const list = readAll()[uid];
  if (!Array.isArray(list)) return [];
  // 默认地址永远排最前：列表顶部就是结算会用到的那个
  return list.slice().sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
}

export function getDefaultAddress(userId) {
  const list = listAddresses(userId);
  return list.find((a) => a.isDefault) || list[0] || null;
}

export function getAddress(userId, id) {
  return listAddresses(userId).find((a) => String(a.id) === String(id)) || null;
}

/**
 * 校验：返回错误文案，'' 表示通过。
 * 手机号必填（配送必需），邮编可选但填了必须是 6 位数字。
 */
export function validateAddress(p = {}) {
  const receiver = String(p.receiver || '').trim();
  const phone = String(p.phone || '').trim();
  const province = String(p.province || '').trim();
  const city = String(p.city || '').trim();
  const detail = String(p.detail || '').trim();
  const postal = String(p.postal || '').trim();

  if (!receiver) return '请填写收货人姓名';
  if (receiver.length > 20) return '收货人姓名不超过 20 个字';
  if (!phone) return '请填写手机号';
  if (!/^1[3-9]\d{9}$/.test(phone)) return '手机号格式有误，请填写 11 位手机号';
  if (!province) return '请选择省份';
  if (!city) return '请填写城市与区县';
  if (detail.length < 4) return '详细地址至少 4 个字，便于快递送达';
  if (detail.length > 120) return '详细地址过长，请精简到 120 字以内';
  if (postal && !/^\d{6}$/.test(postal)) return '邮编为 6 位数字';
  return '';
}

function normalize(p = {}, fallback = {}) {
  const province = String(p.province ?? fallback.province ?? '').trim();
  const city = String(p.city ?? fallback.city ?? '').trim();
  return {
    id: String(p.id || fallback.id || `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    receiver: String(p.receiver ?? fallback.receiver ?? '').trim(),
    phone: String(p.phone ?? fallback.phone ?? '').trim(),
    province,
    city,
    // region 与结算页口径保持一致：省份 + 城市/区县 一行显示
    region: [province, city].filter(Boolean).join(' '),
    detail: String(p.detail ?? fallback.detail ?? '').trim(),
    postal: String(p.postal ?? fallback.postal ?? '').trim(),
    isDefault: Boolean(p.isDefault ?? fallback.isDefault),
    local: true,
  };
}

/**
 * 新增或更新（带 id 即更新）。
 * @returns {{ok:boolean, error?:string, address?:object, addresses?:object[]}}
 */
export function saveAddress(userId, payload = {}) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };

  const all = readAll();
  const list = Array.isArray(all[uid]) ? all[uid].slice() : [];
  const editingId = payload.id ? String(payload.id) : '';
  const existing = editingId ? list.find((a) => String(a.id) === editingId) : null;

  const draft = normalize(payload, existing || {});
  const error = validateAddress(draft);
  if (error) return { ok: false, error };

  if (!editingId && list.length >= MAX_PER_USER) {
    return { ok: false, error: `最多保存 ${MAX_PER_USER} 个地址` };
  }

  let next;
  if (existing) {
    next = list.map((a) => (String(a.id) === editingId ? draft : a));
  } else {
    next = [draft, ...list];
  }

  // 默认地址唯一：显式设默认、或这是第一条地址，都把默认权交给它
  const shouldDefault = draft.isDefault || next.length === 1;
  if (shouldDefault) next = next.map((a) => ({ ...a, isDefault: String(a.id) === String(draft.id) }));
  // 兜底：任何时刻都要有一个默认地址，否则结算页会「选不中」
  else if (!next.some((a) => a.isDefault) && next.length) next[0] = { ...next[0], isDefault: true };

  all[uid] = next;
  if (!writeAll(all)) return { ok: false, error: '浏览器存储不可用，地址未能保存' };
  return { ok: true, address: next.find((a) => String(a.id) === String(draft.id)), addresses: sortDefaultFirst(next) };
}

export function removeAddress(userId, id) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };
  const all = readAll();
  const list = Array.isArray(all[uid]) ? all[uid].slice() : [];
  const target = list.find((a) => String(a.id) === String(id));
  if (!target) return { ok: false, error: '地址不存在' };
  let next = list.filter((a) => String(a.id) !== String(id));
  // 删掉的是默认地址 → 由剩下的第一条接任，不让默认位空着
  if (target.isDefault && next.length) next[0] = { ...next[0], isDefault: true };
  all[uid] = next;
  if (!writeAll(all)) return { ok: false, error: '浏览器存储不可用，删除未生效' };
  return { ok: true, addresses: sortDefaultFirst(next) };
}

export function setDefaultAddress(userId, id) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };
  const all = readAll();
  const list = Array.isArray(all[uid]) ? all[uid].slice() : [];
  if (!list.some((a) => String(a.id) === String(id))) return { ok: false, error: '地址不存在' };
  const next = list.map((a) => ({ ...a, isDefault: String(a.id) === String(id) }));
  all[uid] = next;
  if (!writeAll(all)) return { ok: false, error: '浏览器存储不可用，设置未生效' };
  return { ok: true, addresses: sortDefaultFirst(next) };
}

function sortDefaultFirst(list) {
  return list.slice().sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
}
