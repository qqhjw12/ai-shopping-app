/**
 * pointsConfig.js —— 积分 / 签到 / 任务 / 等级的全部规则配置。
 *
 * 纪律：规则一律抽在这里，页面组件（points.js）与数据层（pointsStore.js）不得写死
 * 任何积分数、阈值、任务定义或文案中的数值。零 DOM、零依赖，Node 与浏览器都能 import。
 *
 * 口径说明：
 *  · 签到加成按「连续天数里程碑」周期性发放：每满 7 天 +50，否则每满 3 天 +20；
 *    基础分始终 +10；断签后连续天数重置为 1（重新开始累计）。
 *  · 等级按累计获得积分 totalEarned 划分，不是当前可用积分 points。
 *  · 任务 type=daily 每天重置、weekly 每周一重置、once 永不重置。
 */

export const STORAGE_PREFIX = 'maison_points_v1::';
export const LEDGER_MAX = 200;
export const SIGNIN_HISTORY_MAX = 28;
export const CALENDAR_DAYS = 7;
export const LEDGER_SHOW = 8;

/** 签到规则 */
export const SIGNIN_RULES = {
  base: 10,
  // 顺序有意义：先判 7 天再判 3 天（第 21 天只发 7 天档，不重复发 3 天档）
  milestones: [
    { every: 7, bonus: 50, label: '连续 7 天' },
    { every: 3, bonus: 20, label: '连续 3 天' },
  ],
  hint: '每日 +10 · 连续 3 天额外 +20 · 连续 7 天额外 +50 · 断签重置',
};

/** 会员等级（阈值升序，按 totalEarned 判定） */
export const LEVELS = [
  { level: 1, name: '新手', min: 0 },
  { level: 2, name: '探索者', min: 200 },
  { level: 3, name: '行家', min: 800 },
  { level: 4, name: '鉴赏家', min: 2000 },
  { level: 5, name: '收藏家', min: 5000 },
];

/** 积分流水类型（规格：签到 / 任务 / 下单 / 兑换） */
export const LEDGER_TYPES = {
  SIGNIN: '签到',
  TASK: '任务',
  ORDER: '下单',
  REDEEM: '兑换',
};

/** 任务定义：behavior 必须与真实行为埋点名一致；dedupe 声明去重口径 */
export const TASK_DEFS = [
  {
    id: 'browse3', title: '浏览 3 个商品', description: '打开 3 款不同商品的详情页',
    reward: 5, type: 'daily', target: 3, behavior: 'view_product', dedupe: 'product',
  },
  {
    id: 'fav1', title: '收藏 1 个商品', description: '把心动的物件加入收藏夹',
    reward: 5, type: 'daily', target: 1, behavior: 'favorite',
  },
  {
    id: 'ai1', title: '完成 1 次 AI 对话', description: '与 AI 导购完成一轮问答',
    reward: 10, type: 'daily', target: 1, behavior: 'ai_chat',
  },
  {
    id: 'share1', title: '分享 1 次商品', description: '复制一件商品的分享链接',
    reward: 10, type: 'daily', target: 1, behavior: 'share',
  },
  {
    id: 'order1', title: '下单成功', description: '完成一笔订单',
    reward: 50, type: 'weekly', target: 1, behavior: 'order_success',
  },
  {
    id: 'review1', title: '评价 1 次', description: '发布一条商品评价',
    reward: 20, type: 'once', target: 1, behavior: 'review',
  },
];

export const TASK_TYPE_LABEL = { daily: '每日', weekly: '每周', once: '一次性' };
export const TASK_STATUS = { ACTIVE: '进行中', CLAIMABLE: '可领取', DONE: '已完成' };

/** 行为 → 任务 id 映射（由 TASK_DEFS 派生，避免两处维护） */
export const BEHAVIOR_TASKS = TASK_DEFS.reduce((map, t) => {
  (map[t.behavior] || (map[t.behavior] = [])).push(t.id);
  return map;
}, {});
