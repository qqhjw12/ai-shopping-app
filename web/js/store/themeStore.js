/**
 * themeStore.js —— 主题的日期判定、演示日期覆盖与取货（纯函数 + 一层 localStorage）。
 *
 * 「主题每天不一样」落到实现上只有一件事：**把日期换算成 MM-DD，再找出命中窗口的
 * 那一个主题**。日期判定是纯函数 themeAt()，所以：
 *   · 真实今天 → 自动落到当期主题（无需任何后台）；
 *   · mock 一个日期 → 同一套纯函数算出另一个主题，用于演示「会切换」；
 *   · 断言可以拿任意日期把全年 365 天都跑一遍，不需要等一年。
 *
 * 演示日期按 scopeId 分桶存 localStorage：它是个人偏好，不该串给别人。
 */
import { scopeId } from './userScope.js';
import { THEMES, THEME_LIMIT, THEME_MOCK_KEY, fallbackTheme } from './themeConfig.js';
import { pickByRule } from './sceneStore.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD（不能用 toISOString：那是 UTC，晚上会差一天） */
export function dateStr(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return dateStr(new Date());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 任意输入 → 'MM-DD'。
 * 接受 'YYYY-MM-DD' / 'MM-DD' / Date / 时间戳；非法值返回 ''（调用方据此回落）。
 */
export function mdOf(input) {
  if (input instanceof Date) return dateStr(input).slice(5);
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return '';
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/) || raw.match(/^(\d{2})-(\d{2})$/);
  if (!m) return '';
  const mo = m[1].length === 4 ? m[2] : m[1];
  const da = m[1].length === 4 ? m[3] : m[2];
  const mi = Number(mo);
  const di = Number(da);
  if (!(mi >= 1 && mi <= 12) || !(di >= 1 && di <= 31)) return '';
  return `${pad2(mi)}-${pad2(di)}`;
}

/**
 * MM-DD 是否落在窗口内（闭区间）。
 * start > end 视为跨年窗口（如 12-27 ~ 02-28），判定改成「或」。
 */
export function inWindow(md, start, end) {
  const a = mdOf(md);
  const s = mdOf(start);
  const e = mdOf(end);
  if (!a || !s || !e) return false;
  if (s <= e) return a >= s && a <= e;
  return a >= s || a <= e;
}

/**
 * 某一天对应的主题。window 全空时回落 fallback（配置被改坏也不白屏）。
 * @param {string|Date|number} [when] 缺省 = 今天
 */
export function themeAt(when) {
  const md = mdOf(when) || mdOf(new Date());
  return THEMES.find((t) => inWindow(md, t.start, t.end)) || fallbackTheme();
}

/* ---------------- 演示日期覆盖 ---------------- */

function mockKey() {
  let scope = 'l:anon';
  try {
    scope = scopeId();
  } catch {
    scope = 'l:anon';
  }
  return `${THEME_MOCK_KEY}::${scope}`;
}

/** 当前生效的演示日期（'' = 用真实今天） */
export function mockDate() {
  try {
    const raw = localStorage.getItem(mockKey());
    return mdOf(raw) ? String(raw).slice(0, 10) : '';
  } catch {
    return '';
  }
}

/** 设置演示日期；传空（或非法值）等于恢复今天 */
export function setMockDate(value) {
  const date = String(value || '').slice(0, 10);
  try {
    if (!mdOf(date)) {
      localStorage.removeItem(mockKey());
      return '';
    }
    localStorage.setItem(mockKey(), date);
    return date;
  } catch {
    return '';
  }
}

/** 恢复今天 */
export function clearMockDate() {
  return setMockDate('');
}

/** 生效日期：有演示日期用演示日期，否则今天 */
export function effectiveDate() {
  return mockDate() || dateStr(new Date());
}

/** 当前主题（页面与首页横幅都用它，保证两处永远同一个） */
export function currentTheme() {
  return themeAt(effectiveDate());
}

/** 主题取货：类目 + 关键词，规则与场景共用一套（sceneStore.pickByRule） */
export function pickThemeProducts(theme, pool, limit = THEME_LIMIT) {
  if (!theme) return { items: [], matchedTags: [], counts: {} };
  return pickByRule(theme, pool, { limit });
}
