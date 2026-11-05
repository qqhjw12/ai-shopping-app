/**
 * sceneArt.js —— 场景 / 主题的氛围图（程序化 SVG，零外部请求）。
 *
 * 和展厅的区别：展厅画的是「空间」（地平线、展台、分区编号），这里画的是
 * 「气氛」（雾、光斑、一条低饱和的地平线）。同一个深空底色，两种视觉语法。
 *
 * 三条纪律：
 *   · **不写图片 URL**。离线、图床抖动、跨域，全都不该让入口卡变成破图；
 *   · 确定性：同一个 id + variant 每次生成完全一样，刷新不跳；
 *   · 不做高饱和色块。节日主题最容易犯的错就是红绿铺满，这里只用一层薄雾。
 */

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

/** 三种画幅：首页场景卡（竖）、结果页头图（横）、主题横幅右半（横短） */
const SIZES = {
  card: [900, 1180],
  hero: [1400, 720],
  banner: [900, 560],
};

/**
 * @param {object} subject 需 id / hue，可选 name（只进 aria-label，不画进画面）
 * @param {{variant?: 'card'|'hero'|'banner'}} opts
 */
export function sceneArtSvg(subject, { variant = 'card' } = {}) {
  const s = subject || {};
  const kind = SIZES[variant] ? variant : 'card';
  const [W, H] = SIZES[kind];
  const hue = Number.isFinite(s.hue) ? s.hue : 200;
  const seed = `${s.id || 'x'}:${kind}`;
  const gid = `sc-${esc(String(s.id || 'x')).replace(/[^a-zA-Z0-9-]/g, '')}-${kind}`;
  const horizon = Math.round(H * (kind === 'card' ? 0.72 : 0.68));

  /* 三团光斑：位置/半径由 seed 决定，颜色只在同一个色相里做明度差 */
  const blobs = [];
  const blobDefs = [];
  for (let i = 0; i < 3; i++) {
    const cx = Math.round(W * (0.18 + rnd(seed, `bx${i}`) * 0.7));
    const cy = Math.round(H * (0.14 + rnd(seed, `by${i}`) * 0.5));
    const rx = Math.round(W * (0.22 + rnd(seed, `br${i}`) * 0.26));
    const ry = Math.round(rx * (0.62 + rnd(seed, `bs${i}`) * 0.5));
    const op = (0.1 + rnd(seed, `bo${i}`) * 0.12).toFixed(3);
    const light = 46 + i * 8;
    blobs.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${gid}-b${i})" opacity="${op}"/>`);
    blobDefs.push(`<radialGradient id="${gid}-b${i}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="hsl(${hue} 62% ${light}%)"/>
      <stop offset="100%" stop-color="hsl(${hue} 62% ${light}%)" stop-opacity="0"/>
    </radialGradient>`);
  }

  /* 横向细光线：越靠下越密，暗示「景深」而不是「海报」 */
  const rays = Array.from({ length: 7 }, (_, i) => {
    const y = Math.round(horizon - 40 - i * (kind === 'card' ? 26 : 18));
    const op = (0.16 - i * 0.018).toFixed(3);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="hsl(${hue} 70% 70%)" stroke-width="1" opacity="${Math.max(0.02, Number(op))}"/>`;
  }).join('');

  return `<svg class="sc-art-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"
  preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(s.name || '场景')} 氛围图">
  <defs>
    <linearGradient id="${gid}-bg" x1="0.1" y1="0" x2="0.7" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 32% 9%)"/>
      <stop offset="55%" stop-color="hsl(${hue} 26% 7%)"/>
      <stop offset="100%" stop-color="#07090c"/>
    </linearGradient>
    ${blobDefs.join('')}
  </defs>
  <rect width="${W}" height="${H}" fill="url(#${gid}-bg)"/>
  ${blobs.join('')}
  ${rays}
  <line x1="0" y1="${horizon}" x2="${W}" y2="${horizon}" stroke="rgba(139,149,163,0.22)" stroke-width="1"/>
  <rect x="0" y="${horizon}" width="${W}" height="${H - horizon}" fill="rgba(7,9,12,0.42)"/>
</svg>`;
}

/** 氛围图 DOM（span 包裹，方便直接塞进卡片的图片位） */
export function sceneArt(subject, opts = {}) {
  const wrap = document.createElement('span');
  wrap.className = `sc-art sc-art-${opts.variant || 'card'}`;
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = sceneArtSvg(subject, opts);
  return wrap;
}
