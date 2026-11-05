/**
 * scenes.js —— 三个「推荐理由」落地页：
 *   #/scene/:id   场景页（跨分类组合）
 *   #/mood/:id    情绪结果页
 *   #/theme/:id   主题页（节日 / 时令）
 *
 * 三个页面的共同点：**商品一律从 views.getProducts() 的池子里筛**，
 * 规则在 sceneStore / themeStore 里，本文件只负责把它们画出来。
 * 商品卡直接复用全站 productCard，所以收藏、对比、加购的行为与别处完全一致。
 */
import { el, emptyEditorial, productCard, toast } from './ui.js';
import { navigate } from './router.js';
import { doAdd, getProducts } from './views.js';
import {
  MOOD_LIMIT, MOODS, SCENE_LIMIT, SC_COPY, moodById, moodHash, sceneById, sceneHash,
} from './store/sceneConfig.js';
import { moodLine, pickMoodProducts, pickSceneProducts } from './store/sceneStore.js';
import {
  THEME_COPY, THEME_LIMIT, THEME_MOCK_PRESETS, themeById,
} from './store/themeConfig.js';
import {
  clearMockDate, currentTheme, effectiveDate, mockDate, pickThemeProducts, setMockDate,
} from './store/themeStore.js';
import { catalogCoupon, claimCoupon, fmtCouponValue, listWallet } from './store/couponStore.js';
import { getCurrentUser } from './user.js';
import { markActiveMood } from './homeEntries.js';
import { sceneArt } from './sceneArt.js';

/* ---------------- 公共零件 ---------------- */

async function getProductsSafe() {
  try {
    const list = await getProducts();
    return Array.isArray(list) ? list : [];
  } catch {
    toast('商品目录暂时读不到，结果先按空白展示', 'warn');
    return [];
  }
}

function artHost(subject, variant) {
  const span = el('span', { class: `sc-art-host is-${variant}` });
  span.appendChild(sceneArt(subject, { variant }));
  return span;
}

/** 商品网格：与全站同一张卡（收藏 / 对比 / 加购都在卡上） */
function productGrid(items, source) {
  const grid = el('div', { class: 'sc-grid' });
  items.forEach((p) => {
    grid.appendChild(productCard(p, {
      onDetail: () => navigate(`#/product/${encodeURIComponent(p.id)}?from=${source}`),
      onAddCart: () => doAdd(p, source),
    }));
  });
  return grid;
}

function metaRow(pairs) {
  return el('div', { class: 'sc-hero-meta' },
    pairs.filter(Boolean).map(([k, v]) => el('span', { class: 'sc-meta' }, [
      el('b', {}, String(v)),
      el('i', {}, k),
    ])));
}

/* ==================== 场景页 ==================== */

export async function renderScenePage(view, id) {
  view.innerHTML = '';
  const scene = sceneById(id);
  if (!scene) {
    view.appendChild(emptyEditorial({
      title: SC_COPY.unknownScene,
      text: '可能是链接里的场景名写错了，或者这个场景已经下线。',
      primaryLabel: '回到首页看全部场景',
      onPrimary: () => navigate('#/'),
      secondaryLabel: '浏览全部甄选',
      onSecondary: () => navigate('#/products'),
    }));
    return;
  }

  const pool = await getProductsSafe();
  const res = pickSceneProducts(scene, pool, SCENE_LIMIT);

  const hero = el('section', { class: 'sc-hero', style: `--hue:${scene.hue}` }, [
    artHost(scene, 'hero'),
    el('span', { class: 'sc-hero-veil', 'aria-hidden': 'true' }),
    el('div', { class: 'sc-hero-body' }, [
      el('a', { class: 'sc-back', href: '#/' }, SC_COPY.backHome),
      el('span', { class: 'sc-hero-eyebrow' }, scene.eyebrow),
      el('h1', { class: 'sc-hero-name' }, scene.name),
      el('p', { class: 'sc-hero-line' }, scene.line),
      metaRow([
        ['件匹配', res.items.length],
        ['个分类', Object.keys(res.counts).length],
        ['来源', SC_COPY.demoTag],
      ]),
    ]),
  ]);

  const body = el('section', { class: 'sc-body' }, []);
  if (!res.items.length) {
    body.appendChild(emptyEditorial({
      title: SC_COPY.emptyScene,
      text: SC_COPY.emptySceneHint,
      primaryLabel: '浏览全部甄选',
      onPrimary: () => navigate('#/products'),
      secondaryLabel: '换个场景',
      onSecondary: () => navigate('#/'),
    }));
  } else {
    body.appendChild(el('p', { class: 'sc-note' }, SC_COPY.scenePickNote));
    body.appendChild(productGrid(res.items, 'scene'));
  }

  view.appendChild(el('section', { class: 'sc-page' }, [hero, body]));
}

/* ==================== 情绪结果页 ==================== */

