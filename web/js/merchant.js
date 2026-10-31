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
import { api, isMissingEndpoint } from './api.js';
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
 * 申请页：分四步把资料收齐（主体资质 → 品牌商品 → 结算售后 → 确认提交）。
 *
 * 三条自我约束（都是「宁可少做一点也不做错」）：
 *   1) 提交必须真落库。网关不可达时（静态演示站）如实提示「未提交」，草稿留在本机——
 *      绝不做「假装提交成功」的假成功页，商家会以为资料已交给平台。
 *   2) 幂等键只在「结果未知」时复用。5xx / 网络断开意味着服务端可能已经写入，
 *      重试必须带同一个 submitKey；4xx 说明肯定没写进去，换新 key，
 *      否则商家改完再提交会被幂等命中、拿回旧单号，改动全部丢失。
 *   3) 银行账号只上传，不在页面回显完整值；服务端只存前 4 后 4（见 schema 迁移 17）。
 */
export function renderMerchantApply(v, query = {}) {
  v.innerHTML = '';

  // 带 id + key 进来 = 回看已提交的申请（刷新/收藏夹重开都走这条路）
  const viewId = String(query.id || '').trim();
  const viewKey = String(query.key || '').trim();
  if (viewId && viewKey) {
    renderApplicationStatus(v, viewId, viewKey);
    return;
  }

  const draft = loadDraft();
  const data = draft?.data || {};
  // 草稿里存的是 1-based 步号，state.step 是 0-based 下标；上限必须是总步数而不是 3，
  // 否则「填到确认页刷新」会被悄悄退回第 3 步（写死 3 的 off-by-one，看着像巧合其实每天都有人踩）
  const state = {
    step: Math.min(APPLY_STEPS.length, Math.max(1, Number(draft?.step) || 1)) - 1,
    busy: false,
    pendingKey: null,
  };

  const progress = el('ol', { class: 'mzf-progress', 'aria-label': '申请进度' });
  const form = el('form', { class: 'mzf-form', novalidate: 'novalidate' });
  const panels = APPLY_STEPS.map(() => el('section', { class: 'mzf-panel' }));

  const draftNote = el('div', { class: 'mzf-draft', hidden: !draft }, [
    el('span', {}, draft ? `已恢复 ${fmtStamp(draft.savedAt)} 保存的草稿` : ''),
    el('button', {
      type: 'button',
      class: 'mzf-draft-clear',
      onclick: () => {
        clearDraft();
        // 直接重进本页：连同已填内容一起清空，比「逐字段擦掉」更符合预期
        location.hash = '#/merchant/apply';
        location.reload();
      },
    }, '清空重填'),
  ]);

  /* ---------------- 各步骤面板 ---------------- */
  panels[0].append(
    fieldChoice('entityKind', '商家主体类型', ENTITY_KINDS, data.entityKind, '按营业执照主体选，选错会影响审核口径'),
    fieldText('company', '主体名称', data.company, { placeholder: '与营业执照一致，如：杭州砚白设计有限公司', maxlength: 60, autocomplete: 'organization' }),
    fieldText('creditCode', '统一社会信用代码', data.creditCode, { placeholder: '18 位，如 91330100MA2H1XYG4K', maxlength: 18, hint: '营业执照右上角那串 18 位代码' }),
    fieldText('contact', '联系人姓名', data.contact, { placeholder: '对接入驻事宜的人', maxlength: 20, autocomplete: 'name' }),
    fieldText('phone', '手机号', data.phone, { placeholder: '11 位手机号', maxlength: 11, inputmode: 'numeric', autocomplete: 'tel' }),
    fieldText('email', '邮箱（选填）', data.email, { placeholder: '用于接收审核结果与合同', maxlength: 80, inputmode: 'email', autocomplete: 'email' }),
  );

  panels[1].append(
    fieldText('brand', '品牌名称', data.brand, { placeholder: '店铺对外展示的品牌名', maxlength: 40 }),
    fieldSeg('brandSource', '品牌来源', BRAND_SOURCES, data.brandSource, '代理需能提供授权链'),
    fieldChips('categories', '主营类目', FORM_CATEGORIES, data.categories, 3, '最多选 3 个，决定你在哪些类目下被 AI 推荐'),
    fieldSeg('skuRange', '预估 SKU 数量', SKU_RANGES, data.skuRange),
    fieldSeg('priceRange', '主力价格带', PRICE_RANGES, data.priceRange),
    fieldToggle('dropship', '支持一件代发', Boolean(data.dropship), '平台仓代发时库存由我们同步，卖完自动下架'),
  );

  panels[2].append(
    fieldText('bankAccount', '开户名', data.bankAccount, { placeholder: '与营业执照主体一致', maxlength: 60 }),
    fieldText('bankBranch', '开户行（选填）', data.bankBranch, { placeholder: '如：招商银行杭州分行营业部', maxlength: 60 }),
    fieldText('bankNo', '银行卡号', data.bankNo, {
      placeholder: '12–24 位数字，仅用于结算验证',
      maxlength: 24,
      inputmode: 'numeric',
      hint: '只保存前 4 位与后 4 位，完整卡号不落库、不进日志',
    }),
    fieldSeg('returnPolicy', '退货政策', RETURN_POLICIES, data.returnPolicy, '平台要求至少 7 天无理由'),
    fieldSeg('shipWithin', '发货时效', SHIP_WITHIN, data.shipWithin, '超时会记入店铺考核'),
    fieldText('note', '补充说明（选填）', data.note, { placeholder: '产地、工艺、特殊资质等想让我们知道的', maxlength: 200 }),
  );

  /* ---------------- 第四步：回读确认 ---------------- */
  const summary = el('dl', { class: 'mzf-summary' });
  const agree = el('div', { class: 'mzf-agree' });
  panels[3].append(summary, agree);

  /* ---------------- 底部导航 ---------------- */
  const errBox = el('div', { class: 'mzf-alert', role: 'alert', hidden: true });
  const btnPrev = el('button', { type: 'button', class: 'mz-btn mz-btn--ghost', onclick: () => goStep(state.step - 1) }, '上一步');
  const btnNext = el('button', { type: 'button', class: 'mz-btn mz-btn--gold', onclick: () => goStep(state.step + 1) }, '下一步');
  const btnSubmit = el('button', { type: 'submit', class: 'mz-btn mz-btn--gold mzf-submit', hidden: true }, '提交入驻申请');
  const nav = el('div', { class: 'mzf-nav' }, [
    btnPrev,
    el('div', { class: 'mzf-nav-right' }, [btnNext, btnSubmit]),
  ]);

  form.append(errBox, ...panels, nav);

  form.addEventListener('input', (e) => {
    const name = e.target.name;
    if (!name) return;
    if (e.target.type === 'checkbox' && name === 'categories') {
      const picked = [...form.querySelectorAll('input[name="categories"]:checked')].map((i) => i.value);
      if (picked.length > 3) {
        e.target.checked = false;
        setFieldError('categories', '主营类目最多选 3 个');
        return;
      }
      data.categories = picked;
      clearFieldError('categories');
    } else if (e.target.type === 'checkbox') {
      data[name] = e.target.checked;
    } else {
      data[name] = e.target.value;
      clearFieldError(name);
    }
    scheduleSave();
  });

  form.addEventListener('change', (e) => {
    if (e.target.name && e.target.type !== 'checkbox') {
      data[e.target.name] = e.target.value;
      clearFieldError(e.target.name);
      scheduleSave();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    if (state.step !== 3) {
      goStep(3);
      return;
    }
    const problems = {};
    if (!agree1.checked) problems.agree = '请确认资料真实有效';
    if (!agree2.checked) problems.policy = '请确认接受平台售后与结算规则';
    if (Object.keys(problems).length) {
      showAlert('提交前还有未确认的条款', problems);
      return;
    }
    await submitApplication();
  });

  /* ---------------- 确认页摘要与承诺 ---------------- */
  const agree1 = el('input', { type: 'checkbox', id: 'mzf-agree-1' });
  const agree2 = el('input', { type: 'checkbox', id: 'mzf-agree-2' });
  agree.append(
    el('label', { class: 'mzf-check', for: 'mzf-agree-1' }, [
      agree1,
      el('span', {}, '我确认以上资料真实有效，并接受平台对资质的核验。'),
    ]),
    el('label', { class: 'mzf-check', for: 'mzf-agree-2' }, [
      agree2,
      el('span', {}, '我接受平台售后规则（至少 7 天无理由）与 T+7 结算周期。'),
    ]),
  );

  function renderSummary() {
    summary.innerHTML = '';
    const row = (idx, label, value) =>
      summary.append(
        el('div', { class: 'mzf-sum-row' }, [
          el('dt', {}, label),
          el('dd', {}, value || '—'),
          el('button', { type: 'button', class: 'mzf-sum-edit', onclick: () => goStep(idx) }, '修改'),
        ]),
      );
    const labelOf = (list, v) => (list.find((o) => o.v === v) || {}).t || '';
    const catNames = (data.categories || [])
      .map((c) => (FORM_CATEGORIES.find((o) => o.id === c) || {}).t)
      .filter(Boolean);
    row(0, '主体', [labelOf(ENTITY_KINDS, data.entityKind), data.company, data.creditCode].filter(Boolean).join(' · '));
    row(0, '联系人', [data.contact, data.phone, data.email].filter(Boolean).join(' · '));
    row(1, '品牌', [data.brand, labelOf(BRAND_SOURCES, data.brandSource)].filter(Boolean).join(' · '));
    row(1, '类目与价格', [catNames.join('、'), labelOf(SKU_RANGES, data.skuRange), labelOf(PRICE_RANGES, data.priceRange)]
      .filter(Boolean)
      .join(' · '));
    row(2, '结算', [data.bankAccount, data.bankBranch, maskCard(data.bankNo)].filter(Boolean).join(' · '));
    row(2, '售后与时效', [labelOf(RETURN_POLICIES, data.returnPolicy), labelOf(SHIP_WITHIN, data.shipWithin)].filter(Boolean).join(' · '));
  }

  /* ---------------- 步骤切换 ---------------- */
  function goStep(next) {
    const target = Math.min(APPLY_STEPS.length - 1, Math.max(0, next));
    // 只能往前走时校验当前步；往回退永远放行（否则改一个字段就先被别的格子拦住）
    if (target > state.step) {
      const fields = validateStep(state.step, data);
      if (Object.keys(fields).length) {
        showAlert('这一步还有需要修改的地方', fields);
        focusFirstError(fields);
        return;
      }
    }
    state.step = target;
    syncView();
    scheduleSave();
    const top = v.querySelector('.mzf-progress');
    if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function syncView() {
    panels.forEach((p, i) => {
      p.hidden = i !== state.step;
      p.classList.toggle('is-active', i === state.step);
    });
    progress.innerHTML = '';
    APPLY_STEPS.forEach((s, i) => {
      progress.append(
        el('li', {
          class: `mzf-prog${i === state.step ? ' is-current' : ''}${i < state.step ? ' is-done' : ''}`,
          'aria-current': i === state.step ? 'step' : null,
        }, [
          el('span', { class: 'mzf-prog-dot' }, i < state.step ? '✓' : String(i + 1)),
          el('span', { class: 'mzf-prog-t' }, s.title),
        ]),
      );
    });
    btnPrev.hidden = state.step === 0;
    btnNext.hidden = state.step === APPLY_STEPS.length - 1;
    btnSubmit.hidden = state.step !== APPLY_STEPS.length - 1;
    if (state.step === APPLY_STEPS.length - 1) renderSummary();
    form.dataset.step = String(state.step + 1);
  }

  /* ---------------- 错误呈现 ---------------- */
  function fieldOf(name) {
    return form.querySelector(`[data-field="${name}"]`);
  }
  function setFieldError(name, msg) {
    const box = fieldOf(name);
    if (!box) return;
    box.classList.add('has-error');
    const slot = box.querySelector('.mzf-err');
    if (slot) slot.textContent = msg;
    const input = box.querySelector('input, textarea');
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      if (slot && slot.id) input.setAttribute('aria-describedby', slot.id);
    }
  }
  function clearFieldError(name) {
    const box = fieldOf(name);
    if (!box) return;
    box.classList.remove('has-error');
    const slot = box.querySelector('.mzf-err');
    if (slot) slot.textContent = '';
    const input = box.querySelector('input, textarea');
    if (input) input.removeAttribute('aria-invalid');
    if (errBox.dataset.count) {
      const left = form.querySelectorAll('.mzf-field.has-error, .mzf-choice-group.has-error').length;
      if (!left) hideAlert();
    }
  }
  function showAlert(title, fields) {
    errBox.hidden = false;
    errBox.dataset.count = '1';
    errBox.innerHTML = '';
    errBox.append(el('strong', {}, title));
    const list = Object.entries(fields);
    if (list.length) {
      errBox.append(el('ul', {}, list.slice(0, 6).map(([, m]) => el('li', {}, m))));
      for (const [name, msg] of list) setFieldError(name, msg);
    }
    errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideAlert() {
    errBox.hidden = true;
    delete errBox.dataset.count;
  }
  function focusFirstError(fields) {
    const first = Object.keys(fields)[0];
    const box = fieldOf(first);
    const input = box && box.querySelector('input, textarea');
    if (input) input.focus({ preventScroll: true });
  }

  /* ---------------- 提交 ---------------- */
  async function submitApplication() {
    state.busy = true;
    btnSubmit.disabled = true;
    btnSubmit.textContent = '提交中…';
    hideAlert();
    // 只有「结果未知」才复用上一次的 key（见文件顶部第 2 条）
    if (!state.pendingKey) state.pendingKey = newKey();
    try {
      const res = await api('/api/merchant/applications', {
        method: 'POST',
        body: { ...data, categories: data.categories || [], submitKey: state.pendingKey },
        // 提交不做 5xx 自动重试：服务端 500 时前端自动重放三次只会让日志更难读，
        // 让用户自己点「重试」时带同一个 submitKey 就够了
        retries: 0,
      });
      clearDraft();
      const id = res.application.id;
      const key = res.queryKey;
      saveLast({ id, key, at: new Date().toISOString() });
      // 跳到状态页（同一路由带参数）：刷新/收藏都能回到这里，而不是回一张重置的空表单
      location.hash = `#/merchant/apply?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`;
    } catch (e) {
      // 4xx = 确定没写进去 → 换新 key；否则保留，重试仍幂等
      if (e && e.status && e.status < 500) state.pendingKey = null;
      // 静态演示站对 /api/* 回 404，被 api() 归为 client 错误；这里要认得出来，
      // 否则会告诉商家「请稍后重试」——他重试一百次也不会成功，因为这台站没有后端。
      const noBackend = Boolean(e) && (e.kind === 'offline' || isMissingEndpoint(e));
      if (e && e.fields) {
        const firstStep = Math.min(...Object.keys(e.fields).map((f) => FIELD_STEP[f] ?? 0));
        state.step = firstStep;
        syncView();
        showAlert(e.message || '请检查填写内容', e.fields);
        focusFirstError(e.fields);
      } else {
        showAlert(noBackend ? '当前未连接网关，申请没有提交' : '提交没有成功，请稍后重试', {});
        errBox.append(
          el('p', { class: 'mzf-alert-note' },
            noBackend
              ? '你现在打开的是静态演示站（没有后端）。启动网关后重试；已填内容保存在本机草稿里，不会丢。'
              : String((e && e.message) || '网络异常，请重试。')),
        );
      }
    } finally {
      state.busy = false;
      btnSubmit.disabled = false;
      btnSubmit.textContent = '提交入驻申请';
    }
  }

  /* ---------------- 草稿 ---------------- */
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft({ data, step: state.step + 1, savedAt: Date.now() }), 400);
  }

  v.append(
    el('div', { class: 'merchant mz-apply' }, [
      el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
      el('span', { class: 'eyebrow' }, 'MERCHANT APPLICATION'),
      el('h1', { class: 'mz-apply-title' }, '入驻申请'),
      el('p', { class: 'mz-lede' }, '四步填完，约 10 分钟。提交后 3 个工作日内出审核结果，通过即可签约上架。'),
      draftNote,
      progress,
      form,
    ]),
  );

  syncView();
}

