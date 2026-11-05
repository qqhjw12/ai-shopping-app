/**
 * sceneConfig.js —— 场景与情绪的**唯一规则源**（零依赖，可被 Node 直接 import 断言）。
 *
 * 为什么抽这一层：一个场景由「去哪些类目取货 / 认哪些标签 / 用什么氛围」三件事
 * 定义，这是内容运营参数，不是渲染细节。写进视图里，运营想加一个「露营」场景
 * 就得改 UI 文件——第二份真源迟早和商品库对不上。
 *
 * 铁律（对应规格「四、数据与配置」）：
 *   · 这里只有**规则**，没有商品。结果一律由 sceneStore 从现有商品池筛出来；
 *   · 标签用商品池里真实存在的词（大写/空格不用），否则规则永远命中 0 条；
 *   · 每个场景 3–5 个类目：少于 3 个就不是「跨分类组合」，多于 5 个变成全站推荐；
 *   · 不 import 任何带 DOM / 网络副作用的模块。
 */

/** 场景页最多展示多少件（4 类目 × 6 件左右的体量，够翻两屏） */
export const SCENE_LIMIT = 24;

/** 情绪结果页上限（情绪是轻量入口，别做成第二个搜索页） */
export const MOOD_LIMIT = 18;

/** 首页默认展示多少个场景：6–8 个（规格上限），再多首页就变成一面墙 */
export const SCENE_HOME_LIMIT = 8;

/** 首页展示的情绪标签数：4–6 个 */
export const MOOD_HOME_LIMIT = 6;

/**
 * 八个场景。
 *   cats  取货类目（一级 categoryId），按顺序轮流取，保证结果真的跨分类
 *   tags  相关性关键词：命中即候选，未命中的用同分类高分商品兜底
 *   hue   氛围图主色相（深空底色上的一层薄雾，不做成彩色海报）
 */
export const SCENES = [
  {
    id: 'commute',
    no: '01',
    name: '通勤穿搭',
    eyebrow: 'SCENE 01 / COMMUTE',
    desc: '早八地铁到晚间小会，一套衣服撑住两种场合',
    line: '通勤不是制服。真正要解决的，是从地铁的拥挤到晚间的体面之间那段换装缝隙。',
    hue: 198,
    cats: ['apparel', 'audio', 'stationery', 'beauty', 'book'],
    tags: ['通勤', '百搭', '气质', '降噪', '通勤代步', '轻便', '职场', '时间管理'],
  },
  {
    id: 'home-relax',
    no: '02',
    name: '居家放松',
    eyebrow: 'SCENE 02 / AT HOME',
    desc: '灯调暗一点，锅里有东西在炖',
    line: '居家的松弛感是可布置的：光、织物、一口热的，三件事凑齐就够了。',
    hue: 28,
    cats: ['home', 'kitchen', 'food', 'book', 'pet'],
    tags: ['布艺', '床品', '炖', '冲调', '阅读', '宠物', '沙发', '护眼', '调光'],
  },
  {
    id: 'camping',
    no: '03',
    name: '周末露营',
    eyebrow: 'SCENE 03 / CAMP',
    desc: '帐篷、营地灯与一顿不用洗碗的晚饭',
    line: '露营的门槛不在装备多贵，而在「少带一件会不会难受」。这里按这个标准筛。',
    hue: 142,
    cats: ['sports', 'food', 'auto', 'apparel'],
    tags: ['露营', '帐篷', '徒步', '防雨', '便携', '背包', '户外', '零食'],
  },
  {
    id: 'date-night',
    no: '04',
    name: '约会之夜',
    eyebrow: 'SCENE 04 / DATE NIGHT',
    desc: '香气、光泽与一件值得被记住的外套',
    line: '约会夜的准备从出门前两小时开始：先定香气，再定轮廓。',
    hue: 322,
    cats: ['beauty', 'apparel', 'food', 'stationery'],
    tags: ['香氛', '彩妆', '气质', '礼盒', '护肤', '大衣', '口红'],
  },
  {
    id: 'gift-idea',
    no: '05',
    name: '送礼灵感',
    eyebrow: 'SCENE 05 / GIFTING',
    desc: '不用问对方想要什么，也能送得体的那几样',
    line: '送礼的难点是「怕重复」。这里挑的都是拆开后会被真用的东西。',
    hue: 12,
    cats: ['food', 'stationery', 'beauty', 'home', 'book'],
    tags: ['礼盒', '送礼', '商务送礼', '香氛', '礼赠', '套装'],
  },
  {
    id: 'school',
    no: '06',
    name: '开学必备',
    eyebrow: 'SCENE 06 / BACK TO SCHOOL',
    desc: '从笔袋到第一台自己的笔记本',
    line: '开学采购清单有个共性：用一整年，且不能在第两周就坏。',
    hue: 46,
    cats: ['stationery', 'computer', 'book', 'apparel', 'audio'],
    tags: ['学生', '考试', '中性笔', '启蒙', '轻薄', '卫衣', '降噪', '本册'],
  },
  {
    id: 'fitness',
    no: '07',
    name: '健身打卡',
    eyebrow: 'SCENE 07 / TRAINING',
    desc: '把「明天开始」拆成今天能做完的一组',
    line: '健身装备只分两类：会天天用的，和第一周之后就落灰的。只留前者。',
    hue: 168,
    cats: ['sports', 'health', 'food', 'audio', 'apparel'],
    tags: ['健身', '运动', '骨传导', '体脂', '营养', '速干', '训练'],
  },
  {
    id: 'coffee-time',
    no: '08',
    name: '咖啡时光',
    eyebrow: 'SCENE 08 / COFFEE',
    desc: '一杯手冲，配一件桌面上的小器物',
    line: '咖啡时间买的是十五分钟的秩序感：水温、杯壁、桌面上没有杂物。',
    hue: 32,
    cats: ['food', 'kitchen', 'home', 'book', 'appliance'],
    tags: ['咖啡', '冲调', '杯', '桌面', '阅读', '料理机', '收纳'],
  },
];

