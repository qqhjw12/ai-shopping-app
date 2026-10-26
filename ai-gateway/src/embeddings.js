import { config } from './config.js';

const DIM = 256;

// 余弦相似度
export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 中英文分词：英文/数字按词，中文按单字
export function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const ascii = lower.match(/[a-z0-9]+/g) || [];
  const cjk = lower.match(/[一-鿿]/g) || [];
  return [...ascii, ...cjk];
}

// 本地确定性嵌入：哈希词袋 + L2 归一化，相似文本余弦更高，零依赖可离线演示
export function localEmbed(text) {
  const vec = new Array(DIM).fill(0);
  for (const t of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    vec[h % DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// Ollama 嵌入 API
async function ollamaEmbed(text) {
  const res = await fetch(`${config.ollamaBaseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.ollamaEmbedModel, prompt: text }),
  });
  if (!res.ok) throw new Error(`ollama embed http ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('ollama embed: missing embedding');
  return data.embedding;
}

// 统一入口：ollama 失败自动降级到本地哈希嵌入
export async function embed(text) {
  if (config.embeddingProvider === 'ollama') {
    try {
      return await ollamaEmbed(text);
    } catch (e) {
      console.warn(`[embeddings] ollama 不可用，降级本地哈希嵌入: ${e.message}`);
      return localEmbed(text);
    }
  }
  return localEmbed(text);
}