/* ============================================================
   申请表单：常量、字段构件、客户端校验、状态页
   ============================================================ */

const ENTITY_KINDS = [
  { v: 'brand', t: '原创品牌', d: '自有设计语言与上新节奏' },
  { v: 'factory', t: '源头工厂', d: '产能与成本优势，缺讲故事的人' },
  { v: 'studio', t: '设计师工作室', d: '小批量、每件都经得起细看' },
  { v: 'food', t: '食品产地', d: '有产地、有工艺、有故事' },
  { v: 'other', t: '其他', d: '以上都不太像，先聊聊看' },
];
const BRAND_SOURCES = [
  { v: 'owned', t: '自有品牌' },
  { v: 'exclusive', t: '独家代理' },
  { v: 'authorized', t: '授权代理' },
];
const SKU_RANGES = [
  { v: 'lt50', t: '50 以内' },
  { v: '50-200', t: '50–200' },
  { v: '200-1000', t: '200–1000' },
  { v: 'gt1000', t: '1000 以上' },
];
const PRICE_RANGES = [
  { v: 'lt100', t: '100 元以内' },
  { v: '100-500', t: '100–500 元' },
  { v: '500-2000', t: '500–2000 元' },
  { v: 'gt2000', t: '2000 元以上' },
];
const RETURN_POLICIES = [
  { v: '7days', t: '7 天无理由' },
  { v: '15days', t: '15 天无理由' },
];
const SHIP_WITHIN = [
  { v: '24h', t: '24 小时内' },
  { v: '48h', t: '48 小时内' },
  { v: '72h', t: '72 小时内' },
];
// 与服务端 data/catalog.js 的一级类目一一对应（服务端是权威，传了不存在的 id 会被丢弃并报错）
const FORM_CATEGORIES = [
  { id: 'phone', t: '手机数码' }, { id: 'computer', t: '电脑办公' }, { id: 'audio', t: '音频耳机' },
  { id: 'appliance', t: '家用电器' }, { id: 'apparel', t: '服饰鞋包' }, { id: 'food', t: '食品生鲜' },
  { id: 'home', t: '家居家具' }, { id: 'sports', t: '运动户外' }, { id: 'beauty', t: '美妆个护' },
  { id: 'baby', t: '母婴玩具' }, { id: 'book', t: '图书文娱' }, { id: 'kitchen', t: '厨具餐具' },
  { id: 'pet', t: '宠物用品' }, { id: 'auto', t: '车载出行' }, { id: 'health', t: '健康保健' },
  { id: 'stationery', t: '办公文具' },
];

