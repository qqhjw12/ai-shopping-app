// 心愿单助力仓储层：公开开关、公开索引（跨 scope 可读）、访客助力去重、阶梯进度、奖励领取。
//
// 为什么要有「公开索引」这张独立的表：
//   本地心愿单是按 scopeId() 分桶的，访客有自己的 scope，读不到别人的桶。
//   所以公开出去的不是「我的收藏夹」，而是索引里的一条**最小快照**（商品 id / 理由 / 助力记录）。
//   localStorage 是 per-origin 的，因此同一浏览器里换账号、开两个标签页都能看到同一份进度；
//   跨浏览器无法同步（没有服务端），这一点在页面上会如实说明，不做假的实时。
//
// 状态一律推导、不落盘：助力人数 = 索引里 helps 的长度；解锁状态 = 人数 ≥ 阈值。
// 落盘的只有事实（谁在什么时候助力了、哪一档奖励领过），避免两处数据打架。
import {
  WL_ALLOW_SELF_HELP,
  WL_HELP_LIMIT_PER_VISITOR,
  WL_ID_PREFIX,
  WL_MAX_ITEMS,
  WL_MAX_NOTICES,
  WL_PUBLIC_INDEX_KEY,
  WL_REASON_FALLBACK,
  WL_REASON_MAX,
  WL_REASON_MIN,
  WL_STORAGE_PREFIX,
  WL_TIERS,
  WL_TIER_THRESHOLDS,
} from './wishlistConfig.js';
import { scopeId } from './userScope.js';

/* ==================== 纯函数：理由与进度 ==================== */

/** 理由归一：去首尾空白、压缩连续空白、按上限截断；太短则回落到兜底文案。 */
export function clampReason(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (s.length < WL_REASON_MIN) return '';
  return s.slice(0, WL_REASON_MAX);
}

/** 展示用理由：没填就用兜底，不显示空条。 */
export function displayReason(board) {
  const s = clampReason(board && board.reason);
  return s || WL_REASON_FALLBACK;
}

/** 已助力人数（同一 scope 只算一次，防御脏数据里重复的 scope）。 */
export function helpCount(pub) {
  const helps = Array.isArray(pub && pub.helps) ? pub.helps : [];
  return new Set(helps.map((h) => String((h && h.scope) || ''))).size;
}

/** 某个 scope 是否已经助力过。 */
export function hasHelped(pub, scope = scopeId()) {
  const helps = Array.isArray(pub && pub.helps) ? pub.helps : [];
  return helps.some((h) => String((h && h.scope) || '') === String(scope));
}

/**
 * 能否助力：
 *   self   —— 自己的心愿单不给助力（可配置放开）
 *   done   —— 已经助力过（达到每访客上限）
 *   full   —— 所有阶梯都已解锁，再助力也没有新增收益，直接置灰
 */
export function canHelp(pub, scope = scopeId()) {
  if (!pub || !pub.id) return { ok: false, reason: 'not_found' };
  const owner = String(pub.ownerScope || '');
  if (!WL_ALLOW_SELF_HELP && owner && owner === String(scope)) return { ok: false, reason: 'self' };
  if (hasHelped(pub, scope)) return { ok: false, reason: 'done' };
  if (WL_HELP_LIMIT_PER_VISITOR <= 0) return { ok: false, reason: 'closed' };
  if (helpCount(pub) >= WL_TIER_THRESHOLDS[WL_TIER_THRESHOLDS.length - 1]) {
    return { ok: false, reason: 'maxed' };
  }
  return { ok: true, reason: 'ok' };
}

/**
 * 阶梯进度：返回每一档的解锁状态与还差几人，外加「下一档」。
 * need 一律按「还差几人」给出（0 表示已达标），视图层不用再算一次。
 */
export function tierProgress(pub, tiers = WL_TIERS) {
  const have = helpCount(pub);
  const list = (Array.isArray(tiers) ? tiers : []).map((t) => ({
    ...t,
    unlocked: have >= t.threshold,
    need: Math.max(0, t.threshold - have),
  }));
  const next = list.find((t) => !t.unlocked) || null;
  return {
    have,
    tiers: list,
    next,
    maxThreshold: list.length ? list[list.length - 1].threshold : 0,
    /** 进度条归一化到「最高阈值」，0–1 */
    ratio: list.length ? Math.min(1, have / Math.max(1, list[list.length - 1].threshold)) : 0,
    allUnlocked: list.length > 0 && list.every((t) => t.unlocked),
  };
}

