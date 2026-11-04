// 秒杀场次：运营后台唯一的写入方，首页秒杀区唯一的读取方。
//
// 为什么配置住在 localStorage 而不是数据库：
// 本轮的数据纪律是「mock + localStorage」，秒杀是一场**可配置的演示场次**，
// 不是交易真相源——真正需要服务端背书的是「这一单按什么价成交」，
// 那件事仍然归订单链路管。所以这里把「配置」与「成交」分开：
//   配置（本文件）    场次标题、起止时间、参与商品、秒杀价、库存，
//                    运营在 #/admin/flash 里改，前台刷新即生效；
//   成交（state.js）  用户点「立即抢购」就是一个普通的购物袋条目，
//                    只是价格取的是本场秒杀价，后续走既有的结算与订单链路。
//
// 将来要接真实后端时，只需要把 readState / writeState 换成 GET / PUT
// /api/flash-sale，上层的渲染、门禁、倒计时全都不用动——这是刻意留的缝。

const STATE_KEY = 'maison_flash_sale_v1';
const OPS_KEY_SLOT = 'maison_flash_ops_key';

/** 默认场次时长。2 小时是电商秒杀最常用的时长：足够覆盖一个流量峰，又不至于长到失去紧迫感 */
export const SLOT_MINUTES = 120;

/** 一场最多挂几件。再多就不是「秒杀」而是「打折频道」，横向轨道也放不下 */
export const MAX_ITEMS = 8;

/** 秒杀价相对原价的折扣区间：低于 8 折才有抢的感觉，高于 4 折平台要亏 */
const DISCOUNT_MIN = 0.55;
const DISCOUNT_MAX = 0.8;

/* ---------------- 存储 ---------------- */

const listeners = new Set();

function readState() {
  try {
    const d = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    /* 配额满 / 隐私模式：本次会话内内存里的对象仍是新的，只是刷不开下次 */
  }
  notify();
}

export function onFlashChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  // 快照遍历：回调里可能再次订阅（例如刷新后重建计时器），直接遍历 Set 会扩散
  [...listeners].forEach((fn) => {
    try {
      fn();
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  });
}

// 跨标签页同步：后台改完场次，前台那个标签页不必手动刷新就能看到新价
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key === STATE_KEY) notify();
  });
}

/* ---------------- 归一化 ----------------
   凡是 localStorage 里的东西都当作不可信输入：用户可以在 DevTools 里把它改成
   负数价格或者 9999 件库存。这里逐字段夹逼，坏数据一律丢弃而不是让页面崩掉。 */

const clampInt = (v, min, max, def = min) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};

function normalizeItem(raw) {
  if (!raw || raw.productId == null || raw.productId === '') return null;
  const stock = clampInt(raw.stock, 0, 9999, 0);
  return {
    productId: String(raw.productId),
    price: clampInt(raw.price, 1, 999999, 1),
    stock,
    // 已抢数量不能超过库存：超了进度条会画出 120%，后台看一眼就知道数据坏了
    sold: clampInt(raw.sold, 0, stock, 0),
    limit: clampInt(raw.limit, 1, 9, 1),
  };
}

function normalizeSale(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const startAt = Number(raw.startAt) || 0;
  const endAt = Number(raw.endAt) || 0;
  // 没有合法时间窗的场次无法倒计时，直接判废——让前台回到「无场次」而不是显示 00:00:00
  if (!startAt || !endAt || endAt <= startAt) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS);
  if (!items.length) return null;
  return {
    id: String(raw.id || `fs-${startAt}`),
    title: String(raw.title || '限时秒杀').slice(0, 24),
    protocol: String(raw.protocol || 'FLASH PROTOCOL').slice(0, 28),
    note: String(raw.note || '').slice(0, 48),
    startAt,
    endAt,
    status: raw.status === 'paused' ? 'paused' : 'live',
    items,
    updatedAt: Number(raw.updatedAt) || startAt,
    updatedBy: String(raw.updatedBy || 'system').slice(0, 20),
  };
}

/* ---------------- 默认场次 ----------------
   首次访问不能给一块空白：「首页顶部做秒杀」如果打开是空的，等于没做。
   所以按商品池现算一场出来。全部取值由 productId 的字符和决定（seedOf），
   同一次访问里怎么刷新都是同一组价格与库存，e2e 才能稳定断言。 */