const APPLY_STEPS = [
  { title: '主体资质', fields: ['entityKind', 'company', 'creditCode', 'contact', 'phone', 'email'] },
  { title: '品牌商品', fields: ['brand', 'brandSource', 'categories', 'skuRange', 'priceRange', 'dropship'] },
  { title: '结算售后', fields: ['bankAccount', 'bankBranch', 'bankNo', 'returnPolicy', 'shipWithin', 'note'] },
  { title: '确认提交', fields: [] },
];
// 服务端字段级错误 → 该跳到第几步。手写这张映射而不是「遍历所有面板找 data-field」：
// 后者在第 4 步（摘要页）没有输入框，会跳不过去，商家就卡在确认页看着报错发呆。
const FIELD_STEP = APPLY_STEPS.reduce((acc, s, i) => {
  for (const f of s.fields) acc[f] = i;
  return acc;
}, {});

const DRAFT_KEY = 'maison_merchant_draft_v1';
const LAST_KEY = 'maison_merchant_last_application_v1';

let fieldSeq = 0;
function fieldShell(name, label, body, { hint = '', wide = false } = {}) {
  const errId = `mzf-err-${++fieldSeq}`;
  return el('div', { class: `mzf-field${wide ? ' is-wide' : ''}`, 'data-field': name }, [
    el('span', { class: 'mzf-label' }, label),
    body,
    hint ? el('span', { class: 'mzf-hint' }, hint) : null,
    el('span', { class: 'mzf-err', id: errId }),
  ]);
}

