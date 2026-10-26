import { config, useReal } from './config.js';
import { log } from './logger.js';

// 埋点事件落地：docker 模式写 Elasticsearch（product_events 索引，自动建映射）；
// local 模式写内存环形缓冲（演示用，重启清空）。两者均为 best-effort，不阻塞主请求。
const ES_INDEX = (config.esIndex || 'products') + '_events';
const MEMORY_CAP = 1000;
const memory = [];

/**
 * 写入一条埋点事件（发送即忘，内部自吞错误）。
 * @param {{event:string, source?:string, productId?:string, userId?:string, meta?:object}} raw
 * @returns {'es'|'memory'}
 */
export async function trackEvent(raw) {
  const doc = {
    event: String(raw.event || 'view').slice(0, 64),
    source: String(raw.source || 'unknown').slice(0, 64),
    productId: raw.productId ? String(raw.productId) : null,
    userId: raw.userId ? String(raw.userId) : 'anonymous',
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    ts: new Date().toISOString(),
  };

  if (useReal() && config.elasticsearchUrl) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(`${config.elasticsearchUrl}/${ES_INDEX}/_doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
        signal: ctrl.signal,
      });
      if (!res.ok) log.warn('track_es', { status: res.status });
    } catch (e) {
      log.warn('track_es', { err: e.message });
    } finally {
      clearTimeout(timer);
    }
    return 'es';
  }

  memory.push(doc);
  if (memory.length > MEMORY_CAP) memory.shift();
  return 'memory';
}

/**
 * 聚合统计，支持按 productId / source 过滤。
 * @param {{productId?:string, source?:string}} [filter]
 */
export async function getTrackStats(filter = {}) {
  if (useReal() && config.elasticsearchUrl) return esStats(filter);
  return memoryStats(filter);
}

function memoryStats({ productId, source } = {}) {
  const rows = memory.filter(
    (d) => (!productId || d.productId === productId) && (!source || d.source === source),
  );
  const bySource = {};
  rows.forEach((d) => { bySource[d.source] = (bySource[d.source] || 0) + 1; });
  const recent = rows.slice(-20).reverse();
  return { total: rows.length, bySource, recent };
}

async function esStats({ productId, source } = {}) {
  const must = [];
  if (productId) must.push({ term: { productId } });
  if (source) must.push({ term: { source } });
  const query = must.length ? { bool: { must } } : { match_all: {} };
  const body = {
    size: 0,
    query,
    aggs: {
      bySource: { terms: { field: 'source', size: 50 } },
      recent: {
        top_hits: { size: 20, sort: [{ ts: 'desc' }], _source: ['event', 'source', 'productId', 'ts'] },
      },
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${config.elasticsearchUrl}/${ES_INDEX}/_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      log.warn('track_stats_es', { status: res.status });
      return { total: 0, bySource: {}, recent: [] };
    }
    const json = await res.json();
    const bySource = {};
    (json.aggregations?.bySource?.buckets || []).forEach((b) => { bySource[b.key] = b.doc_count; });
    const recent = (json.aggregations?.recent?.hits?.hits || []).map((h) => ({
      event: h._source.event,
      source: h._source.source,
      productId: h._source.productId,
      ts: h._source.ts,
    }));
    return { total: json.hits?.total?.value || 0, bySource, recent };
  } catch (e) {
    log.warn('track_stats_es', { err: e.message });
    return { total: 0, bySource: {}, recent: [] };
  } finally {
    clearTimeout(timer);
  }
}
