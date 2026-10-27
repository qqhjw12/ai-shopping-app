// 真实商品数据导入管线（compliant ingestion pipeline）
//
// 借鉴 GitHub 上的开源数据项目，合规地抓取「开放许可」的商品数据填充数据库：
//   - Free-Ecommerce-Products-Api (Kolzsticks)：开放使用，含真实商品图与美元标价
//   - Open Food Facts：ODbL 开放数据库，CC-BY 商品图，适合做「食品生鲜」真实数据
//
// 设计原则：只采用明确可商用的开放源，绝不抓取任何商业站点受保护数据（违反 ToS / 版权）。
// 图片统一存 URL，前端在离线或图床不可达时回退到程序化 SVG 封面，保证不出现破图。
//
// 用法（在 ai-gateway/ 目录下）：
//   npm run db:ingest                 # 用 .cache 里的快照填充（离线、可复现，默认）
//   npm run db:ingest -- --fetch      # 实时抓取最新数据写入 .cache 再填充（需联网）
//   npm run db:ingest -- --reset      # 清空已导入的真实商品后重灌
//   npm run db:ingest -- --no-demo    # 不生成 web 演示数据
//   npm run db:ingest -- --fetch --limit 5000   # 仅抓 5000 条做快速验证
//   OFF_CAP=50000 npm run db:ingest -- --fetch  # 环境变量控制 Open Food Facts 抓取上限（默认 20000）
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb } from '../src/db/connection.js';
import { ensureSeeded } from '../src/db/seedDb.js';
import { CATEGORIES, SUBCATEGORIES } from '../src/data/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '../.cache');
const DEMO_OUT = resolve(__dirname, '../../web/js/demo-real-data.js');

const ARGS = new Set(process.argv.slice(2));
const FETCH = ARGS.has('--fetch');
const RESET = ARGS.has('--reset');
const NO_DEMO = ARGS.has('--no-demo');
// 抓取数量上限：--limit N 优先，其次环境变量 OFF_CAP，默认尽量把库做大
const LIMIT = [...ARGS].find((a) => a.startsWith('--limit='));
const OFF_CAP = LIMIT ? Number(LIMIT.split('=')[1]) || 20000 : Number(process.env.OFF_CAP || 20000);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 演示汇率（仅用于价格展示统一为人民币）
const USD_TO_CNY = 7.1;
const EUR_TO_CNY = 7.8;

// ---------- 类目映射（开放数据英文类目 → 本站两级类目） ----------
const FE_TOP = {
  'Beauty & Personal Care': 'beauty',
  'Electronics & Gadgets': 'phone',
  'Fashion & Apparel': 'apparel',
  'Home & Kitchen': 'home',
  'Health & Fitness': 'health',
};
const FE_SUB_FALLBACK = { beauty: 'beauty_personal', phone: 'computer_desk', apparel: 'apparel_top', home: 'home_furniture', health: 'health_monitor' };

