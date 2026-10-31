// 克利夫兰艺术博物馆开放数据导入（Cleveland Museum of Art Open Access API）
//
// 动机：图书文娱下的「文创手作 book_hobby」「乐器音像 book_instrument」两个二级类目
// 长期为 0 件。艺术复刻画 / 乐器是博物馆商店的真实商品形态，而克利夫兰艺术博物馆
// 的 Open Access API 是少数「免 API Key、内置 CC0 过滤、图片 CDN 直链」的开放数据源：
//   https://openaccess-api.clevelandart.org/api/artworks/?has_image=1&cc0=1
//   - cc0=1    只返回无权利保留（CC0）的藏品
//   - has_image=1  只返回带图藏品（openaccess-cdn.clevelandart.org 直链）
// 曾尝试 Art Institute of Chicago API，被 Cloudflare 人机校验硬拦（curl 与浏览器 UA 均被挡），
// 改用克利夫兰。数据 CC0、图片 CC0，可商用，无 ToS 问题。
//
// 用法（在 ai-gateway/ 目录下）：
//   npm run db:cleveland            # 拉取（或读缓存）并入库，幂等可重复执行
//   npm run db:cleveland -- --dry   # 只打印映射结果，不写库
//   npm run db:cleveland -- --refresh  # 忽略缓存重新拉取
//   CMA_CAP=3000 npm run db:cleveland  # 控制抓取上限（默认 2000 件）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb } from '../src/db/connection.js';
import { SUBCATEGORIES } from '../src/data/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(__dirname, '../.cache/cma-artworks.json');
const DRY = process.argv.includes('--dry');
const REFRESH = process.argv.includes('--refresh');
const CMA_CAP = Number(process.env.CMA_CAP || 2000);
const PAGE_SIZE = 100;
const HOST = 'https://openaccess-api.clevelandart.org/api/artworks/';

const SNAME = new Map(SUBCATEGORIES.map((s) => [s.id, s.name]));

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed, a, b) {
  const x = (hashStr(String(seed)) * 9301 + 49297) % 233280;
  return a + Math.floor((x / 233280) * (b - a + 1));
}
// 外部源偶有编码事故，字段里混入 U+FFFD 替换符——入库前统一清洗（与 ingest-real-data 同口径）
function sanitizeText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
}
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const REVIEW_POOL = [
  '画芯色彩层次很好，装裱后直接挂客厅，朋友都问在哪买的。',
  '微喷细节到位，纸质厚实，比想象中更有质感。',
  '包装非常严实，边角无损，满意的一次购买。',
  '复刻还原度不错，配框之后氛围感拉满。',
  '选作书房挂画，尺寸标准，安装方便，值得推荐。',
];

async function fetchJSON(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ai-shopping-app-ingest/1.0 (CC0 open-access demo)' } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return null;
}

async function fetchAll() {
  // 缓存合并策略与 ingest-real-data 一致：只增不减，任何一次抓取失败都不丢已抓数据
  const prior = (!REFRESH && existsSync(CACHE)) ? JSON.parse(readFileSync(CACHE, 'utf8')) : [];
  const seen = new Set(prior.map((a) => String(a.id)));
  const out = [...prior];
  console.log(`[cma] 缓存已有 ${prior.length} 条`);
  // 先探 total，再按页推进；单页失败重试后仍无 → 结束本轮（下轮可续抓）
  let skip = 0;
  while (out.length < CMA_CAP) {
    const url = `${HOST}?has_image=1&cc0=1&limit=${PAGE_SIZE}&skip=${skip}`
      + `&fields=id,title,creators,creation_date,type,department,culture,images`;
    const j = await fetchJSON(url);
    const batch = j && j.data;
    if (!batch || !batch.length) { console.warn(`[cma] skip=${skip} 无数据，停止翻页`); break; }
    for (const a of batch) {
      if (out.length >= CMA_CAP) break;
      if (!a || seen.has(String(a.id))) continue;
      if (!a.title || !a.images?.web?.url) continue; // 只保留有图有名字的真实藏品
      seen.add(String(a.id));
      out.push(a);
    }
    console.log(`[cma] skip=${skip} → 累计 ${out.length}`);
    if (batch.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 300)); // 礼貌限速
    if (out.length) { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(out)); }
  }
  if (out.length) { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(out)); }
  return out;
}

