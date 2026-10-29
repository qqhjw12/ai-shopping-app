// DummyJSON 开放数据导入（https://dummyjson.com，免费开放 API，用于原型/演示的合成商品数据）
//
// 动机：本站核心品类（手机数码 26 / 服饰鞋包 26 / 家用电器 16…）在真实导入数据
// （图书 19822 / 食品 12397）的衬托下显得空空荡荡。DummyJSON 的 ~200 件合成商品
// 恰好覆盖这些短板品类，全部映射为「海外直邮」叙事，与现有 Open Library /
// Open Food Facts 的进口商品语义一致。
//
// 用法（在 ai-gateway/ 目录下）：
//   node scripts/import-dummyjson.mjs             # 拉取最新数据入库（幂等，可重复执行）
//   node scripts/import-dummyjson.mjs --dry       # 只打印映射结果，不写库
//
// 合规说明：DummyJSON 明确为公开演示 API，无登录、无 ToS 限制条款，图片 CDN 公开可嵌；
// 价格为美元演示价 × 汇率折算，仅用于演示站。
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb } from '../src/db/connection.js';
import { CATEGORIES, SUBCATEGORIES } from '../src/data/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(__dirname, '../.cache/dummyjson-products.json');
const DRY = process.argv.includes('--dry');
const USD_TO_CNY = 7.1;

// DummyJSON 子类目 → 本站两级类目（id 必须存在于 catalog.js）
const CAT_MAP = {
  smartphones: ['phone', 'phone_smart'],
  tablets: ['phone', 'phone_wear'],
  'mobile-accessories': ['phone', 'phone_acc'],
  laptops: ['computer', 'computer_laptop'],
  'mens-watches': ['phone', 'phone_wear'],
  'womens-watches': ['phone', 'phone_wear'],
  vehicle: ['auto', 'auto_ride'],
  motorcycle: ['auto', 'auto_ride'],
  'mens-shirts': ['apparel', 'apparel_top'],
  tops: ['apparel', 'apparel_top'],
  'womens-dresses': ['apparel', 'apparel_top'],
  'mens-shoes': ['apparel', 'apparel_shoe'],
  'womens-shoes': ['apparel', 'apparel_shoe'],
  'womens-bags': ['apparel', 'apparel_shoe'],
  sunglasses: ['apparel', 'apparel_shoe'],
  'womens-jewellery': ['apparel', 'apparel_shoe'],
  fragrances: ['beauty', 'beauty_makeup'],
  'skin-care': ['beauty', 'beauty_skincare'],
  beauty: ['beauty', 'beauty_personal'],
  furniture: ['home', 'home_furniture'],
  'home-decoration': ['home', 'home_clean'],
  'kitchen-accessories': ['kitchen', 'kitchen_store'],
  groceries: ['food', 'food_snack'],
  'sports-accessories': ['sports', 'sports_fitness'],
};

const CNAME = new Map(CATEGORIES.map((c) => [c.id, c.name]));
const SNAME = new Map(SUBCATEGORIES.map((s) => [s.id, s.name]));

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (h * 31 + String(s).charCodeAt(i)) % 100000;
  return h;
}

/** USD 演示价 → 人民币整数（尾数打 9，像正经标价） */
function toCNY(usd) {
  const v = Math.max(9, Math.round((Number(usd) || 0) * USD_TO_CNY));
  return v % 10 === 9 ? v : v - (v % 10) + 9;
}

async function fetchAll() {
  // category-list 先拿全量子类目，再逐类目分页拉取（每类最多 100 条足够覆盖演示库）
  const cats = await (await fetch('https://dummyjson.com/products/category-list')).json();
  const out = [];
  for (const cat of cats) {
    let skip = 0;
    for (;;) {
      const res = await fetch(`https://dummyjson.com/products/category/${encodeURIComponent(cat)}?limit=100&skip=${skip}`);
      if (!res.ok) throw new Error(`fetch ${cat} http ${res.status}`);
      const page = await res.json();
      for (const p of page.products || []) out.push({ ...p, _cat: cat });
      if ((page.skip || 0) + (page.products || []).length >= (page.total || 0)) break;
      skip += 100;
      await new Promise((r) => setTimeout(r, 350)); // 温和限速，不做压测
    }
  }
  return out;
}