function feSub(catId, sub) {
  const s = (sub || '').toLowerCase();
  if (catId === 'beauty') {
    if (/skin|moistur|serum|lotion|cream/i.test(s)) return 'beauty_skincare';
    if (/makeup|foundation|lipstick|nail|cosmetic/i.test(s)) return 'beauty_makeup';
    return 'beauty_personal';
  }
  if (catId === 'phone') {
    if (/audio|headphone|speaker|earbud|sound/i.test(s)) return 'audio_speaker';
    if (/phone|mobile|smartphone/i.test(s)) return 'phone_smart';
    if (/watch|wearable|fitness tracker/i.test(s)) return 'phone_wear';
    if (/tv|television/i.test(s)) return 'computer_monitor';
    if (/laptop|computer/i.test(s)) return 'computer_laptop';
    if (/tablet/i.test(s)) return 'phone_wear';
    if (/camera/i.test(s)) return 'computer_desk';
    return 'computer_desk';
  }
  if (catId === 'apparel') {
    if (/foot|shoe|sneaker|heel|slipper|boot/i.test(s)) return 'apparel_shoe';
    if (/accessor|bag|handbag|sunglass|wallet/i.test(s)) return 'apparel_shoe';
    return 'apparel_top';
  }
  if (catId === 'home') {
    if (/furniture|sofa|rug|decor|chair|table|desk/i.test(s)) return 'home_furniture';
    if (/bed|mattress|pillow/i.test(s)) return 'home_bedding';
    if (/kitchen applian|refriger|appliance|vacuum/i.test(s)) return 'appliance_kitchen';
    if (/cookware|pot|pan|bake/i.test(s)) return 'kitchen_pot';
    if (/dinner|tableware|plate|bowl|serve/i.test(s)) return 'kitchen_table';
    if (/lamp|light/i.test(s)) return 'home_clean';
    if (/clean|storage|organiz/i.test(s)) return 'home_clean';
    return 'home_furniture';
  }
  if (catId === 'health') {
    if (/fit|treadmill|dumbbell|gym|equip/i.test(s)) return 'sports_fitness';
    if (/nutrition|protein|supplement|vitamin/i.test(s)) return 'health_supplement';
    if (/monitor|pressure|thermometer/i.test(s)) return 'health_monitor';
    if (/first aid|medical/i.test(s)) return 'health_care';
    if (/glove|knee|gear|sport/i.test(s)) return 'sports_wear';
    return 'health_monitor';
  }
  return FE_SUB_FALLBACK[catId] || catId;
}

// 食品生鲜（Open Food Facts）二级类目推断
function offSub(tags) {
  const t = (tags || []).join(' ').toLowerCase();
  if (/beverage|drink|soda|juice|tea|coffee|water|dairy.?drink|yogurt/i.test(t)) return 'food_drink';
  if (/snack|biscuit|chocolat|cookie|confection|candy|sweet|chip|crisp/i.test(t)) return 'food_snack';
  return 'food_grain';
}

// ---------- 工具 ----------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed, a, b) {
  const x = (hashStr(String(seed)) * 9301 + 49297) % 233280;
  return a + Math.floor((x / 233280) * (b - a + 1));
}
const CATHUE = { phone: 212, computer: 200, audio: 280, appliance: 190, apparel: 330, food: 25, home: 18, sports: 145, beauty: 340, baby: 50, book: 265, kitchen: 15, pet: 30, auto: 220, health: 160, stationery: 230 };
function gradient(catId, id) {
  const base = CATHUE[catId] ?? 200;
  const h = base + ((hashStr(id) % 26) - 13);
  const h2 = h + 18;
  return `hsl(${h} 60% 52%),hsl(${h2} 62% 46%)`;
}

const CNAME = new Map(CATEGORIES.map((c) => [c.id, c.name]));
const SNAME = new Map(SUBCATEGORIES.map((s) => [s.id, s.name]));

