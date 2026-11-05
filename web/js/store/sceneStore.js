/**
 * sceneStore.js —— 场景 / 情绪的**取货规则**（纯函数，零副作用，可被 Node 直接断言）。
 *
 * 一句话说清取货口径：**只从传入的商品池里筛，绝不造商品、绝不请求接口**。
 *   1) 相关度 = 命中规则关键词的数量（标签 / 名称 / 子类目 / 卖点都算）；
 *   2) 类目之间**轮流取**，保证结果真的是「跨分类组合」，而不是被图书（本站
 *      商品池里体量最大的类目）一口气占满；
 *   3) 同一分类内：相关度降序 → 销量降序 → id 升序。全程确定性，刷新不重排。
 *
 * 为什么销量只做微弱加权：销量是「别人买过」的证据，不是「适合这个场景」的证据。
 * 它只能在同一档相关度里做微调，不能把低相关的高销商品顶到第一屏。
 */

/** 商品的可检索文本（标签 + 标题 + 子类目 + 卖点），小写化后做包含匹配 */
function hayOf(p) {
  if (!p) return '';
  const tags = Array.isArray(p.tags) ? p.tags : [];
  return [
    p.name, p.brand, p.category, p.subCategory, p.highlight,
    ...tags,
  ].map((s) => String(s == null ? '' : s)).join(' ').toLowerCase();
}

/**
 * 单件商品在某个规则下的相关度。
 * @returns {{ score:number, hits:number, matched:string[] }}
 */
export function scoreProduct(product, rule) {
  const keywords = Array.isArray(rule && rule.tags) ? rule.tags : [];
  const hay = hayOf(product);
  const matched = [];
  if (hay) {
    for (const kw of keywords) {
      const k = String(kw || '').toLowerCase();
      if (k && hay.includes(k)) matched.push(String(kw));
    }
  }
  const hits = matched.length;
  const sales = Math.max(0, Number(product && product.sales) || 0);
  // 销量分最多 6 分（log10 压缩），远小于一次关键词命中的 10 分
  const salesScore = Math.min(6, Math.log10(sales + 1) * 2);
  const ratingBonus = Number(product && product.rating) >= 4.8 ? 1 : 0;
  return {
    score: hits * 10 + (hits ? 6 : 0) + salesScore + ratingBonus,
    hits,
    matched,
  };
}

/** 同一分类内的排序：相关度 → 销量 → id */
function compareScored(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const sa = Number(a.p.sales) || 0;
  const sb = Number(b.p.sales) || 0;
  if (sb !== sa) return sb - sa;
  return String(a.p.id).localeCompare(String(b.p.id));
}

/**
 * 按规则从商品池取货。
 * @param {object} rule 需要 cats（一级类目数组）与 tags（关键词数组）
 * @param {Array} pool 商品池（来自 views.getProducts()）
 * @param {{limit?:number, perCat?:number}} opts
 * @returns {{ items:Array, matchedTags:string[], counts:Record<string,number> }}
 */
export function pickByRule(rule, pool, { limit = 24, perCat = 0 } = {}) {
  const cats = Array.isArray(rule && rule.cats) ? rule.cats.map(String) : [];
  const list = Array.isArray(pool) ? pool : [];
  const max = Math.max(1, Number(limit) || 24);

  // 按类目分桶；不在 cats 里的商品一律不进候选（这就是「与商品库相关」的边界）
  const buckets = cats.map((cat) => list
    .filter((p) => p && String(p.categoryId || '') === cat)
    .map((p) => ({ p, ...scoreProduct(p, rule) }))
    .sort(compareScored));

  const used = new Set();
  const items = [];
  const tagFreq = new Map();
  const counts = {};

  const take = (i) => {
    const bucket = buckets[i];
    while (bucket.length) {
      const head = bucket.shift();
      const id = String(head.p.id);
      if (used.has(id)) continue;
      used.add(id);
      items.push(head.p);
      counts[cats[i]] = (counts[cats[i]] || 0) + 1;
      head.matched.forEach((t) => tagFreq.set(t, (tagFreq.get(t) || 0) + 1));
      return true;
    }
    return false;
  };

  // 第一轮：每类配额 = limit / 类目数，轮流取一件 → 跨分类组合且各类占比均衡
  const quota = Math.max(1, Number(perCat) || Math.ceil(max / Math.max(1, buckets.length)));
  const taken = buckets.map(() => 0);
  let progressed = true;
  while (items.length < max && progressed) {
    progressed = false;
    for (let i = 0; i < buckets.length && items.length < max; i++) {
      if (taken[i] >= quota) continue;
      if (take(i)) {
        taken[i] += 1;
        progressed = true;
      }
    }
  }
  // 第二轮：有的类目没货，剩下列表还没取满就放开配额（不让空类目拖累总数）
  progressed = true;
  while (items.length < max && progressed) {
    progressed = false;
    for (let i = 0; i < buckets.length && items.length < max; i++) {
      if (take(i)) progressed = true;
    }
  }

  // 命中标签按「命中商品数」降序，用于结果页那句数据推导的说明
  const matchedTags = [...tagFreq.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([t]) => t);

  return { items, matchedTags, counts };
}

/** 只要商品时的便捷包装 */
export function pickItems(rule, pool, opts) {
  return pickByRule(rule, pool, opts).items;
}

/** 场景取货：limit 由调用方按场景页/首页不同口径传入 */
export function pickSceneProducts(scene, pool, limit) {
  if (!scene) return { items: [], matchedTags: [], counts: {} };
  return pickByRule(scene, pool, { limit });
}

/** 情绪取货 */
export function pickMoodProducts(mood, pool, limit) {
  if (!mood) return { items: [], matchedTags: [], counts: {} };
  return pickByRule(mood, pool, { limit });
}

/**
 * 情绪结果页那行说明：前半句来自配置，后半句是**实际筛出的命中标签**。
 * 命中为空时退到情绪自己的 note——仍然不是视图里硬编码的句子。
 */
export function moodLine(mood, matchedTags) {
  const m = mood || {};
  const hits = (Array.isArray(matchedTags) ? matchedTags : []).slice(0, 4);
  const lead = String(m.pickLead || '为这种心情挑的：');
  if (hits.length) return `${lead}${hits.join(' · ')}`;
  return String(m.note || lead);
}

/** 某个规则能在池子里取到多少件（首页计数用，不看 limit） */
export function ruleCount(rule, pool) {
  const cats = Array.isArray(rule && rule.cats) ? rule.cats.map(String) : [];
  const list = Array.isArray(pool) ? pool : [];
  return list.filter((p) => p && cats.includes(String(p.categoryId || ''))).length;
}