function moodPillRow(activeId, onPick) {
  const row = el('div', { class: 'md-pills is-switch', role: 'group', 'aria-label': '切换心情' });
  MOODS.forEach((m) => {
    const on = m.id === activeId;
    row.appendChild(el('button', {
      type: 'button',
      class: `md-pill${on ? ' is-active' : ''}`,
      'aria-pressed': String(on),
      style: `--hue:${m.hue}`,
      onclick: () => onPick(m),
    }, [
      el('span', { class: 'md-pill-name' }, m.name),
      el('span', { class: 'md-pill-note' }, m.note),
    ]));
  });
  return row;
}

export async function renderMoodPage(view, id) {
  view.innerHTML = '';
  const mood = moodById(id);
  if (!mood) {
    view.appendChild(emptyEditorial({
      title: SC_COPY.unknownMood,
      text: '情绪标签只有首页那几个，点一个就能回到对应的结果。',
      primaryLabel: '回到首页挑一个',
      onPrimary: () => navigate('#/'),
    }));
    return;
  }
  markActiveMood(mood.id); // 回首页时胶囊上还留着这个

  const pool = await getProductsSafe();
  const res = pickMoodProducts(mood, pool, MOOD_LIMIT);
  const line = moodLine(mood, res.matchedTags);

  const hero = el('section', { class: 'sc-hero is-mood', style: `--hue:${mood.hue}` }, [
    artHost(mood, 'hero'),
    el('span', { class: 'sc-hero-veil', 'aria-hidden': 'true' }),
    el('div', { class: 'sc-hero-body' }, [
      el('a', { class: 'sc-back', href: '#/' }, SC_COPY.backHome),
      el('span', { class: 'sc-hero-eyebrow' }, SC_COPY.moodEyebrow),
      el('h1', { class: 'sc-hero-name' }, mood.name),
      // 这一行不是写死的：命中标签来自实际筛出的商品
      el('p', { class: 'sc-hero-line' }, line),
      el('p', { class: 'sc-note is-inline' }, SC_COPY.moodPickNote(res.matchedTags)),
    ]),
    el('div', { class: 'sc-hero-pills' }, [
      moodPillRow(mood.id, (next) => navigate(moodHash(next.id))),
    ]),
  ]);

  const body = el('section', { class: 'sc-body' }, [
    res.items.length
      ? productGrid(res.items, 'mood')
      : emptyEditorial({
        title: '这个心情暂时没筛到商品',
        text: '按类目分布没命中也说明池子里这几类还没上货，先去逛全部甄选。',
        primaryLabel: '浏览全部甄选',
        onPrimary: () => navigate('#/products'),
      }),
  ]);

  view.appendChild(el('section', { class: 'sc-page' }, [hero, body]));
}

/* ==================== 主题页 ==================== */

function couponTicket(theme) {
  const c = catalogCoupon(theme.couponId);
  if (!c) return el('p', { class: 'td-note' }, THEME_COPY.couponMissing);

  const user = getCurrentUser();
  const heldNow = () => (user && user.id
    ? listWallet(user.id).filter((w) => String(w.couponId) === String(c.id))
    : []);
  const btn = el('button', {
    type: 'button',
    class: 'td-coupon-btn',
    'aria-label': `领取 ${c.title}`,
  }, '');

  const paint = () => {
    const claimed = heldNow().some((w) => w.state === 'unused');
    btn.disabled = claimed;
    btn.classList.toggle('is-claimed', claimed);
    btn.textContent = claimed
      ? THEME_COPY.couponClaimed
      : (user ? THEME_COPY.couponClaim : THEME_COPY.couponLogin);
  };

  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (!user) {
      toast(THEME_COPY.couponLoginToast, 'warn');
      navigate(`#/login?redirect=${encodeURIComponent(`/theme/${theme.id}`)}`);
      return;
    }
    btn.disabled = true;
    const res = await claimCoupon(user.id, c.id);
    if (!res.ok) {
      toast(res.error || '领取失败', res.error === '该券已在卡包中' ? 'warn' : 'err');
      paint();
      return;
    }
    toast(THEME_COPY.couponOk, 'ok');
    paint();
  });
  paint();

  return el('article', { class: 'td-coupon', 'data-coupon': c.id }, [
    el('div', { class: 'td-coupon-val' }, [
      el('span', { class: 'td-coupon-num num' }, fmtCouponValue(c)),
      el('span', { class: 'td-coupon-th' }, `满 ${c.threshold} 可用`),
    ]),
    el('div', { class: 'td-coupon-body' }, [
      el('b', { class: 'td-coupon-title' }, c.title),
      el('span', { class: 'td-coupon-scope' }, c.scopeText || '全场通用'),
      el('span', { class: 'td-coupon-note' }, c.note || ''),
    ]),
    btn,
  ]);
}

