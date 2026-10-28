// 运营可配参数：运费 / 配送方式 / 券返还顺延规则。
//
// 这些值以前写死在两个地方（服务端 orderService 的 SHIPPING_FEE、couponRules 的
// REFUND_GRACE_DAYS，加上前端 orderStore / couponStore 的同值副本），改一个数字要发版，
// 还必然出现「服务端改了前端没改」的错位——同一张券在两台设备上算出不同到期日。
//
// 现在收敛成一张 app_settings 键值表：
//   - 代码里的 DEFAULT_SETTINGS 是唯一默认值来源（表空/缺字段时兜底，不在迁移里插数据，
//     否则「迁移插的旧默认值」与「代码新默认值」会长期打架）；
//   - PUT 只接受白名单字段，逐项做范围与类型校验——配置错了会直接算出负运费、零元订单；
//   - 读路径进程内缓存，写路径主动失效，另有 TTL 兜住「多实例各改一次」的情况。
import { getDb } from '../db/connection.js';

/**
 * 默认值：前端 store/config.js 的 DEFAULT_CONFIG 必须与此同值。
 * （前端那份是「拉不到 /api/config」时的离线兜底，不是第二份真源。）
 */
export const DEFAULT_SETTINGS = {
  shipping: {
    methods: [
      {
        id: 'standard',
        name: '标准配送',
        fee: 0,
        freeOver: null,
        eta: '预计 3–5 个工作日送达',
        note: '全场包邮 · 顺丰/京东随机',
      },
      {
        id: 'express',
        name: '加急配送',
        fee: 18,
        freeOver: null,
        eta: '预计次日 18:00 前送达',
        note: '限一二线城市 · 加收 ¥18',
      },
    ],
    // 配送方式列表为空 / 传入未知 id 时的兜底项
    fallbackId: 'standard',
  },
  payment: {
    // 支付方式只记录用户的选择，不接真实支付网关（演示环境不产生扣款）。
    // 但「有哪些支付方式、叫什么名字」属于运营话术（大促时关掉货到付款是常规操作），
    // 所以和配送方式一样进配置，而不是写死在前端常量里。
    methods: [
      { id: 'online', name: '在线支付', note: '微信 / 支付宝（演示环境不产生真实扣款）' },
      { id: 'cod', name: '货到付款', note: '签收时向配送员付款' },
    ],
    fallbackId: 'online',
  },
  coupon: {
    // 取消订单返还时有效期顺延的天数
    refundGraceDays: 7,
    // 同一张券最多顺延几次（防「下单→取消」刷有效期）
    maxExtensions: 3,
  },
};

const CACHE_TTL_MS = 30_000;
let cache = null; // { at:number, data:object }

/* ---------------- 校验 ---------------- */

class SettingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingError';
    this.status = 400;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function intIn(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SettingError(`${label} 必须是数字`);
  if (!Number.isInteger(value)) throw new SettingError(`${label} 必须是整数`);
  if (value < min || value > max) throw new SettingError(`${label} 必须在 ${min}–${max} 之间`);
  return value;
}

function textIn(value, max, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new SettingError(`${label} 不能为空`);
  if (s.length > max) throw new SettingError(`${label} 不能超过 ${max} 字`);
  return s;
}

const SHIPPING_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/;
/** 配送方式：数组 1–5 项，id 唯一，运费 0–999，freeOver 为 null 或 0–100000 */
export function validateShippingMethods(input) {
  if (!Array.isArray(input) || !input.length) throw new SettingError('shipping.methods 必须是非空数组');
  if (input.length > 5) throw new SettingError('shipping.methods 最多 5 项');
  const seen = new Set();
  return input.map((m, i) => {
    const label = `shipping.methods[${i}]`;
    if (!isPlainObject(m)) throw new SettingError(`${label} 必须是对象`);
    const id = String(m.id || '');
    if (!SHIPPING_ID_RE.test(id)) throw new SettingError(`${label}.id 只能是小写字母开头的字母数字/下划线/短横`);
    if (seen.has(id)) throw new SettingError(`${label}.id 重复：${id}`);
    seen.add(id);
    const freeOver = m.freeOver == null || m.freeOver === '' ? null : intIn(Number(m.freeOver), 0, 100000, `${label}.freeOver`);
    return {
      id,
      name: textIn(m.name, 20, `${label}.name`),
      fee: intIn(Number(m.fee), 0, 999, `${label}.fee`),
      freeOver,
      eta: textIn(m.eta, 40, `${label}.eta`),
      note: String(m.note == null ? '' : m.note).trim().slice(0, 40),
    };
  });
}