// 藏品 → 本站商品。乐器类单分到 book_instrument（乐器音像），其余进 book_hobby（文创手作）
function toLocalItem(a) {
  const type = sanitizeText(a.type);
  const sub = /musical/i.test(type) ? 'book_instrument' : 'book_hobby';
  const id = `cma_${a.id}`;
  const title = sanitizeText(a.title);
  const creator = sanitizeText(a.creators && a.creators[0] && a.creators[0].description) || sanitizeText(a.culture) || '克利夫兰艺术博物馆';
  const year = sanitizeText(a.creation_date);
  const price = rand(id, 68, 688);
  const h = hashStr(id);
  const desc = `《${title}》${creator !== '克利夫兰艺术博物馆' ? ` · ${creator}` : ''}${year ? ` · ${year}` : ''}。克利夫兰艺术博物馆 CC0 开放藏品授权，艺术微喷复刻，高精度还原原作笔触与色彩，支持品质装裱后发货。`;
  return {
    id,
    name: title,
    brand: creator,
    categoryId: 'book',
    subCategoryId: sub,
    price,
    originalPrice: Math.round(price * 1.22),
    description: desc,
    tags: ['艺术复刻', '开放藏品', type || '艺术品', SNAME.get(sub) || '文创'].filter(Boolean),
    rating: 4.6,
    reviewsCount: 5 + (h % 90),
    sales: 10 + (h % 400),
    coverColor: `hsl(265 58% 50%),hsl(283 60% 44%)`,
    highlight: `${SNAME.get(sub) || '文创手作'} · 馆藏复刻`,
    highlights: ['馆藏 CC0 授权', '微喷复刻', '品质装裱可选', '七天无理由'],
    imageUrl: a.images.web.url,
    skus: [
      { id: `${id}-s1`, spec: '画芯 40×50cm', price, stock: rand(id, 20, 120), status: 'on_sale' },
      { id: `${id}-s2`, spec: '装裱 50×60cm', price: Math.round(price * 1.6), stock: rand(id + 'f', 10, 60), status: 'on_sale' },
    ],
    reviews: [
      { rating: 5, content: REVIEW_POOL[h % REVIEW_POOL.length], author: '匿名买家', daysAgo: 5 + (h % 25) },
      { rating: 4, content: REVIEW_POOL[(h >> 3) % REVIEW_POOL.length], author: '真实买家', daysAgo: 15 + (h % 30) },
    ],
    brandId: `br_cma_${hashStr(creator).toString(16).slice(0, 12)}`,
  };
}

function insertAll(db, items) {
  const insP = db.prepare(`INSERT OR REPLACE INTO products
    (id, name, brand, category_id, sub_category_id, price, original_price, description, tags, rating, reviews_count, sales, status, cover_color, highlight, highlights, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on_sale', ?, ?, ?, ?)`);
  const insSku = db.prepare('INSERT OR REPLACE INTO product_skus (id, product_id, spec, price, stock, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insRev = db.prepare('INSERT INTO reviews (product_id, user_id, rating, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insBrand = db.prepare('INSERT OR REPLACE INTO brands (id, name, category_id, logo_color) VALUES (?, ?, ?, ?)');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const p of items) {
      insP.run(p.id, p.name, p.brand, p.categoryId, p.subCategoryId, p.price, p.originalPrice, p.description,
        JSON.stringify(p.tags), p.rating, p.reviewsCount, p.sales, p.coverColor, p.highlight, JSON.stringify(p.highlights), p.imageUrl);
      for (const s of p.skus) insSku.run(s.id, p.id, s.spec, s.price, s.stock, s.status);
      p.reviews.forEach((r) => insRev.run(p.id, 'u_demo', r.rating, sanitizeText(r.content), r.author, daysAgo(r.daysAgo)));
      const hue = hashStr(p.brand) % 360;
      insBrand.run(p.brandId, p.brand, p.categoryId, `hsl(${hue} 62% 48%)`);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

async function main() {
  const raw = await fetchAll();
  const seen = new Set();
  const items = raw.map(toLocalItem)
    .filter(Boolean)
    .filter((p) => (seen.has(p.id) || !p.name || !p.imageUrl ? false : seen.add(p.id)));
  const bySub = {};
  items.forEach((p) => { bySub[p.subCategoryId] = (bySub[p.subCategoryId] || 0) + 1; });
  console.log(`[cma] 映射结果 ${items.length} 件：`, JSON.stringify(bySub));
  if (DRY) {
    items.slice(0, 5).forEach((p) => console.log(' ', p.id, p.name.slice(0, 40), '¥' + p.price, '→', p.subCategoryId));
    return;
  }
  const db = getDb();
  // 幂等：先清旧 cma_ 商品及其引用（评价 / SKU / 购物车 / 收藏 / 品牌），再整批插入。
  // reviews 是纯 INSERT，不先删会在重复执行时翻倍。
  db.exec("DELETE FROM reviews WHERE product_id LIKE 'cma_%'");
  db.exec("DELETE FROM product_skus WHERE product_id LIKE 'cma_%'");
  db.exec("DELETE FROM cart_items WHERE product_id LIKE 'cma_%'");
  db.exec("DELETE FROM favorites WHERE product_id LIKE 'cma_%'");
  db.exec("DELETE FROM products WHERE id LIKE 'cma_%'");
  db.exec("DELETE FROM brands WHERE id LIKE 'br_cma_%'");
  const n = insertAll(db, items);
  const total = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  console.log(`[cma] 已写入 ${n} 件（全库现共 ${total} 件商品）。重启网关以重建检索索引。`);
}

main().catch((e) => {
  console.error('[cma] 导入失败:', e.message);
  process.exit(1);
});