const REVIEW_POOL = [
  '东西收到了，包装很用心，质量超出预期，推荐！',
  '用了一段时间，性价比很高，会回购。',
  '物流很快，客服态度也好，整体体验不错。',
  '实物和描述一致，没有色差，满意。',
  '朋友推荐来的，确实好用，已经安利给同事了。',
  '做工扎实，细节到位，这个价位很能打。',
  '客服回复及时，售后有保障，放心买。',
  '用了几天才来评价，稳定可靠，值得入手。',
];
function makeReviews(id, rating) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const r = Math.max(3, Math.min(5, Math.round(rating) + (i % 2 ? 1 : 0)));
    out.push({ rating: r, content: REVIEW_POOL[(hashStr(id) + i) % REVIEW_POOL.length], author: ['真实买家', '匿名用户', '老顾客'][i % 3], daysAgo: 10 + i * 7 });
  }
  return out;
}
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function mapFreeEcom(p) {
  const catId = FE_TOP[p.category] || 'phone';
  const sub = feSub(catId, p.subCategory);
  const id = `fe_${p.id}`;
  const price = Math.round((p.priceCents || 0) / 100 * USD_TO_CNY);
  const original = Math.round(price * 1.18);
  const rating = p.rating?.stars || 4.6;
  const reviewsCount = p.rating?.count || 0;
  const sales = reviewsCount * 7 + (hashStr(id) % 50);
  const tags = [...(p.keywords || []).slice(0, 4), SNAME.get(sub) || ''].filter(Boolean);
  const stock1 = rand(id, 30, 160);
  const hasGift = hashStr(id) % 2 === 0;
  return {
    id,
    name: p.name,
    brand: '',
    categoryId: catId,
    subCategoryId: sub,
    price,
    originalPrice: original,
    description: p.description || '',
    tags,
    rating,
    reviewsCount,
    sales,
    coverColor: gradient(catId, id),
    highlight: SNAME.get(sub) || p.subCategory || '',
    highlights: ['正品保障', '顺丰包邮', '七天无理由', '支持退换'],
    imageUrl: p.image || '',
    skus: [
      { id: `${id}-s1`, spec: '标准装', price, stock: stock1, status: 'on_sale' },
      ...(hasGift ? [{ id: `${id}-s2`, spec: '礼盒装', price: Math.round(price * 1.25), stock: rand(id + 'g', 10, 60), status: 'on_sale' }] : []),
    ],
    reviews: makeReviews(id, rating),
  };
}

function mapOFF(p) {
  const catId = 'food';
  const sub = offSub(p.categories_tags);
  const id = `off_${p.code}`;
  let price = parseFloat((p.price || '').replace(/[^0-9.]/g, ''));
  const cur = (p.price || '').trim();
  if (price > 0 && /€|eur|euro/i.test(cur)) price = Math.round(price * EUR_TO_CNY);
  else if (price > 0 && /\$|usd/i.test(cur)) price = Math.round(price * USD_TO_CNY);
  else price = rand(id, 5, 90); // OFF 价格稀疏时按食品合理区间生成（演示用）
  const original = Math.round(price * 1.12);
  const rating = 4.6;
  const reviewsCount = rand(id, 5, 120);
  const sales = reviewsCount * 6 + (hashStr(id) % 40);
  const brand = (p.brands || '').split(',')[0]?.trim() || '';
  const tags = [...(p.categories_tags || []).slice(0, 3).map((t) => t.replace(/-/g, ' ')), SNAME.get(sub) || ''].filter(Boolean);
  const name = p.product_name || id;
  const stock1 = rand(id, 40, 200);
  return {
    id,
    name,
    brand,
    categoryId: catId,
    subCategoryId: sub,
    price,
    originalPrice: original,
    description: p.generic_name || name,
    tags,
    rating,
    reviewsCount,
    sales,
    coverColor: gradient(catId, id),
    highlight: SNAME.get(sub) || '食品生鲜',
    highlights: ['产地直发', '冷链保鲜', '正品溯源', '七天无理由'],
    imageUrl: p.image_front_url || '',
    skus: [{ id: `${id}-s1`, spec: '标准装', price, stock: stock1, status: 'on_sale' }],
    reviews: makeReviews(id, rating),
    brandId: brand ? `br_off_${Buffer.from(brand).toString('hex').slice(0, 16)}` : null,
  };
}