function sceneEntries(theme) {
  const list = (theme.scenes || []).map((sid) => sceneById(sid)).filter(Boolean);
  if (!list.length) return null;
  return el('div', { class: 'td-scenes' }, list.map((s) => el('a', {
    class: 'td-scene',
    href: sceneHash(s.id),
    style: `--hue:${s.hue}`,
  }, [
    el('span', { class: 'td-scene-art' }, [sceneArt(s, { variant: 'card' })]),
    el('span', { class: 'td-scene-veil', 'aria-hidden': 'true' }),
    el('span', { class: 'td-scene-body' }, [
      el('span', { class: 'td-scene-eyebrow' }, s.eyebrow),
      el('b', { class: 'td-scene-name' }, s.name),
      el('span', { class: 'td-scene-desc' }, s.desc),
    ]),
  ])));
}

/**
 * 演示日期切换：点了就落盘 + 整页重画（不刷新浏览器，也不丢当前滚动位置之外的东西）。
 * 使用显式 id 进页时也允许切换——切完跳到「当期主题」，因为日期才是这里的真源。
 */
function mockSwitcher(view, theme) {
  const current = mockDate();
  const row = el('div', { class: 'td-mock-row', role: 'group', 'aria-label': THEME_COPY.mockHead });
  THEME_MOCK_PRESETS.forEach((preset) => {
    const on = preset.date === current;
    row.appendChild(el('button', {
      type: 'button',
      class: `td-mock-btn${on ? ' is-active' : ''}`,
      'aria-pressed': String(on),
      onclick: () => {
        if (preset.date) setMockDate(preset.date);
        else clearMockDate();
        renderThemePage(view, '');
      },
    }, preset.label));
  });

  return el('section', { class: 'td-mock' }, [
    el('div', { class: 'td-mock-head' }, [
      el('span', { class: 'eyebrow' }, THEME_COPY.mockHead),
      el('p', { class: 'td-mock-hint' }, THEME_COPY.mockHint),
    ]),
    row,
    el('p', { class: 'td-mock-now' }, [
      el('span', {}, `生效日期 ${effectiveDate()}`),
      el('span', { class: 'td-mock-theme' }, `当期主题：${theme.name}`),
    ]),
  ]);
}

export async function renderThemePage(view, id) {
  view.innerHTML = '';
  const theme = id ? themeById(id) : currentTheme();
  if (!theme) {
    view.appendChild(emptyEditorial({
      title: THEME_COPY.unknownTheme,
      text: '主题按日期自动切换，链接里的 id 可能已经不是当期主题了。',
      primaryLabel: '看看当期主题',
      onPrimary: () => navigate('#/theme'),
    }));
    return;
  }

  const pool = await getProductsSafe();
  const res = pickThemeProducts(theme, pool, THEME_LIMIT);

  const hero = el('section', { class: 'sc-hero is-theme', style: `--hue:${theme.hue}` }, [
    artHost(theme, 'hero'),
    el('span', { class: 'sc-hero-veil', 'aria-hidden': 'true' }),
    el('div', { class: 'sc-hero-body' }, [
      el('a', { class: 'sc-back', href: '#/' }, THEME_COPY.pageBack),
      el('span', { class: 'sc-hero-eyebrow' }, theme.eyebrow),
      el('h1', { class: 'sc-hero-name' }, theme.name),
      el('p', { class: 'sc-hero-line' }, theme.line),
      metaRow([
        ['件商品', res.items.length],
        ['主题窗口', THEME_COPY.window(theme.start, theme.end)],
        ['来源', THEME_COPY.demoTag],
      ]),
    ]),
  ]);

  const couponSection = el('section', { class: 'td-block' }, [
    el('div', { class: 'td-block-head' }, [
      el('h2', {}, THEME_COPY.couponHead),
      el('a', { class: 'td-block-link', href: '#/coupons' }, THEME_COPY.couponGo),
    ]),
    el('p', { class: 'td-block-lead' }, THEME_COPY.couponLead),
    couponTicket(theme),
  ]);

  const poolSection = el('section', { class: 'td-block' }, [
    el('div', { class: 'td-block-head' }, [
      el('h2', {}, THEME_COPY.productHead),
      el('span', { class: 'td-block-meta' }, `${res.items.length} 件`),
    ]),
    el('p', { class: 'td-block-lead' }, THEME_COPY.productLead),
    res.items.length
      ? productGrid(res.items, 'theme')
      : emptyEditorial({
        title: THEME_COPY.emptyPool,
        text: THEME_COPY.emptyPoolHint,
        primaryLabel: '浏览全部甄选',
        onPrimary: () => navigate('#/products'),
      }),
  ]);

  const scenes = sceneEntries(theme);
  const sceneSection = scenes
    ? el('section', { class: 'td-block' }, [
      el('div', { class: 'td-block-head' }, [
        el('h2', {}, THEME_COPY.scenesHead),
      ]),
      el('p', { class: 'td-block-lead' }, THEME_COPY.scenesLead),
      scenes,
    ])
    : null;

  view.appendChild(el('section', { class: 'sc-page is-theme' }, [
    hero,
    couponSection,
    poolSection,
    sceneSection,
    mockSwitcher(view, theme),
  ].filter(Boolean)));
}
