# 场景化 / 情绪化 / 节日化购物入口 — 交付总览

> **本步范围**：首页新增三块「今天为什么来逛」的入口 —— ①「今天想逛什么」8 个场景卡、
> ②「按心情挑」6 个情绪胶囊、③「今日主题」节日/时令横幅；点击分别进入
> `#/scene/:id`、`#/mood/:id`、`#/theme/:id` 三个结果页。
> **明确不动**：虚拟展厅与 AR 试穿（`showroom*.js` / `pdpTryOn.js` / `arTryOn.js`）——
> 源码零改动，两侧都有断言守着。
> **设计语言**：沿用 Deep Space Command 深空令牌，未引入任何新色系、未新增任何假商品、
> 未引入任何第三方库。

---

## 一、架构决策

| # | 决策 | 一句话理由 |
|---|---|---|
| 1 | 配置、取货规则、渲染**三层三文件**：`sceneConfig/themeConfig`（零依赖纯常量）→ `sceneStore/themeStore`（纯函数 + 一层 localStorage）→ `homeEntries/scenes`（只画） | 规格要求「不写死在组件」；分层后同一套规则既能被 Node 直接断言，也能被首页/结果页/横幅三处复用 |
| 2 | `sceneConfig.js` / `themeConfig.js` **一行 import 都没有** | 上一轮踩过：配置层一旦引到 `couponStore → api.js → auth.js`，Node 里读 `location` 直接崩。券目录由视图层传入，配置只存 `couponId` |
| 3 | 主题券**只写 `couponId`，不写面额** | 面额是券域的事实，抄一份就必然有一天和券中心对不上；主题页复用 `catalogCoupon/claimCoupon/listWallet` |
| 4 | 场景/情绪/主题**共用一套取货函数** `pickByRule(rule, pool, {limit})` | 三套入口的差别只在「类目集合 + 关键词」，规则实现没必要写三遍 |
| 5 | 取货**按类目分桶 + 配额轮流取**（quota = ⌈limit ÷ 类目数⌉），取不满时第二轮放开配额 | 本站商品池里图书 1431 件、食品 913 件，纯按相关度排会被这两个类目吃掉整页；轮流取才是真·跨分类组合 |
| 6 | 销量只做**微弱加权**（log10 压缩后封顶 6 分，一次关键词命中值 10 分） | 销量是「别人买过」的证据，不是「适合这个场景」的证据；不能让低相关的高销商品顶到第一屏 |
| 7 | 节日窗口用 `MM-DD` + **支持跨年**（`start > end` 时判定改成「或」） | 「12-27 ~ 02-28」这种窗口用 `YYYY-MM-DD` 写死就只能演示一年；`MM-DD` 让六段窗口首尾相接覆盖全年 |
| 8 | 「今天是哪个主题」是**纯函数** `themeAt(date)`，演示日期只是喂进去的另一个参数 | 真实今天自动落当期；`setMockDate('2026-12-20')` 立刻变圣诞——同一套函数，不是两套逻辑 |
| 9 | 演示日期按 `scopeId()` 分桶存 localStorage | 它是个人演示偏好，换账号不该串；脏值一律收敛为「今天」 |
| 10 | 首页横幅与主题页头图都读 `currentTheme()` | 两处永远同一个主题；切了演示日期之后首页横幅必须同步变，否则用户会以为没生效 |
| 11 | 情绪页那行说明由 `moodLine(mood, matchedTags)` **用筛出来的命中标签拼** | 规格明令「不写死文案」；拼出来的句子会随商品池变化，也能反过来验证筛选是否生效 |
| 12 | 首页只放 6–8 个场景（`SCENE_HOME_LIMIT = 8`），横向原生轨道 + `scroll-snap` | 8 个场景一次铺开会挤成两行半；轨道天然可横滑，且没有定时器、没有程序化滚动 |
| 13 | 氛围图**程序化 SVG 现画**（`sceneArt.js`），确定性、零外链 | 离线/图床抖动时不会一片破图；同一 id 永远同一张图，截图与断言都稳定 |
| 14 | `homeEntries.js` 故意**不 import `views.js`** | `views.js` 要 import 它来占位，反向引用就是循环依赖 |

---

## 二、文件清单

