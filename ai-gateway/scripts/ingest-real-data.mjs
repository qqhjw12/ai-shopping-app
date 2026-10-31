// 真实商品数据导入管线（compliant ingestion pipeline）
//
// 借鉴 GitHub 上的开源数据项目，合规地抓取「开放许可」的商品数据填充数据库：
//   - Free-Ecommerce-Products-Api (Kolzsticks)：开放使用，含真实商品图与美元标价
//   - Open Food Facts：ODbL 开放数据库，CC-BY 商品图，适合做「食品生鲜」真实数据
//   - Open Library：开放图书元数据（CC0 / 开放许可封面），适合做「图书文娱」真实数据
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
//   OFF_CAP=60000 npm run db:ingest -- --fetch  # 环境变量控制 Open Food Facts 抓取上限（默认 40000）
//   INGEST_FAMILIES=obf,opf,ol npm run db:ingest -- --fetch  # 只实时抓取指定家族（美妆/宠物/图书），其余从缓存载入（避开不可达库）
//   OL_CAP=30000 npm run db:ingest -- --fetch  # 控制 Open Library 图书抓取上限（默认 25000）
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
// 抓取数量上限：--limit N / --limit=N 均可，其次环境变量 OFF_CAP，默认尽量把库做大
const argv = process.argv.slice(2);
const liIdx = argv.indexOf('--limit');
const LIMIT = argv.find((a) => a.startsWith('--limit=')) || (liIdx !== -1 && argv[liIdx + 1] ? `--limit=${argv[liIdx + 1]}` : null);
const OFF_CAP = LIMIT ? Number(LIMIT.split('=')[1]) || 40000 : Number(process.env.OFF_CAP || 40000);
// Open Library（图书）抓取上限：默认 25000，可通过 OL_CAP 调整
const OL_CAP = LIMIT ? Number(LIMIT.split('=')[1]) || 25000 : Number(process.env.OL_CAP || 25000);
// 静态演示包上限：库可以无限大，但 web/js/demo-real-data.js 只保留代表性子集，保证 Pages 首屏速度
const DEMO_CAP = Number(process.env.DEMO_CAP || 3000);
// 真实商品 ID 前缀集合（fe_/off_/obf_/opf_/oprf_/ol_），用于全量同步时统一清理
const REAL_PAT = "'fe_%' OR id LIKE 'off_%' OR id LIKE 'obf_%' OR id LIKE 'opf_%' OR id LIKE 'oprf_%' OR id LIKE 'ol_%'";
const BRAND_PAT = "'br_fe_%' OR id LIKE 'br_off_%' OR id LIKE 'br_obf_%' OR id LIKE 'br_opf_%' OR id LIKE 'br_oprf_%' OR id LIKE 'br_ol_%'";
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

