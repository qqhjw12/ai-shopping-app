/**
 * showroomArt.js —— 展厅氛围图（程序化 SVG，零外部请求）。
 *
 * 为什么不用实拍大图：这站的商品图本来就是「确定性 SVG 封面」，展厅里突然
 * 塞几张外链摄影图，离线/图床抖动就是一片破图 + 控制台报错（前几轮踩过）。
 * 这里用同样的视觉语言画一张宽幅氛围图：深空底色 + 一层分区色薄雾 +
 * 远处的地平线、展台与巨型衬线编号。纯 DOM/SVG，随时可换真图。
 *
 * 确定性：同一个 zone.id 每次生成的随机参数完全一致，刷新不跳变。
 */

/* ---------------- 稳定哈希（FNV-1a，与 products.js 同款） ---------------- */
function hash(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
const rnd = (seed, salt) => ((hash(`${seed}:${salt}`) >>> 8) % 1000) / 1000;
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 宽幅氛围图 SVG 字符串。
 * @param {object} zone 分区（需 id / no / name / hue）
 * @param {{variant?: 'card'|'hero'}} opts card=列表页 16:9，hero=详情页更高更宽
 */
export function zoneArtSvg(zone, { variant = 'card' } = {}) {
  const z = zone || {};
  const seed = `${z.id || 'x'}:${variant}`;
  const hue = Number.isFinite(z.hue) ? z.hue : 200;
  const W = 1200;
  const H = variant === 'hero' ? 720 : 620;
  const gid = `sr-${esc(String(z.id || 'x')).replace(/[^a-zA-Z0-9-]/g, '')}-${variant}`;
  const horizon = variant === 'hero' ? H * 0.66 : H * 0.68;

  /* 展台：三个高度错落的方台，位置随 seed 微调 */
  const plinths = Array.from({ length: 3 }, (_, i) => {
    const w = 120 + rnd(seed, `w${i}`) * 90;
    const h = 54 + rnd(seed, `h${i}`) * 46;
    const x = 150 + i * 300 + (rnd(seed, `x${i}`) - 0.5) * 60;
    const y = horizon - h + 8;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2"
      fill="rgba(232,237,242,0.05)" stroke="rgba(139,149,163,0.28)" stroke-width="1"/>
    <line x1="${x.toFixed(1)}" y1="${(y + 10).toFixed(1)}" x2="${(x + w).toFixed(1)}" y2="${(y + 10).toFixed(1)}"
      stroke="rgba(34,211,238,0.22)" stroke-width="1"/>`;
  }).join('');

  /* 横向细网格：向上逐级衰减，暗示纵深 */
  const cols = Array.from({ length: 9 }, (_, i) => {
    const x = ((i + 0.5) * W) / 9;
    const op = 0.1 - Math.abs(i - 4) * 0.012;
    return `<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${horizon.toFixed(1)}"
      stroke="rgba(34,211,238,${Math.max(0.02, op).toFixed(3)})" stroke-width="1"/>`;
  }).join('');

  /* 顶部刻度：像仪表盘的那排短竖线 */
  const ticks = Array.from({ length: 26 }, (_, i) => {
    const x = 60 + i * 42;
    const long = i % 5 === 0;
    return `<line x1="${x}" y1="44" x2="${x}" y2="${44 + (long ? 12 : 6)}"
      stroke="rgba(232,237,242,${long ? 0.34 : 0.16})" stroke-width="1"/>`;
  }).join('');

  const glowX = Math.round(W * (0.58 + rnd(seed, 'gx') * 0.18));
  const glowY = Math.round(horizon * (0.42 + rnd(seed, 'gy') * 0.2));

  return `<svg class="sr-art-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
  preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(z.name || '展厅')} 氛围图">
  <defs>
    <linearGradient id="${gid}-bg" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 34% 7%)"/>
      <stop offset="58%" stop-color="hsl(${hue} 30% 10%)"/>
      <stop offset="100%" stop-color="#07090c"/>
    </linearGradient>
    <radialGradient id="${gid}-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="hsl(${hue} 70% 58%)" stop-opacity="0.28"/>
      <stop offset="65%" stop-color="hsl(${hue} 70% 48%)" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="hsl(${hue} 70% 40%)" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#${gid}-bg)"/>
  <ellipse cx="${glowX}" cy="${glowY}" rx="${Math.round(W * 0.42)}" ry="${Math.round(H * 0.5)}"
    fill="url(#${gid}-glow)"/>
  ${cols}

  <!-- 巨型衬线编号（分区识别符，压在水位线以下一点） -->
  <text x="${W - 56}" y="${Math.round(horizon - 40)}" text-anchor="end"
    font-family="Georgia, 'Times New Roman', serif" font-style="italic"
    font-size="${variant === 'hero' ? 300 : 250}" fill="rgba(232,237,242,0.07)">${esc(z.no || '00')}</text>

  <!-- 地平线 -->
  <line x1="0" y1="${horizon.toFixed(1)}" x2="${W}" y2="${horizon.toFixed(1)}"
    stroke="rgba(139,149,163,0.34)" stroke-width="1"/>
  ${plinths}

  <!-- 展台下的倒影渐隐带 -->
  <rect x="0" y="${horizon.toFixed(1)}" width="${W}" height="${(H - horizon).toFixed(1)}"
    fill="rgba(7,9,12,0.55)"/>

  ${ticks}
  <text x="60" y="34" font-family="'SFMono-Regular', ui-monospace, monospace" font-size="13"
    letter-spacing="3" fill="rgba(34,211,238,0.72)">MAISON / ${esc(z.eyebrow || 'SHOWROOM')}</text>
  <text x="60" y="${Math.round(horizon - 26)}" font-family="Georgia, 'Times New Roman', serif"
    font-size="${variant === 'hero' ? 62 : 52}" fill="#e8edf2">${esc(z.name || '展厅')}</text>
  <text x="60" y="${Math.round(horizon + 52)}" font-family="'SFMono-Regular', ui-monospace, monospace"
    font-size="14" letter-spacing="1.4" fill="rgba(139,149,163,0.9)">${esc(z.floor || z.desc || '')}</text>
</svg>`;
}

/**
 * 氛围图 DOM（挂在一个 span 上，避免直接 innerHTML 到页面节点里丢语义）
 * @returns {HTMLElement}
 */
export function zoneArt(zone, opts = {}) {
  const wrap = document.createElement('span');
  wrap.className = `sr-art sr-art-${opts.variant === 'hero' ? 'hero' : 'card'}`;
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = zoneArtSvg(zone, opts);
  return wrap;
}
