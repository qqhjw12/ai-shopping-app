import { config, useReal } from './config.js';
import { log } from './logger.js';

// 埋点事件落地：docker 模式写 Elasticsearch（<esIndex>_events 索引，启动期建索引模板）；
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
 * 聚合统计，支持按 productId / source 过滤。返回全链路多维聚合，供分析看板使用。
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
  const byEvent = {}, bySource = {}, byProduct = {};
  rows.forEach((d) => {
    byEvent[d.event] = (byEvent[d.event] || 0) + 1;
    bySource[d.source] = (bySource[d.source] || 0) + 1;
    if (d.productId) byProduct[d.productId] = (byProduct[d.productId] || 0) + 1;
  });
  const recent = rows.slice(-50).reverse().map((d) => ({
    event: d.event, source: d.source, productId: d.productId, userId: d.userId, ts: d.ts,
  }));
  return { total: rows.length, byEvent, bySource, byProduct, recent };
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
      byEvent: { terms: { field: 'event', size: 20 } },
      bySource: { terms: { field: 'source', size: 50 } },
      byProduct: { terms: { field: 'productId', size: 20 } },
      recent: {
        top_hits: {
          size: 50,
          sort: [{ ts: 'desc' }],
          _source: ['event', 'source', 'productId', 'userId', 'ts'],
        },
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
      return { total: 0, byEvent: {}, bySource: {}, byProduct: {}, recent: [] };
    }
    const json = await res.json();
    const toMap = (buckets) => {
      const m = {};
      (buckets || []).forEach((b) => { m[b.key] = b.doc_count; });
      return m;
    };
    const recent = (json.aggregations?.recent?.hits?.hits || []).map((h) => ({
      event: h._source.event,
      source: h._source.source,
      productId: h._source.productId,
      userId: h._source.userId,
      ts: h._source.ts,
    }));
    return {
      total: json.hits?.total?.value || 0,
      byEvent: toMap(json.aggregations?.byEvent?.buckets),
      bySource: toMap(json.aggregations?.bySource?.buckets),
      byProduct: toMap(json.aggregations?.byProduct?.buckets),
      recent,
    };
  } catch (e) {
    log.warn('track_stats_es', { err: e.message });
    return { total: 0, byEvent: {}, bySource: {}, byProduct: {}, recent: [] };
  } finally {
    clearTimeout(timer);
  }
}

// 启动期 best-effort 建索引模板：event/source/productId/userId 设为 keyword，ts 设为 date，
// 保证 terms 聚合可用、时间可排序。ES 不可用时静默跳过（首条写入走动态映射兜底）。
export async function ensureTrackIndex() {
  if (!useReal() || !config.elasticsearchUrl) return;
  const template = {
    index_patterns: [ES_INDEX],
    template: {
      mappings: {
        properties: {
          event: { type: 'keyword' },
          source: { type: 'keyword' },
          productId: { type: 'keyword' },
          userId: { type: 'keyword' },
          meta: { type: 'object' },
          ts: { type: 'date' },
        },
      },
    },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${config.elasticsearchUrl}/_index_template/product_events_template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(template),
      signal: ctrl.signal,
    });
    if (!res.ok) log.warn('track_index', { status: res.status });
    else log.info('track_index', { msg: 'ensured', index: ES_INDEX });
  } catch (e) {
    log.warn('track_index', { err: e.message });
  } finally {
    clearTimeout(timer);
  }
}
