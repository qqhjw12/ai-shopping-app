// 程序化商品图：为每款商品生成一张「渐变底 + 类目线稿」的 SVG。
// 为什么不用真实图片：本项目零依赖、离线可跑、GitHub Pages 也能用，
// 外链图床会引入网络依赖与版权问题，所以改为按商品数据现场绘制——
// 同一个商品的封面永远一致（来自数据库 coverColor），同类目视觉成体系。

// 8 个类目的线稿（画布 200×200，图形居中；stroke 统一由外层 group 控制）
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

// 类目兜底色（商品没带 coverColor 时使用，保证视觉不塌），与前端口灰度一致
const FALLBACK = {
  phone: '#4f6ef7,#8b7cf6',
  computer: '#0e9abb,#5ad3e0',
  audio: '#7c3aed,#c084fc',
  appliance: '#0d9488,#5eead4',
  apparel: '#e0407f,#ff9ab5',
  food: '#f59e0b,#fbbf24',
  home: '#b45309,#e0a86a',
  sports: '#16a34a,#6ee7a0',
  beauty: '#d831bf,#e879d8',
  baby: '#f43f5e,#fb8fa8',
  book: '#ca8a04,#eab308',
  kitchen: '#dc2626,#f97316',
  pet: '#65a30d,#a3e635',
  auto: '#0891b2,#38bdf8',
  health: '#4f46e5,#818cf8',
  stationery: '#7e22ce,#c084fc',
};

function escapeAttr(s) {
  return String(s).replace(/[<>"'&]/g, '');
}

/** 拆出双色："#aaa,#bbb" → ['#aaa','#bbb'] */
function colorsOf(p) {
  const raw = (p && p.coverColor) || FALLBACK[(p && p.categoryId) || ''] || '#64748b,#94a3b8';
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return [parts[0] || '#64748b', parts[1] || parts[0] || '#94a3b8'];
}

export function colorPair(p) {
  return colorsOf(p);
}

/**
 * 生成商品图 SVG 字符串
 * @param {object} p 商品（需 id / categoryId / coverColor，缺失也能兜底）
 * @param {{label?:boolean}} [opts] label 为真时在角落显示品牌首字，用于极小尺寸
 */
export function productArtSvg(p, opts = {}) {
  const key = escapeAttr((p && p.id) || 'x') + '-' + Math.random().toString(36).slice(2, 7);
  const [c1, c2] = colorsOf(p);
  const art = ART[(p && p.categoryId) || ''] || ART.phone;
  const gid = `g-${key}`;
  const seed = String((p && p.id) || 'x').charCodeAt(String((p && p.id) || 'x').length - 1) || 0;
  // 光斑位置随商品微调，避免所有商品长得完全一样
  const cx = 120 + (seed % 50);
  const cy = 34 + (seed % 24);
  return `
<svg class="art" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${escapeAttr(c1)}"/>
      <stop offset="100%" stop-color="${escapeAttr(c2)}"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" fill="url(#${gid})"/>
  <circle cx="${cx}" cy="${cy}" r="72" fill="#fff" opacity="0.12"/>
  <circle cx="26" cy="182" r="58" fill="#000" opacity="0.10"/>
  <path d="M0 150 L200 60 L200 200 L0 200 Z" fill="#fff" opacity="0.05"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.92" stroke-width="3.4"
     stroke-linecap="round" stroke-linejoin="round" transform="translate(0,4)">
    ${art}
  </g>
</svg>`;
}

/**
 * 商品图 DOM 节点（替代原先的 emoji 占位）
 * @returns {HTMLElement}
 */
export function productArt(p, cls = '') {
  const wrap = document.createElement('span');
  wrap.className = `art-wrap ${cls}`.trim();
  wrap.innerHTML = productArtSvg(p);
  return wrap;
}
