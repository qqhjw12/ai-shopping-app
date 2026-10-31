// 商家工作台的数据层：商品 / 库存 / 订单 / 店铺信息，全部落在 localStorage。
//
// 三条硬规矩（都是这一层负责守住的，页面只管画）：
//
//   1) **按商家分桶**。同一个浏览器里可能先后打开过好几家店（演示站尤其常见），
//      商品和订单绝不能串。所以桶 key 是入驻申请编号（MA… 或 ML…），
//      而不是「整个浏览器一份」。串数据比没数据更糟——商家会以为别人动了他的货。
//
//   2) **种子数据是确定性的**。首访生成 5 个商品 / 4 笔订单，全部由申请资料
//      （品牌、类目、价格带）派生，不用 Math.random：刷新、重开、换标签页
//      看到的必须是同一批货，否则「我上午看到的那个商品呢」。
//
//   3) **写失败必须让调用方知道**。隐私模式 / 配额满时 localStorage 会静默抛，
//      吞掉异常就会出现「改完库存刷新没了」。所以每个写操作都返回布尔或抛
//      带 code:'storage' 的错误，由页面提示。
//
// 这一层不认识 DOM、不认识路由，只认识商家编号和数据结构——这样它能在
// 真网关接进来时被替换成 HTTP 调用，页面一行不用改。
//
// ---- 设计令牌提示（样式在 styles.css 的「商家工作台」段） ----
//   信息密度优先：正文 12–13px、行高 1.6、表格行距 10px 上下；
//   分隔只用 1px var(--line)，不用重色块、不用卡片阴影堆叠；
//   强调色只有 var(--gold) 一处，红色仅用于「库存预警 / 失败」；
//   圆角沿用 var(--r-card)=16 / var(--r-btn)=12 / var(--r-pill)=999；
//   字体沿用 var(--serif) 做标题、var(--sans) 做正文与表格数字。

const STORE_KEY = 'maison_merchant_shop_v1';
/** 数据形状版本：将来改结构时按它做迁移，别让旧桶读出半个对象 */
const SCHEMA = 1;

/** 库存预警线（默认值）：低于等于它就在库存页和概览上标黄 */
export const LOW_STOCK_AT = 10;

export const PRODUCT_STATUS_LABEL = { reviewing: '审核中', on: '在售', off: '已下架' };
export const ORDER_STATUS_LABEL = { pending: '待发货', shipped: '已发货', done: '已完成' };
export const CARRIERS = ['顺丰速运', '京东物流', '中通快递', '圆通速递', '邮政 EMS'];

/* ---------------- 底层读写 ---------------- */

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

function storageError() {
  return Object.assign(
    new Error('这台浏览器不允许本地存储（隐私模式或空间已满），改动存不下来'),
    { code: 'storage' },
  );
}

/** 取某个商家的桶；没有就返回 null（不自动建，建桶必须走 seed） */
function bucketOf(merchantId) {
  const all = readAll();
  const b = all[String(merchantId || '')];
  return b && b.schema === SCHEMA && Array.isArray(b.products) ? b : null;
}

/** 统一的写入口：改完桶写回，失败抛 storage 错误 */
function commit(merchantId, bucket) {
  const all = readAll();
  all[String(merchantId || '')] = bucket;
  if (!writeAll(all)) throw storageError();
  return bucket;
}

/* ---------------- 种子数据 ---------------- */

// 每个类目两个像样的单品名：演示时「素白 SUBAI」卖粗陶杯，
// 比「商品 1 / 商品 2」有说服力得多，而且不需要编造销量与评价。
const SEED_NAMES = {
  phone: ['磁吸无线充电座', '防窥钢化膜套装'],
  computer: ['胡桃木笔记本支架', '机械键盘腕托'],
  audio: ['开放式蓝牙耳机', '便携解码耳放'],
  appliance: ['桌面循环扇', '手持挂烫机'],
  apparel: ['水洗棉麻衬衫', '轻柔羊毛围巾'],
  food: ['高山单丛茶礼盒', '低温烘焙坚果'],
  home: ['手作粗陶马克杯', '亚麻抱枕套'],
  sports: ['轻量徒步背包', '天然橡胶瑜伽垫'],
  beauty: ['氨基酸洁面慕斯', '植物精油护手霜'],
  baby: ['纯棉纱布浴巾', '榉木积木套装'],
  book: ['布面精装笔记本', '博物馆联名信笺'],
  kitchen: ['铸铁小平底锅', '橄榄木砧板'],
  pet: ['可拆洗宠物窝', '陶瓷慢食碗'],
  auto: ['车载香氛挂件', '折叠收纳箱'],
  health: ['草本足浴包', '筋膜放松球'],
  stationery: ['黄铜笔搁', '活页手账本'],
};
const FALLBACK_NAMES = ['季节限定款', '经典复刻款', '联名限量款'];

