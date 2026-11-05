// 拼团规则的唯一来源：成团档位、团价折扣、mock 截止时长、成员昵称池、分享奖励与文案。
// 零 DOM、零依赖（只读 pointsConfig 的既有任务定义，避免同一份奖励写两遍），
// Node 侧可直接 import 断言；仓储层与视图层都不允许写死这里的任何数值。
import { TASK_DEFS } from './pointsConfig.js';

/** 拼团数据前缀：按 scopeId() 分桶。「我的团」列表不给别人看，只有分享出去的单个团可被看到。 */
export const GB_STORAGE_PREFIX = 'maison_groupbuy_v1::';

/** 每人最多留存的历史团（含已成团/已失败），超出按截止时间淘汰最旧的。 */
export const GB_MAX_GROUPS = 24;

/**
 * 成团档位。discount = 团价相对单买价的降幅，全部落在 10%–30% 区间内
 * （GB_DISCOUNT_MIN / MAX 就是用来断言这件事的，不许虚标）。
 * 人越多越便宜——否则「凑人头」对用户没有收益，场景不成立。
 */
export const GB_TIERS = [
  { size: 2, discount: 0.1, label: '2 人团', hint: '再拉 1 人即成团' },
  { size: 3, discount: 0.18, label: '3 人团', hint: '再拉 2 人即成团' },
  { size: 5, discount: 0.28, label: '5 人团', hint: '5 人成团，单价最低' },
];

/** 规格硬约束：团价必须比单买低 10%–30%，低于/高于都算配置错误。 */
export const GB_DISCOUNT_MIN = 0.1;
export const GB_DISCOUNT_MAX = 0.3;

/** 默认档位（弹层初始选中项）。 */
export const GB_DEFAULT_SIZE = 3;

/** mock 截止时长：真实业务里由活动配置决定，这里固定 24h，保证任何时刻打开都能看到走的倒计时。 */
export const GB_DURATION_MS = 24 * 60 * 60 * 1000;

/** 倒计时刷新间隔（只改文本，不重建 DOM）。 */
export const GB_TICK_MS = 1000;

/** 剩余时间进入「紧张」态的阈值，用于文案变色。 */
export const GB_URGENT_MS = 60 * 60 * 1000;

/** 团状态：待成团 → 已成团 / 拼团失败（失败 = 到期仍未满员）。 */
export const GB_STATUS = { OPEN: 'open', FORMED: 'formed', FAILED: 'failed' };

export const GB_STATUS_TEXT = {
  [GB_STATUS.OPEN]: '待成团',
  [GB_STATUS.FORMED]: '已成团',
  [GB_STATUS.FAILED]: '拼团失败',
};

/** 团号：GB + yyMMdd + 4 位序号，便于肉眼核对与二次查询。 */
export const GB_NO_PREFIX = 'GB';
export const GB_NO_SEQ_LEN = 4;

/**
 * 模拟好友昵称池：演示态「模拟好友参团」从这里按顺序取，
 * 同一个团里不重复用同一个人填两个坑。
 */
export const GB_FRIEND_NAMES = [
  '阿岚', '小野', 'Nova', '橘子', '阿吉', 'Momo', '老周', 'Kite',
  '半糖', '阿柚', 'Tina', '豆包', '阿森', 'Luna', '小满', '阿凉',
];

/** 团长昵称兜底（未登录演示态，没有真实用户名可读）。 */
export const GB_OWNER_FALLBACK = '我';

/** 昵称池被用尽后的续命名前缀（例如 好友1 / 好友2），避免出现重名成员。 */
export const GB_FRIEND_FALLBACK = '好友';

/** 分享奖励：直接复用积分体系里既有的「分享」任务，不另造一条奖励通道。 */
const SHARE_TASK = TASK_DEFS.find((t) => t.behavior === 'share') || null;
export const GB_SHARE_TASK_ID = SHARE_TASK ? SHARE_TASK.id : 'share1';
export const GB_SHARE_REWARD = SHARE_TASK ? SHARE_TASK.reward : 10;

/** 分享出去的落地页：别人点开就是这个团的详情（带 invite 标记）。 */
export function gbShareHash(id) {
  return `#/group-buy/${encodeURIComponent(String(id || ''))}?invite=1`;
}

/** 二维码占位：不引入真实二维码库，用纯 CSS 网格 + 团号首字母渲染（见样式层 .gb-qr）。 */
export const GB_QR_NOTE = '演示用二维码占位，扫码功能不接入';

/** 页面文案集中管理，视图层不写死中文。 */
export const GB_COPY = {
  eyebrow: 'GROUP BUY',
  title: '拼团大厅',
  lead: '凑够人就能按团价拿走。人越多，单价越低。',
  startCta: '发起拼团',
  startTitle: '发起拼团',
  startLead: '选一个成团人数，团价立刻算给你看。',
  createCta: '开团',
  openListCta: '查看我的团',
  inviteCta: '邀请好友',
  // 分享奖励不直接加分，而是把积分体系里的「分享」任务推到可领取
  // （任务何时领取由用户在积分页决定，页面不能替他说「已经加到账上」）
  inviteCopied: '邀请链接已复制，分享任务已记录',
  inviteTaskHint: (pts) => `${pts} 积分在「积分与任务」里领取`,
  inviteFail: '当前环境不支持自动复制，请手动复制地址栏链接',
  simulateCta: '模拟好友参团',
  simulateHint: '演示用：点一下相当于一位好友加入',
  simulateDone: '一位好友参团了',
  formedToast: '成团了，可以结算',
  failedToast: '这个团到期没满员，已自动关闭',
  checkoutCta: '去结算',
  remaining: (n) => `还差 ${n} 人成团`,
  full: '已满员',
  membersTitle: '团成员',
  ownerTag: '团长',
  emptyTitle: '还没有进行中的团',
  emptyLead: '在商品详情页点「发起拼团」，选个人数就能开团。',
  emptyCta: '去逛商品',
  listTitle: '我的团',
  filterOpen: '进行中',
  filterDone: '已结束',
  priceSave: (pct) => `省 ${pct}%`,
  groupPriceLabel: '拼团价',
  singlePriceLabel: '单买价',
  deadlineLabel: '截止',
  noProduct: '商品已不在库中，该团无法继续',
  notFound: '这个团不存在，或已在另一台设备上被清理',
  notFoundCta: '回拼团大厅',
  shareTitle: '分享这个团',
  inviteLanding: '你正在看好友分享的拼团，可直接参团',
  orderTag: '拼团',
  createdToast: (no) => `开团成功，团号 ${no}`,
};