function fieldText(name, label, value, opts = {}) {
  const input = el('input', {
    type: 'text',
    name,
    value: value == null ? '' : String(value),
    placeholder: opts.placeholder || '',
    maxlength: opts.maxlength || null,
    inputmode: opts.inputmode || null,
    autocomplete: opts.autocomplete || 'off',
  });
  return fieldShell(name, label, input, { hint: opts.hint });
}

function fieldChoice(name, label, options, current, hint) {
  const group = el('div', { class: 'mzf-choice-group' },
    options.map((o) =>
      el('label', { class: 'mzf-choice' }, [
        el('input', { type: 'radio', name, value: o.v, checked: current === o.v }),
        el('span', { class: 'mzf-choice-box' }, [
          el('strong', {}, o.t),
          o.d ? el('em', {}, o.d) : null,
        ]),
      ]),
    ),
  );
  return fieldShell(name, label, group, { hint });
}

function fieldSeg(name, label, options, current, hint) {
  const group = el('div', { class: 'mzf-seg' },
    options.map((o) =>
      el('label', { class: 'mzf-seg-item' }, [
        el('input', { type: 'radio', name, value: o.v, checked: current === o.v }),
        el('span', {}, o.t),
      ]),
    ),
  );
  return fieldShell(name, label, group, { hint });
}

