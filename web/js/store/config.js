// 运行时配置：运营可配参数（运费/配送方式、券返还顺延规则）在前端的唯一读取入口。
//
// 为什么要这一层：这些值以前是前端各写一份常量（orderStore 的运费、couponStore 的
// 顺延 7 天 / 上限 3 次），与服务端那份靠「记得同时改」来维持一致。
// 现在服务端是唯一真源（app_settings + GET /api/config），前端只负责：
//   1) 启动时拉一次，缓存到 localStorage，下次进站先用缓存渲染（不闪、不阻塞首屏）；
//   2) 拉不到（离线 / 纯静态托管）时用 DEFAULT_CONFIG 兜底——它是「离线默认」，
//      不是第二份真源，所以必须与网关 settingsService.DEFAULT_SETTINGS 同值；
//   3) 配置变化后通知订阅者重算（已渲染的运费/顺延提示不能停留在旧值）。
import { api, isMissingEndpoint } from '../api.js';

const CACHE_KEY = 'maison_runtime_config';
/** 缓存有效期：过了就重新拉一次（配置改动要能在一个刷新的周期内生效），但过期的缓存仍可用作离线兜底 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const DAY = 86400000;

/**
 * 离线默认配置。与 ai-gateway/src/services/settingsService.js 的 DEFAULT_SETTINGS 同值。
 * 改这里的数值唯一的意义是「没有网关时演示得合理」，有网关时一切以服务端为准。
 */
export const DEFAULT_CONFIG = Object.freeze({
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
    fallbackId: 'standard',
  },
  payment: {
    methods: [
      { id: 'online', name: '在线支付', note: '微信 / 支付宝（演示环境不产生真实扣款）' },
      { id: 'cod', name: '货到付款', note: '签收时向配送员付款' },
    ],
    fallbackId: 'online',
  },
  coupon: { refundGraceDays: 7, maxExtensions: 3 },
});

/* ---------------- 归一化（防御服务端/缓存里的脏数据） ---------------- */

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);

function normalizeShipping(raw) {
  const base = DEFAULT_CONFIG.shipping;
  const list = Array.isArray(raw && raw.methods) ? raw.methods : [];
  const methods = list
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id).slice(0, 20),
      fee: Math.max(0, num(m.fee, 0)),
      freeOver: m.freeOver == null || m.freeOver === '' ? null : Math.max(0, num(m.freeOver, 0)),
      eta: String(m.eta || '').slice(0, 40),
      note: String(m.note || '').slice(0, 40),
    }));
  if (!methods.length) return { ...base, methods: base.methods.map((m) => ({ ...m })) };
  const wanted = String((raw && raw.fallbackId) || '');
  const fallbackId = methods.some((m) => m.id === wanted) ? wanted : methods[0].id;
  return { methods, fallbackId };
}

function normalizeCoupon(raw) {
  const base = DEFAULT_CONFIG.coupon;
  return {
    refundGraceDays: Math.max(0, Math.min(90, Math.round(num(raw && raw.refundGraceDays, base.refundGraceDays)))),
    maxExtensions: Math.max(0, Math.min(10, Math.round(num(raw && raw.maxExtensions, base.maxExtensions)))),
  };
}

/**
 * 支付方式：与配送方式同一套归一化逻辑（列表非空、id 唯一、兜底项必须存在）。
 * 支付方式不参与算钱，但它会进订单快照——服务端改了名字而前端还显示旧名字，
 * 或者运营下线了某个方式而前端还能选中下单，都是从这里没对齐开始的。
 */
function normalizePayment(raw) {
  const base = DEFAULT_CONFIG.payment;
  const list = Array.isArray(raw && raw.methods) ? raw.methods : [];
  const seen = new Set();
  const methods = [];
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    methods.push({
      id: m.id,
      name: String(m.name || m.id).slice(0, 20),
      note: String(m.note || '').slice(0, 40),
    });
  }
  if (!methods.length) return { ...base, methods: base.methods.map((m) => ({ ...m })) };
  const wanted = String((raw && raw.fallbackId) || '');
  const fallbackId = methods.some((m) => m.id === wanted) ? wanted : methods[0].id;
  return { methods, fallbackId };
}

/** 服务端响应 / 缓存 → 完整可用的配置对象（缺项一律回落到默认值） */
export function normalizeConfig(raw) {
  const src = isObj(raw) ? raw : {};
  return {
    shipping: normalizeShipping(src.shipping),
    payment: normalizePayment(src.payment),
    coupon: normalizeCoupon(src.coupon),
  };
}

/* ---------------- 缓存 ---------------- */

