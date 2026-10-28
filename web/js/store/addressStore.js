// 收货地址簿：**服务端为准，本地缓存兜底**，同一账号换设备自动跟随。
//
// 数据流：
//   - 同步读：listAddresses / getDefaultAddress 直接读 localStorage 缓存（首屏立即渲染，不闪骨架）
//   - 异步校准：hydrateAddresses 拉服务端覆盖缓存；离线时沿用手上的缓存
//   - 写操作：先乐观写缓存（标 pending）→ 调 API → 成功后用服务端返回的清单覆盖缓存
//             离线（网关不可达）时保留 pending，下次 hydrate 自动补推
//
// 缓存 key 与结算页共用（maison_addresses_v1 = { userId: [...] }），
// 避免「账户中心加了地址、结算页看不到」。
import { getCurrentUser } from '../user.js';
import { api, isMissingEndpoint } from '../api.js';

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

function setCache(uid, list) {
  const all = readAll();
  all[uid] = list;
  return writeAll(all);
}

function cachedList(uid) {
  const list = readAll()[uid];
  return Array.isArray(list) ? list : [];
}

function sortDefaultFirst(list) {
  return list.slice().sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
}

/** 默认唯一：显式指定优先，否则保留原默认，没有就取第一条 */
function settleDefault(list, preferId = null) {
  if (!list.length) return list;
  const exists = preferId && list.some((a) => String(a.id) === String(preferId));
  const target = exists
    ? String(preferId)
    : (list.find((a) => a.isDefault) || list[0]).id;
  return list.map((a) => ({ ...a, isDefault: String(a.id) === String(target) }));
}

/** 服务端地址项 → 缓存项（口径统一；region 缺失时用 province+city 拼） */
function fromServer(a = {}) {
  const province = String(a.province || '').trim();
  const city = String(a.city || '').trim();
  return {
    id: String(a.id || ''),
    receiver: String(a.receiver || '').trim(),
    phone: String(a.phone || '').trim(),
    province,
    city,
    region: String(a.region || '').trim() || [province, city].filter(Boolean).join(' '),
    detail: String(a.detail || '').trim(),
    postal: String(a.postal || '').trim(),
    isDefault: Boolean(a.isDefault),
    pending: false,
  };
}

/** 判断一次失败是否来自「网关不可达」（而非用户输入错误） */
function unreachable(e) {
  if (!e) return true;
  // 静态托管没有 /api/addresses（404/405/501）：这不是业务拒绝，应降级落本地，
  // 否则演示站点上「新增地址」会一直报错、结算页永远提交不了。
  if (isMissingEndpoint(e)) return true;
  if (e.kind === 'network' || e.kind === 'offline' || e.kind === 'server') return true;
  return !e.status; // 拿不到 HTTP 状态码 = 没连上
}

/* ---------------- 同步读（走缓存） ---------------- */

export function listAddresses(userId) {
  const uid = currentId(userId);
  if (!uid) return [];
  return sortDefaultFirst(cachedList(uid));
}

export function getDefaultAddress(userId) {
  const list = listAddresses(userId);
  return list.find((a) => a.isDefault) || list[0] || null;
}

export function getAddress(userId, id) {
  return listAddresses(userId).find((a) => String(a.id) === String(id)) || null;
}

/** 地址是否已经同步到服务端（UI 用来提示「仅本机」） */
export function isPending(address) {
  return Boolean(address && address.pending);
}

/**
 * 把「只存在于界面上」的兜底项并入缓存。
 * 结算页离线时会垫一条演示地址，若不并入缓存，用户在这条之外新增时
 * 计算基数就少了它，表现为「新增成功但列表数量没变」。
 */
export function ensureCached(userId, address) {
  const uid = currentId(userId);
  if (!uid || !address || !address.id) return;
  const list = cachedList(uid);
  if (list.some((a) => String(a.id) === String(address.id))) return;
  setCache(uid, sortDefaultFirst(settleDefault([...list, address])));
}

/* ---------------- 异步校准（服务端为准） ---------------- */

/**
 * 把缓存里未同步成功的地址逐条补推服务端。
 * 成功与否都不抛错——补推是尽力而为，失败的下次再看。
 */