function seedOf(id) {
  let h = 7;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return h;
}

/** 秒杀价：原价的 55%–80%，取整到元；永远低于原价，否则这场没有意义 */
function flashPriceOf(product, seed) {
  const list = Number(product.originalPrice) > Number(product.price)
    ? Number(product.originalPrice)
    : Number(product.price) || 0;
  if (list <= 0) return 0;
  const ratio = DISCOUNT_MIN + (seed % 26) / 100; // 0.55 ~ 0.80
  const clamped = Math.min(DISCOUNT_MAX, ratio);
  return Math.max(1, Math.round(list * clamped));
}

function buildDefaultSale(products, actor = 'system') {
  const pool = (Array.isArray(products) ? products : [])
    .filter((p) => p && p.id != null)
    // 秒杀商品必须有价格锚点（原价），否则「立省多少」无从谈起
    .filter((p) => Number(p.price) > 0)
    .filter((p) => Number(p.originalPrice) > Number(p.price));

  // 每个品牌最多一件：秒杀位是最贵的曝光位，被一个牌子包场就很像清库存
  const brandSeen = new Set();
  const picks = [];
  for (const p of pool) {
    if (picks.length >= 5) break;
    const brand = p.brand || p.categoryId || p.id;
    if (brandSeen.has(brand)) continue;
    brandSeen.add(brand);
    picks.push(p);
  }
  // 有折扣锚点的商品不够 3 件时放宽品牌限制，凑够一场最低限度的编排
  for (const p of pool) {
    if (picks.length >= 3) break;
    if (!picks.includes(p)) picks.push(p);
  }
  if (!picks.length) return null;

  const startAt = Date.now();
  return {
    id: `fs-${startAt}`,
    title: '深空闪购 · 本场',
    protocol: 'FLASH PROTOCOL 07',
    note: '限时 2 小时 · 每件限购 1 件 · 抢完即止',
    startAt,
    endAt: startAt + SLOT_MINUTES * 60000,
    status: 'live',
    items: picks.map((p) => {
      const seed = seedOf(p.id);
      const stock = 12 + (seed % 40);
      return {
        productId: String(p.id),
        price: flashPriceOf(p, seed),
        stock,
        // 开场即有 15%–55% 的假进度：全新场次显示 0% 会让人以为没人抢
        sold: Math.round(stock * (0.15 + (seed % 41) / 100)),
        limit: 1,
      };
    }),
    updatedAt: startAt,
    updatedBy: actor,
  };
}

/* ---------------- 读取 ---------------- */

/**
 * 当前场次（含惰性初始化）。
 * @param {Array} products 商品池，仅在需要生成默认场次时使用
 * @returns {object|null}
 */
export function ensureSale(products = []) {
  const state = readState();
  const existing = state && normalizeSale(state.sale);
  if (existing) return existing;
  const created = buildDefaultSale(products);
  if (!created) return null;
  writeState({ version: 1, sale: created });
  return created;
}

/** 只读取，不生成（后台页先看有没有配置时用） */
export function getSale() {
  const state = readState();
  return state && normalizeSale(state.sale);
}

/**
 * 场次阶段。status 只记 live/paused，ended 与 pending 由时间推导——
 * 时间是会自己往前走的，把它也存进状态就会出现「状态还写着 live、其实早过了点」。
 * @returns {'pending'|'live'|'ended'|'paused'}
 */
export function phaseOf(sale, at = Date.now()) {
  if (!sale) return 'ended';
  if (at < sale.startAt) return 'pending';
  if (at >= sale.endAt) return 'ended';
  return sale.status === 'paused' ? 'paused' : 'live';
}

/** 单件可抢数量：库存 − 已抢，再被限购压一次 */
export function remainingOf(item) {
  if (!item) return 0;
  return Math.max(0, Math.min(item.stock - item.sold, item.limit));
}

/**
 * 首页要用的那份：场次 + 阶段 + 剩余秒数。
 * 已结束的场次也照样返回（前台据此显示「本场已收舱」而不是整块消失，
 * 整块消失会让刚点进来的人以为页面缺了一块）。
 */
export function readActive(products = []) {
  const sale = ensureSale(products);
  if (!sale) return null;
  return { sale, phase: phaseOf(sale), leftMs: Math.max(0, sale.endAt - Date.now()) };
}

