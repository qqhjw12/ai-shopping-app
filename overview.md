# 商品对比擂台 + AI 搭配师 — 交付总览

> **本步范围**：新增「商品对比」与「AI 搭配」两个决策辅助功能。
> **明确不动**：AI 盲盒（`web/js/blindbox.js` 仅 1 处 `comparable: false`）、积分/签到/任务三件套
> （`web/js/store/pointsConfig.js` / `pointsStore.js` / `web/js/points.js` / `web/js/store/pointsSpend.js` 全部零改动，有断言守着）。
> **设计语言**：沿用 Deep Space Command 深空令牌，未引入任何新色系。

---

## 一、架构决策

| # | 决策 | 一句话理由 |
|---|---|---|
| 1 | 规则与实现彻底分离：`compareConfig.js` / `outfitConfig.js` 只放常量，`compareStore.js` / `outfitStore.js` 只放纯函数 | 视图层只负责画，Node 侧可直接 `import` 断言，无需 DOM |
| 2 | 对比按钮通过 `setCompareSlot(fn)` **注册插槽**注入 `ui.js` | `ui.js ⇄ compare.js` 若互相静态 import 会形成 ESM 循环依赖，插槽把依赖方向拧成单向 |
| 3 | `compare.js` / `outfit.js` 用**动态 `await import('./views.js')`** 取 `getProducts()` / `doAdd()` | 同上，避开 `views.js → compare.js → views.js` 的环 |
| 4 | 「最优项」用 `box-shadow: inset 0 0 0 1px` 而非真实 `border` | `table-layout: fixed` 下表加真实边框会撑动列宽，隔壁列跟着跳 |
| 5 | AI 推荐指数只吃商品自身字段，不做「组内归一化」 | 否则加/减一件商品会让已经看到的分数漂移，用户会以为数据在乱跳 |
| 6 | 搭配理由「先枚举所有真实成立的关系，再哈希挑一条」 | 原写法是「首个命中优先级」，实测 210 条抽样里 100% 落到「价位互补」，模板再多也没用 |

---

## 二、文件清单

### 新增（7 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/js/store/compareConfig.js` | 104 | 对比擂台唯一规则源：上限 4、维度表、属性组映射、AI 权重、旧类目别名 |
| `web/js/store/compareStore.js` | 336 | 对比列表仓储（按 `scopeId()` 隔离）+ 维度/最优/差异/AI 指数纯函数 |
| `web/js/store/outfitConfig.js` | 93 | AI 搭配唯一规则源：25 个一级类目全覆盖的搭配策略 + 7 条理由模板 |
| `web/js/store/outfitStore.js` | 218 | 搭配挑选、理由判定、套装价、单件替换、购物袋载荷 |
| `web/js/compare.js` | 276 | 加入/移出开关、全局悬浮条、`#/compare` 页面 |
| `web/js/outfit.js` | 155 | 详情页 AI 搭配面板（默认收起，点击才算） |
| `scripts/e2e-compare.mjs` | 367 | 31 条浏览器验收断言 |

### 改动（8 个）

| 文件 | 改动 |
|---|---|
| `web/js/ui.js` | +17：`setCompareSlot()` 注册插槽；`productCard()` 新增 `comparable` 选项 |
| `web/js/views.js` | +6：PDP 次要操作区插入 `compareToggle`、服务卡后插入 `outfitPanel(p)` |
| `web/js/app.js` | +12：路由 `#/compare`、`setActiveNav` 归到 products、`has-pdp-bar` 类、启动期装配插槽与悬浮条 |
| `web/js/blindbox.js` | **+2 仅限**：结果卡 `comparable: false`（本步不动盲盒） |
| `web/index.html` | +1：页脚「服务」列加「对比擂台」入口 |
| `web/styles.css` | +543（12817 → 13360）：100 条 `.cmp-*` / `.ot-*` 规则 |
| `scripts/check-web.mjs` | +260（3433 → 3693）：23 条对比/搭配断言，模块数 71 → **77** |
| `README.md` | +2：命令清单补 `e2e-compare`，断言计数更新 |

---

## 三、关键代码

### 1. 最优项：全员相同则不标

```js
export function bestIndexes(dim, products) {
  if (!dim || !dim.better || !Array.isArray(products) || products.length < 2) return [];
  const values = products.map((p) => Number(dim.read(p)));
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length < 2) return [];
  const target = dim.better === 'lower' ? Math.min(...valid) : Math.max(...valid);
  const out = [];
  values.forEach((v, i) => { if (Number.isFinite(v) && v === target) out.push(i); });
  return out.length === values.length ? [] : out; // 全体相同 → 没有「最优」
}
```

### 2. AI 推荐指数（只吃自身字段，不随对比对象漂移）