async function flushPending(uid, pendingList) {
  if (!pendingList.length) return false;
  let pushed = 0;
  for (const a of pendingList) {
    try {
      await api('/api/addresses', {
        method: 'POST',
        retries: 0,
        body: {
          userId: uid,
          receiver: a.receiver,
          phone: a.phone,
          province: a.province,
          city: a.city,
          detail: a.detail,
          postal: a.postal,
          isDefault: a.isDefault,
        },
      });
      pushed += 1;
    } catch {
      // 单条失败不影响其余；保持 pending 等下次
    }
  }
  return pushed > 0;
}

/**
 * 从服务端拉取地址簿并覆盖缓存。
 * @returns {Promise<{addresses: object[], online: boolean}>}
 */
export async function hydrateAddresses(userId) {
  const uid = currentId(userId);
  if (!uid) return { addresses: [], online: false };

  const cached = cachedList(uid);
  const pending = cached.filter((a) => a && a.pending);
  if (pending.length) await flushPending(uid, pending);

  try {
    const d = await api(`/api/addresses?userId=${encodeURIComponent(uid)}`, { retries: 0 });
    const server = (Array.isArray(d && d.addresses) ? d.addresses : []).map(fromServer);
    // 补推失败的仍留在本地，标记 pending，避免用户以为地址丢了
    const stillPending = cached.filter((a) => a && a.pending &&
      !server.some((s) => s.receiver === a.receiver && s.detail === a.detail));
    const merged = sortDefaultFirst(settleDefault([...server, ...stillPending]));
    setCache(uid, merged);
    return { addresses: merged, online: true };
  } catch {
    // 离线 / 静态演示（无后端）：沿用手上的缓存
    return { addresses: sortDefaultFirst(cached), online: false };
  }
}

/* ---------------- 校验 ---------------- */

/**
 * 校验：返回错误文案，'' 表示通过。
 * 手机号必填（配送必需），邮编可选但填了必须是 6 位数字。
 */
export function validateAddress(p = {}) {
  const receiver = String(p.receiver || '').trim();
  const phone = String(p.phone || '').trim();
  const province = String(p.province || '').trim();
  const city = String(p.city || '').trim();
  const region = String(p.region || '').trim();
  const detail = String(p.detail || '').trim();
  const postal = String(p.postal || '').trim();

  if (!receiver) return '请填写收货人姓名';
  if (receiver.length > 20) return '收货人姓名不超过 20 个字';
  if (!phone) return '请填写手机号';
  if (!/^1[3-9]\d{9}$/.test(phone)) return '手机号格式有误，请填写 11 位手机号';
  if (!province && !region) return '请选择省份';
  if (!city && !region) return '请填写城市与区县';
  if (detail.length < 4) return '详细地址至少 4 个字，便于快递送达';
  if (detail.length > 120) return '详细地址过长，请精简到 120 字以内';
  if (postal && !/^\d{6}$/.test(postal)) return '邮编为 6 位数字';
  return '';
}

