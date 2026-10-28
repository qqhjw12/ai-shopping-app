// 程序化商品图：为每款商品生成一张「构图模板 + 类目线稿」的 SVG 封面。
// 为什么不用真实图片：本项目零依赖、离线可跑、GitHub Pages 也能用，
// 外链图床会引入网络依赖与版权问题，所以改为按商品数据现场绘制。
//
// v2 —— 解决「看起来像没有图片」的三个根因：
//   1. 同类目封面只有 ±5° 旋转的微差 → 拼图四格几乎相同。
//      现在：每商品按 id 稳定派生「6 种构图模板 × 3 档明暗 + 位置/角度参数」，
//      同类目相邻商品也能拉开明显差距。
//   2. 浅色底上用白色线稿 → 线稿几乎隐形，观感就是"没图"。
//      现在：按底色亮度自适应线稿颜色（浅底换墨色）。
//   3. 装饰层全是 0.05~0.1 透明度的白 → 浅底上看不见。
//      现在：装饰色随明暗档切换（深底纸白 / 浅底墨黑）。

// 16 个类目的线稿（画布 200×200，图形居中；stroke 由外层 group 统一控制）
const ART = {
  phone: `
    <rect x="72" y="40" width="56" height="120" rx="13"/>
    <line x1="90" y1="51" x2="110" y2="51"/>
    <rect x="86" y="145" width="28" height="4" rx="2"/>
    <line x1="72" y1="72" x2="72" y2="98"/>`,
  computer: `
    <rect x="52" y="52" width="96" height="70" rx="6"/>
    <path d="M36 130 H164 L173 146 H27 Z"/>
    <line x1="58" y1="137" x2="142" y2="137" opacity="0.45"/>`,
  audio: `
    <path d="M56 112 V92 a44 44 0 0 1 88 0 V112"/>
    <rect x="42" y="104" width="28" height="46" rx="13"/>
    <rect x="130" y="104" width="28" height="46" rx="13"/>
    <path d="M70 127 h60" opacity="0.4"/>`,
  appliance: `
    <rect x="62" y="38" width="76" height="124" rx="10"/>
    <line x1="62" y1="90" x2="138" y2="90"/>
    <line x1="96" y1="102" x2="96" y2="124"/>
    <line x1="112" y1="102" x2="112" y2="124"/>
    <line x1="94" y1="56" x2="94" y2="76"/>`,
  apparel: `
    <path d="M78 56 L58 65 L44 96 L64 107 L70 94 V154 H130 V94 L136 107 L156 96 L142 65 L122 56 Z"/>
    <path d="M78 56 a22 22 0 0 0 44 0"/>
    <line x1="88" y1="126" x2="112" y2="126" opacity="0.4"/>`,
  food: `
    <path d="M44 106 H156 a56 56 0 0 1-112 0 Z"/>
    <line x1="30" y1="106" x2="170" y2="106"/>
    <path d="M86 84 q9-11 0-22"/>
    <path d="M100 80 q9-13 0-25"/>
    <path d="M114 84 q9-11 0-22"/>`,
  home: `
    <path d="M66 130 V82 a10 9 0 0 1 68 0 V130"/>
    <rect x="54" y="126" width="92" height="16" rx="7"/>
    <line x1="68" y1="142" x2="60" y2="170"/>
    <line x1="132" y1="142" x2="140" y2="170"/>
    <line x1="66" y1="104" x2="134" y2="104" opacity="0.4"/>`,
  sports: `
    <path d="M100 46 L166 150 H34 Z"/>
    <path d="M100 46 V150"/>
    <path d="M100 76 L130 150 M100 76 L70 150" opacity="0.45"/>
    <path d="M34 150 H166"/>`,
  beauty: `
    <rect x="86" y="62" width="28" height="92" rx="12"/>
    <rect x="94" y="40" width="12" height="22" rx="4"/>
    <path d="M86 42 H114"/>
    <path d="M100 90 q12 16 0 32 q-12-16 0-32" opacity="0.45"/>`,
  baby: `
    <rect x="84" y="80" width="34" height="70" rx="12"/>
    <rect x="93" y="58" width="16" height="22" rx="5"/>
    <path d="M97 58 a5 8 0 0 1 8 0"/>
    <line x1="84" y1="104" x2="118" y2="104" opacity="0.4"/>
    <line x1="84" y1="120" x2="118" y2="120" opacity="0.4"/>
    <circle cx="60" cy="76" r="11" opacity="0.55"/>
    <circle cx="140" cy="88" r="8" opacity="0.45"/>`,
  book: `
    <path d="M100 68 V150 q-24-8-46-8 V58 q22 0 46 10"/>
    <path d="M100 68 V150 q24-8 46-8 V58 q-22 0-46 10"/>
    <line x1="62" y1="82" x2="88" y2="90" opacity="0.4"/>
    <line x1="112" y1="90" x2="138" y2="82" opacity="0.4"/>`,
  kitchen: `
    <path d="M48 98 h82 v32 a41 41 0 0 1-82 0 Z"/>
    <line x1="130" y1="106" x2="168" y2="106"/>
    <path d="M48 98 H130"/>
    <path d="M80 78 q9-13 0-24 M100 74 q9-15 0-28 M120 78 q9-13 0-24" opacity="0.5"/>`,
  pet: `
    <ellipse cx="100" cy="124" rx="27" ry="23"/>
    <circle cx="70" cy="92" r="12"/>
    <circle cx="92" cy="78" r="12"/>
    <circle cx="116" cy="78" r="12"/>
    <circle cx="138" cy="92" r="12"/>`,
  auto: `
    <circle cx="60" cy="132" r="26"/>
    <circle cx="146" cy="132" r="26"/>
    <path d="M60 132 h26 l24-44 h28 l16 44"/>
    <path d="M92 88 h30"/>
    <path d="M110 88 V68 h16" opacity="0.7"/>`,
  health: `
    <path d="M100 48 V88 M80 68 H120"/>
    <path d="M24 150 h22 l9-18 l14 34 l13-24 l9 8 h38" opacity="0.65"/>
    <rect x="76" y="112" width="48" height="26" rx="8" opacity="0.35"/>`,
  stationery: `
    <path d="M64 134 L156 42 l16 16 L80 150 Z"/>
    <path d="M58 140 L50 148 l10 10 l8-8"/>
    <line x1="86" y1="112" x2="112" y2="86" opacity="0.4"/>
    <path d="M74 124 L102 96" opacity="0.3"/>`,
};