function fieldChips(name, label, options, current, max, hint) {
  const picked = new Set(Array.isArray(current) ? current : []);
  const group = el('div', { class: 'mzf-chips' },
    options.map((o) =>
      el('label', { class: 'mzf-chip' }, [
        el('input', { type: 'checkbox', name, value: o.id, checked: picked.has(o.id) }),
        el('span', {}, o.t),
      ]),
    ),
  );
  group.dataset.max = String(max || 0);
  return fieldShell(name, label, group, { hint });
}

function fieldToggle(name, label, checked, hint) {
  const text = el('span', { class: 'mzf-toggle-text' }, checked ? '支持' : '暂不支持');
  const input = el('input', {
    type: 'checkbox',
    name,
    checked,
    // 开关上的文案要跟着状态走，否则勾上之后还写着「暂不支持」，商家会以为没生效
    onchange: (e) => { text.textContent = e.target.checked ? '支持' : '暂不支持'; },
  });
  return fieldShell(name, label,
    el('label', { class: 'mzf-toggle' }, [input, el('span', { class: 'mzf-toggle-track', 'aria-hidden': 'true' }), text]),
    { hint },
  );
}

/**
 * 客户端校验：只为「少一次往返」，不是防线。
 * 文案与服务端 merchantService 保持同义——两边说法不一致时，商家会以为自己看错了。
 */