// ---------- 抓取 ----------
async function fetchFreeEcom() {
  const res = await fetch('https://kolzsticks.github.io/Free-Ecommerce-Products-Api/main/products.json', {
    headers: { 'User-Agent': 'ai-shopping-app-ingest/1.0' },
  });
  if (!res.ok) throw new Error('freeEcom http ' + res.status);
  return res.json();
}
async function fetchOFF() {
  // Open Food Facts v2 搜索 API（ODbL 开放库，CC-BY 图）：每页 1000 条，分页抓取，尽量把库做大。
  // 只保留「有商品名 + 有封面图」的真实条目；限流/错误自动重试并退避；断网直接抛出由上層回退缓存。
  const cats = [
    'biscuits', 'chocolates', 'breakfast-cereals', 'teas', 'coffees', 'yogurts', 'snacks',
    'canned-foods', 'pizzas', 'soft-drinks', 'juices', 'cheeses', 'breads', 'pastas', 'rice',
    'fruits', 'vegetables', 'meats', 'fish', 'eggs', 'oils', 'sauces', 'soups', 'frozen-foods',
    'beverages', 'dairy-drinks', 'plant-based-foods', 'baby-foods', 'condiments', 'spreads',
    'cocoa-and-chocolate', 'instant-beverages', 'ice-creams', 'prepared-salads', 'seafood',
  ];
  const fields = 'code,product_name,brands,categories_tags,image_front_url,price,generic_name';
  const seen = new Set();
  const out = [];
  for (const c of cats) {
    if (out.length >= OFF_CAP) break;
    let page = 1;
    while (page <= 4 && out.length < OFF_CAP) {
      const url = `https://world.openfoodfacts.org/api/v2/search?categories_tags=${encodeURIComponent(c)}&page_size=1000&page=${page}&fields=${fields}&json=1`;
      let j = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'ai-shopping-app-ingest/1.0 (educational demo)' } });
          if (res.status === 429 || res.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
          if (!res.ok) break;
          j = await res.json();
          break;
        } catch (e) {
          if (attempt === 3) throw e; // 断网等致命错误上浮，由上层回退到本地快照
          await sleep(600 * (attempt + 1));
        }
      }
      if (!j || !j.products || !j.products.length) break;
      for (const p of j.products) {
        if (out.length >= OFF_CAP) break;
        const code = String(p.code || p._id || '');
        if (!code || seen.has(code)) continue;
        if (!p.product_name || !p.image_front_url) continue; // 只留有图有名字的真实商品
        seen.add(code);
        out.push(p);
      }
      page++;
      await sleep(250); // 礼貌限速
    }
    console.log(`    · ${c}: 累计 ${out.length}`);
    saveCache('openfoodfacts-products.json', out); // 每类目增量落盘，超时可续跑不丢进度
  }
  return out;
}
function loadCache(name, fallback) {
  const f = resolve(CACHE_DIR, name);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  return fallback;
}
function saveCache(name, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(resolve(CACHE_DIR, name), JSON.stringify(data, null, 2));
}

