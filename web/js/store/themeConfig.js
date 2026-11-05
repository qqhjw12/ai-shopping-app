/**
 * themeConfig.js —— 节日 / 时令主题的**唯一规则源**（零依赖，可被 Node 直接 import 断言）。
 *
 * 规格里最容易做错的一条是「禁止节日主题写死日期不可切换」。所以这里把日期做成
 * **MM-DD 窗口**（不是写死的某一天），全年无缝拼接六月主题：任一日期都能落到
 * 某个主题上，没有「空窗期返回空数组」这种半死状态。窗口支持跨年（start > end），
 * 十二月底到二月底的「新年」正好用它。
 *
 *   roundsThroughYear：12-27 → 02-28 这样跨年的窗口，判定时按「或」处理
 *
 * 券只存 couponId，不 import couponStore：券目录（含运行时覆盖）由视图层传入，
 * 规则层保持零副作用——否则 Node 里做断言会撞上 couponStore → api.js → location。
 */

/** 每个主题最多展示多少件 */
export const THEME_LIMIT = 28;

/** mock 日期键（按 scopeId 分桶：演示日期是个人偏好，不该串给别人） */
export const THEME_MOCK_KEY = 'maison_theme_mock_date_v1';

/** 兜底主题：配置若被改坏（窗口重叠/全空），至少还有一个能画出来的主题 */
export const THEME_FALLBACK_ID = 'autumn-home';

/**
 * 六个主题，按 MM-DD 窗口首尾相接覆盖全年：
 *   12-27 ~ 02-28  新年盛装（跨年窗口）
 *   03-01 ~ 05-15  春日焕新
 *   05-16 ~ 08-10  夏日出行
 *   08-11 ~ 09-30  开学季
 *   10-01 ~ 11-30  秋日暖居
 *   12-01 ~ 12-26  圣诞礼物
 * scenes 是主题页下方的「主题场景入口」，指向 sceneConfig 里真实存在的场景。
 */
export const THEMES = [
  {
    id: 'new-year',
    name: '新年盛装',
    eyebrow: 'THEME / NEW YEAR',
    start: '12-27',
    end: '02-28',
    hue: 348,
    desc: '把一年里最好看的那套留到这几天',
    line: '新年的仪式感不在烟花，在「今天值得穿好一点」这个决定里。',
    pitch: '换一身新的，开个好头',
    cats: ['apparel', 'beauty', 'food', 'home'],
    tags: ['气质', '大衣', '香氛', '礼盒', '彩妆', '沙发', '保暖'],
    couponId: 'demo-c90',
    scenes: ['date-night', 'gift-idea'],
  },
  {
    id: 'spring-refresh',
    name: '春日焕新',
    eyebrow: 'THEME / SPRING',
    start: '03-01',
    end: '05-15',
    hue: 152,
    desc: '换季先换掉的是厚重感',
    line: '春天最该买的是「薄一层」：外套、床品、和一杯不必趁热喝的茶。',
    pitch: '薄一层就够的过渡季',
    cats: ['apparel', 'home', 'beauty', 'food', 'book'],
    tags: ['轻薄', '百搭', '床品', '清爽', '冲调', '旅行'],
    couponId: 'demo-c30',
    scenes: ['commute', 'home-relax'],
  },
  {
    id: 'summer-outdoor',
    name: '夏日出行',
    eyebrow: 'THEME / SUMMER',
    start: '05-16',
    end: '08-10',
    hue: 186,
    desc: '把周末还给自己',
    line: '夏天的装备标准只有两条：轻，且不怕晒。',
    pitch: '轻装出门，晒不到也累不着',
    cats: ['sports', 'auto', 'food', 'apparel', 'audio'],
    tags: ['便携', '户外', '露营', '防晒', '速干', '骨传导', '骑行'],
    couponId: 'cp-bag20',
    scenes: ['camping', 'fitness'],
  },
  {
    id: 'back-to-school',
    name: '开学季',
    eyebrow: 'THEME / BACK TO SCHOOL',
    start: '08-11',
    end: '09-30',
    hue: 46,
    desc: '一支好笔和一台不卡的电脑',
    line: '开学采购最容易被忽略的是「用一年会不会坏」，这里按这个标准排。',
    pitch: '用满一整个学年',
    cats: ['stationery', 'computer', 'book', 'apparel', 'audio'],
    tags: ['学生', '考试', '中性笔', '本册', '轻薄', '启蒙', '降噪'],
    couponId: 'demo-c30',
    scenes: ['school', 'commute'],
  },
  {
    id: 'autumn-home',
    name: '秋日暖居',
    eyebrow: 'THEME / AUTUMN',
    start: '10-01',
    end: '11-30',
    hue: 26,
    desc: '天暗得早了，把家里弄暖一点',
    line: '秋天真正需要的是「回到家不想再出门」的那种暖：光、织物、和一锅在炖的东西。',
    pitch: '把家调成暖色的一档',
    cats: ['home', 'kitchen', 'food', 'apparel', 'book'],
    tags: ['保暖', '布艺', '炖', '冲调', '阅读', '护眼', '绒'],
    couponId: 'cp-home50',
    scenes: ['home-relax', 'coffee-time'],
  },
  {
    id: 'christmas-gift',
    name: '圣诞礼物',
    eyebrow: 'THEME / CHRISTMAS',
    start: '12-01',
    end: '12-26',
    hue: 4,
    desc: '拆开就会用上的那种礼物',
    line: '节日礼物最怕变成一次性摆设，所以这里优先挑「消耗品」与「天天用的东西」。',
    pitch: '别送会被收进柜子的礼物',
    cats: ['food', 'stationery', 'beauty', 'home', 'book'],
    tags: ['礼盒', '送礼', '香氛', '冲调', '桌面', '零食'],
    couponId: 'cp-big150',
    scenes: ['gift-idea', 'date-night'],
  },
];

