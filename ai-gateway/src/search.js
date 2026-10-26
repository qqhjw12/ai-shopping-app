import { config } from './config.js';
import { embed } from './embeddings.js';
import * as vectorStore from './vectorStore.js';
import * as searchStore from './searchStore.js';
import { sampleProducts } from './data/products.js';

const byId = new Map(sampleProducts.map((p) => [p.id, p]));

// 把 mall 商品写入向量库 + 搜索库
export async function seed() {
  const products = await (await import('./mallClient.js')).fetchProducts();
  const points = [];
  const payloads = [];
  for (const p of products) {
    const text = [p.name, p.description, (p.tags || []).join(' '), p.category, p.brand].join(' ');
    const vector = await embed(text);
    points.push({ id: p.id, vector, payload: p });
    payloads.push({ id: p.id, ...p });
    byId.set(p.id, p);
  }
  await vectorStore.upsert(points);
  await searchStore.index(payloads);
  return products.length;
}

// 混合检索：向量召回 + 关键词召回，按权重融合重排
export async function hybridSearch(query, topK = 5) {
  const qVec = await embed(query);
  const [vec, kw] = await Promise.all([
    vectorStore.search(qVec, topK * 3),
    searchStore.search(query, topK * 3),
  ]);

  const fused = new Map();
  const add = (list, key) => {
    for (const item of list) {
      const cur = fused.get(item.id) || { id: item.id, vector: 0, keyword: 0 };
      cur[key] = item.score;
      fused.set(item.id, cur);
    }
  };
  add(vec, 'vector');
  add(kw, 'keyword');

  const results = [...fused.values()].map((r) => ({
    id: r.id,
    score: r.vector * config.vectorWeight + r.keyword * config.keywordWeight,
    vectorScore: Number(r.vector.toFixed(3)),
    keywordScore: Number(r.keyword.toFixed(3)),
  }));
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, topK).map((r) => ({
    ...byId.get(r.id),
    score: Number(r.score.toFixed(3)),
    vectorScore: r.vectorScore,
    keywordScore: r.keywordScore,
  }));
}

// 按 id 取单个商品（兼容数字 / 字符串 id），供商品问答按 productId 聚焦
export function getProductById(id) {
  if (id == null) return null;
  return byId.get(id) || byId.get(Number(id)) || byId.get(String(id)) || null;
}

// 返回全部已索引商品，供前端商品页 / 演示使用
export function listAllProducts() {
  return [...byId.values()];
}