// Open Food Facts 商品的一级类目推断：默认食品生鲜，命中非食品标签时分流到对应一级类目
function offTopCategory(tags) {
  const t = (tags || []).join(' ').toLowerCase();
  if (/cosmetic|makeup|make-up|lipstick|foundation|mascara|eyeshadow|perfume|fragrance|deodorant|shampoo|conditioner|soap|toothpaste|sunscreen|skin-care|skincare|moisturizer|cleanser/i.test(t)) return 'beauty';
  if (/pet.?food|cat.?food|dog.?food|feline|canine/i.test(t)) return 'pet';
  // 婴儿分流：除 baby/infant 外，纸尿裤类标签（diapers/nappies/nappy）也要进母婴——
  // 这类商品按字面是「卫生用品」，tags 里可能一个 baby 字样都没有
  if (/baby|infant|toddler|diaper|napp(y|ie)/i.test(t)) return 'baby';
  if (/dietary.?supplement|vitamin|sport.?nutrition|protein|nutri/i.test(t)) return 'health';
  return 'food';
}
// Open Food Facts 二级类目推断（按一级类目分别匹配）
function offSub(catId, tags) {
  const t = (tags || []).join(' ').toLowerCase();
  if (catId === 'beauty') {
    if (/makeup|make-up|foundation|lipstick|mascara|eyeshadow|perfume|fragrance/i.test(t)) return 'beauty_makeup';
    if (/skin|moistur|serum|cream|lotion|cleanser|sunscreen|care/i.test(t)) return 'beauty_skincare';
    return 'beauty_personal';
  }
  if (catId === 'pet') {
    if (/cat|feline/i.test(t)) return 'pet_cat';
    if (/dog|canine/i.test(t)) return 'pet_dog';
    return 'pet_accessory';
  }
  if (catId === 'baby') {
    if (/milk|formula|infant/i.test(t)) return 'baby_milk';
    if (/toy|game|play/i.test(t)) return 'baby_toy';
    return 'baby_care';
  }
  if (catId === 'health') {
    if (/vitamin|supplement|protein|nutri/i.test(t)) return 'health_supplement';
    if (/care|medical|device|monitor|thermometer|pressure/i.test(t)) return 'health_care';
    return 'health_monitor';
  }
  // 默认（food）
  if (/beverage|drink|soda|juice|tea|coffee|water|dairy.?drink|yogurt/i.test(t)) return 'food_drink';
  if (/snack|biscuit|chocolat|cookie|confection|candy|sweet|chip|crisp|cake|pastry|ice/i.test(t)) return 'food_snack';
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

function mapOFF(p, prefix = 'off') {
  const forceCat = { obf: 'beauty', opf: 'pet', oprf: 'health' }[prefix] || null;
  const catId = forceCat || offTopCategory(p.categories_tags);
  const sub = offSub(catId, p.categories_tags);
  const id = `${prefix}_${p.code}`;
  let price = parseFloat((p.price || '').replace(/[^0-9.]/g, ''));
  const cur = (p.price || '').trim();
  if (price > 0 && /€|eur|euro/i.test(cur)) price = Math.round(price * EUR_TO_CNY);
  else if (price > 0 && /\$|usd/i.test(cur)) price = Math.round(price * USD_TO_CNY);
  else price = rand(id, 5, 90); // OFF 价格稀疏时按合理区间生成（演示用）
  const original = Math.round(price * 1.12);
  const rating = 4.6;
  const reviewsCount = rand(id, 5, 120);
  const sales = reviewsCount * 6 + (hashStr(id) % 40);
  const brand = (p.brands || '').split(',')[0]?.trim() || '';
  const tags = [...(p.categories_tags || []).slice(0, 3).map((t) => t.replace(/-/g, ' ')), SNAME.get(sub) || ''].filter(Boolean);
  const name = p.product_name || id;
  const stock1 = rand(id, 40, 200);
  const isFood = catId === 'food';
  const highlights = isFood
    ? ['产地直发', '冷链保鲜', '正品溯源', '七天无理由']
    : ['正品保障', '顺丰包邮', '七天无理由', '支持退换'];
  const highlight = SNAME.get(sub) || (isFood ? '食品生鲜' : '真实好物');
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
    highlight,
    highlights,
    imageUrl: p.image_front_url || '',
    skus: [{ id: `${id}-s1`, spec: '标准装', price, stock: stock1, status: 'on_sale' }],
    reviews: makeReviews(id, rating),
    brandId: brand ? `br_${prefix}_${Buffer.from(brand).toString('hex').slice(0, 16)}` : null,
  };
}