```js
export function aiIndex(p) {
  const r = clamp(num(p && p.rating), 0, AI_INDEX_CAPS.rating) / AI_INDEX_CAPS.rating;
  const s = clamp(num(p && p.sales), 0, AI_INDEX_CAPS.sales) / AI_INDEX_CAPS.sales;
  const v = clamp(reviewsOf(p), 0, AI_INDEX_CAPS.reviews) / AI_INDEX_CAPS.reviews;
  return Math.round(clamp(AI_INDEX_WEIGHTS.rating * r + AI_INDEX_WEIGHTS.sales * s
    + AI_INDEX_WEIGHTS.reviews * v, 0, 1) * 100);
}
// 权重 0.6 / 0.25 / 0.15，和为 1（有断言）
```

### 3. 旧类目兼容：三代兜底

演示商品用的是上一代 16 类目体系（`phone` / `home` / `apparel`…），不在现行 25 个一级分类树内，
不兜底的话搭配策略会永远走默认分支：

```js
export function l1Of(p) {
  const chain = getAncestors(p.categoryId);                       // ① 现行分类树祖先
  if (chain.length) return chain[chain.length - 1].id;
  if (p.categoryId && LEGACY_L1_ALIAS[p.categoryId]) return LEGACY_L1_ALIAS[p.categoryId]; // ② 别名表
  const hit = CATEGORY_TREE.find((n) => n.name === String(p.category || '').trim());        // ③ 类目名
  return hit ? hit.id : null;
}
```

### 4. 搭配理由：先枚举真实关系，再确定性挑一条

```js
export function reasonCandidates(product, mate, strategy = strategyFor(product)) {
  const out = [];
  const c1 = colorFamilyOf(product); const c2 = colorFamilyOf(mate);
  if (c1 && c2 && c1.id === c2.id) out.push(say('same-color', { color: c1.name }));
  if (product && mate && product.brand && product.brand === mate.brand) out.push(say('same-brand'));
  if (mainPrice > 0 && matePrice > 0) {
    const diff = Math.round((Math.abs(mainPrice - matePrice) / Math.max(mainPrice, matePrice)) * 100);
    if (diff <= 30) out.push(say('near-price', { diff })); else out.push(say('price-ladder'));
  }
  if (l1Of(mate) !== l1Of(product)) out.push(say('category-pair'));
  if (stockOf(product) > 0 && stockOf(mate) > 0) out.push(say('ready-stock'));
  out.push(say('same-scene'));           // 策略里的场景描述永远成立
  return out;
}
// pickReason 用 hash(productId:mateId:r) 挑；reasonList 传 avoid Set，同一套装内不复用句式
```

### 5. 对比页三态首屏（修掉的真实缺陷）

`paint()` 是同步的，`getProducts()` 是异步的。原写法在池未到时就判定「商品已不在库中」，
用户会看到一帧假错误：

```js
const paint = () => {
  if (!st.ids.length) { /* 空态 */ return; }
  if (!poolReady)   { stage.appendChild(el('p', { class: 'cmp-hint', id: 'cmp-loading' }, COPY.loading)); return; }
  if (poolFailed)   { stage.appendChild(el('p', { class: 'cmp-hint cmp-hint-warn', id: 'cmp-load-failed' }, COPY.loadFailed)); return; }
  /* 真正渲染表格 */
};
loadPool().then((list) => { pool = list; poolReady = true; if (page.isConnected) paint(); })
          .catch(() => { poolFailed = true; poolReady = true; if (page.isConnected) paint(); });
```

### 6. 最优项样式：1px 青线用 inset 阴影画

```css
.cmp-val.is-best {
  background: var(--color-cyan-dim);
  box-shadow: inset 0 0 0 1px var(--color-cyan-line);
  color: var(--color-cyan);
}
```

### 7. 移动端：表格换横向滚动卡片 + 悬浮条让位

```css
@media (max-width: 860px) {
  .cmp-table { display: none; }
  .cmp-card  { flex: 0 0 248px; width: 248px; }         /* 固定宽度，不挤压变形 */
}
body.has-pdp-bar .cmp-dock { bottom: calc(80px + env(safe-area-inset-bottom)); }  /* 不遮吸底栏 */
body.has-pdp-bar .pdp-page { padding-bottom: calc(146px + env(safe-area-inset-bottom)); }
```

---

## 四、访问路径

| 入口 | 路径 |
|---|---|
| 列表页加对比 | `#/products` → 商品卡「加入对比」 |
| 详情页加对比 | `#/product/<id>` → 次要操作区「加入对比」（主操作区移动端隐藏，故放次要区） |
| 对比页 | `#/compare`（页脚「服务 → 对比擂台」也可进） |
| AI 搭配 | `#/product/<id>` → 服务卡下方「AI 搭配」入口，点击展开 |

---

