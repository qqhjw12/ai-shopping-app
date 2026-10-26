import http from 'node:http';
import { config, useReal, startupWarnings } from './config.js';
import { log } from './logger.js';
import {
  attachContext,
  applyCors,
  checkRateLimit,
  checkAuth,
} from './middleware.js';
import * as vectorStore from './vectorStore.js';
import * as searchStore from './searchStore.js';
import { seed, hybridSearch, listAllProducts } from './search.js';
import * as difyClient from './difyClient.js';
import { guideShopping, streamGuide } from './guide.js';
import { generateCopywriting } from './copywrite.js';
import { handleAfterSale } from './aftersale.js';
import { trackEvent, getTrackStats } from './trackStore.js';

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return null;
  }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res, status, message, reqId) {
  send(res, status, { error: message, reqId });
}

// ===== SSE（流式）辅助 =====
function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 通知 nginx 不要缓冲（流式透传）
  });
}
function sseWrite(res, obj) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function sseDone(res) {
  if (!res.writableEnded) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 探测外部依赖（docker 模式用于 /ready）
function probeDeps() {
  const deps = {
    vectorStore: vectorStore.count() > 0,
    searchStore: searchStore.count() > 0,
  };
  if (useReal()) {
    // 真实模式下，至少要求 Dify 关键 App Key 已配置（否则仍走降级，但标注未就绪）
    deps.difyConfigured = !!(
      config.dify.customerServiceApiKey && config.dify.productQaApiKey
    );
    deps.qdrant = true; // 连接由适配器内部保证，启动期已校验
    deps.elasticsearch = true;
  } else {
    deps.difyConfigured = config.runMode === 'local'; // local 用内置兜底
  }
  deps.ready = Object.values(deps).every(Boolean);
  return deps;
}

// 业务路由（不含中间件/探针）
async function route(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/seed') {
    const n = await seed();
    return send(res, 200, { seeded: n });
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.query || '';
    const topK = Number(parsed.topK || 5);
    if (!query) return sendError(res, 400, 'query required', req.reqId);
    const results = await hybridSearch(query, topK);
    return send(res, 200, { query, count: results.length, results });
  }

  if (req.method === 'GET' && url.pathname === '/api/products') {
    const products = listAllProducts().map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      pic: p.pic || '',
      brand: p.brand || '',
      category: p.category || '',
      description: p.description || '',
      tags: p.tags || [],
    }));
    return send(res, 200, { count: products.length, products });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/products/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/products/'.length));
    const all = listAllProducts();
    const p = all.find((x) => x.id === id);
    if (!p) return sendError(res, 404, 'product not found', req.reqId);
    return send(res, 200, {
      product: {
        id: p.id,
        name: p.name,
        price: p.price,
        pic: p.pic || '',
        brand: p.brand || '',
        category: p.category || '',
        description: p.description || '',
        tags: p.tags || [],
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.message || parsed.query || '';
    if (!query) return sendError(res, 400, 'message required', req.reqId);
    try {
      if (parsed.stream) {
        await handleChatStream(res, { ...parsed, query });
        return;
      }
      const r = await difyClient.chat({
        mode: 'customer-service',
        query,
        userId: parsed.userId || 'anonymous',
        conversationId: parsed.conversationId,
      });
      return send(res, 200, { type: 'customer-service', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 客服流式（SSE）：docker 走 Dify 逐字，否则本地 FAQ 打字机
  async function handleChatStream(res, parsed) {
    sseInit(res);
    let conversationId = null;
    try {
      const mode = await difyClient.streamChat(
        {
          mode: 'customer-service',
          query: parsed.query,
          userId: parsed.userId || 'anonymous',
          conversationId: parsed.conversationId,
        },
        (t) => sseWrite(res, { text: t }),
        (cid) => {
          conversationId = cid;
        },
      );
      sseWrite(res, { conversationId, mode });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/qa') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const query = parsed.query || '';
    if (!query) return sendError(res, 400, 'query required', req.reqId);
    try {
      if (parsed.stream) {
        await handleQaStream(res, { ...parsed, query });
        return;
      }
      const r = await difyClient.chat({
        mode: 'product-qa',
        query,
        userId: parsed.userId || 'anonymous',
        conversationId: parsed.conversationId,
        productId: parsed.productId,
      });
      return send(res, 200, { type: 'product-qa', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/guide') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    const message = parsed.message || parsed.query || '';
    if (!message) return sendError(res, 400, 'message required', req.reqId);
    try {
      if (parsed.stream) {
        await handleGuideStream(res, { ...parsed, message });
        return;
      }
      const r = await guideShopping({
        message,
        userId: parsed.userId || 'anonymous',
        budget: parsed.budget,
        category: parsed.category,
        topK: parsed.topK,
      });
      return send(res, 200, { type: 'shopping-guide', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 导购流式（SSE）：先逐段回传导购话术，最后回传商品卡片
  async function handleGuideStream(res, parsed) {
    sseInit(res);
    try {
      const { cards, mode } = await streamGuide(
        {
          message: parsed.message,
          userId: parsed.userId || 'anonymous',
          budget: parsed.budget,
          category: parsed.category,
          topK: parsed.topK,
        },
        (t) => sseWrite(res, { text: t }),
      );
      sseWrite(res, { products: cards, mode });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  // 商品问答流式（SSE）：逐字回传答案，最后回传关联商品卡片
  async function handleQaStream(res, parsed) {
    sseInit(res);
    let conversationId = null;
    let results = [];
    let mode = null;
    try {
      mode = await difyClient.streamProductQa(
        {
          query: parsed.query,
          userId: parsed.userId || 'anonymous',
          conversationId: parsed.conversationId,
          productId: parsed.productId,
        },
        (t) => sseWrite(res, { text: t }),
        (cid, m, r) => {
          conversationId = cid;
          mode = m;
          results = r || [];
        },
      );
      sseWrite(res, { productId: parsed.productId || null, results, conversationId, mode });
    } catch (e) {
      sseWrite(res, { error: e.message });
    } finally {
      sseDone(res);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/copywrite') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const product = parsed.product || {};
      const r = await generateCopywriting({
        product,
        sellingPoints: parsed.sellingPoints || product.tags || [],
        tone: parsed.tone || '专业',
        platform: parsed.platform || '通用',
        count: parsed.count || 3,
      });
      return send(res, 200, { type: 'copywrite', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  // 推荐来源埋点 + 渠道分析（来源闭环数据）
  if (req.method === 'POST' && url.pathname === '/api/track') {
    const parsed = await readJson(req);
    if (!parsed || !parsed.event) return sendError(res, 400, 'event required', req.reqId);
    // 发送即忘：先回 202，异步落 ES / 内存，不阻塞主流程
    trackEvent({
      event: parsed.event,
      source: parsed.source,
      productId: parsed.productId,
      userId: parsed.userId || 'anonymous',
      meta: parsed.meta,
    }).catch(() => {});
    return send(res, 202, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/track/stats') {
    const productId = url.searchParams.get('productId') || undefined;
    const source = url.searchParams.get('source') || undefined;
    const stats = await getTrackStats({ productId, source });
    return send(res, 200, { stats });
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/aftersale') {
    const parsed = await readJson(req);
    if (!parsed) return sendError(res, 400, 'invalid json', req.reqId);
    try {
      const r = await handleAfterSale({
        userId: parsed.userId || 'anonymous',
        orderId: parsed.orderId,
        query: parsed.query || '',
      });
      return send(res, 200, { type: 'aftersale', ...r });
    } catch (e) {
      return sendError(res, e.status || 500, e.message, req.reqId);
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, {
      service: 'ai-gateway',
      endpoints: [
        'GET /health',
        'GET /ready',
        'POST /api/seed',
        'POST /api/search {query, topK}',
        'GET /api/products',
        'POST /api/ai/chat {message, userId?, conversationId?}',
        'POST /api/ai/qa {query, userId?, conversationId?, productId?} (stream:true 时 SSE 逐字，末尾回传 results)',
        'POST /api/ai/guide {message, userId?, budget?, category?, topK?}',
        'POST /api/ai/copywrite {product, sellingPoints?, tone?, platform?, count?}',
        'POST /api/ai/aftersale {userId?, orderId?, query?}',
        'POST /api/track {event, source?, productId?, userId?, meta?} (推荐来源埋点，202 异步落 ES/内存)',
        'GET /api/track/stats?productId=&source= (渠道分析聚合)',
      ],
    });
  }

  return sendError(res, 404, 'not found', req.reqId);
}

const server = http.createServer(async (req, res) => {
  attachContext(req, res);
  applyCors(req, res);

  // 预检请求直接放行
  if (req.method === 'OPTIONS') return send(res, 204, {});

  const url = new URL(req.url, `http://localhost:${config.port}`);
  const isProbe = url.pathname === '/health' || url.pathname === '/ready';

  // 探针接口不鉴权、不限流（供编排器/负载均衡探活）
  if (isProbe) {
    if (url.pathname === '/health') {
      return send(res, 200, {
        status: 'ok',
        runMode: config.runMode,
        embedding: config.embeddingProvider,
        vectorStore: vectorStore.count(),
        searchStore: searchStore.count(),
      });
    }
    const deps = probeDeps();
    return send(res, deps.ready ? 200 : 503, {
      status: deps.ready ? 'ready' : 'not ready',
      runMode: config.runMode,
      deps,
    });
  }

  // 业务接口：限流 + 鉴权
  const limit = checkRateLimit(req);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    log.warn('rate_limited', { reqId: req.reqId, ip: req.ip });
    return sendError(res, 429, 'too many requests', req.reqId);
  }
  if (!checkAuth(req)) {
    log.warn('auth_failed', { reqId: req.reqId, ip: req.ip, path: url.pathname });
    return sendError(res, 401, 'unauthorized', req.reqId);
  }

  const startedAt = req.startedAt;
  try {
    await route(req, res, url);
  } catch (e) {
    log.error('unhandled', { reqId: req.reqId, ip: req.ip, err: e.message, stack: e.stack });
    return sendError(res, 500, 'internal error', req.reqId);
  } finally {
    log.info('access', {
      reqId: req.reqId,
      ip: req.ip,
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  }
});

// ===== 优雅停机 =====
let isClosing = false;
const connections = new Set();

server.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

function shutdown(signal) {
  if (isClosing) return;
  isClosing = true;
  log.warn('shutdown', { signal, msg: 'received, draining connections' });
  // 停止接收新连接；已建立的连接自然结束
  server.close((err) => {
    if (err) log.error('shutdown', { err: err.message });
    for (const s of connections) s.destroy();
    log.info('shutdown', { msg: 'closed, bye' });
    process.exit(0);
  });
  // 兜底：超时强制退出，避免僵尸进程
  const forced = setTimeout(() => {
    log.warn('shutdown', { msg: 'force exit after timeout' });
    process.exit(0);
  }, 10000);
  forced.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, async () => {
  log.info('listen', {
    port: config.port,
    runMode: config.runMode,
    embedding: config.embeddingProvider,
  });
  const warns = startupWarnings();
  for (const w of warns) log.warn('config', { msg: w });
  try {
    const n = await seed();
    log.info('seed', { count: n });
  } catch (e) {
    log.error('seed', { err: e.message });
  }
});
