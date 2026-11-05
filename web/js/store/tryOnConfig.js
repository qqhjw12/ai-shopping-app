/**
 * tryOnConfig.js —— AR 试穿/试妆的**唯一规则源**（零依赖，Node 可直接 import）。
 *
 * 为什么要有这一层：规格说「服饰、鞋靴、美妆、珠宝、钟表、眼镜」六类才显示入口，
 * 但这站同时存在两套类目 id：
 *   · 商品池（demo-data / 网关）用老的 16 个一级：apparel / beauty / phone …
 *   · 分类树（categoryTree）用新的 25 个一级：womenswear / shoes / watches …
 * 把判断写在视图里，必然只覆盖其中一套。所以这里做成「一级类目映射 + 关键词兜底」，
 * 两套 id 都认，加新类目只改这张表。
 *
 * 另：`watches` 这个一级在分类树里是「钟表**眼镜**」合并的，所以它必须靠关键词
 * 再分一次叉，否则买太阳镜的人会看到「AR 试戴手表」——比没有按钮更糟。
 */

/** 试穿类型（决定文案与演示层的贴图位置） */
export const TRYON_KIND = {
  APPAREL: 'apparel',
  SHOES: 'shoes',
  BEAUTY: 'beauty',
  JEWELRY: 'jewelry',
  WATCH: 'watch',
  GLASSES: 'glasses',
};

/** 入口文案：同一句「AR 试穿」用在口红上是错的 */
export const TRYON_KIND_TEXT = {
  apparel: 'AR 试穿',
  shoes: 'AR 试穿',
  beauty: 'AR 试妆',
  jewelry: 'AR 试戴',
  watch: 'AR 试戴',
  glasses: 'AR 试戴',
};

/** 一级类目 → 试穿类型（两套 id 并存的完整映射） */
export const TRYON_CATEGORY_KIND = {
  // 新分类树
  womenswear: 'apparel',
  menswear: 'apparel',
  lingerie: 'apparel',
  shoes: 'shoes',
  jewelry: 'jewelry',
  watches: 'watch', // 「钟表眼镜」合并一级，下面再按关键词分叉
  beauty: 'beauty',
  // 商品池沿用的老 id
  apparel: 'apparel',
};

/**
 * 关键词兜底：[正则, 类型]。顺序即优先级——先匹配到的赢。
 * 眼镜排在手表前面：分类树里两者同属 `watches`，写反了就是错标签。
 */
export const TRYON_RULES = [
  [/眼镜|镜架|镜框|太阳镜|墨镜|隐形(眼镜)?|glasses|sunglass|eyewear|frame/i, 'glasses'],
  [/手表|腕表|机械表|石英表|watch|smartwatch/i, 'watch'],
  [/鞋|靴|sneaker|shoe|boot|loafer|sandal/i, 'shoes'],
  [/珠宝|项链|戒指|耳环|耳钉|手链|吊坠|jewel|ring|necklace|bracelet|earring/i, 'jewelry'],
  [/口红|唇釉|唇膏|粉底|眼影|腮红|高光|香水|彩妆|精华|面霜|乳液|lipstick|makeup|perfume|foundation|serum/i, 'beauty'],
  [/衣|裙|裤|外套|衬衫|针织|卫衣|风衣|羽绒|dress|shirt|coat|jacket|knit|hoodie|pants|skirt/i, 'apparel'],
];

/** 演示层文案：所有会被用户读到的句子都在这里，改口吻不用翻实现 */
export const TRYON_COPY = {
  entryHelp: '演示模式：用占位画面模拟摄像头与上身/上脸效果，不做人脸识别、不上传任何图像',
  desktopTitle: '请在移动设备上体验 AR 试穿',
  desktopBody: (label) => `${label}需要手机的后置摄像头。桌面端可以先用 360° 查看从各个角度观察商品；在手机上打开本页即可进入演示层。`,
  desktopOk: '知道了',
  cameraOn: '演示中 · 摄像头模拟画面',
  cameraLive: '演示中 · 真实摄像头背景',
  cameraDenied: '摄像头未授权，已切回模拟画面（不影响继续试用）',
  cameraFailed: '没法读取摄像头，已用模拟画面继续',
  staticNote: '当前设备不支持摄像头预览，这是静态试穿示意图',
  demoTag: '演示模式',
  skuLabel: '颜色 / 规格',
  shootLabel: '截图保存',
  shareLabel: '分享',
  shootToast: '试穿截图已生成（演示用占位图，未上传）',
  shootFail: '这个浏览器不支持导出截图，可先截屏保存',
  shareToast: '分享链接已复制（演示占位，不会真的发出去）',
  shareFail: '复制失败，可手动复制地址栏链接',
  closeLabel: '退出试穿',
  emptySku: '该商品暂无可切换规格',
  fitHint: '拖动画面可移动贴图位置',
  loadFail: 'AR 演示层加载失败，已降级为静态说明（不影响浏览与购买）',
  liveToggle: '启用摄像头背景',
  liveToggleHint: '只在本机渲染，不上传、不做识别',
  screenshotCaption: 'MAISON / AR DEMO',
};

