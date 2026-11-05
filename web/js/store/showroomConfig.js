/**
 * showroomConfig.js —— 虚拟展厅的**唯一规则源**（零依赖，可被 Node 直接 import 断言）。
 *
 * 为什么单独抽一层：分区怎么划分、每个分区去哪个商品池取货、卡片上限、
 * 视图模式的持久化键，这些都是「内容运营」参数，不是渲染细节。写进视图里
 * 就会变成第二个真源——运营想加一个分区，得改 UI 文件。这里只放数据。
 *
 * 约束：
 *   · 不 import 任何带 DOM / 网络副作用的模块（本文件在 check-web 里要能裸跑）；
 *   · 分区数量按规格 3–5 个——多了首屏就是一面墙，用户点不进去；
 *   · 氛围图**不写 URL**：由 showroomArt.js 用 SVG 现画，零外部请求、绝不破图。
 */

/** 视图模式：网格（信息密度高）/ 展厅（大卡 + 景深） */
export const SR_VIEW = { GRID: 'grid', HALL: 'hall' };

/** 视图偏好持久化键（按 scopeId 分桶：同一个人换设备不共享，换账号不串） */
export const SR_VIEW_KEY = 'maison_showroom_view_v1';

/** 每个分区最多展出多少件（横向展厅一屏 3–4 张大卡，14 件足够划两屏） */
export const SR_CARD_LIMIT = 14;

/** 大厅（列表页）分区卡片数上限——列表就该短 */
export const SR_MAX_ZONES = 5;

/**
 * 五个主题分区。
 *   categories：到商品池里按 categoryId 取货（一级类目，含子孙）
 *   hue：氛围图主色相（深空底色上的一层薄雾，不做成彩色海报）
 *   floor：分区地面文案（展厅里的一行小字，替代「精选中」这种空话）
 */
export const SHOWROOM_ZONES = [
  {
    id: 'spring-wardrobe',
    no: '01',
    name: '春日衣橱',
    eyebrow: 'ZONE 01 / APPAREL',
    desc: '亚麻、真丝与低饱和的过渡季衣橱',
    floor: '换季时最难搭的那几件，先在这里挂好',
    categories: ['apparel', 'womenswear', 'menswear'],
    hue: 158,
  },
  {
    id: 'digital-frontier',
    no: '02',
    name: '数码前线',
    eyebrow: 'ZONE 02 / DIGITAL',
    desc: '从掌上终端到桌面工作站的效率装备',
    floor: '通电即用，参数不堆、体验优先',
    categories: ['phone', 'computer', 'audio'],
    hue: 196,
  },
  {
    id: 'scent-lab',
    no: '03',
    name: '香氛实验室',
    eyebrow: 'ZONE 03 / BEAUTY',
    desc: '调香、色号与配方的气味档案',
    floor: '气味与色号一律按肤感分柜',
    categories: ['beauty'],
    hue: 322,
  },
  {
    id: 'quiet-living',
    no: '04',
    name: '静境家居',
    eyebrow: 'ZONE 04 / LIVING',
    desc: '厨房与居室里那些安静的日常器物',
    floor: '一天要用三次的东西，值得挑得慢一点',
    categories: ['home', 'kitchen'],
    hue: 34,
  },
  {
    id: 'snowline-gear',
    no: '05',
    name: '雪线装备',
    eyebrow: 'ZONE 05 / OUTDOOR',
    desc: '户外与出行：从城市通勤到高海拔',
    floor: '风雪线以上，装备先替你说话',
    categories: ['sports', 'auto'],
    hue: 210,
  },
];

/** 文案集中存放：改口吻不用翻视图文件 */
export const SR_COPY = {
  pageTitle: '虚拟展厅',
  eyebrow: 'MAISON SHOWROOM / 演示展厅',
  lead: '五个主题分区，按场景而不是按类目摆货。氛围图与景深均为程序化生成，不加载任何外部图片与 3D 库。',
  enter: '进入展厅',
  enterZone: (name) => `进入「${name}」`,
  viewGrid: '网格',
  viewHall: '展厅',
  viewLabel: '查看方式',
  hallHint: '横向滑动浏览，点击卡片进详情',
  gridHint: '网格视图信息更密，适合比价',
  emptyZone: '这个分区暂时没有上架商品',
  emptyZoneHint: '展台还在布展，先去看看别的分区。',
  backToList: '← 返回展厅大厅',
  countUnit: '件展品',
  addToBag: '加入购物袋',
  detail: '查看详情',
  demoTag: '演示数据',
  lazyNote: '进入视口才加载',
};

/** 按 id 取分区；未命中返回 null（调用方据此走 404） */
export function zoneById(id) {
  const key = String(id || '');
  return SHOWROOM_ZONES.find((z) => z.id === key) || null;
}

/** 分区 id 列表（断言与调试用） */
export function zoneIds() {
  return SHOWROOM_ZONES.map((z) => z.id);
}

/** 分区 slug → 路由 hash（统一在这里拼，避免各处手写字符串） */
export function zoneHash(id) {
  return `#/showroom/${encodeURIComponent(String(id || ''))}`;
}

/** 视图模式归一：任何脏值都收敛到网格（默认视图） */
export function normalizeView(v) {
  return v === SR_VIEW.HALL ? SR_VIEW.HALL : SR_VIEW.GRID;
}
