/**
 * homeEntries.js —— 首页的三块「今天为什么来逛」入口：
 *   ① 今天想逛什么（8 个场景卡，横向一条轨道）
 *   ② 按心情挑（6 个胶囊）
 *   ③ 今日主题横幅（当期节日 / 时令）
 *
 * 三块都是**纯静态**：不等商品接口，也不做任何请求——入口不该比首屏慢。
 * 商品筛选发生在点进去之后的场景页 / 情绪页 / 主题页里（sceneStore 的活）。
 *
 * 故意不 import views.js：views.js 要 import 本文件来占位，反向引用会形成环。
 */
import { el } from './ui.js';
import { navigate } from './router.js';
import {
  SC_COPY, homeMoods, homeScenes, moodHash, sceneHash,
} from './store/sceneConfig.js';
import { THEME_COPY, themeHash } from './store/themeConfig.js';
import { currentTheme, mockDate } from './store/themeStore.js';
import { catalogCoupon, fmtCouponValue } from './store/couponStore.js';
import { sceneArt } from './sceneArt.js';

/**
 * 上次点的情绪（模块级）。
 * 用途只有一个：从情绪页返回首页时，胶囊上还留着「你刚选的那个」。
 * 不落 localStorage —— 它是跳板，不是筛选条件，刷新后清空才是对的。
 */
let activeMoodId = '';

/** 由情绪页回写：让首页胶囊与当前结果页保持一致 */
export function markActiveMood(id) {
  activeMoodId = String(id || '');
}

/* ---------------- ① 今天想逛什么 ---------------- */

function sceneCard(scene, index) {
  return el('a', {
    class: 'sc-card',
    href: sceneHash(scene.id),
    style: `--hue:${scene.hue}; --i:${index}`,
    'aria-label': SC_COPY.enterScene(scene.name),
  }, [
    el('span', { class: 'sc-card-art' }, [sceneArt(scene, { variant: 'card' })]),
    el('span', { class: 'sc-card-veil', 'aria-hidden': 'true' }),
    el('span', { class: 'sc-card-body' }, [
      el('span', { class: 'sc-card-no' }, scene.no),
      el('b', { class: 'sc-card-name' }, scene.name),
      el('span', { class: 'sc-card-desc' }, scene.desc),
      el('span', { class: 'sc-card-foot' }, [
        el('span', { class: 'sc-card-cats' }, `${scene.cats.length} 个分类`),
        el('span', { class: 'sc-card-go', 'aria-hidden': 'true' }, '→'),
      ]),
    ]),
  ]);
}

function sceneRail() {
  const scenes = homeScenes();
  return el('div', { class: 'sc-rail-wrap' }, [
    el('div', {
      class: 'sc-rail',
      role: 'list',
      'aria-label': `${scenes.length} 个场景，横向滑动浏览`,
    }, scenes.map((s, i) => {
      const card = sceneCard(s, i);
      card.setAttribute('role', 'listitem');
      return card;
    })),
  ]);
}

/* ---------------- ② 按心情挑 ---------------- */

function moodPills() {
  const moods = homeMoods();
  const row = el('div', { class: 'md-pills', role: 'group', 'aria-label': SC_COPY.moodTitle });
  moods.forEach((m) => {
    const pressed = String(m.id) === activeMoodId;
    const btn = el('button', {
      type: 'button',
      class: `md-pill${pressed ? ' is-active' : ''}`,
      'aria-pressed': String(pressed),
      style: `--hue:${m.hue}`,
      onclick: () => {
        activeMoodId = m.id;
        row.querySelectorAll('.md-pill').forEach((n) => {
          const on = n === btn;
          n.classList.toggle('is-active', on);
          n.setAttribute('aria-pressed', String(on));
        });
        navigate(moodHash(m.id));
      },
    }, [
      el('span', { class: 'md-pill-name' }, m.name),
      el('span', { class: 'md-pill-note' }, m.note),
    ]);
    row.appendChild(btn);
  });
  return row;
}

/* ---------------- ③ 今日主题横幅 ---------------- */

function themeBanner() {
  const theme = currentTheme();
  if (!theme) return null;
  const coupon = catalogCoupon(theme.couponId);
  const mock = mockDate();
  return el('a', {
    class: 'td-banner',
    href: themeHash(theme.id),
    style: `--hue:${theme.hue}`,
    'aria-label': `${THEME_COPY.bannerKicker}：${theme.name}`,
  }, [
    el('div', { class: 'td-banner-copy' }, [
      el('span', { class: 'td-banner-kicker' }, THEME_COPY.bannerKicker),
      el('h3', { class: 'td-banner-title' }, theme.name),
      el('p', { class: 'td-banner-desc' }, theme.pitch || theme.desc),
      el('div', { class: 'td-banner-meta' }, [
        coupon ? el('span', { class: 'td-banner-coupon' }, THEME_COPY.bannerCoupon(fmtCouponValue(coupon))) : null,
        el('span', { class: 'td-banner-window' }, THEME_COPY.window(theme.start, theme.end)),
        mock ? el('span', { class: 'td-banner-mock' }, THEME_COPY.mockActive(mock)) : null,
      ]),
      el('span', { class: 'td-banner-go' }, [THEME_COPY.bannerEnter, el('i', { 'aria-hidden': 'true' }, ' →')]),
    ]),
    el('span', { class: 'td-banner-art' }, [sceneArt(theme, { variant: 'banner' })]),
  ]);
}

/* ---------------- 组装 ---------------- */

/** 首页用：一个 section 里三块，位置在功能模块之后、扫描结果之前 */
export function homeEntryBlock() {
  const banner = themeBanner();
  return el('section', { class: 'sc-entry', style: '--i:2', 'aria-label': '今天想逛什么' }, [
    el('div', { class: 'section-heading sc-entry-head' }, [
      el('div', {}, [
        el('span', { class: 'eyebrow' }, SC_COPY.homeEyebrow),
        el('h2', {}, SC_COPY.homeTitle),
        el('p', { class: 'sc-entry-lead' }, SC_COPY.homeLead),
      ]),
      el('span', { class: 'sc-rail-hint' }, SC_COPY.railHint),
    ]),
    sceneRail(),
    el('div', { class: 'md-block' }, [
      el('div', { class: 'md-head' }, [
        el('span', { class: 'eyebrow' }, SC_COPY.moodEyebrow),
        el('p', { class: 'md-lead' }, SC_COPY.moodLead),
      ]),
      moodPills(),
    ]),
    banner,
  ].filter(Boolean));
}