/** 截图尺寸（竖屏 9:16，够发朋友圈又不至于太大） */
export const TRYON_SHOT = { W: 720, H: 1280 };

/** 真实摄像头背景：后置优先（试穿要拍全身/桌面） */
export const TRYON_CAMERA = { facingMode: 'environment' };

/** 摄像头能力探测口径：有 getUserMedia 就给「演示 + 可选真背景」，没有就静态示意图 */
export function cameraSupported(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : null);
  return !!(n && n.mediaDevices && typeof n.mediaDevices.getUserMedia === 'function');
}

/** 商品 → 试穿类型；不支持的类目返回 null（入口据此不渲染） */
export function tryOnKindOf(product) {
  if (!product || typeof product !== 'object') return null;
  const cat = String(product.categoryId || '');
  const base = TRYON_CATEGORY_KIND[cat] || null;
  const hay = [
    product.subCategory, product.subCategoryId, product.category, product.name,
    Array.isArray(product.tags) ? product.tags.join(' ') : '',
  ].filter(Boolean).join(' ');

  const hit = TRYON_RULES.find(([re]) => re.test(hay));
  const byKeyword = hit ? hit[1] : null;

  // 「钟表眼镜」合并一级：必须靠关键词分叉，否则太阳镜会拿到手表的文案
  if (base === 'watch') {
    if (byKeyword === 'glasses') return TRYON_KIND.GLASSES;
    return TRYON_KIND.WATCH;
  }
  // 服饰一级里混着鞋履（老池的「服饰鞋包」就是这么分类的），关键词更准
  if (base === 'apparel' && byKeyword === 'shoes') return TRYON_KIND.SHOES;
  return base || byKeyword;
}

/** 入口文案；不支持试穿返回空串 */
export function tryOnLabel(product) {
  const kind = tryOnKindOf(product);
  return kind ? TRYON_KIND_TEXT[kind] || 'AR 试穿' : '';
}

/** 是否该显示入口（视图层唯一的判断口径） */
export function supportsTryOn(product) {
  return tryOnKindOf(product) !== null;
}

/**
 * 规格串 → 稳定色相（0–359）：切 SKU 时贴图靠它换色，
 * 同一个规格每次拿到同一个颜色，刷新不跳。
 */
export function tryOnHueOf(spec) {
  const s = String(spec == null ? '' : spec);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/**
 * 常见色名 → 真实颜色（半透明叠色）。哈希色相只做兜底：
 * 规格里写「黑 / M」结果贴图泛绿光，用户第一反应是坏了，不是演示。
 */
export const TRYON_COLOR_WORDS = [
  [/米白|燕麦|奶油|象牙|cream|ivory|oat/i, 'hsl(38 46% 84% / 0.5)'],
  [/白|white/i, 'hsl(210 30% 94% / 0.5)'],
  [/水洗蓝|牛仔|denim/i, 'hsl(212 46% 46% / 0.5)'],
  [/蓝|blue/i, 'hsl(216 68% 46% / 0.5)'],
  [/军绿|橄榄|olive/i, 'hsl(88 32% 36% / 0.5)'],
  [/绿|green/i, 'hsl(148 42% 40% / 0.5)'],
  [/粉|樱|pink|sakura/i, 'hsl(342 68% 72% / 0.5)'],
  [/红|枣|酒红|red|wine/i, 'hsl(356 62% 44% / 0.5)'],
  [/驼|卡其|杏|camel|khaki|tan/i, 'hsl(32 46% 56% / 0.5)'],
  [/棕|咖|褐|brown|coffee/i, 'hsl(24 42% 34% / 0.5)'],
  [/银|silver/i, 'hsl(204 14% 72% / 0.55)'],
  [/金|gold/i, 'hsl(44 58% 56% / 0.55)'],
  [/灰|grey|gray/i, 'hsl(214 10% 46% / 0.5)'],
  [/黑|black/i, 'hsl(220 10% 10% / 0.6)'],
];

/** 规格串 → 叠色。先查色名词表，命中即用真实色；未命中回落哈希色相。 */
export function tryOnTintOf(spec) {
  const s = String(spec == null ? '' : spec);
  const hit = TRYON_COLOR_WORDS.find(([re]) => re.test(s));
  if (hit) return hit[1];
  return `hsl(${tryOnHueOf(s)} 62% 58% / 0.34)`;
}

/** 演示贴图的初始位置（按类型给不同落点：脸/上身/脚/腕） */
export function overlayPreset(kind) {
  switch (kind) {
    case 'beauty':
      return { top: '26%', left: '50%', scale: 0.62, caption: '上脸示意' };
    case 'glasses':
      return { top: '30%', left: '50%', scale: 0.5, caption: '镜架示意' };
    case 'jewelry':
      return { top: '42%', left: '50%', scale: 0.4, caption: '佩戴示意' };
    case 'watch':
      return { top: '58%', left: '38%', scale: 0.36, caption: '腕表示意' };
    case 'shoes':
      return { top: '74%', left: '50%', scale: 0.6, caption: '上脚示意' };
    case 'apparel':
    default:
      return { top: '48%', left: '50%', scale: 0.78, caption: '上身示意' };
  }
}