/** 已解锁但还没领的档位（主人侧高亮「领取奖励」用）。 */
export function claimableTiers(pub) {
  const claimed = Array.isArray(pub && pub.claimedTiers) ? pub.claimedTiers.map(Number) : [];
  return tierProgress(pub).tiers.filter((t) => t.unlocked && !claimed.includes(t.threshold));
}

/* ==================== 仓储层：本地心愿单设置（按 scope 隔离） ==================== */

export function storageKey(scope = scopeId()) {
  return `${WL_STORAGE_PREFIX}${scope}`;
}

/** 空板：还没公开过时也有一个稳定结构，视图层不用到处判空。 */
export function emptyBoard(scope = scopeId()) {
  return {
    id: '',
    scope,
    ownerName: '',
    public: false,
    reason: '',
    createdAt: '',
    updatedAt: '',
    notices: [],
  };
}

export function normalizeBoard(raw, scope = scopeId()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const notices = (Array.isArray(r.notices) ? r.notices : [])
    .map((n) => ({
      id: String((n && n.id) || ''),
      tier: Number((n && n.tier) || 0),
      couponId: String((n && n.couponId) || ''),
      title: String((n && n.title) || ''),
      at: typeof (n && n.at) === 'string' ? n.at : new Date().toISOString(),
      read: Boolean(n && n.read),
    }))
    .filter((n) => n.id)
    .slice(0, WL_MAX_NOTICES);
  return {
    id: String(r.id || ''),
    scope: String(r.scope || scope),
    ownerName: String(r.ownerName || '').slice(0, 24),
    public: Boolean(r.public),
    reason: clampReason(r.reason),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    notices,
  };
}

export function loadBoard() {
  const s = scopeId();
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(storageKey(s)) || 'null');
  } catch {
    raw = null;
  }
  return normalizeBoard(raw, s);
}

export function saveBoard(board) {
  try {
    const b = normalizeBoard(board, board.scope || scopeId());
    localStorage.setItem(storageKey(b.scope), JSON.stringify(b));
    return true;
  } catch {
    return false;
  }
}

/* ==================== 仓储层：公开索引（跨 scope 可读） ==================== */

