// 图片搜索（色彩特征检索）：不上传原图、不跑语义识别。
//
// 工作方式：前端把上传图缩成 48×48 小图提取「主色签名」（HSL + 权重的直方图），
// 这里对在售商品的 cover_color（"hex,hex" 双色调色板）做环形色相最近邻匹配，
// 返回调色板最接近的几件商品。图片本身永远不离开用户浏览器。
//
// 将来接真正的视觉检索（CLIP embedding + 向量库）时：
// 输入签名从「颜色数组」换成「向量数组」，score 函数换成余弦相似度，其余不动。
import * as productRepo from '../repositories/productRepo.js';

/** "#314ad8" → { h: 229, s: 0.66, l: 0.52 }；解析失败返回 null */
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

/** 环形色相距离：0 同色，0.5 正对色（互补色） */
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 单色匹配分：色相为主（权重 0.8），饱和度 / 明度差做轻惩罚。
 * 0 = 完全一致，越大越远；< 0.35 算「看起来是一类颜色」。
 */
function colorScore(sig, prod) {
  return (hueDist(sig.h, prod.h) / 180) * 0.8
    + Math.abs(sig.s - prod.s) * 0.15
    + Math.abs(sig.l - prod.l) * 0.1;
}

/**
 * 色彩特征检索。
 * @param {Array<{h:number,s:number,l:number,weight?:number}>} colors 前端提取的主色签名（1–5 个）
 * @param {{limit?: number}} [opts]
 * @returns {{source:'color-feature', matched:boolean, products:Array}}
 */
export function searchByColor(colors, { limit = 4 } = {}) {
  const sigs = (Array.isArray(colors) ? colors : [])
    .map((c) => ({ h: Number(c && c.h), s: Number(c && c.s), l: Number(c && c.l), w: Number(c && c.weight) || 1 }))
    .filter((c) => Number.isFinite(c.h) && Number.isFinite(c.s) && Number.isFinite(c.l) && c.w > 0)
    .slice(0, 5);
  if (!sigs.length) {
    const err = new Error('colors required: [{h,s,l,weight}]');
    err.status = 400;
    throw err;
  }

  const all = productRepo.filterProducts({ limit: 300 });
  const scored = [];
  for (const p of all) {
    const palette = String(p.coverColor || '')
      .split(',')
      .map(hexToHsl)
      .filter(Boolean);
    if (!palette.length) continue;
    // 每个签名色找商品调色板里最接近的一色，再按签名权重平均
    let sum = 0;
    let wsum = 0;
    for (const s of sigs) {
      let best = Infinity;
      for (const c of palette) {
        const v = colorScore(s, c);
        if (v < best) best = v;
      }
      sum += best * s.w;
      wsum += s.w;
    }
    scored.push({ p, score: sum / wsum });
  }
  scored.sort((a, b) => a.score - b.score);

  const top = scored.slice(0, limit);
  return {
    source: 'color-feature',
    // 最接近的一件仍在「同类色」范围内才算命中；否则让前端如实说没找到近色
    matched: top.length > 0 && top[0].score < 0.35,
    products: top.map((x) => ({
      id: x.p.id,
      name: x.p.name,
      price: x.p.price,
      originalPrice: x.p.originalPrice ?? null,
      pic: x.p.pic || '',
      coverColor: x.p.coverColor || '',
      highlight: x.p.highlight || '',
      brand: x.p.brand || '',
      category: x.p.category || '',
      categoryId: x.p.categoryId || '',
      rating: x.p.rating ?? 4.8,
      sales: x.p.sales ?? 0,
      stock: null,
      reason: `主色调接近（色彩距离 ${x.score.toFixed(2)}）`,
    })),
  };
}