function normalize(p = {}, fallback = {}) {
  const province = String(p.province ?? fallback.province ?? '').trim();
  const city = String(p.city ?? fallback.city ?? '').trim();
  return {
    id: String(p.id || fallback.id || `a_local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    receiver: String(p.receiver ?? fallback.receiver ?? '').trim(),
    phone: String(p.phone ?? fallback.phone ?? '').trim(),
    province,
    city,
    // region 与结算页口径保持一致：省份 + 城市/区县 一行显示
    region: [province, city].filter(Boolean).join(' ') || String(p.region ?? fallback.region ?? '').trim(),
    detail: String(p.detail ?? fallback.detail ?? '').trim(),
    postal: String(p.postal ?? fallback.postal ?? '').trim(),
    isDefault: Boolean(p.isDefault ?? fallback.isDefault),
    pending: false,
  };
}

/* ---------------- 写操作（异步，服务端为准） ---------------- */

/**
 * 新增或更新（带 id 即更新）。
 * 乐观写本地 → 调 API → 服务端清单覆盖缓存；离线时保留本地并标 pending。
 * @returns {Promise<{ok:boolean, error?:string, address?:object, addresses?:object[], online?:boolean}>}
 */
export async function saveAddress(userId, payload = {}) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };

  const list = cachedList(uid);
  const editingId = payload.id ? String(payload.id) : '';
  const existing = editingId ? list.find((a) => String(a.id) === editingId) : null;

  const draft = normalize(payload, existing || {});
  const error = validateAddress(draft);
  if (error) return { ok: false, error };

  if (!editingId && list.length >= MAX_PER_USER) {
    return { ok: false, error: `最多保存 ${MAX_PER_USER} 个地址` };
  }

  // 1) 乐观本地写：界面立刻有反馈，不等网络
  const nextRaw = existing
    ? list.map((a) => (String(a.id) === editingId ? { ...draft, pending: true } : a))
    : [{ ...draft, pending: true }, ...list];
  const next = sortDefaultFirst(settleDefault(nextRaw, draft.isDefault ? draft.id : null));
  setCache(uid, next);

  // 2) 同步服务端
  try {
    const d = await api('/api/addresses', {
      method: 'POST',
      retries: 0,
      body: {
        userId: uid,
        id: editingId || undefined,
        receiver: draft.receiver,
        phone: draft.phone,
        // region 必须一起发：结算页的地址表单只有一个「省/市/区」输入框，
        // 此时 province / city 都是空的，只有 region 有值。漏发 region 会让
        // 网关判定「地区为空」直接 400——纯静态模式因为 404 回落本地，看不出这个问题。
        province: draft.province,
        city: draft.city,
        region: draft.region,
        detail: draft.detail,
        postal: draft.postal,
        isDefault: draft.isDefault,
      },
    });
    const server = (Array.isArray(d && d.addresses) ? d.addresses : []).map(fromServer);
    const synced = sortDefaultFirst(settleDefault(server));
    setCache(uid, synced);
    const savedId = String((d && d.id) || draft.id);
    return {
      ok: true,
      online: true,
      address: synced.find((a) => String(a.id) === savedId) || synced[0],
      addresses: synced,
    };
  } catch (e) {
    if (!unreachable(e)) {
      // 业务错误（401/409/400…）：回滚乐观写，把服务端文案给用户
      setCache(uid, list);
      return { ok: false, error: e.message || '地址保存失败' };
    }
    // 网关不可达：保留本地，等下次 hydrate 补推
    return {
      ok: true,
      online: false,
      address: next.find((a) => String(a.id) === String(draft.id)),
      addresses: next,
    };
  }
}

/** 删除地址；网关不可达时仅删本地并保留待同步标记（下次拉取会以服务端为准） */
export async function removeAddress(userId, id) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };
  const list = cachedList(uid);
  const target = list.find((a) => String(a.id) === String(id));
  if (!target) return { ok: false, error: '地址不存在' };

  const next = sortDefaultFirst(settleDefault(list.filter((a) => String(a.id) !== String(id))));
  setCache(uid, next);

  try {
    const d = await api(
      `/api/addresses/${encodeURIComponent(id)}?userId=${encodeURIComponent(uid)}`,
      { method: 'DELETE', retries: 0 },
    );
    const server = (Array.isArray(d && d.addresses) ? d.addresses : []).map(fromServer);
    const synced = sortDefaultFirst(settleDefault(server));
    setCache(uid, synced);
    return { ok: true, online: true, addresses: synced };
  } catch (e) {
    if (!unreachable(e)) {
      setCache(uid, list); // 回滚
      return { ok: false, error: e.message || '删除失败' };
    }
    return { ok: true, online: false, addresses: next };
  }
}

/** 设为默认地址（幂等） */
export async function setDefaultAddress(userId, id) {
  const uid = currentId(userId);
  if (!uid) return { ok: false, error: '请先登录' };
  const list = cachedList(uid);
  if (!list.some((a) => String(a.id) === String(id))) return { ok: false, error: '地址不存在' };

  const next = sortDefaultFirst(settleDefault(list, id));
  setCache(uid, next);

  try {
    const d = await api(
      `/api/addresses/${encodeURIComponent(id)}/default?userId=${encodeURIComponent(uid)}`,
      { method: 'POST', retries: 0 },
    );
    const server = (Array.isArray(d && d.addresses) ? d.addresses : []).map(fromServer);
    const synced = sortDefaultFirst(settleDefault(server, id));
    setCache(uid, synced);
    return { ok: true, online: true, addresses: synced };
  } catch (e) {
    if (!unreachable(e)) {
      setCache(uid, list);
      return { ok: false, error: e.message || '设置失败' };
    }
    return { ok: true, online: false, addresses: next };
  }
}