function readIndex() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(WL_PUBLIC_INDEX_KEY) || 'null');
  } catch {
    raw = null;
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeIndex(index) {
  try {
    localStorage.setItem(WL_PUBLIC_INDEX_KEY, JSON.stringify(index));
    return true;
  } catch {
    return false;
  }
}

export function normalizePublic(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const products = (Array.isArray(r.products) ? r.products : [])
    .map((p) => String((p && p.id) || p || ''))
    .filter(Boolean)
    .slice(0, WL_MAX_ITEMS);
  const helps = (Array.isArray(r.helps) ? r.helps : [])
    .map((h) => ({ scope: String((h && h.scope) || ''), at: typeof (h && h.at) === 'string' ? h.at : '' }))
    .filter((h) => h.scope);
  // 同一 scope 只保留最早的一条，长度即人数
  const seen = new Set();
  const dedupedHelps = helps.filter((h) => (seen.has(h.scope) ? false : (seen.add(h.scope), true)));
  return {
    id: String(r.id || ''),
    ownerScope: String(r.ownerScope || ''),
    ownerName: String(r.ownerName || '').slice(0, 24),
    reason: clampReason(r.reason),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    products,
    helps: dedupedHelps,
    claimedTiers: (Array.isArray(r.claimedTiers) ? r.claimedTiers : []).map(Number).filter(Number.isFinite),
    // 已通知过的阶梯，避免同一档反复推通知
    notifiedTiers: (Array.isArray(r.notifiedTiers) ? r.notifiedTiers : []).map(Number).filter(Number.isFinite),
  };
}

/** 全部公开心愿单（列表用，最新在前）。 */
export function listPublic() {
  const idx = readIndex();
  return Object.values(idx)
    .map(normalizePublic)
    .filter((p) => p.id && p.products.length)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** 读一份公开心愿单；不存在返回 null（页面走「不存在」态，不抛错）。 */
export function getPublic(id) {
  const key = String(id || '');
  if (!key) return null;
  const idx = readIndex();
  return idx[key] ? normalizePublic(idx[key]) : null;
}

/* ==================== 动作区：公开 / 收回 / 改理由 ==================== */

function newBoardId(now = Date.now()) {
  return `${WL_ID_PREFIX}${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 发布（或刷新）公开快照。
 * productIds 由调用方传入当前收藏（视图层已经按收藏顺序排好），这里只做截断与去重。
 */
export function publish(productIds, { ownerName = '', reason = '', now = Date.now() } = {}) {
  const ids = [...new Set((Array.isArray(productIds) ? productIds : []).map(String).filter(Boolean))]
    .slice(0, WL_MAX_ITEMS);
  if (!ids.length) return { ok: false, reason: 'empty' };

  const board = loadBoard();
  const at = new Date(now).toISOString();
  if (!board.id) {
    board.id = newBoardId(now);
    board.createdAt = at;
  }
  board.public = true;
  board.ownerName = String(ownerName || board.ownerName || '').slice(0, 24);
  board.reason = clampReason(reason) || board.reason;
  board.updatedAt = at;
  if (!saveBoard(board)) return { ok: false, reason: 'storage' };

  const idx = readIndex();
  const prev = idx[board.id] ? normalizePublic(idx[board.id]) : null;
  const next = normalizePublic({
    ...(prev || {}),
    id: board.id,
    ownerScope: board.scope,
    ownerName: board.ownerName,
    reason: board.reason,
    createdAt: board.createdAt,
    updatedAt: at,
    products: ids.map((id) => ({ id })),
    // 已公开过的助力记录必须保留：改一次理由就清零等于把别人的助力吃掉了
    helps: prev ? prev.helps : [],
    claimedTiers: prev ? prev.claimedTiers : [],
    notifiedTiers: prev ? prev.notifiedTiers : [],
  });
  idx[board.id] = next;
  if (!writeIndex(idx)) return { ok: false, reason: 'storage' };
  return { ok: true, board, public: next };
}

/** 收回公开：从索引里删掉条目（助力记录随之消失，这是用户的明确意图）。 */
export function unpublish() {
  const board = loadBoard();
  if (!board.id) return { ok: false, reason: 'not_public' };
  board.public = false;
  board.updatedAt = new Date().toISOString();
  saveBoard(board);
  const idx = readIndex();
  if (idx[board.id]) {
    delete idx[board.id];
    writeIndex(idx);
  }
  return { ok: true, board };
}

/** 同步收藏变化：已公开的心愿单在收藏增删后要跟着更新，否则公开页会显示已移除的商品。 */
export function syncPublic(productIds, { ownerName = '', reason = '' } = {}) {
  const board = loadBoard();
  if (!board.public || !board.id) return { ok: false, reason: 'not_public' };
  return publish(productIds, { ownerName: ownerName || board.ownerName, reason: reason || board.reason });
}

/** 改心愿理由：本地改完立刻刷新公开快照（否则分享页还是旧理由）。 */
export function setReason(text) {
  const board = loadBoard();
  board.reason = clampReason(text);
  board.updatedAt = new Date().toISOString();
  if (!saveBoard(board)) return { ok: false, reason: 'storage' };
  if (board.public && board.id) {
    const idx = readIndex();
    if (idx[board.id]) {
      const pub = normalizePublic(idx[board.id]);
      pub.reason = board.reason;
      pub.updatedAt = board.updatedAt;
      idx[board.id] = pub;
      writeIndex(idx);
    }
  }
  return { ok: true, board };
}

/* ==================== 动作区：访客助力 ==================== */

/**
 * 助力：往公开索引里追加一条 { scope, at }，并结算「本次是否跨过某个阶梯」。
 * 返回值里的 unlocked 是被本次助力解开的档位（可能为 null），视图层据此弹提示。
 */
export function help(id, scope = scopeId(), now = Date.now()) {
  const key = String(id || '');
  const idx = readIndex();
  if (!idx[key]) return { ok: false, reason: 'not_found' };
  const pub = normalizePublic(idx[key]);
  const gate = canHelp(pub, scope);
  if (!gate.ok) return gate;

  const before = helpCount(pub);
  pub.helps = [...pub.helps, { scope: String(scope), at: new Date(now).toISOString() }];
  pub.updatedAt = new Date(now).toISOString();
  const after = helpCount(pub);

  // 跨过的阶梯：before < threshold <= after
  const crossed = WL_TIERS.filter((t) => before < t.threshold && after >= t.threshold);
  idx[key] = pub;
  if (!writeIndex(idx)) return { ok: false, reason: 'storage' };

  return {
    ok: true,
    reason: 'helped',
    count: after,
    countBefore: before,
    unlocked: crossed.length ? crossed[crossed.length - 1] : null,
    crossed,
    public: pub,
  };
}

/* ==================== 动作区：主人侧通知与领奖 ==================== */

/**
 * 把「某档已解锁」写进主人的本地通知栏。
 * 由公开页在助力跨过阈值时调用 —— 因为 localStorage 同源，访客也能写入主人的分桶；
 * 这是演示态唯一能做到跨 scope 通知的方式，跨浏览器不具备这个能力。
 */
export function pushOwnerNotice(pub, tier, now = Date.now()) {
  if (!pub || !pub.ownerScope || !tier) return { ok: false, reason: 'invalid' };
  const ownerScope = String(pub.ownerScope);
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(WL_STORAGE_PREFIX + ownerScope) || 'null');
  } catch {
    raw = null;
  }
  const board = normalizeBoard(raw, ownerScope);
  if (!board.id) board.id = pub.id;
  const noticed = new Set(board.notices.map((n) => Number(n.tier)));
  if (noticed.has(Number(tier.threshold))) return { ok: false, reason: 'duplicate' };
  board.notices = [{
    id: `n_${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    tier: Number(tier.threshold),
    couponId: String(tier.couponId || ''),
    title: String(tier.title || ''),
    at: new Date(now).toISOString(),
    read: false,
  }, ...board.notices].slice(0, WL_MAX_NOTICES);
  if (!saveBoard(board)) return { ok: false, reason: 'storage' };

  const idx = readIndex();
  if (idx[pub.id]) {
    const p = normalizePublic(idx[pub.id]);
    p.notifiedTiers = [...new Set([...p.notifiedTiers, Number(tier.threshold)])];
    idx[pub.id] = p;
    writeIndex(idx);
  }
  return { ok: true, board };
}

/** 未读通知（收藏页顶部提示条用）。 */
export function unreadNotices() {
  return loadBoard().notices.filter((n) => !n.read);
}

export function markNoticesRead() {
  const board = loadBoard();
  if (!board.notices.length) return { ok: false, reason: 'empty' };
  board.notices = board.notices.map((n) => ({ ...n, read: true }));
  saveBoard(board);
  return { ok: true };
}

/** 已领取的档位写进公开索引：换设备/重新登录后仍然显示「已领取」。 */
export function markTierClaimed(id, threshold) {
  const idx = readIndex();
  const key = String(id || '');
  if (!idx[key]) return { ok: false, reason: 'not_found' };
  const pub = normalizePublic(idx[key]);
  pub.claimedTiers = [...new Set([...pub.claimedTiers, Number(threshold)])].filter(Number.isFinite);
  idx[key] = pub;
  writeIndex(idx);
  const board = loadBoard();
  board.notices = board.notices.map((n) => (Number(n.tier) === Number(threshold) ? { ...n, read: true } : n));
  saveBoard(board);
  return { ok: true, public: pub };
}

/** 已领取档位集合（视图层灰化按钮用）。 */
export function claimedTiers(id) {
  const pub = getPublic(id);
  return pub ? pub.claimedTiers : [];
}

/* ==================== 配置校验：券必须真实存在 ==================== */

/**
 * 阶梯里的 couponId 必须在券目录里找得到，否则「达标领券」会静默失败。
 * 配置层保持零依赖，所以校验放在这里，由视图层在渲染时调一次。
 */
export function validateTiers(catalog) {
  const list = Array.isArray(catalog) ? catalog : [];
  const checked = WL_TIERS.map((t) => {
    const hit = list.find((c) => c && c.id === t.couponId);
    return { ...t, coupon: hit || null, ok: Boolean(hit), title: hit ? hit.title : '' };
  });
  const bad = checked.filter((t) => !t.ok);
  if (bad.length && typeof console !== 'undefined' && console.warn) {
    console.warn('[wishlist] 奖励券不在券目录中，达标后将无法发放：', bad.map((t) => t.couponId));
  }
  return checked;
}
