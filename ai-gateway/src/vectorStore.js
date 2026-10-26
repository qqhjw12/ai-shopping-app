import { config, useReal } from './config.js';
import { cosine } from './embeddings.js';

// 内存兜底：始终维护，保证 local 模式与真实服务异常时可用
const mem = new Map(); // id -> { vector, payload }

async function ensureCollection() {
  const url = `${config.qdrantUrl}/collections/${config.collection}`;
  const get = await fetch(url);
  if (get.ok) return;
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: { size: 256, distance: 'Cosine' },
    }),
  });
}

async function qdrantUpsert(points) {
  await ensureCollection();
  const res = await fetch(`${config.qdrantUrl}/collections/${config.collection}/points`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points }),
  });
  if (!res.ok) throw new Error(`qdrant upsert http ${res.status}`);
}

async function qdrantSearch(vector, topK) {
  const res = await fetch(`${config.qdrantUrl}/collections/${config.collection}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, limit: topK, with_payload: true }),
  });
  if (!res.ok) throw new Error(`qdrant search http ${res.status}`);
  const data = await res.json();
  return (data.result || []).map((r) => ({ id: String(r.id), score: r.score }));
}

// points: [{ id, vector, payload }]
export async function upsert(points) {
  for (const p of points) mem.set(p.id, { vector: p.vector, payload: p.payload });
  if (useReal()) {
    try {
      await qdrantUpsert(points);
    } catch (e) {
      console.warn(`[vectorStore] Qdrant 写入失败，仅内存可用: ${e.message}`);
    }
  }
}

// 返回 [{ id, score }] 按分数降序
export async function search(vector, topK = 10) {
  if (useReal()) {
    try {
      return await qdrantSearch(vector, topK);
    } catch (e) {
      console.warn(`[vectorStore] Qdrant 查询失败，降级内存检索: ${e.message}`);
    }
  }
  const scored = [];
  for (const [id, item] of mem) {
    scored.push({ id, score: cosine(vector, item.vector) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export function count() {
  return mem.size;
}