// ---------- Open Library 图书数据源（开放元数据，封面为 Open Library 开放图）----------
// 图书是 Open Food Facts 家族无法覆盖的「其他类目」中，唯一可稳定爬取真实商品的开放源。
// 按 subject 分流到「图书文娱」的二级类目（畅销图书 / 文创手作 / 乐器音像）。
function mapOpenLibrary(p) {
  const workKey = String(p.key || '').replace(/^\/works\//, '');
  const id = `ol_${workKey || hashStr(p.title)}`;
  if (!p.title) return null;
  const author = (p.author_name && p.author_name[0]) || '佚名';
  const sub = p._sub || 'book_read';
  const subjectLabel = (p._subject || '').replace(/_/g, ' ');
  const year = p.first_publish_year || '';
  const price = rand(id, 22, 188);
  const original = Math.round(price * 1.25);
  const rating = 4.6;
  const reviewsCount = rand(id, 6, 400);
  const sales = reviewsCount * 5 + (hashStr(id) % 50);
  const tags = ['正版图书', '纸质书', SNAME.get(sub) || '图书', subjectLabel].filter(Boolean);
  const desc = `《${p.title}》${author !== '佚名' ? `由${author}所著` : ''}${year ? `，${year}年出版` : ''}，收录于「${subjectLabel || '综合'}」主题，正版馆藏、塑封发货。`;
  const cover = p.cover_i ? `https://covers.openlibrary.org/b/id/${p.cover_i}-L.jpg` : '';
  const brandId = `br_ol_${Buffer.from(author).toString('hex').slice(0, 16)}`;
  return {
    id,
    name: p.title,
    brand: author,
    categoryId: 'book',
    subCategoryId: sub,
    price,
    originalPrice: original,
    description: desc,
    tags,
    rating,
    reviewsCount,
    sales,
    coverColor: gradient('book', id),
    highlight: SNAME.get(sub) || '正版好书',
    highlights: ['正版图书', '塑封完好', '七天无理由', '破损包换'],
    imageUrl: cover,
    skus: [{ id: `${id}-s1`, spec: '标准装', price, stock: rand(id, 30, 200), status: 'on_sale' }],
    reviews: makeReviews(id, rating),
    brandId,
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

const MAX_PAGE_RETRY = 5;
// 单页抓取 + 韧性重试：429/5xx 指数退避 + 抖动；其他 4xx 返回 null（该类目结束）；重试耗尽返回 undefined
async function fetchPage(url) {
  for (let attempt = 0; attempt < MAX_PAGE_RETRY; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ai-shopping-app-ingest/1.0 (educational demo)' } });
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(20000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500); // 指数退避 + 抖动
        await sleep(wait);
        continue;
      }
      if (!res.ok) return null; // 其他 4xx：该类目无更多数据
      return await res.json();
    } catch (e) {
      if (attempt === MAX_PAGE_RETRY - 1) throw e; // 断网等致命错误上浮由上层回退
      await sleep(Math.min(20000, 1000 * 2 ** attempt));
    }
  }
  return undefined; // 重试耗尽仍失败
}

// ---------- Open Food Facts 家族数据源（均 ODbL 开放，CC-BY 图）----------
// 主食品库 + 美妆库 + 宠物粮库 + 商品事实库，覆盖食品生鲜与合规非食品类目
const BEAUTY_CATS = [
  'shampoos', 'make-up', 'makeup', 'foundations', 'lipsticks', 'mascara', 'eyeshadows',
  'perfumes', 'fragrances', 'deodorants', 'soaps', 'toothpastes', 'sunscreens',
  'skincare', 'creams', 'moisturizers', 'cleansers', 'lip-balms', 'cosmetics',
  // 扩展标签（探针实测首页即有带图商品）：护发/美甲/身体/面部/彩妆/男士护理
  'serum', 'serums', 'toner', 'nail-polish', 'nail-polishes', 'nail-care',
  'hair-dye', 'hair-color', 'hair-gel', 'hair-spray', 'hair-mask',
  'conditioner', 'conditioners', 'body-care', 'body-wash', 'body-lotion', 'body-oil',
  'face-wash', 'facial-cleanser', 'face-care', 'concealer', 'powder', 'blush',
  'eyeliner', 'make-up-remover', 'after-sun-care', 'shaving', 'shaving-foam', 'shaving-cream',
  'beard-oil', 'oral-care', 'mouthwash', 'wipes',
  // 第二轮扩展（探针实测首页高带图率）：手护/发油/干洗/面膜/卸妆/美黑/淡香/古龙/止汗/棉签/剃须/须后/脱毛
  'lip-gloss', 'hand-cream', 'hair-oil', 'dry-shampoo', 'face-mask', 'eye-makeup-remover',
  'self-tanner', 'eau-de-toilette', 'cologne', 'antiperspirant', 'cotton-swab', 'shaving-gel',
  'aftershave', 'hair-removal',
];
const PET_CATS = ['dog-foods', 'cat-foods', 'pet-foods', 'pet-care', 'bird-foods', 'fish-foods', 'dog-treats', 'cat-treats', 'rodent-food', 'reptile-food', 'bird-food', 'fish-food', 'senior-cat-food', 'rabbit-food'];
const PRODUCT_CATS = ['dietary-supplements', 'vitamins', 'sports-nutrition', 'proteins', 'minerals'];
const FOOD_CATS = [
  // ===== 烘焙 / 零食 / 甜点 =====
  'biscuits', 'chocolates', 'cookies', 'cakes', 'pastries', 'crackers', 'cereal-bars', 'snacks',
  'chips', 'pretzels', 'popcorn', 'candy', 'chocolate-bars', 'ice-creams', 'desserts', 'puddings',
  'waffles', 'pancakes', 'rice-cakes', 'bread-spreads', 'chocolate-spreads', 'fine-pastries',
  // ===== 早餐 / 谷物 =====
  'breakfast-cereals', 'oatmeal', 'muesli', 'granola', 'flours', 'baking', 'sugars',
  // ===== 饮品 =====
  'teas', 'coffees', 'soft-drinks', 'juices', 'beverages', 'dairy-drinks', 'instant-beverages',
  'energy-drinks', 'sport-drinks', 'kombucha', 'waters', 'cocoa', 'milks',
  // ===== 乳制品 =====
  'yogurts', 'cheeses', 'milk', 'butter', 'cream', 'kefir', 'fromages',
  // ===== 主食 / 粮油 =====
  'breads', 'pastas', 'rice', 'noodles', 'instant-noodles', 'couscous', 'quinoa', 'lentils', 'beans', 'chickpeas',
  'polenta', 'semolina', 'cereals', 'breakfast',
  // ===== 果蔬 / 菌菇 =====
  'fruits', 'vegetables', 'mushrooms', 'olives', 'pickles', 'fermented-foods', 'potatoes', 'tomatoes',
  // ===== 肉 / 蛋 / 海鲜 =====
  'meats', 'fish', 'seafood', 'eggs', 'poultry', 'pork', 'beef',
  // ===== 罐头 / 冷冻 / 即食 =====
  'canned-foods', 'canned-vegetables', 'canned-fish', 'frozen-foods', 'prepared-salads', 'soups', 'instant-soups',
  'prepared-meals', 'sandwiches', 'pizzas', 'sushi', 'ready-to-eat', 'frozen-desserts',
  // ===== 调味 / 酱料 =====
  'oils', 'sauces', 'condiments', 'spices', 'vinegars', 'mustards', 'ketchup', 'mayonnaise',
  'salad-dressings', 'soy-sauce', 'hot-sauce', 'pesto', 'hummus', 'stock-cubes', 'herbs', 'gravies',
  // ===== 涂抹酱 / 甜味剂 =====
  'spreads', 'honey', 'jams', 'syrups', 'nut-butters', 'tahini', 'cocoa-and-chocolate', 'caramels',
  // ===== 植物基 / 乳制品替代 =====
  'plant-based-foods', 'tofu', 'soy-milks', 'almond-milks', 'oat-milks', 'coconut-milks', 'vegan',
  // ===== 干货 / 坚果 =====
  'dried-products', 'nuts', 'seeds', 'dry-pasta',
  // ===== 标签维度（用于扩量，OFF 这些标签下商品极多）=====
  'vegetarian', 'organic', 'bio', 'gluten-free', 'halal', 'low-fat', 'no-added-sugar', 'fair-trade',
  // ===== 母婴分流（用户提议：扩 OFF 的非食品分流）=====
  // 奶粉辅食走 baby_milk，尿裤湿巾/奶瓶奶嘴走 baby_care，其余落到 baby_care 兜底
  'baby-foods', 'baby-milks', 'infant-formulas', 'baby-infant-formulas', 'follow-on-milks',
  'diapers', 'nappies', 'baby-wipes', 'baby-bottles', 'baby-teats', 'baby-care-products',
  // ===== 营养补剂分流（world.openproductfacts.org 本机不可达，改从主库同名类目取，
  // offTopCategory 会把 vitamin/supplement/protein 标签分流到健康保健）=====
  'dietary-supplements', 'vitamins', 'sports-nutrition', 'proteins', 'minerals', 'food-supplements',
];
// 各家族：抓取主机、类目、缓存 key、默认一级类目（非食品家族用默认类目，避免被 tags 误分流）
// 注意：OFF 对未认证「深层整库分页」会返回 401（第 11 页起拦截），故一律走 categories_tags 浅分页，
// 命中率远高于整库分页（整库仅 ~5% 带图且被 401 截断）。顺序：美妆/宠物粮排前，食品库（较抖）排最后。
const FAMILY_SOURCES = [
  { key: 'obf', host: 'https://world.openbeautyfacts.org', cats: BEAUTY_CATS, cat: 'beauty' },
  { key: 'opf', host: 'https://world.openpetfoodfacts.org', cats: PET_CATS, cat: 'pet' },
  { key: 'oprf', host: 'https://world.openproductfacts.org', cats: PRODUCT_CATS, cat: 'health' },
  { key: 'off', host: 'https://world.openfoodfacts.org', cats: FOOD_CATS, cat: null },
];

// 通用家族抓取：按 categories_tags 逐类目走 v2 搜索 API，每页 1000，分页 + 韧性重试；只保留有图有名字的真实条目
async function fetchOFFFamily(host, cats, key) {
  const fields = 'code,product_name,brands,categories_tags,image_front_url,price,generic_name';
  const seen = new Set();
  const out = [];
  // 合并已有缓存：live 抓取只增不减。off 主食品库间歇 503，若整轮只抓到部分就直接覆盖缓存会回退已抓数据；
  // 先载入已提交缓存，live 只在既有无重复的基础上追加，保证任何情况下不丢已抓商品。
  const prior = loadFamilyCache(key);
  for (const p of prior) {
    const code = String(p.code || p._id || '');
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(p);
  }
  if (prior.length) console.log(`    · ${key}: 载入已有缓存 ${prior.length} 条（合并抓取，只增不减）`);
  for (const c of cats) {
    if (out.length >= OFF_CAP) break;
    let page = 1;
    while (page <= 40 && out.length < OFF_CAP) {
      const url = `${host}/api/v2/search?categories_tags=${encodeURIComponent(c)}&page_size=1000&page=${page}&fields=${fields}&json=1`;
      let j;
      try {
        j = await fetchPage(url);
      } catch (e) {
        console.warn(`    · ${key}:${c}: 网络异常，跳过该类目（${e.message}）`);
        break;
      }
      if (j === null) break; // 4xx → 该类目结束
      if (j === undefined) { console.warn(`    · ${key}:${c}: 重试耗尽，跳过该类目`); break; }
      if (!j.products || !j.products.length) break;
      for (const p of j.products) {
        if (out.length >= OFF_CAP) break;
        const code = String(p.code || p._id || '');
        if (!code || seen.has(code)) continue;
        if (!p.product_name || !p.image_front_url) continue; // 只留有图有名字的真实商品
        seen.add(code);
        out.push({ ...p, _srcPrefix: key });
      }
      page++;
      await sleep(250); // 礼貌限速
    }
    console.log(`    · ${key}:${c}: 累计 ${out.length}`);
    if (out.length) saveCache(`${key}-products.json`, out); // 增量落盘；空则不覆盖已有缓存
  }
  return out;
}

// 单家族整轮重试：开轮健康探测失败（限流/抖动）则等待后重跑整轮；多次仍 0 上浮由上层回退缓存
async function fetchFamilyWithRetry(src) {
  const MAX_SWEEP = 3;
  for (let s = 0; s < MAX_SWEEP; s++) {
    const probe = await fetchPage(`${src.host}/api/v2/search?categories_tags=${encodeURIComponent(src.cats[0])}&page_size=10&page=1&fields=code,product_name,image_front_url&json=1`);
    if (probe === undefined) {
      if (s < MAX_SWEEP - 1) {
        const w = 60000 + s * 60000;
        console.warn(`[!] ${src.key} 开轮探测失败（可能限流/抖动），${Math.round(w / 1000)}s 后重试整轮（${s + 1}/${MAX_SWEEP}）`);
        await sleep(w);
        continue;
      }
      throw new Error('持续不可用');
    }
    const r = await fetchOFFFamily(src.host, src.cats, src.key);
    if (r.length > 0) return r;
    if (s < MAX_SWEEP - 1) {
      const w = 45000 + s * 30000;
      console.warn(`[!] ${src.key} 本轮抓取为 0，重试（${Math.round(w / 1000)}s）`);
      await sleep(w);
    }
  }
  throw new Error('持续不可用');
}

async function fetchOFF() {
  return fetchOFFFamily(FAMILY_SOURCES[0].host, FAMILY_SOURCES[0].cats, FAMILY_SOURCES[0].key);
}

// ---------- Open Library 图书数据源 ----------
// subject → 图书文娱二级类目：畅销图书 / 文创手作 / 乐器音像
const OL_HOST = 'https://openlibrary.org';
const OL_SUBJECTS = [
  // 畅销图书
  ['fiction', 'book_read'], ['fantasy', 'book_read'], ['science_fiction', 'book_read'],
  ['romance', 'book_read'], ['mystery', 'book_read'], ['thriller', 'book_read'],
  ['crime', 'book_read'], ['historical_fiction', 'book_read'], ['biography', 'book_read'],
  ['history', 'book_read'], ['philosophy', 'book_read'], ['business', 'book_read'],
  ['self_help', 'book_read'], ['young_adult', 'book_read'], ['horror', 'book_read'],
  ['poetry', 'book_read'], ['comics', 'book_read'], ['travel', 'book_read'],
  // 文创手作
  ['art', 'book_hobby'], ['drawing', 'book_hobby'], ['painting', 'book_hobby'],
  ['crafts', 'book_hobby'], ['photography', 'book_hobby'], ['design', 'book_hobby'],
  ['calligraphy', 'book_hobby'], ['architecture', 'book_hobby'], ['gardening', 'book_hobby'],
  // 乐器音像
  ['music', 'book_instrument'], ['guitar', 'book_instrument'], ['piano', 'book_instrument'],
  ['songbooks', 'book_instrument'], ['musicians', 'book_instrument'],
];

// 抓取 Open Library：按 subject 翻页，只保留「有书名 + 有封面图」的真实条目；
// 合并已有缓存（只增不减），逐主题增量落盘（空结果不覆盖）；复用 fetchPage 的韧性重试。
async function fetchOpenLibrary() {
  const prior = loadCache('ol-products.json', []);
  const seen = new Set(prior.map((p) => `ol_${String(p.key || '').replace(/^\/works\//, '')}`));
  const out = [...prior];
  let cap = OL_CAP;
  for (const [subject, sub] of OL_SUBJECTS) {
    if (out.length >= cap) break;
    let page = 1;
    while (page <= 15 && out.length < cap) {
      const url = `${OL_HOST}/search.json?subject=${encodeURIComponent(subject)}&limit=50&page=${page}&fields=title,author_name,cover_i,first_publish_year,key`;
      let j;
      try {
        j = await fetchPage(url);
      } catch (e) {
        console.warn(`    · ol:${subject}: 网络异常，跳过该主题（${e.message}）`);
        break;
      }
      if (j === null || j === undefined) { console.warn(`    · ol:${subject}: 无更多数据`); break; }
      const docs = j.docs || [];
      if (!docs.length) break;
      for (const d of docs) {
        if (out.length >= cap) break;
        const k = String(d.key || '').replace(/^\/works\//, '');
        if (!k || seen.has(`ol_${k}`)) continue;
        if (!d.title || !d.cover_i) continue; // 只保留有封面图的真实图书
        seen.add(`ol_${k}`);
        out.push({ ...d, _sub: sub, _subject: subject });
      }
      page++;
      await sleep(200); // 礼貌限速
    }
    console.log(`    · ol:${subject}: 累计 ${out.length}`);
    if (out.length) saveCache('ol-products.json', out); // 增量落盘；空则不覆盖已有缓存
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
// 加载某家族缓存；off 家族兼容旧缓存文件名 openfoodfacts-products.json
function loadFamilyCache(key) {
  if (key === 'off') {
    const f = loadCache('off-products.json', null);
    if (f && f.length) return f;
    return loadCache('openfoodfacts-products.json', []);
  }
  return loadCache(`${key}-products.json`, []);
}

// ---------- 写入 ----------
// 外部源（尤其 Open Beauty/Food Facts）偶有编码事故，字段里混入 U+FFFD 替换符。
// 入库前统一清洗：替换符直接剔除（比保留半截乱码体面），再把连续空白压成一个。
function sanitizeText(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/\uFFFD/g, '').replace(/\s+/g, ' ').trim();
}
function sanitizeItem(p) {
  for (const k of ['name', 'brand', 'description', 'highlight', 'imageUrl']) {
    if (typeof p[k] === 'string') p[k] = sanitizeText(p[k]);
  }
  if (Array.isArray(p.highlights)) p.highlights = p.highlights.map(sanitizeText);
  if (Array.isArray(p.tags)) p.tags = p.tags.map(sanitizeText);
  if (Array.isArray(p.skus)) p.skus = p.skus.map((s) => ({ ...s, spec: sanitizeText(s.spec) }));
  return p;
}

function insertProducts(db, items) {
  items = items.map(sanitizeItem);
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
  // 超过 DEMO_CAP 时按固定步长均匀抽样（保持类目覆盖均匀），控制静态演示包体积
  let list = items;
  if (items.length > DEMO_CAP) {
    const step = Math.ceil(items.length / DEMO_CAP);
    list = items.filter((_, i) => i % step === 0).slice(0, DEMO_CAP);
  }
  const rows = list.map((p) => ({
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
    db.exec(`DELETE FROM products WHERE id LIKE ${REAL_PAT}`);
    db.exec(`DELETE FROM reviews WHERE product_id LIKE ${REAL_PAT}`);
    db.exec(`DELETE FROM product_skus WHERE product_id LIKE ${REAL_PAT}`);
    db.exec(`DELETE FROM brands WHERE id LIKE ${BRAND_PAT}`);
  }

  const feRaw = [];
  const offRaw = [];
  const olRaw = [];
  if (FETCH) {
    console.log('[*] 实时抓取 Free-Ecommerce-Products-Api ...');
    try {
      const fe = await fetchFreeEcom();
      saveCache('freeecom-products.json', fe);
      feRaw.push(...fe);
      console.log(`[*] 已缓存 ${fe.length} 条`);
    } catch (e) {
      console.warn('[!] Free-Ecommerce 抓取失败，回退本地快照：', e.message);
      feRaw.push(...loadCache('freeecom-products.json', []));
    }
    // INGEST_FAMILIES=obf,opf,ol 时只实时抓取指定家族，其余直接从缓存载入，避免不可达库（503/超时）拖慢整轮
    const onlyFam = process.env.INGEST_FAMILIES ? process.env.INGEST_FAMILIES.split(',').map((s) => s.trim()) : null;
    for (const src of FAMILY_SOURCES) {
      let r = [];
      if (onlyFam && !onlyFam.includes(src.key)) {
        r = loadFamilyCache(src.key);
        console.log(`[*] ${src.key} 未列入实时抓取，载入缓存 ${r.length} 条`);
      } else {
        console.log(`[*] 实时抓取 ${src.host}（${src.key}）...`);
        try {
          const live = await fetchFamilyWithRetry(src);
          if (live.length) { saveCache(`${src.key}-products.json`, live); r = live; }
        } catch (e) {
          console.warn(`[!] ${src.key} 抓取失败（断网/限流），回退本地快照：`, e.message);
        }
        if (!r.length) r = loadFamilyCache(src.key); // 实时无数据/失败 → 用本地快照（不覆盖已有缓存）
      }
      offRaw.push(...r);
      console.log(`[*] ${src.key} 就绪 ${r.length} 条`);
    }
    // Open Library（图书）—— 独立数据源，可被 INGEST_FAMILIES 包含（如 INGEST_FAMILIES=ol 只抓图书）
    if (onlyFam && !onlyFam.includes('ol')) {
      olRaw.push(...loadCache('ol-products.json', []));
      console.log(`[*] ol 未列入实时抓取，载入缓存 ${olRaw.length} 条`);
    } else {
      console.log('[*] 实时抓取 Open Library（图书）...');
      try {
        const live = await fetchOpenLibrary();
        if (live.length) olRaw.push(...live);
      } catch (e) {
        console.warn('[!] Open Library 抓取失败，回退本地快照：', e.message);
      }
      if (!olRaw.length) olRaw.push(...loadCache('ol-products.json', []));
      console.log(`[*] ol 就绪 ${olRaw.length} 条`);
    }
  } else {
    feRaw.push(...loadCache('freeecom-products.json', []));
    for (const src of FAMILY_SOURCES) offRaw.push(...loadFamilyCache(src.key));
    olRaw.push(...loadCache('ol-products.json', []));
  }

  const items = [
    ...feRaw.map(mapFreeEcom),
    ...offRaw.map((p) => mapOFF(p, p._srcPrefix)).filter(Boolean),
    ...olRaw.map(mapOpenLibrary).filter(Boolean),
  ];
  if (!items.length) {
    console.warn('[!] 没有可导入的真实商品数据（请先 --fetch 或放置 .cache 快照）');
    return;
  }

  // 全量同步真实商品：先清掉旧的 fe_/off_/obf_/opf_/oprf_ 数据（含购物车/收藏引用）再插入，
  // 保证重复运行幂等、且不会因 reviews 为纯 INSERT 而产生重复评价
  db.exec(`DELETE FROM reviews WHERE product_id LIKE ${REAL_PAT}`);
  db.exec(`DELETE FROM product_skus WHERE product_id LIKE ${REAL_PAT}`);
  db.exec(`DELETE FROM cart_items WHERE product_id LIKE ${REAL_PAT}`);
  db.exec(`DELETE FROM favorites WHERE product_id LIKE ${REAL_PAT}`);
  db.exec(`DELETE FROM products WHERE id LIKE ${REAL_PAT}`);
  db.exec(`DELETE FROM brands WHERE id LIKE ${BRAND_PAT}`);

  const n = insertProducts(db, items);
  const dN = emitDemo(items);
  const total = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  console.log(`[✓] 导入真实商品 ${n} 款（Free-Ecommerce ${feRaw.length} + OFF 家族 ${offRaw.length} + Open Library ${olRaw.length}）`);
  if (dN) console.log(`[✓] 已生成 web 演示数据 ${dN} 款 -> web/js/demo-real-data.js`);
  console.log(`[✓] 当前数据库商品总数：${total}（含原有演示数据 ${seeded.products}）`);
}

main().catch((e) => { console.error('[x] 导入失败:', e); process.exit(1); });