function validateStep(step, d) {
  const f = {};
  const s = (v) => (v == null ? '' : String(v));
  if (step === 0) {
    if (!ENTITY_KINDS.some((o) => o.v === d.entityKind)) f.entityKind = '请选择商家主体类型';
    if (s(d.company).trim().length < 2) f.company = '请填写营业执照上的主体名称';
    if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(s(d.creditCode).toUpperCase().replace(/\s+/g, '')))
      f.creditCode = '统一社会信用代码为 18 位（数字与大写字母）';
    if (s(d.contact).trim().length < 2) f.contact = '请填写联系人姓名';
    if (!/^1[3-9]\d{9}$/.test(s(d.phone).replace(/[\s-]/g, ''))) f.phone = '请填写 11 位手机号';
    if (s(d.email).trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s(d.email).trim())) f.email = '邮箱格式不正确';
  } else if (step === 1) {
    if (!s(d.brand).trim()) f.brand = '请填写品牌名称';
    if (!BRAND_SOURCES.some((o) => o.v === d.brandSource)) f.brandSource = '请选择品牌来源';
    if (!Array.isArray(d.categories) || !d.categories.length) f.categories = '请至少选择一个主营类目';
    if (!SKU_RANGES.some((o) => o.v === d.skuRange)) f.skuRange = '请选择预估 SKU 数量';
    if (!PRICE_RANGES.some((o) => o.v === d.priceRange)) f.priceRange = '请选择主力价格带';
  } else if (step === 2) {
    if (s(d.bankAccount).trim().length < 2) f.bankAccount = '请填写开户名（与营业执照一致）';
    if (!/^\d{12,24}$/.test(s(d.bankNo).replace(/\s/g, ''))) f.bankNo = '银行卡号为 12–24 位数字';
    if (!RETURN_POLICIES.some((o) => o.v === d.returnPolicy)) f.returnPolicy = '请选择退货政策';
    if (!SHIP_WITHIN.some((o) => o.v === d.shipWithin)) f.shipWithin = '请选择发货时效';
  }
  return f;
}