/** 价格带 → 基准价（元），再从基准价派生 5 个不同价 */
const PRICE_BASE = { lt100: 68, '100-500': 268, '500-2000': 980, gt2000: 3200 };
const PRICE_FACTOR = [1, 0.62, 1.34, 0.86, 1.16];
/** 固定库存：保证有 2 个低于预警线（演示「库存预警」不是空谈） */
const SEED_STOCK = [42, 6, 118, 23, 3];
/** 固定状态：在售 3 / 已下架 1 / 审核中 1，三种状态一眼看全 */
const SEED_STATUS = ['on', 'on', 'on', 'off', 'reviewing'];

const pad4 = (n) => String(n).padStart(4, '0');
const dayStamp = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');

/** n 天前（本地时区的当天 0 点起算，避免 UTC 跨日把「今日订单」算错） */
function daysAgo(n, hour = 9, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function seedProducts(app) {
  const brand = String(app.brand || '').trim();
  const cats = (Array.isArray(app.categories) && app.categories.length ? app.categories : ['home']).slice(0, 3);
  // 名称来源：本店类目里的单品 → 不够 5 个就用「限定款」补齐（不重复造类目）
  const names = [];
  cats.forEach((c) => (SEED_NAMES[c] || []).forEach((n) => names.push({ name: n, categoryId: c })));
  for (const n of FALLBACK_NAMES) {
    if (names.length >= 5) break;
    names.push({ name: `${brand || ''}${n}`.trim(), categoryId: cats[0] });
  }

  const base = PRICE_BASE[app.priceRange] || PRICE_BASE['100-500'];
  const merchantKey = String(app.id || 'x');
  return names.slice(0, 5).map((item, i) => {
    const price = Math.max(9, Math.round(base * PRICE_FACTOR[i] * 10) / 10);
    return {
      id: `MP${pad4(i + 1)}`,
      name: item.name,
      categoryId: item.categoryId,
      price,
      stock: SEED_STOCK[i],
      warnAt: LOW_STOCK_AT,
      status: SEED_STATUS[i],
      // 图片占位：不存真图（本机没有对象存储），靠 productArt 按 id 程序化画封面
      createdAt: daysAgo(30 - i * 3, 10, 0).toISOString(),
      updatedAt: daysAgo(30 - i * 3, 10, 0).toISOString(),
      seed: merchantKey,
    };
  });
}

function seedOrders(products) {
  // 两单在今天（其中一单待发货）、一单昨天待发货、一单三天前已完成
  const plan = [
    { p: 0, qty: 1, day: 0, hour: 9, minute: 12, status: 'pending' },
    { p: 2, qty: 2, day: 0, hour: 8, minute: 5, status: 'shipped', carrier: CARRIERS[0], tracking: 'SF139700228841' },
    { p: 1, qty: 1, day: 1, hour: 16, minute: 40, status: 'pending' },
    { p: 0, qty: 1, day: 3, hour: 11, minute: 26, status: 'done', carrier: CARRIERS[1], tracking: 'JD883001774629' },
  ];
  const NAME = ['林', '周', '陈', '吴', '郑'];
  return plan.map((o, i) => {
    const item = products[o.p];
    const at = daysAgo(o.day, o.hour, o.minute).toISOString();
    return {
      id: `MO${dayStamp(daysAgo(o.day, o.hour, o.minute))}${pad4(i + 1)}`,
      productId: item ? item.id : '',
      productName: item ? item.name : '—',
      categoryId: item ? item.categoryId : '',
      price: item ? item.price : 0,
      qty: o.qty,
      amount: Math.round((item ? item.price : 0) * o.qty * 100) / 100,
      status: o.status,
      // 买家信息一律打码：工作台是给商家看单的，不是给人肉数据库的
      buyer: `${NAME[i % NAME.length]}**`,
      region: ['浙江杭州', '江苏苏州', '上海', '广东深圳'][i % 4],
      createdAt: at,
      shippedAt: o.status === 'pending' ? null : at,
      finishedAt: o.status === 'done' ? daysAgo(o.day - 2, 20, 10).toISOString() : null,
      carrier: o.carrier || '',
      trackingNo: o.tracking || '',
    };
  });
}

function seedShop(app) {
  const cats = Array.isArray(app.categories) ? app.categories : [];
  const brand = String(app.brand || app.company || '我的店铺').trim();
  return {
    name: brand,
    // 简介从申请资料派生，别一开始就写「专业可靠值得信赖」这种谁都能说的话
    intro: cats.length
      ? `${brand}，做${cats.length >= 2 ? '这几件' : '一件'}我们自己也天天用的小东西。`
      : `${brand} 的官方店铺。`,
    logoText: brand.replace(/[a-zA-Z\s]/g, '').slice(0, 2) || brand.slice(0, 2) || '店',
    logoColor: 0,
    updatedAt: new Date().toISOString(),
  };
}

function seed(app) {
  const products = seedProducts(app);
  return {
    schema: SCHEMA,
    merchantId: String(app.id || ''),
    seededAt: new Date().toISOString(),
    shop: seedShop(app),
    products,
    orders: seedOrders(products),
  };
}

/* ---------------- 对外：读取 ---------------- */

/**
 * 打开某商家的工作台数据。首次调用会按申请资料种一份演示数据并落盘。
 * @param {object} app 入驻申请（public 视图，需要 id / brand / categories / priceRange）
 */
export function ensureShop(app) {
  const id = String((app && app.id) || '');
  if (!id) throw Object.assign(new Error('缺少商家编号'), { code: 'args' });
  const existing = bucketOf(id);
  if (existing) return view(existing);
  const created = seed(app);
  commit(id, created);
  return view(created);
}

/** 只读：没有桶就返回 null（页面上用于「还没建店」的兜底） */
export function getShop(merchantId) {
  const b = bucketOf(merchantId);
  return b ? view(b) : null;
}

function view(b) {
  return {
    shop: { ...b.shop },
    products: b.products.map((p) => ({ ...p })),
    orders: b.orders.map((o) => ({ ...o })),
    seededAt: b.seededAt,
  };
}

/** 概览四项。今日订单按本地日期比，不做 UTC 偏移——商家看的是自己的今天 */
export function statsOf(state) {
  const today = dayStamp(new Date());
  const onSale = state.products.filter((p) => p.status === 'on').length;
  const todayOrders = state.orders.filter((o) => dayStamp(new Date(o.createdAt)) === today);
  const pending = state.orders.filter((o) => o.status === 'pending');
  // 预警只算「还在卖/待卖」的货：已下架的商品不需要补货，把它算进来只会稀释提醒
  const low = state.products.filter((p) => p.status !== 'off' && p.stock <= p.warnAt);
  return {
    onSale,
    todayOrderCount: todayOrders.length,
    todayAmount: Math.round(todayOrders.reduce((s, o) => s + o.amount, 0) * 100) / 100,
    pendingCount: pending.length,
    lowStockCount: low.length,
    lowStock: low.sort((a, b) => a.stock - b.stock),
  };
}

/* ---------------- 对外：商品 ---------------- */

function nextProductId(products) {
  const max = products.reduce((n, p) => Math.max(n, Number(String(p.id).replace(/\D/g, '')) || 0), 0);
  return `MP${pad4(max + 1)}`;
}

/**
 * 新增商品。状态固定「审核中」——平台不让商家自己把新货直接挂到在售，
 * 这条规则在演示里也保留，否则商家会以为上架不用审。
 */
export function createProduct(merchantId, input = {}) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });

  const name = String(input.name || '').trim().slice(0, 40);
  const price = Math.round(Number(input.price) * 100) / 100;
  const stock = Math.floor(Number(input.stock));
  const categoryId = String(input.categoryId || '');
  if (name.length < 2) throw Object.assign(new Error('商品名至少 2 个字'), { code: 'args' });
  if (!Number.isFinite(price) || price <= 0) throw Object.assign(new Error('请填写大于 0 的价格'), { code: 'args' });
  if (!Number.isFinite(stock) || stock < 0) throw Object.assign(new Error('库存不能为负数'), { code: 'args' });
  if (!categoryId) throw Object.assign(new Error('请选择类目'), { code: 'args' });

  const now = new Date().toISOString();
  const product = {
    id: nextProductId(b.products),
    name,
    categoryId,
    price,
    stock,
    warnAt: Number(input.warnAt) > 0 ? Math.floor(Number(input.warnAt)) : LOW_STOCK_AT,
    status: 'reviewing',
    createdAt: now,
    updatedAt: now,
  };
  b.products.unshift(product);
  commit(merchantId, b);
  return { ...product };
}

