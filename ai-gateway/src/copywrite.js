import { config } from './config.js';
import { appEnabled, runWorkflow } from './difyClient.js';

// 运营文案生成：输入商品 + 卖点 + 语气 + 平台，产出标题/详情/种草文案多版本。
// docker 模式调用 Dify Workflow（运营同事在 Dify 控制台自助编辑的那个 App）；
// local 模式用内置模板兜底，保证离线演示可跑。

const TONE_DESC = {
  专业: '专业、严谨，突出参数与品质',
  活泼: '轻松、有梗，贴近年轻用户',
  种草: '场景化、情绪价值，激发购买欲',
  促销: '紧迫感、价格锚点，强调优惠',
};

function localCopywrite({ product, sellingPoints, tone, platform, count }) {
  const name = product?.name || '本商品';
  const brand = product?.brand || '';
  const category = product?.category || '';
  const price = product?.price != null ? `¥${product.price}` : '';
  const sp = sellingPoints && sellingPoints.length ? sellingPoints : product?.tags || ['高品质', '好用'];
  const toneDesc = TONE_DESC[tone] || TONE_DESC['专业'];
  const n = Number(count) || 3;

  const titles = [];
  const social = [];
  for (let i = 0; i < n; i++) {
    const point = sp[i % sp.length];
    titles.push(`【${brand || category || '新品'}】${name} ${point} ${price}`);
    social.push(
      `还在为选${category || '好物'}纠结？${name}真的香！${point}，${price}就能拿下，冲就完事了～ #${platform}`,
    );
  }
  const detail =
    `${name}（${brand}）\n` +
    `主打${sp.join('、')}。${toneDesc}。\n` +
    `现仅${price}，适合追求品质的你，闭眼入不踩雷。`;
  const hashtags = ['#好物推荐', `#${category || '购物'}`, `#${brand || '优选'}`];

  return { titles, detail, social, hashtags, mode: 'local' };
}

export async function generateCopywriting({
  product = {},
  sellingPoints = [],
  tone = '专业',
  platform = '通用',
  count = 3,
}) {
  if (appEnabled('copywrite')) {
    try {
      const inputs = {
        product_name: product?.name || '',
        brand: product?.brand || '',
        category: product?.category || '',
        price: product?.price != null ? String(product.price) : '',
        selling_points: (sellingPoints || []).join('、'),
        tone,
        platform,
        count: String(count || 3),
      };
      const r = await runWorkflow(config.dify.copywriteApiKey, { inputs, userId: 'ops' });
      const out = r.outputs || {};
      return {
        titles: out.titles || [],
        detail: out.detail || '',
        social: out.social || [],
        hashtags: out.hashtags || [],
        mode: 'dify',
      };
    } catch (e) {
      console.warn(`[copywrite] Dify 失败，回退本地模板: ${e.message}`);
    }
  }
  return localCopywrite({ product, sellingPoints, tone, platform, count });
}
