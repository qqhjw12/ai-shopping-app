/**
 * showroomStore.js —— 展厅的取货与偏好（纯函数 + 一层 localStorage）。
 *
 * 取货口径只看 `categoryId`：展厅是「按场景摆货」，但落地到数据仍是类目过滤，
 * 不另造一套分区商品表（第二份真源迟早和主目录对不上）。
 *
 * 偏好（网格 / 展厅）按 scopeId 分桶：同一台设备换账号不会互相改视野；
 * 读盘失败一律回落到默认视图，绝不因为 localStorage 脏了就白屏。
 */
import { scopeId } from './userScope.js';
import { SR_CARD_LIMIT, SR_VIEW_KEY, normalizeView } from './showroomConfig.js';

/** 商品归属某分区：categoryId 命中分区的任一 categories */
export function inZone(product, zone) {
  if (!product || !zone) return false;
  const cats = Array.isArray(zone.categories) ? zone.categories : [];
  return cats.includes(String(product.categoryId || ''));
}

/**
 * 取一个分区的展品。
 * 排序：有销量先按销量降、再按 id——确定性，刷新不重排；无销量商品沉底但保留，
 * 不会因为「销量为 0」就从展厅消失（那是只上架没卖过，不是下架）。
 */
export function pickZoneProducts(zone, pool, limit = SR_CARD_LIMIT) {
  const list = Array.isArray(pool) ? pool : [];
  const matched = list.filter((p) => inZone(p, zone));
  const sorted = matched.slice().sort((a, b) => {
    const sa = Number(a.sales) || 0;
    const sb = Number(b.sales) || 0;
    if (sb !== sa) return sb - sa;
    return String(a.id).localeCompare(String(b.id));
  });
  const max = Math.max(1, Number(limit) || SR_CARD_LIMIT);
  return sorted.slice(0, max);
}

/** 分区展品数（用于大厅卡片上的计数，不显示的话就不调用） */
export function zoneCount(zone, pool) {
  return pickZoneProducts(zone, pool, Number.MAX_SAFE_INTEGER).length;
}

/* ---------------- 视图偏好 ---------------- */

function viewKey() {
  let scope = 'l:anon';
  try {
    scope = scopeId();
  } catch {
    scope = 'l:anon';
  }
  return `${SR_VIEW_KEY}::${scope}`;
}

/** 读取视图偏好；损坏/越界一律回落网格 */
export function loadView() {
  try {
    return normalizeView(localStorage.getItem(viewKey()));
  } catch {
    return normalizeView(null);
  }
}

/** 写入视图偏好（写不进去就静默——偏好丢了不影响用） */
export function saveView(view) {
  try {
    localStorage.setItem(viewKey(), normalizeView(view));
    return true;
  } catch {
    return false;
  }
}
