import { config } from './config.js';
import * as faq from './faq.js';
import { hybridSearch, getProductById } from './search.js';

// Dify 客户端：承载智能客服 + 商品问答 + AI 导购（均走 Dify chat-messages API）。
// 离线 / 未配置时自动降级到本地逻辑（faq 兜底 / 向量检索兜底），保证演示可跑。

// 导出供 guide.js 复用：直接调用 Dify chat-messages
export async function chatMessages(apiKey, { query, userId, conversationId, inputs }) {
  const body = {
    inputs: inputs || {},
    query,
    user: userId || 'anonymous',
    response_mode: 'blocking',
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
  const resp = await fetch(`${config.dify.apiUrl}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dify chat failed ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return {
    answer: data.answer,
    conversationId: data.conversation_id || null,
    messageId: data.message_id || null,
    mode: 'dify',
  };
}

// Dify 流式对话：response_mode=streaming，逐段回调 onDelta(answerDelta)。
// 解析 Dify 的 SSE（event:message 含 answer 增量，event:message_end 含 conversation_id）。
// docker 模式且配置了对应 App Key 时由网关调用；失败抛出供上层回退本地。
export async function streamChatMessages(
  apiKey,
  { query, userId, conversationId, inputs, onDelta },
) {
  const body = {
    inputs: inputs || {},
    query,
    user: userId || 'anonymous',
    response_mode: 'streaming',
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
  const resp = await fetch(`${config.dify.apiUrl}/chat-messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dify chat stream failed ${resp.status}: ${text}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let conversationIdOut = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue; // 非 JSON 心跳/注释行，跳过
      }
      if (evt.event === 'message' && evt.answer) {
        onDelta(evt.answer);
      } else if (evt.event === 'message_end') {
        conversationIdOut = evt.conversation_id || (evt.metadata && evt.metadata.conversation_id) || null;
      } else if (evt.event === 'error') {
        throw new Error(evt.message || 'Dify stream error');
      }
    }
  }
  return { conversationId: conversationIdOut, mode: 'dify' };
}

