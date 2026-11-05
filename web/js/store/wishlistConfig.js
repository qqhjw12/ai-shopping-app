// 心愿单助力规则的唯一来源：助力阶梯、每档奖励券、访客助力限制、理由长度与文案。
// 关键设计：奖励只写 couponId，不写面额 —— 面额、门槛、有效期永远由券目录说了算，
// 运营改券不用改这里，也不会出现「页面写减 20、券包里实际减 10」。
// 零 DOM、零依赖（不 import couponStore，否则会把 api/auth 的浏览器依赖拖进来），
// Node 可直接 import 断言。

/** 心愿单数据前缀：按 scopeId() 分桶。别人只能看被公开出去的那一份。 */
export const WL_STORAGE_PREFIX = 'maison_wishlist_v1::';

/**
 * 公开索引：**跨 scope 可读**。访客有自己的 scopeId()，不共享这张表就打不开别人的公开页。
 * 只存「公开页需要的最小信息」（id / 主人昵称 / 商品 id 列表 / 理由 / 助力记录 / 领取标记），
 * 不存主人的整个收藏夹，避免一个链接把收藏全量公开出去。
 */
export const WL_PUBLIC_INDEX_KEY = 'maison_wishlist_public_v1';

/** 公开页 id 前缀，出现在 URL 里，一眼能认出是心愿单。 */
export const WL_ID_PREFIX = 'wl_';

/** 一个心愿单最多放几件商品（超过就分单，公开页也不会长到滑不完）。 */
export const WL_MAX_ITEMS = 12;

/** 心愿理由长度：太短没信息量，太长会把卡片撑破。 */
export const WL_REASON_MIN = 4;
export const WL_REASON_MAX = 60;

/** 理由预设：用户不想手打时可一键填，仍然落在上面的长度区间内。 */
export const WL_REASON_PRESETS = [
  '等了很久的补货款，想和朋友一起拿下',
  '生日礼物候选，先放这儿攒点人气',
  '换季必买，等一个折扣就下手',
];

/** 理由为空时的兜底文案（老数据 / 用户跳过填写）。 */
export const WL_REASON_FALLBACK = '就是很喜欢，想收';

/**
 * 助力阶梯：threshold 人助力解锁对应奖励券。
 * couponId 必须真实存在于券目录；校验在 wishlistStore.validateTiers(catalog) 里做，
 * 这样配置层保持零依赖，同时错误仍然会在页面渲染时暴露（并写入 console.warn）。
 */
export const WL_TIERS = [
  { threshold: 3, couponId: 'cp-bag20' },
  { threshold: 10, couponId: 'demo-c90' },
];

/** 阶梯阈值升序（推导函数依赖顺序，别在别处再排一次）。 */
export const WL_TIER_THRESHOLDS = WL_TIERS.map((t) => t.threshold).sort((a, b) => a - b);

/** 满进度阈值：进度条归一化到最后一个阶梯。 */
export const WL_MAX_THRESHOLD = WL_TIER_THRESHOLDS[WL_TIER_THRESHOLDS.length - 1] || 1;

/** 一个访客对同一份心愿单只能助力一次（按 scopeId 去重），防止刷新刷进度。 */
export const WL_HELP_LIMIT_PER_VISITOR = 1;

/** 是否允许给自建的心愿单助力（关掉，否则「自己点十下就领券」）。 */
export const WL_ALLOW_SELF_HELP = false;

/** 达标后给主人的通知保留条数上限。 */
export const WL_MAX_NOTICES = 20;

/** 页面文案。 */
export const WL_COPY = {
  eyebrow: 'WISH LIST',
  title: '公开心愿单',
  publicToggle: '公开心愿单',
  publicOn: '已公开，任何人拿到链接都能看',
  publicOff: '未公开，只有你自己能看到',
  publicEmpty: '收藏夹是空的，先收几件再来公开',
  copyLink: '复制分享链接',
  copied: '分享链接已复制',
  copyFail: '当前环境不支持自动复制，请手动复制地址栏链接',
  openPublic: '预览公开页',
  openOwn: '我公开的心愿单',
  helpCta: '为 TA 助力',
  helpedCta: '已助力',
  helpedToast: '助力成功，进度 +1',
  selfHelp: '这是你自己的心愿单，给自己助力不算数',
  duplicateHelp: '你已经助力过这份心愿单了',
  loginHint: '未登录也能助力，记录暂存在本机',
  progress: (have, need) => `已获 ${have} 人助力，再 ${need} 人可享奖励`,
  progressDone: (have) => `已获 ${have} 人助力，奖励已解锁`,
  tierLocked: (reward, need) => `再 ${need} 人可享${reward}`,
  tierUnlocked: (reward) => `${reward} 已解锁`,
  claimCta: '领取奖励',
  claimed: '已领取',
  claimToast: (reward) => `已发放到券包：${reward}`,
  claimLogin: '登录后才能把券发到你的券包',
  claimDone: '该奖励已领取过',
  noticeTitle: '你的心愿单达成助力目标',
  noticeBody: (reward) => `奖励「${reward}」可以领了`,
  ownerHint: '好友助力达标后，奖励券会自动进你的券包',
  emptyPublic: '这份心愿单还没有商品',
  notFound: '这份心愿单不存在，或主人已经收回公开',
  notFoundCta: '去逛商品',
  reasonLabel: '心愿理由',
  itemsCount: (n) => `${n} 件心愿`,
  visitors: (n) => `${n} 位好友助力`,
  ownerLabel: '心愿单主人',
};