// 类目底色：低饱和的暖中性色（[深, 浅] 两端），同类目共享色彩体系。
const PALETTE = {
  phone: ['#5F665D', '#929A87'],
  computer: ['#525E62', '#8E9A9A'],
  audio: ['#514E49', '#898277'],
  appliance: ['#6E6659', '#AB9F8B'],
  apparel: ['#806157', '#BB9B8D'],
  food: ['#806B51', '#BAA173'],
  home: ['#716659', '#AC9C89'],
  sports: ['#505B4E', '#8D9480'],
  beauty: ['#8C6B64', '#C3A59C'],
  baby: ['#957872', '#C5ABA2'],
  book: ['#655C4C', '#A29378'],
  kitchen: ['#796752', '#B29B80'],
  pet: ['#626957', '#9EA386'],
  auto: ['#525B5E', '#8E9697'],
  health: ['#5E6D66', '#96A49C'],
  stationery: ['#6B6252', '#A39784'],
  misc: ['#6B6257', '#A69B89'],
};

const INK = '#33312C';
const PAPER = '#FBF8F1';

function escapeAttr(s) {
  return String(s).replace(/[<>"'&]/g, '');
}

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [36, 10, 63];
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

/** 稳定 seed：同一商品永远派生同一封面（不再用 Math.random） */
function seedOf(p) {
  const s = String((p && p.id) || 'x');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 商品专属色彩：在类目色系内做三档明暗变体。
 * 返回 { c1, c2, light, stroke, deco, shadow }
 *  - light=true 表示浅色底：线稿/装饰换墨色，保证可见
 */
function colorsOf(p) {
  const cat = (p && p.categoryId) || 'misc';
  const pair = PALETTE[cat] || PALETTE.misc;
  const seed = seedOf(p);
  const [h, s0, l0] = hexToHsl(pair[0]);
  const shift = (((seed >>> 3) % 9) - 4) * 1.4;
  const hue = (h + shift + 360) % 360;
  const s = s0;
  const tone = (seed >>> 6) % 3; // 0 深 / 1 中 / 2 浅
  const L = {
    0: [clamp(l0 - 13, 14, 92), clamp(l0 + 2, 20, 94)],
    1: [clamp(l0 - 5, 18, 92), clamp(l0 + 10, 24, 94)],
    2: [clamp(l0 + 16, 22, 88), clamp(l0 + 26, 28, 92)],
  }[tone];
  const c1 = `hsl(${hue} ${Math.max(5, s - 3)}% ${L[0]}%)`;
  const c2 = `hsl(${hue} ${Math.max(5, s + 1)}% ${L[1]}%)`;
  const light = L[0] > 52;
  return {
    c1,
    c2,
    light,
    stroke: light ? INK : PAPER,
    deco: light ? 'rgba(51, 49, 44,' : 'rgba(250, 249, 246,',
    shadow: light ? 'rgba(51, 49, 44, 0.14)' : 'rgba(10, 10, 8, 0.22)',
  };
}

export function colorPair(p) {
  const c = colorsOf(p);
  return [c.c1, c.c2];
}

/* ------------------------------------------------------------------
   6 种构图模板（背景 + 装饰层），T = colorsOf 结果，r = 伪随机参数
   ------------------------------------------------------------------ */

// v0 拱门：中央拱形龛 + 地面阴影
function bdArches(T, r) {
  const w = 88 + r(0) * 26;
  const top = 118 - r(1) * 22;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <path d="M${100 - w / 2} 200 V${top} a${w / 2} ${w / 2} 0 0 1 ${w} 0 V200 Z" fill="${T.deco}0.12)"/>
  <ellipse cx="100" cy="164" rx="${w / 2 + 6}" ry="7" fill="${T.shadow}"/>`;
}

// v1 对角色块：右上大圆 + 左下三角 + 对角线
function bdDiagonal(T, r) {
  const cx = 150 + r(0) * 26;
  const cy = 26 + r(1) * 30;
  const rad = 62 + r(2) * 26;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <circle cx="${cx}" cy="${cy}" r="${rad}" fill="${T.deco}0.13)"/>
  <path d="M-14 214 L94 60 L214 214 Z" fill="${T.deco}0.09)"/>
  <line x1="${20 + r(3) * 40}" y1="200" x2="200" y2="${60 + r(4) * 50}" stroke="${T.deco}0.22)" stroke-width="0.9"/>
  <ellipse cx="100" cy="162" rx="46" ry="7" fill="${T.shadow}"/>`;
}

// v2 圆窗：中央纸色圆窗，线稿落在窗内
function bdWindow(T, r) {
  const rad = 58 + r(0) * 12;
  const off = (r(1) - 0.5) * 14;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <circle cx="${100 + off}" cy="102" r="${rad + 12}" fill="${T.deco}0.1)"/>
  <circle cx="${100 + off}" cy="102" r="${rad}" fill="${T.light ? 'rgba(255,255,255,0.5)' : 'rgba(250,249,246,0.14)'}"/>
  <circle cx="${100 + off}" cy="102" r="${rad}" fill="none" stroke="${T.deco}0.35)" stroke-width="1"/>
  <circle cx="${100 + off}" cy="102" r="${rad + 18}" fill="none" stroke="${T.deco}0.18)" stroke-width="0.7"/>
  <ellipse cx="${100 + off}" cy="${102 + rad * 0.62}" rx="${rad * 0.62}" ry="6" fill="${T.shadow}"/>`;
}

// v3 层叠卡：三张错位圆角卡片
function bdStack(T, r) {
  const o = (r(0) - 0.5) * 18;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <rect x="${34 + o}" y="40" width="120" height="120" rx="14" fill="${T.deco}0.08)" transform="rotate(${-6 - r(1) * 5} 100 100)"/>
  <rect x="${40 - o}" y="46" width="120" height="120" rx="14" fill="${T.deco}0.14)" transform="rotate(${3 + r(2) * 5} 100 100)"/>
  <ellipse cx="100" cy="166" rx="52" ry="7" fill="${T.shadow}"/>`;
}

// v4 波纹：底部三层波浪
function bdWaves(T, r) {
  const y1 = 138 + r(0) * 14;
  const y2 = y1 + 12 + r(1) * 8;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <circle cx="${40 + r(2) * 120}" cy="${34 + r(3) * 26}" r="42" fill="${T.deco}0.1)"/>
  <path d="M0 ${y1} Q 50 ${y1 - 14} 100 ${y1} T 200 ${y1} V200 H0 Z" fill="${T.deco}0.12)"/>
  <path d="M0 ${y2} Q 60 ${y2 - 10} 120 ${y2} T 200 ${y2 - 4} V200 H0 Z" fill="${T.deco}0.18)"/>
  <ellipse cx="100" cy="158" rx="48" ry="7" fill="${T.shadow}"/>`;
}

// v5 编号海报：超大衬线序号水印 + 底部色带
function bdPoster(T, r, serial) {
  const bx = 14 + r(0) * 10;
  return `
  <rect width="200" height="200" fill="url(#GID)"/>
  <text x="${196 - r(1) * 30}" y="66" fill="${T.deco}0.16)" font-family="Georgia, serif"
        font-size="${58 + r(2) * 16}" font-style="italic" text-anchor="end">${escapeAttr(serial)}</text>
  <rect x="${bx}" y="168" width="${120 + r(3) * 40}" height="7" rx="3.5" fill="${T.deco}0.24)"/>
  <ellipse cx="100" cy="158" rx="44" ry="6" fill="${T.shadow}"/>`;
}

const BACKDROPS = [bdArches, bdDiagonal, bdWindow, bdStack, bdWaves, bdPoster];

/**
 * 生成商品图 SVG 字符串
 * @param {object} p 商品（需 id / categoryId，缺失也能兜底）
 */
export function productArtSvg(p) {
  const cat = (p && p.categoryId) || 'misc';
  const T = colorsOf(p);
  const seed = seedOf(p);
  const gid = `g-${escapeAttr(String((p && p.id) || 'x'))}`;
  const r = (n) => ((seed >>> (n * 4)) % 100) / 100; // 0..1 的稳定伪随机
  const serial = String(((seed >>> 9) % 97) + 1).padStart(2, '0');
  const art = ART[cat] || ART.phone;

  const backdrop = BACKDROPS[(seed >>> 12) % BACKDROPS.length](T, r, serial);
  // 线稿姿态：位置 / 角度 / 缩放都随商品变，幅度克制
  const gx = 100 + (r(5) - 0.5) * 8;
  const gy = 98 + (r(6) - 0.5) * 8;
  const angle = ((seed % 17) - 8) * 1.1;
  const scale = 0.9 + r(7) * 0.2;

  return `
<svg class="art" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <linearGradient id="${gid}" x1="${r(8) > 0.5 ? 1 : 0}" y1="0" x2="${r(9) > 0.5 ? 1 : 0}" y2="1">
      <stop offset="0%" stop-color="${escapeAttr(T.c1)}"/>
      <stop offset="100%" stop-color="${escapeAttr(T.c2)}"/>
    </linearGradient>
  </defs>
  ${backdrop.replace(/GID/g, gid)}
  <path d="M14 22 H52" stroke="${T.deco}0.45)" stroke-width="0.8"/>
  <text x="14" y="15" fill="${T.deco}0.62)" font-family="Georgia, serif" font-size="5" letter-spacing="1.1">MAISON / ${escapeAttr(cat.toUpperCase())}</text>
  <text x="186" y="188" fill="${T.deco}0.5)" font-family="Georgia, serif" font-style="italic" font-size="7" text-anchor="end">No. ${escapeAttr(serial)}</text>
  <g fill="none" stroke="${T.stroke}" stroke-opacity="0.88" stroke-width="1.5"
     stroke-linecap="round" stroke-linejoin="round"
     transform="translate(${gx} ${gy}) rotate(${angle}) scale(${scale}) translate(-100 -100)">
    ${art}
  </g>
</svg>`;
}

/**
 * 商品图 DOM 节点
 * @returns {HTMLElement}
 */
export function productArt(p, cls = '') {
  const wrap = document.createElement('span');
  wrap.className = `art-wrap ${cls}`.trim();
  wrap.innerHTML = productArtSvg(p);
  return wrap;
}