const maskCard = (no) => {
  const s = String(no || '').replace(/\s/g, '');
  return s.length >= 8 ? `${s.slice(0, 4)} **** ${s.slice(-4)}` : s;
};

const newKey = () =>
  (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

/** SQLite 存的是 UTC 'YYYY-MM-DD HH:MM:SS'，页面要按本地时间显示（直接 slice 会差 8 小时） */
function fmtStamp(value) {
  if (!value) return '—';
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && d.data ? d : null;
  } catch {
    return null;
  }
}
function saveDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch { /* 隐私模式写不了：本次会话仍可填完提交，只是刷新后不保留 */ }
}
function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch { /* 同上 */ }
}
function saveLast(v) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(v));
  } catch { /* 同上 */ }
}
export function lastApplication() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
  } catch {
    return null;
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1600);
  } catch {
    btn.textContent = '请手动选择复制';
  }
}

/* ---------------- 状态页（回看已提交的申请） ---------------- */

const STATUS_STEPS = [
  { t: '已提交', d: '资料已进入平台审核队列' },
  { t: '资质审核', d: '主体与品牌资质核验，3 个工作日内出结果' },
  { t: '签约开通', d: '电子签约后开通商家后台，配置运费与售后' },
];

function statusTimeline(status) {
  // 已通过 / 未通过都是终态：第三段直接说结论，不再画「审核中」的进度
  const doneCount = status === 'reviewing' ? 1 : 3;
  return el('ol', { class: 'mzf-timeline' },
    STATUS_STEPS.map((s, i) =>
      el('li', { class: `mzf-tl${i < doneCount ? ' is-done' : ''}` }, [
        el('span', { class: 'mzf-tl-dot', 'aria-hidden': 'true' }, i < doneCount ? '✓' : String(i + 1)),
        el('div', {}, [el('strong', {}, s.t), el('p', {}, s.d)]),
      ]),
    ),
  );
}