/** 文案集中存放 */
export const THEME_COPY = {
  bannerKicker: 'THEME OF THE DAY / 今日主题',
  bannerEnter: '进入主题页',
  bannerCoupon: (v) => `主题券 ${v}`,
  pageBack: '← 回到首页',
  productHead: '主题商品池',
  productLead: '按当期主题的类目与关键词从在售商品里筛出，不新增假商品。',
  couponHead: '主题优惠券',
  couponLead: '与券中心同一张券：领了就在券包里，结算时自动匹配。',
  couponGo: '去券中心看看',
  couponClaim: '立即领取',
  couponClaimed: '已领取',
  couponLogin: '登录后领取',
  couponLoginToast: '登录后即可领取',
  couponOk: '已存入我的券包',
  scenesHead: '主题场景',
  scenesLead: '同一个主题，按不同场景拆开逛。',
  mockHead: '演示日期',
  mockHint: '主题按日期自动切换。这里可以改一个演示日期，看同一天里首页与主题页会变成哪一个。',
  mockToday: '恢复今天',
  mockActive: (d) => `演示日期 ${d}`,
  window: (s, e) => `${s} — ${e}`,
  demoTag: '演示数据',
  unknownTheme: '这个主题不存在',
  emptyPool: '这个主题暂时没有匹配到商品',
  emptyPoolHint: '换个主题看看，或者浏览全部甄选。',
  couponMissing: '这张券不在券目录里',
};

/** 主题 id 列表 */
export function themeIds() {
  return THEMES.map((t) => t.id);
}

/** 按 id 取主题；未命中返回 null */
export function themeById(id) {
  const key = String(id || '');
  return THEMES.find((t) => t.id === key) || null;
}

/** 兜底主题 */
export function fallbackTheme() {
  return themeById(THEME_FALLBACK_ID) || THEMES[0] || null;
}

/** 主题 → 路由 hash */
export function themeHash(id) {
  return `#/theme/${encodeURIComponent(String(id || ''))}`;
}

/**
 * 演示日期预设：规格要求「用 mock 日期即可演示」，所以给几个能一眼看出
 * 主题在不同日子会变的日期。空字符串 = 用真实今天。
 */
export const THEME_MOCK_PRESETS = [
  { label: '恢复今天', date: '' },
  { label: '10-15 · 秋日暖居', date: '2026-10-15' },
  { label: '12-20 · 圣诞礼物', date: '2026-12-20' },
  { label: '09-01 · 开学季', date: '2026-09-01' },
  { label: '06-20 · 夏日出行', date: '2026-06-20' },
  { label: '04-10 · 春日焕新', date: '2026-04-10' },
  { label: '01-20 · 新年盛装', date: '2026-01-20' },
];