/**
 * 六种情绪。
 *   note 是情绪的自我描述，pickLead 拼在结果页那行说明的前半句——
 *   后半句的标签来自**实际筛出的商品**，所以那一行不是写死的文案。
 */
export const MOODS = [
  {
    id: 'heal',
    name: '治愈',
    no: '01',
    hue: 158,
    note: '把声音调小，把光调暖',
    pickLead: '为这种心情挑的：',
    cats: ['beauty', 'home', 'food', 'book', 'pet'],
    tags: ['舒缓', '温和', '保湿', '修护', '护眼', '暖', '宠物', '冲调', '情绪'],
  },
  {
    id: 'energy',
    name: '元气',
    no: '02',
    hue: 42,
    note: '今天想往外走',
    pickLead: '为这种心情挑的：',
    cats: ['food', 'beauty', 'sports', 'audio', 'apparel'],
    tags: ['清爽', '提神', '运动', '户外', '速干', '控油', '健身'],
  },
  {
    id: 'chill',
    name: '松弛',
    no: '03',
    hue: 196,
    note: '不赶时间的那种状态',
    pickLead: '为这种心情挑的：',
    cats: ['home', 'apparel', 'food', 'book', 'kitchen'],
    tags: ['宽松', '布艺', '休闲', '便携', '沙发', '炖', '阅读'],
  },
  {
    id: 'focus',
    name: '专注',
    no: '04',
    hue: 214,
    note: '关掉通知，只留一扇窗',
    pickLead: '为这种心情挑的：',
    cats: ['computer', 'audio', 'home', 'stationery', 'book'],
    tags: ['降噪', '办公', '人体工学', '时间管理', '轻薄', '桌面', '考试'],
  },
  {
    id: 'romance',
    name: '浪漫',
    no: '05',
    hue: 330,
    note: '为一件小事认真一次',
    pickLead: '为这种心情挑的：',
    cats: ['beauty', 'apparel', 'food', 'book', 'stationery'],
    tags: ['香氛', '彩妆', '气质', '礼盒', '护肤', '大衣'],
  },
  {
    id: 'cool',
    name: '酷感',
    no: '06',
    hue: 262,
    note: '参数要硬，外形要冷',
    pickLead: '为这种心情挑的：',
    cats: ['audio', 'computer', 'apparel', 'auto', 'phone'],
    tags: ['电竞', '低延时', '机械', '金属', '游戏本', '骨传导', '冲锋衣'],
  },
];

/** 文案集中存放：改口吻不用翻视图文件 */
export const SC_COPY = {
  homeEyebrow: 'TODAY / 今天想逛什么',
  homeTitle: '今天想逛什么',
  homeLead: '按场景挑，而不是按类目翻。横着滑，八个入口都在一条轨道上。',
  railHint: '横向滑动查看全部场景',
  moodEyebrow: 'PICK BY MOOD / 按心情挑',
  moodTitle: '按心情挑',
  moodLead: '不写关键词，先说你今天是什么状态。',
  enterScene: (name) => `进入「${name}」场景`,
  sceneCount: '件匹配',
  backHome: '← 回到首页',
  backToMood: '← 换一种心情',
  scenePickNote: '按场景规则从在售商品里筛出来的组合，未命中的类目用同类别高分商品补齐。',
  moodPickNote: (hits) => (hits.length ? `命中关键词：${hits.join(' · ')}` : '按类目分布挑选，无关键词命中'),
  emptyScene: '这个场景暂时没筛到商品',
  emptySceneHint: '规则命中的类目还没上货，先去逛逛全部甄选。',
  unknownScene: '这个场景不存在',
  unknownMood: '这个情绪不存在',
  demoTag: '演示规则',
};

/** 场景 id 列表（断言与调试用） */
export function sceneIds() {
  return SCENES.map((s) => s.id);
}

/** 情绪 id 列表 */
export function moodIds() {
  return MOODS.map((m) => m.id);
}

/** 按 id 取场景；未命中返回 null（调用方据此走空态） */
export function sceneById(id) {
  const key = String(id || '');
  return SCENES.find((s) => s.id === key) || null;
}

/** 按 id 取情绪 */
export function moodById(id) {
  const key = String(id || '');
  return MOODS.find((m) => m.id === key) || null;
}

/** 首页要展示的场景（按配置顺序截断，不做随机，否则每天位置都在跳） */
export function homeScenes() {
  return SCENES.slice(0, SCENE_HOME_LIMIT);
}

/** 首页要展示的情绪 */
export function homeMoods() {
  return MOODS.slice(0, MOOD_HOME_LIMIT);
}

/** 场景 → 路由 hash（统一在这里拼，避免各处手写字符串） */
export function sceneHash(id) {
  return `#/scene/${encodeURIComponent(String(id || ''))}`;
}

/** 情绪 → 路由 hash */
export function moodHash(id) {
  return `#/mood/${encodeURIComponent(String(id || ''))}`;
}