function toLocalItem(p) {
  const map = CAT_MAP[p._cat] || CAT_MAP[p.category];
  if (!map) return null; // 未知类目宁缺毋滥
  const [categoryId, subCategoryId] = map;
  const id = `dj_${p.id}`;
  const title = String(p.title || '').trim();
  const brand = (p.brand || 'Overseas Select').trim();
  const rating = Math.min(5, Math.max(3.5, Number(p.rating) || 4.2));
  const price = toCNY(p.price);
  const original = toCNY((Number(p.price) || 0) * 1.25);
  const h = hashStr(id);
  const seed = h % 360;
  const sales = 40 + (h % 2600);
  const pic = p.thumbnail || (p.images && p.images[0]) || '';
  const desc = `海外直邮 · ${title}，${brand} 出品，${CNAME.get(categoryId)}热卖单品。官方渠道采购，支持七天无理由退换，国际物流全程可追踪。`;
  const highlights = ['海外直邮', '正品保障', '七天无理由', '全球联保'];
  const tags = [SNAME.get(subCategoryId) || '进口好物', '海外直邮', p._cat];
  const reviews = [
    { rating: 5, content: '包装完好，物流比预期快，质感对得起价格。', author: '匿名买家', daysAgo: 6 + (h % 20) },
    { rating: 4, content: '和描述一致，做工不错，值得回购。', author: '匿名买家', daysAgo: 12 + (h % 30) },
  ];
  return {
    id,
    name: title,
    brand,
    categoryId,
    subCategoryId,
    price,
    originalPrice: original,
    description: desc,
    tags,
    rating: Math.round(rating * 10) / 10,
    reviewsCount: 18 + (h % 400),
    sales,
    coverColor: `hsl(${seed} 60% 52%),hsl(${(seed + 18) % 360} 62% 46%)`,
    highlight: `${CNAME.get(categoryId)} · 海外直邮`,
    highlights,
    imageUrl: pic,
    skus: [{ id: `dj_sku_${p.id}`, product_id: id, spec: '标准装', price, stock: 30 + (h % 170), status: 'on_sale' }],
    reviews,
    brandId: `br_dj_${hashStr(brand)}`,
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
      p.reviews.forEach((r) => {
        const d = new Date(Date.now() - r.daysAgo * 86400e3).toISOString().slice(0, 10);
        insRev.run(p.id, 'u_demo', r.rating, r.content, r.author, d);
      });
      if (p.brand && p.brandId) {
        const hue = hashStr(p.brand) % 360;
        insBrand.run(p.brandId, p.brand, p.categoryId, `hsl(${hue} 62% 48%)`);
      }
      n += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

async function main() {
  let raw;
  if (existsSync(CACHE) && !process.argv.includes('--refresh')) {
    raw = JSON.parse(readFileSync(CACHE, 'utf8'));
    console.log(`[dummyjson] 使用缓存 ${CACHE}（${raw.length} 条，--refresh 重新拉取）`);
  } else {
    console.log('[dummyjson] 在线拉取中…');
    raw = await fetchAll();
    mkdirSync(dirname(CACHE), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(raw, null, 1));
    console.log(`[dummyjson] 已缓存 ${raw.length} 条`);
  }

  const seen = new Set();
  const items = raw.map(toLocalItem).filter(Boolean).filter((p) => (seen.has(p.id) ? false : seen.add(p.id)));
  const byCat = {};
  items.forEach((p) => { byCat[p.categoryId] = (byCat[p.categoryId] || 0) + 1; });
  console.log(`[dummyjson] 映射结果 ${items.length} 条：`, JSON.stringify(byCat));

  if (DRY) {
    items.slice(0, 5).forEach((p) => console.log(' ', p.id, p.name, '¥' + p.price, '→', p.categoryId + '/' + p.subCategoryId));
    return;
  }

  const db = getDb();
  const n = insertAll(db, items);
  const total = db.prepare('SELECT COUNT(*) c FROM products').get().c;
  console.log(`[dummyjson] 已写入 ${n} 条（全库现共 ${total} 件商品）。重启网关以重建检索索引。`);
}

main().catch((e) => {
  console.error('[dummyjson] 导入失败:', e.message);
  process.exit(1);
});