/** 上下架。审核中的商品不给改（还没通过审核，谈不上「上下架」） */
export function setProductStatus(merchantId, productId, status) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const p = b.products.find((x) => x.id === productId);
  if (!p) throw Object.assign(new Error('商品不存在'), { code: 'notfound' });
  if (p.status === 'reviewing') throw Object.assign(new Error('审核中的商品不能上下架'), { code: 'state' });
  if (!['on', 'off'].includes(status)) throw Object.assign(new Error('状态不合法'), { code: 'args' });
  p.status = status;
  p.updatedAt = new Date().toISOString();
  commit(merchantId, b);
  return { ...p };
}

/** 演示用：把审核中的商品放行（真实链路里这一步只能由运营台做） */
export function approveProduct(merchantId, productId) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const p = b.products.find((x) => x.id === productId);
  if (!p) throw Object.assign(new Error('商品不存在'), { code: 'notfound' });
  if (p.status !== 'reviewing') throw Object.assign(new Error('只有审核中的商品需要放行'), { code: 'state' });
  p.status = 'on';
  p.updatedAt = new Date().toISOString();
  commit(merchantId, b);
  return { ...p };
}

/** 改库存（库存页的内联编辑走这里）：只接受 0–99999 的整数 */
export function updateStock(merchantId, productId, stock) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const p = b.products.find((x) => x.id === productId);
  if (!p) throw Object.assign(new Error('商品不存在'), { code: 'notfound' });
  const n = Math.floor(Number(stock));
  if (!Number.isFinite(n) || n < 0 || n > 99999) {
    throw Object.assign(new Error('库存要填 0–99999 之间的整数'), { code: 'args' });
  }
  p.stock = n;
  p.updatedAt = new Date().toISOString();
  commit(merchantId, b);
  return { ...p };
}