function readCache() {
  try {
    const d = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!d || !isObj(d) || !d.config) return null;
    return { config: normalizeConfig(d.config), fetchedAt: num(d.fetchedAt, 0) };
  } catch {
    return null;
  }
}

function writeCache(config, fetchedAt) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ config, fetchedAt }));
  } catch {
    /* 配额满：本进程内 runtime 仍是新的，只是下次进站回到兜底默认 */
  }
}

/* ---------------- 当前生效配置 ---------------- */

const cached = readCache();
let runtime = cached ? cached.config : normalizeConfig(DEFAULT_CONFIG);
let fetchedAt = cached ? cached.fetchedAt : 0;
let online = Boolean(cached);

/** 当前生效配置（只读，不要改它——订阅者共享同一个对象） */
export function getConfig() {
  return runtime;
}

/** 当前配送方式列表（至少一项） */
export function shippingMethods() {
  return runtime.shipping.methods;
}

/** 按 id 取配送方式；未知 id 落到 fallback，再兜底第一项 */
export function findShipping(id) {
  const { methods, fallbackId } = runtime.shipping;
  return methods.find((m) => m.id === id) || methods.find((m) => m.id === fallbackId) || methods[0];
}

/** 当前支付方式列表（至少一项） */
export function paymentMethods() {
  return runtime.payment.methods;
}

/** 按 id 取支付方式；未知 id 落到 fallback，再兜底第一项 */
export function findPayment(id) {
  const { methods, fallbackId } = runtime.payment;
  return methods.find((m) => m.id === id) || methods.find((m) => m.id === fallbackId) || methods[0];
}

/**
 * 运费：配送方式自带定价；配了「满额包邮」（freeOver）且券后商品金额达标时归零。
 * 与服务端 settingsService.shippingFeeOf 同公式——两边算出不同运费，
 * 就是「结算页显示 18、下单变成 28」这类事故的起点。
 */
export function shippingFeeOf(method, goodsAfterDiscount = 0) {
  const m = method || findShipping(null);
  const fee = Math.max(0, num(m.fee, 0));
  if (m.freeOver != null && Number(goodsAfterDiscount) >= Number(m.freeOver)) return 0;
  return fee;
}

/** 券返还规则（顺延天数 / 次数上限），当前生效值 */
export function refundRules() {
  return { ...runtime.coupon };
}

/** 顺延天数，便于页面文案直接用 */
export function refundGraceDays() {
  return runtime.coupon.refundGraceDays;
}

/** 配置是否来自服务端（false = 当前是离线默认/旧缓存，展示上可以更保守） */
export function configIsOnline() {
  return online;
}

/* ---------------- 拉取 ---------------- */

const listeners = new Set();

/** 订阅配置变化（拉取成功后触发），返回取消函数 */
export function onConfigChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  // 快照遍历：回调里可能再次订阅，直接遍历会无限扩散
  [...listeners].forEach((fn) => {
    try {
      fn(runtime);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  });
}

/**
 * 拉服务端配置并覆盖本地（成功才写缓存）。
 * 缓存未过期时直接返回，force=true 强制重新拉（运营改完配置想立刻看到效果时用）。
 *
 * 失败一律安静降级：运费配置拉不到不该让结算页打不开，
 * 但也不会把「拉失败」记成「服务端就是这个值」写进缓存。
 * @returns {Promise<{config:object, online:boolean, changed:boolean}>}
 */
export async function loadRuntimeConfig({ force = false } = {}) {
  const fresh = fetchedAt && Date.now() - fetchedAt < CACHE_TTL_MS;
  if (!force && fresh) return { config: runtime, online, changed: false };
  try {
    const d = await api('/api/config', { retries: 0 });
    const next = normalizeConfig((d && d.settings) || d);
    const changed = JSON.stringify(next) !== JSON.stringify(runtime);
    runtime = next;
    fetchedAt = Date.now();
    online = true;
    writeCache(next, fetchedAt);
    if (changed) notify();
    return { config: runtime, online: true, changed };
  } catch (e) {
    online = false;
    // 静态托管 404 / 离线属预期，别在控制台刷警告
    if (!(isMissingEndpoint(e) || e.kind === 'offline' || !e.status)) {
      console.warn('[config] 运行时配置拉取失败，继续用离线默认', e && e.message);
    }
    return { config: runtime, online: false, changed: false };
  }
}

/** 仅测试用：把配置重置成给定值（不写缓存） */
export function __setRuntimeConfigForTest(raw) {
  runtime = normalizeConfig(raw);
  online = false;
  notify();
  return runtime;
}

export { DAY };