// 本地文本「流式」回传（按字切片 + 小延迟），用于离线/降级时也能呈现打字机效果。
async function streamLocalText(text, onDelta, { chunkSize = 2, delayMs = 12 } = {}) {
  for (let i = 0; i < text.length; i += chunkSize) {
    onDelta(text.slice(i, i + chunkSize));
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// 调用 Dify Workflow（运营文案 / 订单售后等）：POST /v1/workflows/run
export async function runWorkflow(apiKey, { inputs, userId }) {
  const body = {
    inputs: inputs || {},
    response_mode: 'blocking',
    user: userId || 'anonymous',
  };
  const resp = await fetch(`${config.dify.apiUrl}/workflows/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dify workflow failed ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const runData = data.data || {};
  return {
    outputs: runData.outputs || {},
    workflowRunId: runData.workflow_run_id || null,
    mode: 'dify',
  };
}

function appApiKey(mode) {
  if (mode === 'product-qa') return config.dify.productQaApiKey;
  if (mode === 'shopping-guide') return config.dify.shoppingGuideApiKey;
  if (mode === 'copywrite') return config.dify.copywriteApiKey;
  if (mode === 'aftersale') return config.dify.aftersaleApiKey;
  return config.dify.customerServiceApiKey;
}

// 某个 Dify App 是否就绪（docker 模式且配置了对应 Key）
export function appEnabled(mode) {
  return config.runMode === 'docker' && !!appApiKey(mode);
}

// 本地智能客服兜底：关键词匹配 FAQ
function localCustomerService({ query }) {
  return {
    answer: faq.match(query),
    conversationId: null,
    messageId: null,
    mode: 'local-faq',
  };
}

// 本地商品问答兜底：混合检索召回相关商品，再由模板组织答案；支持 productId 聚焦
async function localProductQa({ query, productId }) {
  const results = await hybridSearch(query, config.dify.retrievalLimit);
  let focused = null;
  if (productId) {
    const p = getProductById(productId);
    if (p) {
      focused = p;
      results.sort((a, b) => (a.id === productId ? -1 : b.id === productId ? 1 : 0));
    }
  }
  let answer;
  if (!results.length) {
    answer = '抱歉，我暂时没有找到相关商品信息，您可以换个说法，或联系人工客服进一步咨询。';
  } else if (focused) {
    answer =
      `针对您正在看的「${focused.name}」：${focused.description || ''}` +
      `如果您还有关于材质、尺寸、适配场景的问题，都可以继续问我。`;
  } else {
    const list = results.map((r) => `「${r.name}」（¥${r.price}）`).join('、');
    answer =
      `关于「${query}」，为您找到以下商品：${list}。` +
      `其中「${results[0].name}」的相关性最高，您可以先看看它的详情页；` +
      `如果告诉我您的预算和偏好，我可以帮您进一步筛选。`;
  }
  return { answer, results, conversationId: null, messageId: null, mode: 'local-search' };
}

// 流式对话统一入口：有 Dify 则流式（逐字 onDelta，结束 onDone(conversationId, mode)），
// 无则本地按字回传。返回最终 mode 字符串。
export async function streamChat(
  { mode, query, userId, conversationId, productId, inputs },
  onDelta,
  onDone,
) {
  if (!query || !query.trim()) {
    const err = new Error('query required');
    err.status = 400;
    throw err;
  }
  if (appEnabled(mode)) {
    try {
      const r = await streamChatMessages(appApiKey(mode), {
        query,
        userId,
        conversationId,
        inputs,
        onDelta,
      });
      onDone && onDone(r.conversationId, 'dify');
      return 'dify';
    } catch (e) {
      console.warn(`[difyClient] ${mode} 流式失败，回退本地: ${e.message}`);
    }
  }
  let answer;
  let localMode;
  if (mode === 'product-qa') {
    const r = await localProductQa({ query, userId, productId });
    answer = r.answer;
    localMode = 'local-search';
  } else {
    answer = localCustomerService({ query }).answer;
    localMode = 'local-faq';
  }
  await streamLocalText(answer, onDelta);
  onDone && onDone(null, localMode);
  return localMode;
}

// 商品问答流式：逐字回传答案，结束回传关联商品卡片（results）。
// docker + 配 Dify Key → 代理 Dify 流式；否则本地混合检索组织答案并打字机回传。
export async function streamProductQa(
  { query, userId, conversationId, productId },
  onDelta,
  onDone,
) {
  if (!query || !query.trim()) {
    const err = new Error('query required');
    err.status = 400;
    throw err;
  }
  if (appEnabled('product-qa')) {
    try {
      const r = await streamChatMessages(appApiKey('product-qa'), {
        query,
        userId,
        conversationId,
        inputs: productId ? { product_id: productId } : {},
        onDelta,
      });
      let results = [];
      try {
        results = await hybridSearch(query, config.dify.retrievalLimit);
        if (productId) {
          const p = getProductById(productId);
          if (p) results.sort((a, b) => (a.id === productId ? -1 : b.id === productId ? 1 : 0));
        }
      } catch (e) {
        console.warn(`[difyClient] product-qa 关联检索失败: ${e.message}`);
      }
      onDone && onDone(r.conversationId, 'dify', results);
      return 'dify';
    } catch (e) {
      console.warn(`[difyClient] product-qa 流式失败，回退本地: ${e.message}`);
    }
  }
  const r = await localProductQa({ query, userId, productId });
  await streamLocalText(r.answer, onDelta);
  onDone && onDone(null, r.mode, r.results);
  return r.mode;
}

export async function chat({ mode, query, userId, conversationId, productId, inputs }) {
  if (!query || !query.trim()) {
    const err = new Error('query required');
    err.status = 400;
    throw err;
  }
  if (appEnabled(mode)) {
    try {
      return await chatMessages(appApiKey(mode), { query, userId, conversationId, inputs });
    } catch (e) {
      console.warn(`[difyClient] ${mode} 调用失败，回退本地: ${e.message}`);
    }
  }
  if (mode === 'product-qa') return localProductQa({ query, userId, productId });
  return localCustomerService({ query, userId });
}

// 把商品推入 Dify 知识库（Dataset API），供商品问答的 RAG 检索。
// 仅在 docker 模式且配置了 dataset 凭证时执行；否则打印待同步数量并跳过。
export async function syncProductsToDataset(products) {
  if (config.runMode !== 'docker' || !config.dify.datasetApiKey || !config.dify.datasetId) {
    console.log(`[difyClient] 跳过知识库同步（非 docker 或缺少 dataset 配置），共 ${products.length} 个商品待同步`);
    return { skipped: true, count: products.length };
  }
  const docs = products.map((p) => ({
    name: `${p.name} #${p.id}`,
    text: buildProductDoc(p),
  }));
  const resp = await fetch(`${config.dify.apiUrl}/datasets/${config.dify.datasetId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.dify.datasetApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: docs,
      indexing_technique: 'high_quality',
      process_rule: { mode: 'automatic' },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Dify dataset sync failed ${resp.status}: ${text}`);
  }
  return { skipped: false, count: products.length };
}

function buildProductDoc(p) {
  return [
    `商品名称：${p.name}`,
    `副标题：${p.subtitle || p.description || ''}`,
    `品牌：${p.brand || ''}`,
    `分类：${p.category || ''}`,
    `价格：${p.price}`,
    `标签：${(p.tags || []).join('、')}`,
    `描述：${p.description || ''}`,
  ].join('\n');
}