/* ---------------- 对外：订单 ---------------- */

/** 发货：填运单号 + 快递公司，状态变「已发货」。已发货/已完成的单再发一次会被拒 */
export function shipOrder(merchantId, orderId, { carrier, trackingNo } = {}) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const o = b.orders.find((x) => x.id === orderId);
  if (!o) throw Object.assign(new Error('订单不存在'), { code: 'notfound' });
  if (o.status !== 'pending') throw Object.assign(new Error('这单已经发过货了'), { code: 'state' });

  const c = String(carrier || '').trim();
  const t = String(trackingNo || '').trim().toUpperCase();
  if (!CARRIERS.includes(c)) throw Object.assign(new Error('请选择快递公司'), { code: 'args' });
  // 运单号只做形状校验：各家规则不同，管太死会让商家发不出货
  if (!/^[A-Z0-9-]{6,32}$/.test(t)) throw Object.assign(new Error('运单号为 6–32 位字母或数字'), { code: 'args' });

  o.status = 'shipped';
  o.carrier = c;
  o.trackingNo = t;
  o.shippedAt = new Date().toISOString();
  commit(merchantId, b);
  return { ...o };
}

/** 演示用：把已发货的单标成已完成（真实链路里由买家确认收货触发） */
export function finishOrder(merchantId, orderId) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const o = b.orders.find((x) => x.id === orderId);
  if (!o) throw Object.assign(new Error('订单不存在'), { code: 'notfound' });
  if (o.status !== 'shipped') throw Object.assign(new Error('只有已发货的订单可以完成'), { code: 'state' });
  o.status = 'done';
  o.finishedAt = new Date().toISOString();
  commit(merchantId, b);
  return { ...o };
}

/* ---------------- 对外：店铺 ---------------- */

export function updateShop(merchantId, patch = {}) {
  const b = bucketOf(merchantId);
  if (!b) throw Object.assign(new Error('店铺数据还没建立'), { code: 'missing' });
  const name = String(patch.name == null ? b.shop.name : patch.name).trim().slice(0, 30);
  if (name.length < 2) throw Object.assign(new Error('店铺名至少 2 个字'), { code: 'args' });
  const intro = String(patch.intro == null ? b.shop.intro : patch.intro).trim().slice(0, 120);
  const logoText = String(patch.logoText == null ? b.shop.logoText : patch.logoText).trim().slice(0, 2) || '店';
  const logoColor = Math.max(0, Math.min(5, Number(patch.logoColor) || 0));
  b.shop = { name, intro, logoText, logoColor, updatedAt: new Date().toISOString() };
  commit(merchantId, b);
  return { ...b.shop };
}

/** 重置：把这家店的演示数据推倒重种（商品/订单回到初始状态，店铺名重新派生） */
export function resetShop(app) {
  const id = String((app && app.id) || '');
  if (!id) throw Object.assign(new Error('缺少商家编号'), { code: 'args' });
  const b = seed(app);
  commit(id, b);
  return view(b);
}

/** 清掉所有商家的桶（演示站「清空本机数据」用；只影响本机） */
export function clearAllShops() {
  try {
    localStorage.removeItem(STORE_KEY);
    return true;
  } catch {
    return false;
  }
}