### 新增（7 个前端模块 + 1 个验收脚本）

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/js/store/sceneConfig.js` | 254 | 8 个场景 + 6 个情绪的唯一规则源：id / 名称 / 眉题 / 描述 / 场景文案 / 色调 / 类目映射 / 关键词 / 上限常量 / 文案表 |
| `web/js/store/themeConfig.js` | 190 | 6 个节日时令主题：`MM-DD` 窗口、类目与关键词、`couponId`、关联场景、演示日期预设 |
| `web/js/store/sceneStore.js` | 162 | `scoreProduct` / `pickByRule`（分桶轮流取）/ `pickSceneProducts` / `pickMoodProducts` / `moodLine` / `ruleCount` |
| `web/js/store/themeStore.js` | 121 | `dateStr`（本地时区）/ `mdOf` / `inWindow`（跨年）/ `themeAt` / 演示日期读写 / `currentTheme` / `pickThemeProducts` |
| `web/js/sceneArt.js` | 95 | 确定性氛围图 SVG：三档尺寸（card 900×1180 / hero 1400×720 / banner 900×560），渐变底 + 同色相光斑 + 景深细光线 |
| `web/js/homeEntries.js` | 154 | 首页三块入口（场景轨道 / 情绪胶囊 / 主题横幅），纯静态、不发请求 |
| `web/js/scenes.js` | 374 | 三个结果页：场景页、情绪结果页（含页内换心情）、主题页（主题券 + 商品池 + 场景入口 + 演示日期切换） |
| `scripts/e2e-scene-mood-theme.mjs` | 237 | 36 条浏览器断言，覆盖规格「七、验收」全部条款 |

### 改动（3 个）

| 文件 | 改动 | 说明 |
|---|---|---|
| `web/js/views.js` | +4 | `import { homeEntryBlock }`；首页在功能模块之后 `panel.appendChild(homeEntryBlock())` |
| `web/js/app.js` | +14 | 四条路由（`/scene/:id`、`/mood/:id`、`/theme`、`/theme/:id`）+ 导航归桶（三路径都归 `products`） |
| `web/styles.css` | +484 | `.sc-*` / `.md-*` / `.td-*` 三段样式：卡片、轨道、胶囊、横幅、主题券、演示日期按钮，含 1024/820 两档断点与降级块 |
| `scripts/check-web.mjs` | +约 250 | 新增「场景 / 情绪 / 节日主题」断言块 15 条 |

---

## 三、核心实现要点

### 1. 配置三段式（`配置 → 规则 → 视图`）

```
sceneConfig.js   ← 只读常量，零 import
themeConfig.js   ← 只读常量，零 import（券只存 id）
      ↓
sceneStore.js    ← 纯函数：相关度打分 + 分桶轮流取货
themeStore.js    ← 纯函数：MM-DD 窗口判定 + 演示日期（唯一碰 localStorage 的地方）
      ↓
homeEntries.js / scenes.js  ← 只负责画；券目录由它们从 couponStore 取出来传下去
```

### 2. 取货规则（`pickByRule`）

```
1) 只保留 categoryId ∈ rule.cats 的商品        ← 「场景结果必须与商品库相关」的边界
2) 每个类目内：相关度 ↓ → 销量 ↓ → id ↑        ← 全程确定性，刷新不重排
3) 配额 = ⌈limit ÷ 类目数⌉，各类目轮流取一件    ← 跨分类组合，不被大类别吃满
4) 第二轮放开配额，把 limit 补满               ← 有空类目时不拖累总数
```

相关度：`hits×10 + (hits ? 6 : 0) + min(6, log10(sales+1)×2) + (rating ≥ 4.8 ? 1 : 0)`。

### 3. 日期判定（`themeAt`）

```js
inWindow('01-15', '12-27', '02-28') // true  ← 跨年窗口（start > end 用「或」）
inWindow('06-01', '12-27', '02-28') // false
dateStr(new Date(2026, 0, 1))       // '2026-01-01'（本地时区；toISOString 会掉到 2025-12-31）
```

六个窗口首尾相接：`12-27~02-28` → `03-01~05-15` → `05-16~08-10` → `08-11~09-30` →
`10-01~11-30` → `12-01~12-26` → 回到 `12-27`，**2026 全年 365 天 0 空天**。

### 4. 三个结果页

| 路由 | 顶部 | 主体 |
|---|---|---|
| `#/scene/:id` | 氛围图 hero + 场景文案 `scene.line` + 读数（件数 / 类目数 / 来源） | 商品网格，卡片带加购 / 收藏 / 加入对比 |
| `#/mood/:id` | 氛围图 hero + `moodLine()` 拼出的一行说明 + 页内胶囊（可直接换心情） | 商品网格 |
| `#/theme/:id` | 氛围图 hero + 主题文案 + 窗口 | 主题券（与券中心同一张）→ 主题商品池 → 主题场景入口 → 演示日期切换 |