/**
 * 支付方式：数组 1–5 项，id 唯一。
 * 没有价格字段——支付方式不参与算钱，只决定订单上记什么、结算页显示什么。
 * 正因如此它最容易被误认为「前端常量无所谓」，但它同时出现在订单快照里，
 * 前端改了名字而服务端订单还记着旧 id，历史订单就会显示成「未知方式」。
 */
export function validatePaymentMethods(input) {
  if (!Array.isArray(input) || !input.length) throw new SettingError('payment.methods 必须是非空数组');
  if (input.length > 5) throw new SettingError('payment.methods 最多 5 项');
  const seen = new Set();
  return input.map((m, i) => {
    const label = `payment.methods[${i}]`;
    if (!isPlainObject(m)) throw new SettingError(`${label} 必须是对象`);
    const id = String(m.id || '');
    if (!SHIPPING_ID_RE.test(id)) throw new SettingError(`${label}.id 只能是小写字母开头的字母数字/下划线/短横`);
    if (seen.has(id)) throw new SettingError(`${label}.id 重复：${id}`);
    seen.add(id);
    return {
      id,
      name: textIn(m.name, 20, `${label}.name`),
      note: String(m.note == null ? '' : m.note).trim().slice(0, 40),
    };
  });
}

/**
 * 深合并 + 校验：只接受白名单字段，未提到的字段保持原值。
 * 拒绝未知字段而不是静默丢弃——运营把 `refundGraceDay` 少写一个 s 时，
 * 静默忽略会让人以为「配置生效了但其实没生效」。
 */
export function mergeSettings(base, patch) {
  if (!isPlainObject(patch)) throw new SettingError('配置必须是对象');
  const unknown = Object.keys(patch).filter((k) => k !== 'shipping' && k !== 'payment' && k !== 'coupon');
  if (unknown.length) throw new SettingError(`不支持的配置项：${unknown.join(', ')}`);

  const next = {
    shipping: { ...base.shipping, methods: base.shipping.methods.map((m) => ({ ...m })) },
    payment: { ...base.payment, methods: base.payment.methods.map((m) => ({ ...m })) },
    coupon: { ...base.coupon },
  };

  if (patch.shipping !== undefined) {
    if (!isPlainObject(patch.shipping)) throw new SettingError('shipping 必须是对象');
    const badShipping = Object.keys(patch.shipping).filter((k) => k !== 'methods' && k !== 'fallbackId');
    if (badShipping.length) throw new SettingError(`不支持的 shipping 配置项：${badShipping.join(', ')}`);
    if (patch.shipping.methods !== undefined) {
      next.shipping.methods = validateShippingMethods(patch.shipping.methods);
    }
    if (patch.shipping.fallbackId !== undefined) {
      const fid = String(patch.shipping.fallbackId);
      if (!next.shipping.methods.some((m) => m.id === fid)) throw new SettingError('shipping.fallbackId 必须是某个配送方式的 id');
      next.shipping.fallbackId = fid;
    }
  }

  if (patch.payment !== undefined) {
    if (!isPlainObject(patch.payment)) throw new SettingError('payment 必须是对象');
    const badPayment = Object.keys(patch.payment).filter((k) => k !== 'methods' && k !== 'fallbackId');
    if (badPayment.length) throw new SettingError(`不支持的 payment 配置项：${badPayment.join(', ')}`);
    if (patch.payment.methods !== undefined) {
      next.payment.methods = validatePaymentMethods(patch.payment.methods);
    }
    if (patch.payment.fallbackId !== undefined) {
      const fid = String(patch.payment.fallbackId);
      if (!next.payment.methods.some((m) => m.id === fid)) throw new SettingError('payment.fallbackId 必须是某个支付方式的 id');
      next.payment.fallbackId = fid;
    }
  }

  if (patch.coupon !== undefined) {
    if (!isPlainObject(patch.coupon)) throw new SettingError('coupon 必须是对象');
    const badCoupon = Object.keys(patch.coupon).filter((k) => k !== 'refundGraceDays' && k !== 'maxExtensions');
    if (badCoupon.length) throw new SettingError(`不支持的 coupon 配置项：${badCoupon.join(', ')}`);
    if (patch.coupon.refundGraceDays !== undefined) {
      next.coupon.refundGraceDays = intIn(Number(patch.coupon.refundGraceDays), 0, 90, 'coupon.refundGraceDays');
    }
    if (patch.coupon.maxExtensions !== undefined) {
      next.coupon.maxExtensions = intIn(Number(patch.coupon.maxExtensions), 0, 10, 'coupon.maxExtensions');
    }
  }

  // 兜底项必须存在于最终列表里（可能被同一次 patch 换掉了）
  if (!next.shipping.methods.some((m) => m.id === next.shipping.fallbackId)) {
    next.shipping.fallbackId = next.shipping.methods[0].id;
  }
  if (!next.payment.methods.some((m) => m.id === next.payment.fallbackId)) {
    next.payment.fallbackId = next.payment.methods[0].id;
  }
  return next;
}