/* ---------------- 写入（仅运营后台） ---------------- */

/**
 * 覆盖式保存。startAt 一律重置为「现在」——运营在后台点保存，语义是「按这版立刻开一场」，
 * 而不是「改一份将来才生效的配置」。想暂停用 setStatus('paused')。
 */
export function saveSale({ title, protocol, note, minutes, items, actor = 'ops' }) {
  const now = Date.now();
  const span = clampInt(minutes, 5, 24 * 60, SLOT_MINUTES);
  const clean = (Array.isArray(items) ? items : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS);
  if (!clean.length) return { ok: false, error: '至少要有一件商品' };
  const sale = {
    id: `fs-${now}`,
    title: String(title || '限时秒杀').slice(0, 24),
    protocol: String(protocol || 'FLASH PROTOCOL').slice(0, 28),
    note: String(note || '').slice(0, 48),
    startAt: now,
    endAt: now + span * 60000,
    status: 'live',
    items: clean,
    updatedAt: now,
    updatedBy: String(actor || 'ops').slice(0, 20),
  };
  writeState({ version: 1, sale });
  return { ok: true, sale };
}

/** 开抢 / 暂停。暂停只是不再接受新单，倒计时照走——回来时该剩多少还是多少 */
export function setStatus(status) {
  const state = readState();
  const sale = state && normalizeSale(state.sale);
  if (!sale) return null;
  const next = { ...sale, status: status === 'paused' ? 'paused' : 'live', updatedAt: Date.now() };
  writeState({ version: 1, sale: next });
  return next;
}

/** 延长/缩短结束时间。已经结束的场次延长后会自动回到进行中 */
export function extendSale(minutes, actor = 'ops') {
  const state = readState();
  const sale = state && normalizeSale(state.sale);
  if (!sale) return null;
  const now = Date.now();
  const base = Math.max(now, sale.endAt);
  const next = {
    ...sale,
    endAt: base + clampInt(minutes, 1, 720, 30) * 60000,
    updatedAt: now,
    updatedBy: actor,
  };
  writeState({ version: 1, sale: next });
  return next;
}

/**
 * 记一件已抢。前台每成交一件就调一次，进度条与「剩 N 件」跟着动——
 * 这就是「实时」的全部含义：不是 websocket，是同一份本地状态被两个视图订阅。
 */
export function markSold(productId, qty = 1) {
  const state = readState();
  const sale = state && normalizeSale(state.sale);
  if (!sale) return null;
  let touched = false;
  const items = sale.items.map((it) => {
    if (it.productId !== String(productId)) return it;
    const next = Math.min(it.stock, it.sold + Math.max(1, Math.round(qty)));
    if (next === it.sold) return it;
    touched = true;
    return { ...it, sold: next };
  });
  if (!touched) return sale;
  const nextSale = { ...sale, items };
  writeState({ version: 1, sale: nextSale });
  return nextSale;
}

/** 清空配置：下一次进首页会按当前商品池重新生成一场，后台「重置」按钮用它 */
export function clearSale() {
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    /* 同上 */
  }
  notify();
}

/* ---------------- 运营口令 ----------------
   纯静态演示站没有后端可以校验密钥，但又不能把「改首页秒杀」这件事开放给任何人。
   折中：本机首次进入时由运营**自己设置**一个口令，之后必须一致；只存哈希不存明文。
   这不是安全边界（同一台机器上清掉 localStorage 就能重设），
   它挡住的是「随手点进 #/admin/flash 就把线上活动改了」这种误操作。 */

function hashKey(v) {
  // FNV-1a + 固定盐：演示级。生产环境的口令校验在网关侧（ADMIN_API_KEY），不在这里。
  let h = 0x811c9dc5;
  const s = `maison::${String(v)}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function hasOpsKey() {
  try {
    return Boolean(localStorage.getItem(OPS_KEY_SLOT));
  } catch {
    return false;
  }
}

export function setOpsKey(raw) {
  const v = String(raw || '').trim();
  if (v.length < 4) return false;
  try {
    localStorage.setItem(OPS_KEY_SLOT, hashKey(v));
    return true;
  } catch {
    return false;
  }
}

export function verifyOpsKey(raw) {
  try {
    return localStorage.getItem(OPS_KEY_SLOT) === hashKey(String(raw || '').trim());
  } catch {
    return false;
  }
}
