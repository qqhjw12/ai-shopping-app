// 类型化请求封装：4xx 不重试；5xx / 网络异常自动重试最多 3 次；离线优先提示。
// 默认同源（经 nginx 反代时即网关地址），可用 ?api= 覆盖（本地直连调试用）。

const API_BASE = new URLSearchParams(location.search).get('api') || location.origin;

export const apiBase = API_BASE;

export class ApiError extends Error {
  /** @param {string} message @param {'client'|'server'|'network'|'offline'} kind @param {number} [status] */
  constructor(message, kind, status) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} path  相对路径，如 /api/products
 * @param {{body?: any, retries?: number}} [opts]
 */
export async function api(path, opts = {}) {
  if (!navigator.onLine) throw new ApiError('当前网络不可用，请检查连接后重试', 'offline');
  const retries = opts.retries ?? 3;
  const method = opts.body ? 'POST' : 'GET';
  const headers = { 'Content-Type': 'application/json' };
  let attempt = 0;
  while (true) {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      if (resp.status >= 400 && resp.status < 500) {
        let msg = '请求有误，请检查输入';
        try {
          const d = await resp.json();
          if (d && d.error) msg = d.error;
        } catch {}
        if (resp.status === 401) msg = '服务需要鉴权，请检查 API Key 配置';
        if (resp.status === 429) msg = '请求过于频繁，请稍后再试';
        throw new ApiError(msg, 'client', resp.status);
      }
      if (resp.status >= 500 && attempt < retries) {
        attempt++;
        await sleep(300 * attempt);
        continue;
      }
      if (!resp.ok) throw new ApiError('服务暂时不可用，请稍后重试', 'server', resp.status);
      return await resp.json();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (attempt < retries) {
        attempt++;
        await sleep(300 * attempt);
        continue;
      }
      throw new ApiError('网络异常，请稍后重试', 'network');
    }
  }
}

/**
 * 流式请求（SSE）：用于导购/客服逐字渲染。
 * - 网关返回 text/event-stream 时，逐块解析 data: {json} 并回调 onEvent。
 * - 若网关返回普通 JSON（未启用流式），则整体作为单个事件回调（向前兼容）。
 * @param {string} path
 * @param {object} body
 * @param {(ev:any)=>void} onEvent
 * @param {{retries?:number}} [opts]
 */
export async function streamApi(path, body, onEvent, opts = {}) {
  if (!navigator.onLine) throw new ApiError('当前网络不可用，请检查连接后重试', 'offline');
  const retries = opts.retries ?? 2;
  const doFetch = async () => {
    const resp = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status >= 400 && resp.status < 500) {
      let msg = '请求有误，请检查输入';
      try {
        const d = await resp.json();
        if (d && d.error) msg = d.error;
      } catch {}
      if (resp.status === 401) msg = '服务需要鉴权，请检查 API Key 配置';
      if (resp.status === 429) msg = '请求过于频繁，请稍后再试';
      throw new ApiError(msg, 'client', resp.status);
    }
    if (resp.status >= 500) throw new ApiError('服务暂时不可用，请稍后重试', 'server', resp.status);
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      // 网关未启用流式 → 单个完整事件
      const json = await resp.json();
      onEvent(json);
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* 忽略无法解析的保活行 */
        }
      }
    }
  };
  let attempt = 0;
  while (true) {
    try {
      await doFetch();
      return;
    } catch (e) {
      if (e instanceof ApiError && (e.kind === 'client' || e.kind === 'offline')) throw e;
      if (attempt < retries) {
        attempt++;
        await sleep(300 * attempt);
        continue;
      }
      throw new ApiError('网络异常，请稍后重试', 'network');
    }
  }
}