// ---------- 写入 ----------
function insertProducts(db, items) {
  const insP = db.prepare(`INSERT OR REPLACE INTO products
    (id, name, brand, category_id, sub_category_id, price, original_price, description, tags, rating, reviews_count, sales, status, cover_color, highlight, highlights, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insSku = db.prepare('INSERT OR REPLACE INTO product_skus (id, product_id, spec, price, stock, status) VALUES (?, ?, ?, ?, ?, ?)');
  const insRev = db.prepare('INSERT INTO reviews (product_id, user_id, rating, content, author, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const insBrand = db.prepare('INSERT OR REPLACE INTO brands (id, name, category_id, logo_color) VALUES (?, ?, ?, ?)');
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const p of items) {
      insP.run(p.id, p.name, p.brand, p.categoryId, p.subCategoryId, p.price, p.originalPrice, p.description, JSON.stringify(p.tags), p.rating, p.reviewsCount, p.sales, 'on_sale', p.coverColor, p.highlight, JSON.stringify(p.highlights), p.imageUrl);
      for (const s of p.skus) insSku.run(s.id, p.id, s.spec, s.price, s.stock, s.status);
      for (const r of p.reviews) insRev.run(p.id, 'u_demo', r.rating, r.content, r.author, daysAgo(r.daysAgo));
      if (p.brand && p.brandId) {
        const hue = hashStr(p.brand) % 360;
        insBrand.run(p.brandId, p.brand, p.categoryId, `hsl(${hue} 62% 48%)`);
      }
      n++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

// ---------- 演示数据输出（供 GitHub Pages 纯静态站使用） ----------
function emitDemo(items) {
  if (NO_DEMO) return 0;
  const rows = items.map((p) => ({
    id: p.id,
    name: p.name,
    brand: p.brand,
    category: CNAME.get(p.categoryId) || '',
    categoryId: p.categoryId,
    subCategory: SNAME.get(p.subCategoryId) || '',
    subCategoryId: p.subCategoryId,
    price: p.price,
    originalPrice: p.originalPrice,
    tags: p.tags,
    description: p.description,
    highlight: p.highlight,
    highlights: p.highlights,
    coverColor: p.coverColor,
    rating: p.rating,
    reviewsCount: p.reviewsCount,
    sales: p.sales,
    skus: p.skus,
    pic: p.imageUrl,
  }));
  const banner = '// 真实开放数据商品（由 scripts/ingest-real-data.mjs 生成，请勿手改）\n'
    + '// 数据源：Free-Ecommerce-Products-Api（开放使用）/ Open Food Facts（ODbL）。图片为各源 CC / 开放许可图。\n'
    + '// 网关不可达时前端回退到此数据，保证 GitHub Pages 纯静态演示也能看到真实商品与图片。\n';
  writeFileSync(DEMO_OUT, banner + 'export const demoRealProducts = ' + JSON.stringify(rows, null, 2) + ';\n');
  return rows.length;
}

// ---------- 主流程 ----------
async function main() {
  // 确保库结构与演示种子就绪（含 v5 image_url 列），幂等
  const seeded = ensureSeeded();
  const db = getDb();

  if (RESET) {
    db.exec("DELETE FROM products WHERE id LIKE 'fe_%' OR id LIKE 'off_%'");
    db.exec("DELETE FROM reviews WHERE product_id LIKE 'fe_%' OR product_id LIKE 'off_%'");
    db.exec("DELETE FROM product_skus WHERE product_id LIKE 'fe_%' OR product_id LIKE 'off_%'");
    db.exec("DELETE FROM brands WHERE id LIKE 'br_off_%'");
  }

  let feRaw = [];
  let offRaw = [];
  if (FETCH) {
    console.log('[*] 实时抓取 Free-Ecommerce-Products-Api ...');
    try {
      feRaw = await fetchFreeEcom();
      saveCache('freeecom-products.json', feRaw);
      console.log(`[*] 已缓存 ${feRaw.length} 条`);
    } catch (e) {
      console.warn('[!] Free-Ecommerce 抓取失败，回退本地快照：', e.message);
      feRaw = loadCache('freeecom-products.json', []);
    }
    console.log('[*] 实时抓取 Open Food Facts（食品生鲜，ODbL 开放库）...');
    try {
      offRaw = await fetchOFF();
      saveCache('openfoodfacts-products.json', offRaw);
      console.log(`[*] 已缓存 ${offRaw.length} 条`);
    } catch (e) {
      console.warn('[!] OFF 抓取失败（断网/限流），本次跳过，可使用已缓存快照或稍后重试：', e.message);
    }
  } else {
    feRaw = loadCache('freeecom-products.json', []);
    offRaw = loadCache('openfoodfacts-products.json', []);
  }

  const items = [...feRaw.map(mapFreeEcom), ...offRaw.map(mapOFF).filter(Boolean)];
  if (!items.length) {
    console.warn('[!] 没有可导入的真实商品数据（请先 --fetch 或放置 .cache 快照）');
    return;
  }

  const n = insertProducts(db, items);
  const dN = emitDemo(items);
  const total = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  console.log(`[✓] 导入真实商品 ${n} 款（Free-Ecommerce ${feRaw.length} + Open Food Facts ${offRaw.length}）`);
  if (dN) console.log(`[✓] 已生成 web 演示数据 ${dN} 款 -> web/js/demo-real-data.js`);
  console.log(`[✓] 当前数据库商品总数：${total}（含原有演示数据 ${seeded.products}）`);
}

main().catch((e) => { console.error('[x] 导入失败:', e); process.exit(1); });
