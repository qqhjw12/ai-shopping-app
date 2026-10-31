// 商家入驻：招商落地页（#/merchant/join）+ 申请页（#/merchant/apply）。
//
// 这一步只做「让商家找到门」：一个入口 + 一页说清「为什么来、怎么进、适不适合」。
// 刻意不做重交互——招商页的转化靠信息密度与信任感，不靠动画。
//
// 两个不能踩的坑：
//   1) 页内锚点绝不能用 href="#join-flow"：hash 是这个 SPA 的路由，写进去会被
//      parseHash() 当成路由 "join-flow" → 直接 404。只能用 scrollIntoView。
//   2) 平台数据必须真取 /api/stats；网关不可达（静态演示站）时退化为「数本地
//      演示商品库」，并在页脚注明来源，不硬编码一个好看的数字冒充真实规模。
import { el } from './ui.js';
import { api } from './api.js';
import { getProducts } from './views.js';

const fmt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '—');

/** 平台规模：网关优先；不可达时按本地商品库现算（演示模式下那就是本站真实内容） */
async function loadStats() {
  try {
    const d = await api('/api/stats', { retries: 0 });
    if (d && d.stats && Number(d.stats.products) > 0) return { ...d.stats, live: true };
  } catch {
    /* 演示模式 / 网关不可达 → 本地现算 */
  }
  try {
    const list = await getProducts();
    const brands = new Set(list.map((p) => p.brand).filter(Boolean));
    const cats = new Set(list.map((p) => p.categoryId).filter(Boolean));
    const reviews = list.reduce((n, p) => n + (Number(p.reviewsCount) || 0), 0);
    return { products: list.length, brands: brands.size, reviews, categories: cats.size, live: false };
  } catch {
    return null;
  }
}

const WHY = [
  {
    t: 'AI 导购精准匹配',
    d: '买家说「预算 1000 的通勤耳机」，AI 会带着你的商品回答，并说清为什么推荐它——不是竞价排名，是需求匹配。',
  },
  {
    t: '零成本开店',
    d: '不收开店费、不收保证金，成交才计费；早鸟期平台服务费全免，先卖起来再谈成本。',
  },
  {
    t: '独立结算',
    d: '每笔订单有独立的资金流水，T+7 结算到对公账户；退款与售后单独记账，账目对得上。',
  },
  {
    t: '代发与库存联动',
    d: '支持平台仓代发，SKU 库存实时同步，卖完自动下架不超卖；缺货不用守着后台改状态。',
  },
];

const STEPS = [
  { t: '提交资料', d: '营业执照、品牌资质与结算账户，线上填写约 10 分钟。' },
  { t: '平台审核', d: '资质与商品合规审核，3 个工作日内给出结果。' },
  { t: '签约开通', d: '电子签约后开通商家后台，配置运费与售后规则。' },
  { t: '上架商品', d: '批量导入商品与库存，AI 自动生成卖点文案与标签。' },
  { t: '开始经营', d: '订单实时同步，AI 导购持续为你的商品寻找买家。' },
];

const FITS = [
  { t: '原创设计品牌', d: '有稳定的设计语言和上新节奏，不想只在价格战里卷。' },
  { t: '源头工厂与产业带', d: '有产能和成本优势，缺的是把它讲清楚的人。' },
  { t: '设计师工作室', d: '单品产量不大，但每一件都经得起细看。' },
  { t: '食品与地方特产', d: '有产地、有工艺、有故事，需要被对的人尝到。' },
  { t: '宠物与母婴品牌', d: '复购强、决策谨慎，正需要 AI 把成分和标准讲明白。' },
  { t: '家居与手作好物', d: '客单价不低、决策链长，适合被慢慢介绍而不是被秒杀。' },
];

function sectionHead(eyebrow, title) {
  return el('div', { class: 'section-heading compact' }, [
    el('div', {}, [el('span', { class: 'eyebrow' }, eyebrow), el('h2', {}, title)]),
  ]);
}

function statCell(key, label) {
  return el('div', {}, [
    el('span', { class: 'mz-stat-k', 'data-stat': key }, '—'),
    el('span', { class: 'mz-stat-l' }, label),
  ]);
}

/** 吸底 CTA：招商页常驻，页面底部给内容留出等高留白（.merchant 的 padding-bottom） */
function stickyBar() {
  return el('div', { class: 'mz-bar', role: 'region', 'aria-label': '入驻申请快捷入口' }, [
    el('div', { class: 'mz-bar-inner' }, [
      el('div', { class: 'mz-bar-copy' }, [
        el('strong', {}, '招商进行中'),
        el('span', {}, '早鸟期免平台服务费 90 天 · 审核 3 个工作日内出结果'),
      ]),
      el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '提交入驻申请'),
    ]),
  ]);
}