---

## 四、验收自检（对应规格「七、验收」）

| 验收条款 | 结果 | 证据 |
|---|---|---|
| 首页有「今天想逛什么」 | ✅ | 8 张场景卡一条横向轨道，卡片 `height:320px`、圆角 16px、底部渐变 |
| 首页有情绪标签 | ✅ | 6 个胶囊（治愈/元气/松弛/专注/浪漫/酷感），`min-height:44px` |
| 首页有节日主题横幅 | ✅ | `--color-surface-2` + 1px 细线，左衬线标题 + 窗口/券/演示三枚 chip，右氛围图 |
| 场景页可访问、商品来自真实数据 | ✅ | e2e 把 DOM 上 `data-compare-id` 全部回查 `getProducts()`，8 场景 × 24 件全部命中，每个场景 4–5 个类目 |
| 情绪结果页可访问、说明不写死 | ✅ | `moodLine` 用实际命中标签拼（示例：`为这种心情挑的：冲调 · 宠物 · 修护 · 保湿`） |
| 主题页可访问 | ✅ | 主题券 `data-coupon` 与 `currentCatalog()` 同源校验通过，领券后进券包 |
| 配置可切换当前主题 | ✅ | 演示日期切到 `2026-12-20` → 圣诞礼物；恢复今天 → 回到秋日暖居；**首页横幅同步变**（同源 `currentTheme()`） |
| 移动端横向滚动不溢出 | ✅ | 390px 下 `scrollWidth - clientWidth === 0`，轨道自身可横滑 |
| 热区达标 | ✅ | 胶囊 44px、演示日期按钮 44px、卡片整块可点 |
| 控制台无错误 | ✅ | e2e 全流程 0 个 JS 错误（仅静态站既有的 `/api/*` 404 噪音已按既有口径过滤） |
| 不新增假商品 | ✅ | 无任何商品字面量，全部 `pickByRule` 从 `getProducts()` 筛 |
| 不改展厅 / AR | ✅ | 两侧源码零互引，`check-web` 有断言守着 |

### 构建期断言（`node scripts/check-web.mjs`）

```
检查 97 个前端模块（真实 import，非仅语法解析）   ← 上一步 90 → 本步 97
...
  ok   虚拟展厅与 AR 试穿（14 条）
  ok   场景 / 情绪 / 节日主题（15 条）
✓ 前端自检通过
```

### 浏览器断言（`node scripts/e2e-scene-mood-theme.mjs`）

```
✓ 场景 / 情绪 / 主题验收全部通过      ← 36/36
```

---

## 五、已知限制

1. **节日主题是 mock 的时令日历，不是真实农历/公历节假日表**。六个窗口覆盖全年是为了「每天都有理由」，
   不追求与真实节日日期完全对齐（春节、中秋每年浮动，需要接日历服务）。
2. **演示日期只影响主题，不影响商品库存/价格**。它是「看看另一天的首页长什么样」的开关，
   不做历史回放。
3. **情绪 → 商品的映射靠关键词包含匹配**，商品文案里没写「治愈」这类词就不会命中；
   补词表比补算法划算，词表集中在 `sceneConfig.MOODS[].tags` 一处。
4. **首页场景卡固定取前 8 个**（`SCENE_HOME_LIMIT`）。第 9 个以后的场景目前没有入口，
   要加就得改常量并决定是继续横滑还是换「全部场景」页。
5. **氛围图是程序化 SVG**，风格统一但不等于摄影图。接真实图床时把 `sceneArt()` 换成
   `<img>` 即可，尺寸契约（900×1180 / 1400×720 / 900×560）已经定好。

---

## 六、访问路径与命令

```bash
# 自检
node scripts/check-web.mjs                 # 97 模块 + 全量断言（含本步 15 条）
node scripts/e2e-scene-mood-theme.mjs      # 36 条浏览器验收（自带静态服 + 本机 Edge）

# 手动看
python -m http.server 8080 --directory .   # 或任意静态服
#   http://127.0.0.1:8080/index.html#/            首页三块入口
#   http://127.0.0.1:8080/index.html#/scene/camping
#   http://127.0.0.1:8080/index.html#/mood/focus
#   http://127.0.0.1:8080/index.html#/theme        当期主题（含演示日期切换）
```