async function renderApplicationStatus(v, id, key) {
  const wrap = el('div', { class: 'merchant mz-apply' }, [
    el('a', { class: 'mz-back', href: '#/merchant/join' }, '← 返回招商页'),
    el('span', { class: 'eyebrow' }, 'APPLICATION STATUS'),
    el('h1', { class: 'mz-apply-title' }, '入驻申请'),
    el('div', { class: 'mz-apply-card mzf-loading' }, [el('p', {}, '正在读取申请状态…')]),
  ]);
  v.innerHTML = '';
  v.appendChild(wrap);

  let data = null;
  let error = null;
  try {
    const res = await api(`/api/merchant/applications/${encodeURIComponent(id)}?key=${encodeURIComponent(key)}`, { retries: 1 });
    data = res.application;
  } catch (e) {
    error = e;
  }

  const card = el('div', { class: 'mz-apply-card mzf-result' });
  if (!data) {
    card.append(
      el('span', { class: 'mzf-status is-unknown' }, '无法读取'),
      el('h2', {}, '这份申请查不到'),
      el('p', { class: 'mzf-result-lede' },
        error && (error.kind === 'offline' || isMissingEndpoint(error))
          ? '当前是静态演示站，没有后端可查。启动网关后重新打开本页即可看到状态。'
          : '查询链接可能不完整，或申请编号与凭证不匹配。请核对链接里的编号与 key。'),
      el('div', { class: 'mzf-result-actions' }, [
        el('a', { class: 'mz-btn mz-btn--gold', href: '#/merchant/apply' }, '重新填写申请'),
        el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/join' }, '回到招商页'),
      ]),
    );
    wrap.replaceChild(card, wrap.querySelector('.mzf-loading'));
    return;
  }

  const copyBtn = el('button', { type: 'button', class: 'mzf-copy', onclick: () => copyText(data.id, copyBtn) }, '复制编号');
  const linkBtn = el('button', {
    type: 'button',
    class: 'mzf-copy',
    onclick: () => copyText(location.href, linkBtn),
  }, '复制查询链接');

  card.append(
    el('div', { class: 'mzf-result-head' }, [
      el('span', { class: `mzf-status is-${data.status}` }, data.statusLabel),
      el('div', { class: 'mzf-idrow' }, [
        el('span', { class: 'mzf-idlabel' }, '申请编号'),
        el('strong', { class: 'mzf-id' }, data.id),
        copyBtn,
      ]),
    ]),
    el('h2', {}, data.status === 'reviewing' ? '已收到，正在审核' : '审核已有结果'),
    el('p', { class: 'mzf-result-lede' },
      data.status === 'reviewing'
        ? '资料已进入审核队列，3 个工作日内会通过短信与邮箱告知结果。'
        : data.reviewNote || '审核结果已生成，请留意短信与邮箱通知。'),
    statusTimeline(data.status),
    el('dl', { class: 'mzf-summary static' }, [
      el('div', { class: 'mzf-sum-row' }, [el('dt', {}, '主体'), el('dd', {}, data.company || '—')]),
      el('div', { class: 'mzf-sum-row' }, [el('dt', {}, '品牌'), el('dd', {}, data.brand || '—')]),
      el('div', { class: 'mzf-sum-row' }, [el('dt', {}, '联系人'), el('dd', {}, `${data.contact || '—'} · ${data.phoneMasked || '—'}`)]),
      el('div', { class: 'mzf-sum-row' }, [el('dt', {}, '提交时间'), el('dd', {}, fmtStamp(data.createdAt))]),
    ]),
    el('div', { class: 'mzf-result-actions' }, [
      el('a', { class: 'mz-btn mz-btn--ghost', href: '#/merchant/join' }, '回到招商页'),
      el('a', { class: 'mz-btn mz-btn--gold', href: '#/products' }, '先去逛逛商城'),
      linkBtn,
    ]),
    el('p', { class: 'mzf-foot' }, '把这个链接存进收藏夹，随时回来查看审核进度。链接里含查询凭证，不要转发给无关的人。'),
  );

  wrap.replaceChild(card, wrap.querySelector('.mzf-loading'));
}