## 五、验收自检（逐项）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 可加入对比 | ✅ | 列表卡 / 详情页双入口可加；重复加去重、超 4 个 toast 提示「先移除一个」、存储失败单独文案 |
| 可查看对比 | ✅ | 悬浮条显示「已选 N 件」+「去对比」；`#/compare` 并列展示价格/评分/销量/库存/核心属性/售后/AI 指数 |
| 高亮最优项 | ✅ | 价格取最小、评分/销量/库存取最大；全员相同**不标**；青色细线 + 浅青底，无红绿 |
| 只看差异项 | ✅ | `.is-diff-only` 下 `[data-diff="0"]` 整行隐藏；差异判定按原始值而非格式化文本 |
| 移除单个 / 清空 | ✅ | 表格与卡片两种视图都能移除；清空后回空态并隐藏悬浮条 |
| 刷新不丢、最多 4 个 | ✅ | key `maison_compare_v1::<scopeId()>`；`addId` 硬上限 4；登录/匿名各自独立 |
| AI 搭配按分类合理 | ✅ | 25 个一级类目全部有策略（有断言 `missing === 0`）；服饰搭鞋包配饰、数码搭配件、家居搭软装 |
| 可单个替换 | ✅ | 「换一件」走 `replaceMate()`，排除已用与主商品；无候选时按钮置灰而不是空转 |
| 整套加购 | ✅ | 「一键加购套装」逐件按主商品来源 `doAdd()`，数量 = 1+N |
| 移动端横向滚动 | ✅ | 实测卡片宽 248px、容器横滚、表格已隐藏 |
| 控制台无错误 | ✅ | `e2e-compare` 全程监听 `pageerror` / `console.error`，0 条 |

**命令实跑**：

```text
node scripts/check-web.mjs      → 77 个 ESM 真实 import + 23 条对比/搭配断言，✓ 前端自检通过
node scripts/e2e-compare.mjs    → 31/31，✓ 商品对比 / AI 搭配验收全部通过
```

---

## 六、独立证伪核验抓到并修掉的问题

既有断言全绿 ≠ 覆盖充分，另写 26 项一次性核验（用完即删）。其中 **1 项真实产品缺陷 + 3 项我自己的判定口径写错**：

| 类型 | 问题 | 处理 |
|---|---|---|
| **产品缺陷** | 对比页首屏闪一帧「所选商品已不在当前商品库中」 | `renderCompare` 加 `poolReady` / `poolFailed` 三态；补一条持久 e2e 断言（route 延迟 `/api/products` 后抓首屏 DOM） |
| 核验脚本误报 | B3 把「两件价格相同」当成应标两个最优项 | 产品设计是「全员相同不标」，回源码确认无误，只改脚本为 `[100,100,200,300]` 应标 0,1 |
| 核验脚本误报 | `globalThis.navigator` 只读，赋不上 | 改 `Object.defineProperty(..., { configurable: true, writable: true })` |
| 核验脚本误报 | `check-web` 三条断言自己写错（只扫前 200 条商品 / 非串行吃初始 state / 池里其实有替代品） | 逐一改成全量扫描、串行、`replaceMate([main], …)` |

顺手做掉的两个体验改进：

- **搭配理由句式分布**：修前 210 条抽样 100% 是「价位互补」；修后 `ready-stock 99 / price-ladder 70 / near-price 15 / same-scene 15 / category-pair 11`。
- **演示商品无 `attributes`**：原会硬套属性组，对比页出现整行「—」；改为「真有 attributes 才归组」，否则回落「分类 / 品牌」。

---

## 七、已知限制

1. **对比维度不跨类目自适应**：核心属性按「主商品所属属性组」取，混类目对比（如耳机 vs 连衣裙）时非同类商品该行显示「—」，不会强行对齐出伪维度。
2. **搭配是规则驱动，不是模型驱动**：`OUTFIT_STRATEGY_BY_L1` 是手写映射，新加一级类目必须同步补一条，否则走默认策略（现有 25 条已全覆盖，且 `check-web` 守着）。
3. **套装折扣固定 95 折**：配置里单一常量，不支持按类目差异化或阶梯满减。
4. **对比列表上限硬编码 4**：来自需求，`COMPARE_MAX` 可改但 UI 文案（「最多 4 件」）是独立字符串，改常量时要一起改。
5. **`e2e-ai-panel` 的历史断言缺陷未修**：该脚本「关闭按钮热区 ≥44px」实测 43.9998px（面板动画未完全收敛，`matrix(0.999995,…)` 把 44px 压了 0.0002px）。产品本身合规，属上一轮步骤范围，按「不改范围外」本轮不动。

---

## 八、全量回归

31 套 e2e 串行实跑结果见提交说明与后续记录；本步新增 `e2e-compare` 已确认 31/31。