/* ---------------- 读写 ---------------- */

function readRows(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM app_settings').all()) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* 手工改库写出非法 JSON：当作没配，用默认值兜底而不是让结算页崩 */
    }
  }
  return out;
}

/**
 * 当前生效配置（深拷贝，调用方改不坏缓存）。
 *
 * 库里某一项被手工改坏（少个字段、类型不对）时只降级那一项并告警，
 * 不能让整个结算页因为「运营配错了运费」而 500——收不了钱比算错钱更糟。
 */
export function getSettings() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return structuredClone(cache.data);
  const rows = readRows(getDb());
  let data = structuredClone(DEFAULT_SETTINGS);
  for (const section of ['shipping', 'payment', 'coupon']) {
    if (rows[section] === undefined) continue;
    try {
      data = mergeSettings(data, { [section]: rows[section] });
    } catch (e) {
      console.warn(`[settings] app_settings.${section} 非法，已回退默认值：${e.message}`);
    }
  }
  cache = { at: now, data };
  return structuredClone(data);
}

/** 写配置：只 upsert 本次 patch 涉及的段，其余段不动 */
export function updateSettings(patch, { by = '' } = {}) {
  const db = getDb();
  const current = getSettings();
  const next = mergeSettings(current, patch);
  const upsert = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
      updated_at = datetime('now'), updated_by = excluded.updated_by
  `);
  db.exec('BEGIN');
  try {
    if (patch.shipping !== undefined) upsert.run('shipping', JSON.stringify(next.shipping), by);
    if (patch.payment !== undefined) upsert.run('payment', JSON.stringify(next.payment), by);
    if (patch.coupon !== undefined) upsert.run('coupon', JSON.stringify(next.coupon), by);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 不掩盖原始错误 */
    }
    throw e;
  }
  cache = null; // 写后失效：本进程立刻看到新值，别的实例最多等一个 TTL
  return getSettings();
}

/** 测试/运维用：强制下次读走数据库 */
export function invalidateSettingsCache() {
  cache = null;
}

/* ---------------- 便捷取值 ---------------- */

/** 配送方式列表（含兜底项保证非空） */
export function shippingMethods() {
  return getSettings().shipping.methods;
}

/** 按 id 取配送方式；未知 id 落到 fallbackId，再兜底第一项 */
export function shippingById(id) {
  const s = getSettings().shipping;
  return s.methods.find((m) => m.id === id)
    || s.methods.find((m) => m.id === s.fallbackId)
    || s.methods[0];
}

/**
 * 运费：配送方式自带定价；配了 freeOver（满额包邮门槛）且商品金额达到时归零。
 * 门槛按「券后商品金额」判断——否则用券把总额降到门槛以下却仍免运费，等于券抵了两次。
 */
export function shippingFeeOf(shipping, goodsAfterDiscount = 0) {
  const m = shipping || shippingById(null);
  const fee = Math.max(0, Number(m.fee) || 0);
  const over = m.freeOver == null ? null : Number(m.freeOver);
  if (over !== null && Number(goodsAfterDiscount) >= over) return 0;
  return fee;
}

/** 券返还规则 */
export function couponRules() {
  return getSettings().coupon;
}

/** 支付方式列表（含兜底项保证非空） */
export function paymentMethods() {
  return getSettings().payment.methods;
}

/** 按 id 取支付方式；未知 id 落到 fallbackId，再兜底第一项 */
export function paymentById(id) {
  const p = getSettings().payment;
  return p.methods.find((m) => m.id === id)
    || p.methods.find((m) => m.id === p.fallbackId)
    || p.methods[0];
}

/**
 * 支付方式 id 归一化：未知值落到 fallbackId。
 * 服务端要这么做而不是直接拒绝——运营删掉某个支付方式后，
 * 用户手里还开着一个旧结算页（页面里仍是旧 id），宁可落到默认方式也不要让他下不了单。
 */
export function normalizePaymentId(id) {
  return paymentById(String(id || '')).id;
}
