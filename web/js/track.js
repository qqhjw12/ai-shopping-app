// 埋点上报：fire-and-forget，失败静默（绝不阻断主流程）。
import { api } from './api.js';
import { getUserId } from './state.js';

// 同 (event+source+productId) 2s 内去重，避免路由重复渲染造成重复打点
let lastKey = null;
let lastAt = 0;

/**
 * @param {{event:string, source?:string, productId?:string|null, meta?:object}} payload
 */
export async function trackEvent(payload) {
  const key = JSON.stringify([payload.event, payload.source || '', payload.productId || '']);
  const now = Date.now();
  if (key === lastKey && now - lastAt < 2000) return;
  lastKey = key;
  lastAt = now;
  try {
    await api('/api/track', {
      body: {
        event: payload.event,
        source: payload.source || 'unknown',
        productId: payload.productId || null,
        userId: getUserId(),
        meta: payload.meta || {},
      },
      retries: 0,
    });
  } catch {
    // 埋点失败不影响浏览体验（如演示站点未连网关）
  }
}

/** 拉取某商品的渠道分析（best-effort，失败返回 null） */
export async function fetchProductStats(productId) {
  return fetchStats({ productId });
}

/**
 * 拉取多维聚合分析（best-effort，失败返回 null）。
 * 返回 { total, byEvent, bySource, byProduct, recent }。
 * @param {{productId?:string, source?:string}} [filter]
 */
export async function fetchStats(filter = {}) {
  const qs = new URLSearchParams();
  if (filter.productId) qs.set('productId', filter.productId);
  if (filter.source) qs.set('source', filter.source);
  try {
    const d = await api(`/api/track/stats?${qs.toString()}`, { retries: 0 });
    return d.stats || null;
  } catch {
    return null;
  }
}
