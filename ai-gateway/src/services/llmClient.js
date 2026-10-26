// LLM 客户端（OpenAI 兼容协议）：DeepSeek / 通义千问 / Kimi / OpenAI 等均可直接对接。
// 未配置 LLM_API_KEY 时不启用，由本地对话引擎接管（零外部依赖也能正常对话）。
import { config, llmEnabled } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export { llmEnabled };

function endpoint(path) {
  return `${config.llm.baseUrl}${path}`;
}

function headers() {
  return {
    Authorization: `Bearer ${config.llm.apiKey}`,
    'Content-Type': 'application/json',
  };
}

function body(messages, { stream = false, temperature } = {}) {
  return JSON.stringify({
    model: config.llm.model,
    messages,
    temperature: temperature ?? config.llm.temperature,
    stream,
  });
}

/** 一次性返回完整回复（失败抛错，由上层降级到本地引擎） */
export async function chatComplete(messages, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  try {
    const res = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: headers(),
      body: body(messages, opts),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('LLM returned empty content');
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 流式回复：逐段回调 onDelta，返回完整文本 */
export async function chatStream(messages, onDelta, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.llm.timeoutMs);
  let full = '';
  try {
    const res = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: headers(),
      body: body(messages, { ...opts, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload);
          const delta = evt?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          /* 忽略心跳/非 JSON 行 */
        }
      }
    }
    if (!full.trim()) throw new Error('LLM stream returned empty content');
    return full;
  } finally {
    clearTimeout(timer);
  }
}

/** 简单连通性探测：返回 { ok, model, error } */
export async function probe() {
  if (!llmEnabled()) return { ok: false, error: 'LLM_API_KEY 未配置' };
  try {
    await chatComplete([{ role: 'user', content: 'ping' }], { temperature: 0 });
    return { ok: true, model: config.llm.model, baseUrl: config.llm.baseUrl };
  } catch (e) {
    return { ok: false, error: e.message, model: config.llm.model, baseUrl: config.llm.baseUrl };
  }
}

export { sleep };