export async function renderMerchantJoin(v) {
  v.innerHTML = '';

  const statKeys = [
    ['products', '在售商品'],
    ['brands', '合作品牌'],
    ['reviews', '真实评价'],
    ['categories', '覆盖类目'],
  ];
  const statsPanel = el('aside', { class: 'mz-stats', 'aria-label': '平台规模' }, [
    el('span', { class: 'eyebrow' }, 'PLATFORM NOW'),
    el('div', { class: 'mz-stats-grid' }, statKeys.map(([k, l]) => statCell(k, l))),
    el('p', { class: 'mz-stats-foot' }, '数据实时取自平台商品库'),
  ]);

  const scrollToFlow = () => {
    const target = v.querySelector('#mz-flow');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  v.appendChild(
    el('div', { class: 'merchant' }, [
      el('a', { class: 'mz-back', href: '#/' }, '← 返回商城'),

      /* 首屏：价值主张 + 平台数据（深色块承载信任） */
      el('section', { class: 'mz-hero' }, [
        el('div', { class: 'mz-hero-copy' }, [
          el('span', { class: 'eyebrow' }, [
            el('span', { class: 'eyebrow-rule', 'aria-hidden': 'true' }),
            'MERCHANT PROGRAM · 商家入驻',
          ]),
          el('h1', {}, ['让 AI 帮你找到', el('br'), el('em', {}, '真正想买的人')]),
          el('p', { class: 'mz-lede' }, [
            '买家越来越习惯「说需求」而不是「翻类目」。MAISON AI 的导购会读懂一句话背后的预算、场景与偏好，',
            '把你的商品带到正在找它的人面前——不靠竞价，靠匹配。',
          ]),
          el('div', { class: 'mz-cta-row' }, [
            el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '立即申请入驻'),
            el('button', { class: 'mz-btn mz-btn--ghost', type: 'button', onclick: scrollToFlow }, '了解入驻流程'),
          ]),
          el('p', { class: 'mz-note' }, '早鸟期：前 100 家品牌免平台服务费 90 天 · 审核 3 个工作日内出结果'),
        ]),
        statsPanel,
      ]),

      /* 平台优势：四张安静的文字卡片，只有发丝线，没有图标堆砌 */
      el('section', { class: 'mz-section' }, [
        sectionHead('WHY MAISON', '为什么值得来'),
        el(
          'div',
          { class: 'mz-why-grid' },
          WHY.map((w, i) =>
            el('article', { class: 'mz-why' }, [
              el('span', { class: 'mz-why-idx' }, String(i + 1).padStart(2, '0')),
              el('h3', {}, w.t),
              el('p', {}, w.d),
            ]),
          ),
        ),
      ]),

      /* 入驻流程：横向步骤条（移动端转纵向时间轴） */
      el('section', { class: 'mz-section mz-flow', id: 'mz-flow' }, [
        sectionHead('HOW IT WORKS', '五步，从资料到开卖'),
        el(
          'ol',
          { class: 'mz-steps' },
          STEPS.map((s, i) =>
            el('li', { class: 'mz-step' }, [
              el('span', { class: 'mz-step-dot', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
              el('h3', {}, s.t),
              el('p', {}, s.d),
            ]),
          ),
        ),
      ]),

      /* 适合谁：让商家自我筛选，减少无效申请 */
      el('section', { class: 'mz-section' }, [
        sectionHead('WHO JOINS', '这些商家，和我们更合拍'),
        el(
          'ul',
          { class: 'mz-fit-list' },
          FITS.map((f, i) =>
            el('li', {}, [
              el('span', { class: 'mz-fit-idx', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0')),
              el('div', {}, [el('strong', {}, f.t), el('p', {}, f.d)]),
            ]),
          ),
        ),
      ]),

      /* 收尾深色带：把决定性的那一句再讲一次 */
      el('section', { class: 'mz-final' }, [
        el('div', {}, [
          el('span', { class: 'eyebrow' }, 'NEXT STEP'),
          el('h2', {}, '把好商品，交给会解释的 AI'),
          el('p', {}, '申请后 3 个工作日内出审核结果，签约当天即可上架。'),
        ]),
        el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '立即申请入驻'),
      ]),

      stickyBar(),
    ]),
  );

  // 数据晚到就晚填，不阻塞首屏结构（首屏先出，数字随后补上）
  loadStats().then((s) => {
    if (!s) return;
    for (const [k] of statKeys) {
      const node = statsPanel.querySelector(`[data-stat="${k}"]`);
      if (node) node.textContent = fmt(s[k]);
    }
    const foot = statsPanel.querySelector('.mz-stats-foot');
    if (foot) foot.textContent = s.live ? '数据实时取自平台商品库' : '静态演示站：数据取自本站演示商品库';
  });
}

/**
 * 申请页（第二步的表单尚未接入）。
 * 这里不放一个假表单：填了提交不了、或者假装提交成功，比没有更糟。
 * 只如实说明「表单在下一步开放」，并列出要准备的材料——商家现在就能开始准备。
 */
export function renderMerchantApply(v) {
  v.innerHTML = '';
  const MATS = [
    '营业执照（个体工商户或公司主体均可）',
    '品牌资质或商标文件，代理需提供授权链',
    '对公结算账户信息（开户行、账号、账户名）',
    '首批计划上架的商品清单与库存量级',
  ];
  v.appendChild(
    el('div', { class: 'merchant mz-apply' }, [
      el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
      el('span', { class: 'mz-pending' }, '表单下一步开放'),
      el('h1', { class: 'mz-apply-title' }, '入驻申请'),
      el('p', { class: 'mz-lede' }, '申请表单将在下一步接入。现在可以先准备下面这些材料，届时填写约 10 分钟。'),
      el('div', { class: 'mz-apply-card' }, [
        el('span', { class: 'eyebrow' }, 'WHAT TO PREPARE'),
        el('ul', { class: 'mz-mats' }, MATS.map((m) => el('li', {}, m))),
        el('div', { class: 'mz-apply-actions' }, [
          el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/join' }, '回到招商页'),
          el('a', { class: 'mz-btn mz-btn--gold', href: '#/products' }, '先去看看商城'),
        ]),
      ]),
    ]),
  );
}
