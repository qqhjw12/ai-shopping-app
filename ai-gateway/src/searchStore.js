import { config, useReal } from './config.js';
import { tokenize } from './embeddings.js';

// 内存兜底：关键词倒排 + 子串匹配
const docs = new Map(); // id -> { text, payload }

async function ensureIndex() {
  const res = await fetch(`${config.elasticsearchUrl}/${config.esIndex}`, { method: 'HEAD' });
  if (res.ok) return;
  await fetch(`${config.elasticsearchUrl}/${config.esIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mappings: {
        properties: {
          name: { type: 'text' },
          description: { type: 'text' },
          tags: { type: 'keyword' },
          category: { type: 'keyword' },
        },
      },
    }),
  });
}

async function esIndex(doc) {
  await ensureIndex();
  const res = await fetch(`${config.elasticsearchUrl}/${config.esIndex}/_doc/${doc.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc.payload),
  });
  if (!res.ok) throw new Error(`es index http ${res.status}`);
}

async function esSearch(query, topK) {
  const res = await fetch(`${config.elasticsearchUrl}/${config.esIndex}/_search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      size: topK,
      query: {
        multi_match: {
          query,
          fields: ['name^3', 'tags^2', 'description', 'category'],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`es search http ${res.status}`);
  const data = await res.json();
  return (data.hits?.hits || []).map((h) => ({
    id: String(h._id),
    score: h._score || 0,
  }));
}

// payload 需含 name/description/tags/category 等文本字段
export async function index(payloads) {
  for (const p of payloads) {
    const text = [p.name, p.description, (p.tags || []).join(' '), p.category].join(' ');
    docs.set(p.id, { text, payload: p });
  }
  if (useReal()) {
    try {
      for (const p of payloads) await esIndex(p);
    } catch (e) {
      console.warn(`[searchStore] ES 写入失败，仅内存可用: ${e.message}`);
    }
  }
}

// 返回 [{ id, score }] 归一化到 0..1
export async function search(query, topK = 10) {
  if (useReal()) {
    try {
      return normalize(await esSearch(query, topK));
    } catch (e) {
      console.warn(`[searchStore] ES 查询失败，降级内存检索: ${e.message}`);
    }
  }
  const qTokens = tokenize(query);
  const scored = [];
  for (const [id, item] of docs) {
    const dTokens = tokenize(item.text);
    const set = new Set(dTokens);
    let hit = 0;
    for (const t of qTokens) if (set.has(t)) hit++;
    // 子串加分
    const substr = item.text.toLowerCase().includes(query.toLowerCase()) ? 0.3 : 0;
    const score = qTokens.length ? (hit / qTokens.length) * 0.7 + substr : substr;
    scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function normalize(items) {
  const max = Math.max(1, ...items.map((i) => i.score));
  return items.map((i) => ({ id: i.id, score: i.score / max }));
}

export function count() {
  return docs.size;
}
