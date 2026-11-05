# 积分步骤验收复核（实跑构建 + 独立证伪式全量核验）

> 本轮范围：**只复核并修复「积分 / 每日签到 / 任务中心」步骤内的问题，不改范围外页面**。
> 基线：`node scripts/check-web.mjs` → 66 个 ESM 真实 import 通过、积分底座 12 条断言全绿；
> `node scripts/e2e-points.mjs` → 31/31 全绿。但「全绿」不等于覆盖充分，另写 45 项独立核验
> （A 签到 / B 等级 / C 任务周期 / D 数据模型与隔离 / E 源码纪律）逐条证伪，不接受既有断言自证。

## 未通过项、原因与修复方案

| # | 未通过项 | 性质 | 原因 | 修复方案 | 结果 |
|---|---|---|---|---|---|
| 1 | `applyBehavior('constructor')` 抛 `TypeError: ids.forEach is not a function` | 真实缺陷（数据层） | `BEHAVIOR_TASKS` 是普通 `{}`，直接索引 `constructor` / `toString` / `__proto__` 会取到原型上的函数或对象；`recordBehavior` 有 `hasOwnProperty` 保护，但导出的纯函数 `applyBehavior` 没有 | 抽 `behaviorTaskIds()`：`hasOwnProperty` + `Array.isArray` 双保险，两层入口共用 | ✅ 已修 |
| 2 | AI 空回复仍被计为「完成 1 次 AI 对话」 | 真实缺陷（假进度） | `assistant.streamRun()` 在 `if (!wrap) typing.remove()`（注释即「流结束但无内容」）之后无条件埋点；「没抛异常」被当成「完成对话」 | 改为 `if (!wrap) { 移除 typing } else { recordBehavior('ai_chat') }`，埋点锚到有真实回复内容 | ✅ 已修 |
| 3 | 个人中心没有等级进度条 | 真实缺陷（规格未达标） | `renderPointsEntry()` 算出了 `levelProgress()` 却只用于文案，未渲染 1px 青色细线 | 抽 `levelTrack(lp)` 共用组件，独立页与个人中心都渲染 | ✅ 已修 |
| 4 | 个人中心没有最近 7 天签到日历 | 真实缺陷（规格未达标） | 精简卡只有积分、等级文字与签到按钮，缺日历状态 | 抽 `calendarRow(st, today)` 共用组件；已签青色实心点 / 未签细线空心点 | ✅ 已修 |
| 5 | 验收断言覆盖不足（假阴性风险） | 覆盖缺口 | 原 12 条只测 7 天签到序列、5 个等级阈值、daily + once 重置（且 once 那条断言本身是弱断言：任务本来就是「进行中」）；未覆盖 30 天里程碑（第 21 天不叠加）、跨年断签、13 个阈值边界、weekly 跨周、原型链白名单、读盘容错、`LEDGER_MAX` 截断、个人中心入口、移动端领取按钮实测热区、`reduced-fx` 实测 | `check-web.mjs` 12 → **22 条**，`e2e-points.mjs` 31 → **37 条**，把上述全部固化为持久断言 | ✅ 已补 |

> 核验脚本自身的 1 项误报：E8 用宽泛正则 `!/catch[\s\S]{0,400}recordBehavior/` 把无关代码块里的 `catch`
> 误判成「埋点在失败分支」。回源码确认评价埋点在 `publishReviewApi` 成功之后、浏览埋点在 `recordVisit(p)`
> 之后、下单埋点只在 `finish()` 成功收尾，产品无误；该断言已改为锚定「成功动作 → 埋点」相邻片段的精确匹配。

## 修复后验收结果表（按本步骤验收清单逐项）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 每日签到可签 / 连续签到有加成 / 断签重置 | ✅ | 独立核验 30 天序列 `10/10/30/10/10/30/60…` 与硬编码期望完全一致；第 21 天只发 7 天档 +50、不叠加 3 天档；跨年 12-31 → 01-01 续接第 3 天 +30，隔 3 天断签重置第 1 天 +10；同日重复拦截 |
| 任务进度由真实行为驱动，领取后积分入账并写流水 | ✅ | 浏览按当日不同商品 id 去重、跨天重新可计；收藏/分享走真实 UI，AI 对话/下单/评价走事件入口；空回复不再计入；领取 +5 写 `type='任务'` 流水，重复领取拦截；六处埋点均在真实成功分支 |
| 等级进度随积分变化 | ✅ | 13 个阈值边界全部正确；满级 `ratio=1` 不越界；**真实领取任务**后进度条 `100/200 → 105/200`（50% → 52.5%），不再只靠改 localStorage 验证 |
| 刷新后状态不丢且按用户隔离 | ✅ | 登录 A / 登录 B / 匿名三者分桶；A 的流水 `userId` 只属于 A；刷新前后账户/签到/等级/任务一致；切回恢复 |
| 移动端可用 | ✅ | 单列、无横向滚动；签到按钮与**任务「领取」按钮实测热区均 ≥44×44px**；任务行折行；`reduced-fx` 下积分上浮动效确认为 `animationName: none` |
| 控制台无错误 | ✅ | `e2e-points` 零 JS 错误（过滤外部图与 `/api` 噪音） |
| 禁止项（弹窗 / 无限循环 / 规则写死 / 共享积分） | ✅ | 无 dialog/alert；300ms 一次性上浮；规则全在 `pointsConfig.js`；按 `scopeId()` 分桶 |
| 个人中心与积分页显示等级进度条 + 7 天日历 | ✅ | 新增浏览器断言：个人中心 `trackH=1px`、`fillColor=rgb(34,211,238)`、7 天 / 7 点；入口签到 +10 并重绘进度条；匿名可直接访问 `#/points` |

实跑复核：`node scripts/check-web.mjs` → **66 模块真实 import + 22 条积分断言全过**，`✓ 前端自检通过`；
`node scripts/e2e-points.mjs` → **37/37 全过**；独立核验 45 项 → **全部通过**。

### 全量回归（30 套 e2e 串行实跑）

**27 套通过**，3 套失败均非本次改动引入：

- `e2e-merchant-apply`：网关未启动（`fetch failed`）；按惯例启动独立 8080 网关 + 临时库后补跑 **42/42 通过**，随后停止网关。
- `e2e-discovery`（45/46）与 `e2e-merchant`（26/27）：均只失败「控制台无 JS 错误」一条，原因是 3 张外部商品图 `net::ERR_CONNECTION_CLOSED`（`demo-real-data.js` 本轮未改动），属环境网络噪音，不是 JS 异常。
- 本步改动直接影响的 `e2e-ai-panel`（AI 埋点所在文件）、`e2e-points`（37/37）、`e2e-products`（27/27）、`e2e-home`、`e2e-pdp` 全部通过，**零新增回归**。

## 改动文件列表（本轮复核）

| 文件 | 改动 |
|---|---|
| `web/js/store/pointsStore.js` | +15 行：`behaviorTaskIds()` 白名单双保险，`applyBehavior` / `recordBehavior` 两层入口共用 |
| `web/js/assistant.js` | 埋点由「try 末尾无条件」改为 `if (!wrap) … else { recordBehavior('ai_chat') }` |
| `web/js/points.js` | +46 行：抽 `calendarRow()` / `levelTrack()` 共用组件；`signInCard` / `levelCard` / `renderPointsEntry` 复用；个人中心补进度条与日历 |
| `web/styles.css` | +4 行：`.pt-entry-level` / `.pt-entry-cal` 间距，日历热区 44px |
| `scripts/check-web.mjs` | +100 行：积分断言组 12 → 22 条（长序列/跨年/边界/三种周期/原型链/容错/流水截断/入口/埋点分支） |
| `scripts/e2e-points.mjs` | +75 行：31 → 37 条（真实领取驱动进度条、个人中心进度条+日历+联动、匿名访问、移动端领取按钮实测、reduced-fx 实测） |
| `README.md` | 更新 `e2e-points`（37 断言）与 `check-web`（22 条积分断言）说明 |
| `overview.md` | 本复核章节 |
| `.workbuddy/memory/2026-11-05.md` | 第 19 轮经验 31–34（被 `.gitignore` 忽略，不入版本控制） |

## 遗留问题

- **范围外、按用户约束未修**：`check-web.mjs` 全部 15 个断言组都包在 `if (failed === 0)` 内（全局既有约定，前置失败会跳过后续组）；仓库无 mega menu / 总览页、四页仍读旧演示商品源、商品卡二级分类标签未改；外部商品图 `ERR_CONNECTION_CLOSED` 网络噪音。
- **本步骤已知限制**：积分目前只做「赚取 + 流水」，兑换 / 下单消费未接（`LEDGER_TYPES` 已预留）；任务周期按本地日期未与服务端校准；无跨标签实时同步（刷新可见）；数据仅在本机 localStorage。
- **体验口径（非规格未通过）**：签到按钮文案固定 `签到 +10`，连续签到当天实际到账 +30 / +60 时按钮不预告加成；分享按「用户发起分享」计数，与既有 `trackEvent({event:'share'})` 同口径，剪贴板降级不影响计数。
- 验收脚本中「AI 对话 / 下单 / 评价」三条链路仍用数据层事件入口直调验证累加与领取，真实触发点由 `check-web` 源码断言覆盖，避免 e2e 依赖登录态、网关与表单提交。

---

# 积分 / 每日签到 / 任务中心（奖励底座）— 交付总览

> 本步范围：**新增奖励底座，不改商品数据、不改已有业务逻辑**。
> 六个真实行为点各加 1 行埋点调用（纯接线，业务分支零改动）；规则全部抽到配置，按 `scopeId()` 分桶存 localStorage。
> 架构决策：纯函数数据层 + 配置层 + 视图层三层；积分页 `#/points` 对匿名开放（未登录用持久匿名 id），
> 个人中心放精简签到卡；实时方案用「订阅通知 + 刷新持久化」，不引入轮询 / WebSocket；
> 错误在边界处兜底（localStorage 读写 try/catch、未知行为白名单），不向用户抛堆栈。

## 交付内容 / 改动文件列表

| 文件 | 类型 | 说明 |
|---|---|---|
| `web/js/store/pointsConfig.js` | 新增 | 签到规则、连续加成、5 档等级、6 个任务、4 类流水、周期与文案全部配置化 |
| `web/js/store/pointsStore.js` | 新增 | 纯函数规则（签到/断签/等级/任务/去重/周期重置）+ 按用户隔离的 localStorage 仓储 + 通知订阅 |
| `web/js/points.js` | 新增 | `#/points` 完整页 + 个人中心精简签到卡 + 300ms 上浮 + 轻量 toast |
| `web/styles.css` | 修改 | 追加 `.pt-*` 样式（surface-1 面板 / 1px 细线 / 16px 圆角 / 等宽青色数字 / 1px 等级线 / 移动端单列 / reduced-fx 降级） |
| `web/js/app.js` | 修改 | import `renderPoints` + `#/points` 路由分支 + 顶栏 account 高亮映射 |
| `web/js/accountCenter.js` | 修改 | 个人中心插入 `renderPointsEntry()` 一行 |
| `web/index.html` | 修改 | footer「服务」列加 `#/points` 链接 |
| `web/js/views.js` | 修改 | 3 行埋点：浏览 / 评价 / 分享 |
| `web/js/store/favoriteStore.js` | 修改 | 1 行埋点：主动收藏成功（silent 服务端并回不计） |
| `web/js/assistant.js` | 修改 | 1 行埋点：流式回复成功结束（三个 tab 统一） |
| `web/js/checkout.js` | 修改 | 1 行埋点：`finish()` 统一收尾，覆盖真网关与本地降级两条下单路径 |
| `scripts/e2e-points.mjs` | 新增 | 31 条浏览器验收 |
| `scripts/check-web.mjs` | 修改 | 追加 12 条确定性断言组 |
| `README.md` | 修改 | e2e 清单补 `e2e-points`，构建模块数 63 → 66 |

## 关键代码

规则全部在配置层，组件只引用（禁止写死）：

```js
// store/pointsConfig.js
export const SIGNIN_RULES = {
  base: 10,
  milestones: [{ every: 7, bonus: 50, label: '连续 7 天' }, { every: 3, bonus: 20, label: '连续 3 天' }],
};
export const LEVELS = [
  { level: 1, name: '新手', min: 0 }, { level: 2, name: '探索者', min: 200 },
  { level: 3, name: '行家', min: 800 }, { level: 4, name: '鉴赏家', min: 2000 },
  { level: 5, name: '收藏家', min: 5000 },
];
```

签到纯函数（同日拦截 / 连续判定 / 断签重置 / 写流水）：

```js
// store/pointsStore.js
export function signIn(state, today = dateKey()) {
  const st = normalizeState(state, state.userId, today);
  if (st.account.lastSignInDate === today) return { state: st, result: { ok: false, reason: 'already' } };
  const streak = st.account.lastSignInDate === offsetDateKey(today, -1)
    ? st.account.signInStreak + 1 : 1;
  const reward = signInReward(streak);
  st.account.signInStreak = streak;
  st.account.lastSignInDate = today;
  addPoints(st, reward.total, LEDGER_TYPES.SIGNIN, `每日签到${reward.label ? ` · ${reward.label}加成` : ''}`, today);
  return { state: st, result: { ok: true, amount: reward.total, streak } };
}
export function storageKey(userId = scopeId()) { return `${STORAGE_PREFIX}${userId}`; }
```

真实行为埋点（每处 1 行，不改业务分支，例：下单成功统一收尾）：

```js
// checkout.js — finish(order)
recordBehavior('order_success');   // 真网关与本地降级两条路径都汇聚于此
```

## 访问路径

- 独立页：`#/points`（积分、签到日历、任务中心、等级进度、流水）
- 个人中心：`#/account`（顶部精简签到卡 + 「积分与任务 →」链接）
- 页脚「服务」列：`#/points`
- 数据源：`web/js/store/pointsConfig.js`、`web/js/store/pointsStore.js`
- 验收命令：`node scripts/check-web.mjs`、`node scripts/e2e-points.mjs`

## 验收清单逐项自检

| 验收项 | 结果 | 实测证据 |
|---|---|---|
| 每日签到可签、连续签到有加成、断签重置 | ✅ | 首签 +10；连续第 3 天 +30（10+20）；第 7 天 +60（10+50）；间隔 3 天断签重置为第 1 天且仅 +10；同日重复拦截 |
| 任务进度由真实行为驱动，可领取后积分入账并写流水 | ✅ | 浏览 3 款不同商品（当日同款去重）、收藏、分享走真实 UI；AI 对话 / 下单 / 评价走事件入口；领取 +5 写 `type='任务'` 流水，按钮变「已领取」，重复领取拦截 |
| 等级进度随积分变化 | ✅ | 累计 500 → Lv2 探索者 / 50% /「还差 300 分」；累计 5000 → Lv5 满进度；进度条 1px 青色细线 |
| 刷新后积分、签到、任务状态不丢且按用户隔离 | ✅ | 刷新前后账户/签到/等级/任务一致；`current_user` 切到另一用户积分归零、签到可再签、任务重置；切回恢复；key = `maison_points_v1::<scopeId()>` |
| 移动端可用 | ✅ | 375×812 单列、签到按钮 ≥44px、无横向滚动 |
| 控制台无错误 | ✅ | e2e-points 零 JS 错误（过滤外部图与 `/api` 噪音） |
| 禁止弹窗 / 无限循环动画 / 规则写死 / 用户共享积分 | ✅ | 无 dialog/alert、300ms 一次性上浮（animationend 移除）、规则全在 config、按用户分桶 |
| 不改商品数据与已有业务逻辑 | ✅ | 6 处各 1 行埋点，`views.js` 商品源与所有业务分支零改动 |

构建：`node scripts/check-web.mjs` → **66 个模块全部真实 import 通过**，新增 12 条积分底座断言全过；
`node scripts/e2e-points.mjs` → **31/31 全过**。

全量回归 30 套 e2e 串行实跑：**28 套通过**（含新增 `e2e-points` 31/31、`e2e-products` 27/27、
`e2e-merchant` 27/27）；`e2e-merchant-apply` 按惯例启动独立 8080 网关 + 临时库补跑 **42/42**；
`e2e-discovery`(45/46) 仅「控制台无 JS 错误」一条因 3 个外部商品图 `ERR_CONNECTION_CLOSED`
失败——`demo-real-data.js` 未改动、本步埋点不在该断言的资源加载路径内，属环境网络噪音，
**零新增回归**。（外部图噪音随网络抖动出现/消失，上一轮 `e2e-merchant` 亦曾因此 26/27。）

## 已知限制

- 任务周期：浏览 / 收藏 / AI 对话 / 分享为每日任务，下单为每周任务，评价为一次性任务；重置按**本地日期**计算，未与服务端时间校准。
- 连续加成按**周期性里程碑**发放（每满 7 天 +50，否则每满 3 天 +20），不是仅第 3 / 第 7 天各一次。
- AI 对话埋点在三个 tab 的流式成功路径统一计一次；演示模式无网关时请求失败，不计进度（符合「真实行为」口径）。
- e2e 中「下单成功 / 评价 / AI 对话」三条链路用数据层事件入口直调验证累加与领取；其真实触发点由 `check-web` 源码断言覆盖，避免验收依赖登录态、网关与表单提交。
- 积分目前只做「赚取 + 流水」，兑换 / 下单消费未接（`LEDGER_TYPES` 已预留「下单」「兑换」）。
- 无跨标签页实时同步（刷新即可见）；数据仅在本机 localStorage，未接服务端。

---

# mock 商品数据层（1100 款，单文件 ESM）— 交付总览

## 验收复核（第 2 轮：实跑构建 + 逐项自检 + 范围内修复）

**实跑构建**：CI 的 `build` job 只是把 `web/` 原样发布为 Pages 产物（无 npm build），
真实构建检查 = `node scripts/check-web.mjs` 递归动态 import 全部前端模块；
本轮实跑 **63 个模块全绿**，商品断言组由 12 条扩到 **16 条全过**；
`node scripts/e2e-products.mjs` 由 23 断言扩到 **27/27 全过**。

### 未通过项、原因与修复方案

| # | 验收项 | 判定 | 实测 / 原因 | 修复方案 | 本步修复 |
|---|---|---|---|---|---|
| 1 | 商品与分类匹配（属性） | ❌ | 属性组由 label 正则 + `digital` 兜底决定，单字正则大面积串组：「项链」命中「线」→ 数码组、「乳品饮料」命中「乳」→ 美妆组、`music` 全 40 款命中「乐器」→「装帧/开本」、女装「套装/T恤」无命中 → 数码组（Pro 版 / 深空灰） | 新增导出 `ATTR_GROUP_BY_L1`（一级主组为默认），`GROUP_OVERRIDES` 只保留完整词的明确跨组例外；硬错配（装帧/开本落在 apparel/digital 主组）归零 | ✅ |
| 2 | 价格合理（细分类目） | ❌ | 整级锁定 `mobile`/`fragrance`/`pet` 让手机配件 1067–6443、乐器配件 2181–6713、箱包配件 721–2864；单字「笔」把 `computer_01`「笔记本」压到 **57 元** | 点名口径改为具体类目词锚定（旗舰手机 / 女士香水 / 猫粮），配件·耗材·小样 19–599 规则后置；电脑整机按「一级 + 完整词」锁 2999–12999；图书规则去单字 | ✅ |
| 3 | 验证覆盖（可靠验证） | ❌ | `check-web`/`e2e` 只测 1 个一级（mobile）与 25 个一级计数，未覆盖全树 1106 节点、25 个一级子孙汇总、属性语义、细分配件价格；此前「23/23 全绿」不构成覆盖证明 | 两侧脚本各补 4 条持久断言：全树计数一致、一级 = Σ 二级、属性主组占比 ≥60% 且无硬错配、配件 19–599 / 整机 ≥2999 | ✅ |
| 4 | 总览页 / mega menu 商品数 | ❌ 范围外 | 仓库不存在这两个组件；本步经确认收敛为「分类页 intro 总览读数」，该读数已是真实 1100 | 后续独立步骤新建组件并接 `getCategoryProductCount()` | ❌ 不修 |
| 5 | 四页切源 / 旧数组 deprecated / 商品卡二级标签 | ❌ 范围外 | 规格第四章与「不改页面 UI 和查询逻辑」冲突，已确认收敛为不切换 | 后续独立步骤切源并标记旧数组 | ❌ 不修 |
| 6 | 无破图（四页外部图） | ❌ 范围外 | 本步数据层 300×400 占位图解码通过；四页仍加载外部演示图，3 个 `ERR_CONNECTION_CLOSED` | 后续把外部图换 data-URI 或过滤资源噪音 | ❌ 不修 |

### 修复后验收结果表

| 验收项 | 结果 | 实测证据 |
|---|---|---|
| 每个二级 ≥4 / 一级 ≥30 / 全站 ≥600 | ✅ | 220 个二级各 **5** 款；25 个一级 35–55 款；**1100** 款且 id 全局唯一 |
| 查一级返回其所有子孙商品 | ✅ | 25 个一级全部 = 各自二级之和（0 不一致）；`mobile` 含子孙 35 / 不含 0；跨一级串类目 0 |
| 总览计数与真实数据一致 | ⚠️ 部分 | 全树 **1106** 个节点 `productCount` === `getCategoryProductCount(id)`；分类页显示「收录 1100 件商品」；mega menu 组件不存在（遗留 #4） |
| 商品与分类匹配 | ✅ | 1100 款 `categoryId` 均为二级/三级、名称含所属分类名；属性主组占比最低 64%（母婴/宠物的洗护、布书等为合理跨组），装帧硬错配 **0** |
| 价格合理 | ✅ | 猫粮 114–274 / 智能手机 4065–7481 / 女士香水 442–1275；手机配件 40–474、乐器配件 136–405、箱包配件 139–572；笔记本 3840–10547；全站 `price>0` 且划线价 > 现价 |
| 无破图 | ✅（数据层） | 3:4 data-URI SVG 浏览器解码 300×400，零外部请求；四页外部图见遗留 #5 |
| 控制台无错误 | ✅（四页 JS） | 首页/分类/甄选/搜索四页零 JS 错误；`discovery`/`merchant` 失败项为外部图资源错误，非 JS 异常 |
| 字段 / 工具函数 / 占位图 | ✅ | 15 字段齐全；4 个查询函数可用（`getProductsByCategory` / `getProductById` / `searchProducts` / `getCategoryProductCount`） |
| 不改页面 UI 与查询逻辑 | ✅ | `views.js` 仍是唯一商品入口 `getProducts()`；分类页 16 张卡 + 拼图结构不变 |

### 改动文件列表（本轮）

| 文件 | 改动 |
|---|---|
| `web/js/store/products.js` | 重构 `NARROW_BANDS` + `bandFor`（新增 `PC_LABEL`）；新增导出 `ATTR_GROUP_BY_L1` + `GROUP_OVERRIDES`，替换 `GROUP_RULES` / `attrGroup` |
| `scripts/check-web.mjs` | +30 行：全树计数、25 个一级汇总、属性语义、细分配件/整机价格 4 条持久断言（12→16 条） |
| `scripts/e2e-products.mjs` | +30 行：浏览器侧同源 4 条断言（23→27 条） |
| `README.md` | 更新 `e2e-products`（27 断言）与 `check-web`（63 模块 / 16 条商品断言）两行说明 |
| `overview.md` | 新增本复核章节 |
| `.workbuddy/memory/2026-11-05.md`（新） | 工作日志：经验 22–25，并明确推翻上一轮「经验 19（整级锁定价格带）」 |

### 全量回归

29 套 e2e 串行实跑：**26 套通过**；`e2e-merchant-apply` 按惯例启动独立 8080 网关 +
临时库补跑 **42/42**；`e2e-discovery`(45/46) 与 `e2e-merchant`(26/27) 仅「控制台无 JS 错误」
一条因 3 个外部商品图 `ERR_CONNECTION_CLOSED` 失败——`demo-real-data.js` 未改动、
本步改动不在该断言加载路径内，**零新增回归**。

### 遗留问题

1. 仓库无 mega menu / 总览页，真实计数目前只有分类页 intro 一个展示点（范围外）。
2. 四页仍读 `views.js` 的 2951 款真实演示商品 + 商家商品；旧数组未 deprecated、商品卡分类标签未改（范围外）。
3. 分类页卡片「N 件」仍是旧商品源的价格区间筛选件数，与目录计数口径不同。
4. 属性为按一级语义对齐的通用模板，未做到每个三级类目的专属 SKU 属性。
5. 四页外部演示图 `ERR_CONNECTION_CLOSED` 环境噪音；`src/data/products.ts` 未采用（零构建 ESM）；
   网关 `/api/categories` 仍 16 一级；68 种 slug 重复（未来做 URL 路由需处理）。
6. 未跟踪的 `shots/` 截图目录未纳入本轮提交。

---

> 本步范围（已与用户确认）：**只补数据层 + 真实计数回填 + 分类页总览读数**；
> 首页 / 分类详情 / 搜索结果 / 甄选页的商品源保持不动，页面 UI 与查询逻辑不变。

## 交付内容

| 文件 | 说明 |
|---|---|
| `web/js/store/products.js`（新） | 确定性运行时生成 1100 款 mock 商品 + 4 个查询函数 + 真实计数回填 |
| `web/js/store/categoryTree.js` | 移除哈希假计数，新增 `setCategoryProductCounts()`，`productCount` 由真实数据回填 |
| `web/js/categories.js` | 总览读数 `introCount` 改读 `getCategoryProductCount()`（一处文本，零结构改动） |
| `scripts/check-web.mjs` | 新增 16 条 mock 商品断言组（首轮 12 条，验收复核补 4 条） |
| `scripts/e2e-products.mjs`（新） | 27 断言（首轮 23 条，复核补 4 条），浏览器真实加载 + 占位图解码 + 分类页计数一致 + 四页零回归 |
| `README.md` | e2e 清单补 `e2e-products` |

## 关键代码（设计令牌沿用深空指挥舱）

商品图统一 3:4 占位，底色 `--color-surface-1 #0F141C`、细线 `--color-cyan-line rgba(34,211,238,.22)`、读数 `--color-text-muted #8B95A3`、信号色 `--color-cyan #22D3EE`，零外部请求：

```js
const PLACEHOLDER_SVG = `<svg ... viewBox="0 0 300 400" width="300" height="400">
<rect width="300" height="400" fill="#0F141C"/>
<rect x="0.5" y="0.5" width="299" height="399" fill="none"
      stroke="rgba(34,211,238,0.22)" stroke-width="1"/> ... </svg>`;
export const PLACEHOLDER_IMAGE = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;
```

商品挂三级优先、名称内嵌所属分类名（保证「美妆里不出手机」）：

```js
const anchors = l2.children.length ? l2.children : [l2];
const anchor = anchors[i % anchors.length];
name: `${brand} ${anchor.name} ${pick(SERIES, seed, 3)}`,  // 内容必含分类名
categoryId: anchor.id,
```

计数真实化——`categoryTree.js` 不再生成假数字，由商品源单向回填：

```js
export function setCategoryProductCounts(directCounts) {
  const apply = (nodes) => nodes.reduce((sum, n) => {
    const childSum = apply(n.children || []);
    n.productCount = (counts.get(n.id) || 0) + childSum;  // 与 includeDescendants 口径一致
    return sum + n.productCount;
  }, 0);
  apply(CATEGORY_TREE);
}
```

分类页唯一接线点（`introCount` 一处文本，卡片「N 件」仍保留价格区间筛选语义）：

```js
introCount.textContent = `${rows.length} 个类目 · 收录 ${getCategoryProductCount()} 件商品...`;
```

## 验收清单逐项自检（首轮，口径不完整）

> 本表为首轮自检结论。第 2 轮实跑构建并逐项复核后发现 3 项本步骤范围内未通过项
> （属性语义串组、细分类目价格失真、验证覆盖缺口），已修复；
> **最终结果以文首「验收复核（第 2 轮）」章节为准**。

| 验收项 | 结果 | 实测 |
|---|---|---|
| 每个二级 ≥4 个商品 | ✅ | 每个二级 **5** 款（220 × 5 = 1100） |
| 每个一级 ≥30 个商品 | ✅ | 35–55 款，全部落在 30–60 |
| 全站 ≥600 | ✅ | **1100** 款，id 全局唯一 |
| 查一级返回所有子孙商品 | ✅ | `mobile` 含子孙 35 / 不含 0；`womenswear_01` = 5 |
| 总览计数与真实数据一致 | ✅ | 25 个一级 `productCount` === `getCategoryProductCount(id)`；分类页显示「收录 1100 件商品」 |
| 商品与分类匹配 / 价格合理 | ⚠️ 首轮判定不完整 | 首轮只验名称与点名三项；复核发现属性串组、细分配件/整机价格失真，已修复 |
| 无破图 | ✅ | 占位图浏览器解码 300×400，零外部请求 |
| 控制台无错误 | ✅ | 首页/分类/甄选/搜索四页零 JS 错误 |
| 不改页面 UI 与查询逻辑 | ✅ | `views.js` 仍是唯一商品入口 `getProducts()`；分类页仍 16 张卡、拼图结构不变 |

构建：`node scripts/check-web.mjs` → 63 个模块全部真实 import 通过，16 条商品断言全过；
CI build job 只是把 `web/` 原样发布（无编译步骤），`store/products.js` 在产物内。

全量回归 29 套：**26 套通过**（含 `e2e-products` 27/27）；`e2e-merchant-apply` 补跑独立 8080 网关 **42/42**；
`e2e-discovery`(45/46) 与 `e2e-merchant`(26/27) 仍仅因 3 个外部商品图 `ERR_CONNECTION_CLOSED`
在「控制台零错误」一条失败——环境网络噪音，`demo-real-data.js` 未改动、零新增回归。

## 已知限制

- 仓库**没有 mega menu / 总览页**：`getCategoryProductCount()` 已提供真实计数，本步以「分类页 intro 总览读数」作为唯一展示点；后续若加 mega menu 直接调用该函数即可。
- 4 个页面仍读原有 2951 款真实演示商品 + 商家上架商品（`views.js` 的 `getProducts()`），本步未替换、未删除旧数组，也未改商品卡分类标签——属用户确认范围内「下一步」。
- 分类页卡片上的「N 件」仍是旧商品源的价格区间筛选件数，与本步新目录计数口径不同（保留既有筛选功能）。
- 商品属性为按类目语义分组的通用模板（颜色/尺码/规格/香型等），未做到每个三级类目的专属 SKU 属性。

---

# 分类树数据层扩充（25 一级，纯数据不改 UI）— 交付总览

## 验收复核与修复（实际运行构建后）

按验收清单逐项独立复核 + 实跑构建，发现并修复 2 项本步骤范围内缺陷，另有 1 项为验收脚本口径误报：

| 发现 | 性质 | 原因 | 修复 |
|---|---|---|---|
| 新增数据层未进入构建检查 | **真缺陷** | `check-web.mjs` 只 `readdirSync` 顶层 `web/js/*.js`（44 个），`store/` 下 16 个模块（含本步骤新增 `categoryTree.js`）从未被真实 import；且分类断言组包在 `if (failed === 0)` 内，前置失败即整组跳过 | 改为 `collectModules()` 递归收集，构建清单 44→**62 个模块**全部真实 import 通过；新增持久断言防止回退 |
| 真实商品按二级/三级查询恒为空 | **真缺陷** | 旧商品 17 个 `subCategoryId`（`beauty_skincare`/`book_read`/`food_snack`…）在新树不存在，原兼容桥只映射一级 id，商品只能靠一级别名硬命中，未真正「挂在子孙分类上」 | 新增 `LEGACY_SUBCATEGORY_ALIASES` 覆盖全部 17 个旧二级 id → 新树子孙节点；`productInCategory` 归属集合加入二级别名；新增 `filterProductsByCategory()` 批量查询入口 |
| 独立脚本报 1081 个非法 id | 误报 | 验收正则 `/^[a-z0-9-]+$/` 不允许下划线，而内部 id 是 `womenswear_01_t1` 形式；实测含中文 0、含斜杠 0 | 口径修正为 `/^[a-z0-9_-]+$/` 并单独断言「无中文 id/slug」，重跑 7/7 全过 |

复核后构建与验收：
- `node scripts/check-web.mjs` → **0 失败**，62 个模块全绿，分类断言组 15 条全过
- CI build 等价产物检查 → `web/` 作为 Pages artifact：62 个 js、202 条 import 边、**0 条未解析**，`store/categoryTree.js` 在产物内
- 独立验收 7/7：25 一级清单全覆盖 / 每级 7–11 二级 / 100% 二级带 3–6 三级 / 1106 节点零中文、字段齐全、计数汇总一致 / `getDescendantIds` 25 个一级全一致 / 真实 2951 款商品按二级命中 `beauty_01=387`、`books-culture_01=809`、`food_01=208`、`pet_01=119`、`mother-baby_01=5` / 6 工具函数全可用
- `e2e-category-tree` 11 断言全过，分类页仍 16 卡、UI 零回归、控制台零错误

### 全量回归结论（29 套）

- **27 套通过**；`e2e-merchant-apply` 按惯例需独立 8080 网关，补跑 **42/42 通过**。
- `e2e-discovery`（45/46）与 `e2e-merchant`（26/27）**仅「控制台零 JS 错误」一条失败**：3 个外部商品图片 URL
  （`images.openbeautyfacts.org` / `images.openfoodfacts.org` / `kolzsticks.github.io`）在当前网络
  `net::ERR_CONNECTION_CLOSED`，被浏览器记为 console error。`web/js/demo-real-data.js` 本步骤完全未改动，
  本步骤仅有的 2 个改动文件也都不被页面加载，故属**环境网络噪音、非代码回归**（其余 71 条功能断言全过）。
- 修复方案（**属范围外，本步未执行**）：① e2e 控制台噪音过滤把 `ERR_CONNECTION_CLOSED` 与既有 `404` 同口径处理；
  ② 或把演示商品 `pic` 外部图换成本地 data-URI 占位；③ 或恢复外网/代理白名单。

> 只扩充分类树数据与工具函数，不新增页面、不改任何页面 UI。
> 一级 10→25 个（本步前实际派生 16 个），二级/三级同步补齐。

## 交付内容

1. **`web/js/store/categoryTree.js`（新，数据层）**：
   - **25 个一级**：女装、男装、内衣家居服、鞋靴、箱包、珠宝配饰、钟表眼镜、
     美妆护肤、香水香氛、数码电子、手机通讯、电脑办公、家用电器、智能家居、
     食品生鲜、酒水茶饮、母婴用品、童装玩具、运动户外、健身器材、汽车用品、
     宠物用品、图书文创、办公文具、乐器音响（id/slug 全英文 + 细线 emoji 图标）；
   - **220 个二级**：每个一级 7–11 个（规格 6–12），全部具体类目（如女装下
     连衣裙/汉服旗袍/泳装、香水香氛下香薰蜡烛/试香小样）；
   - **三级 100% 覆盖**（规格 ≥70%）：每个二级 3–6 个具体三级（如连衣裙→
     长款/短款/吊带/衬衫裙、猫粮→幼猫/成猫/处方/冻干粮、香薰蜡烛→大豆蜡/椰子蜡/木质香）；
   - **Category 模型字段齐全**：id/name/slug/parentId/level/icon/description/
     productCount/sort/children；二级三级 id 由「父 id + 序号」确定性生成；
   - **productCount 不写假数字**：叶子用确定性哈希占位（6–60，贴近演示站 256 款
     商品量级），父级 = 直接子级汇总——后续真实商品回填时只改 `leafCount` 一个函数。
2. **6 个工具函数**（页面唯一消费入口，注释明令禁止 import 裸数组）：
   `getCategoryById` / `getChildren` / `getAncestors` / `getCategoryPath` /
   `searchCategories`（名称+slug 关键词命中，含三级）/ `getDescendantIds`
   （一级下全部子孙 id）+ `getCategoryAndDescendantIds`。
3. **旧商品兼容桥**：`LEGACY_CATEGORY_ALIASES`（旧 16 类 id → 新树节点，
   语义重合的 computer/appliance/food/sports/pet/stationery 直接继承旧 id）
   + `productInCategory(product, catId)`——按一级查商品时自动包含子孙分类商品。
4. **UI 零改动**：分类页仍由 `deriveCategoryTree` 驱动（16 卡渲染不变），
   新树为后续步骤的消费做准备；网关 `/api/categories` 未动（避免扰动 256 款
   商品的种子类目映射）。

## 验收自检（check-web 11 断言 + e2e-category-tree 11 断言，全绿）

- ✅ 一级 25 个、每个一级 6–12 二级（实测 7–11）、三级覆盖 100%（≥70%）；
- ✅ getDescendantIds('mobile') 返回 31 个子孙 id（含三级）；
- ✅ 按一级查商品含子孙分类：旧种子商品经映射命中 手机通讯/数码电子，不误判宠物用品；
- ✅ 分类页 UI 零回归：卡片结构/数量与既有口径完全一致；控制台零错误。

## 已知限制

- 旧 16 类商品到新树的映射是过渡方案（apparel→女装、home→智能家居、
  kitchen→家用电器等取最贴近类目），后续真实商品数据回填时商品将直接
  携带新树 categoryId，映射表整体下线；
- 新树尚未接入任何页面 UI（本步范围如此），分类页/筛选项的切换在后续步骤做；
- 网关种子（/api/categories）仍是 16 一级 × 3 二级，演示模式以本地数据层为准。

---

# 氛围动效与全局性能开关（CSS 级）— 交付总览

> 只加 CSS 级氛围动效并建立全局性能开关，不新增页面、不改结构与业务逻辑。

## 交付内容

1. **背景动态网格**：复用全局网格层（`html::before`），`grid-drift` 30s linear
   infinite 以一个周期（32px）为步长斜向漂移——极慢到只被「感觉到」；有效强度
   0.5×0.06≈0.03 ≤0.05。移动端 / reduced-motion / 低内存（`.reduced-fx`）与
   低电量（`.low-power`）自动静止。
2. **扫描线（限量两处）**：Hero 扫描环容器内 1px 渐变细线，5s 从上到下循环，
   opacity 0.25（环自身 0.26 再压一层，实际 ≈0.065），只扫环内空白不覆盖文字
   与商品图；AI 面板保持上轮的一次性横扫。AI 面板打开时 Hero 扫描线自动暂停
   （`body:has(.ai-widget.is-open)` → animation-play-state: paused），预算让位。
3. **交互信号**：卡片 hover 只留边框信号（`.pcard` / `.cat-card` / `.hero-product`
   统一 border-color→青色细线 150ms，删除原 translateY 位移与新增阴影；首页结果卡
   的信号在外壳 `.scan-item` 上，此前已是边框信号）；按钮默认过渡 150ms（组件自带
   更具体过渡的以组件为准）+ 全局 `button:active scale(0.98) / 120ms`；全站
   `transition: all` 清零，收敛为 transform/opacity/border-color/background-color/color。
4. **全局性能开关**（`web/js/fx.js`，head 内首帧前同步加载）：
   - `html.reduced-fx`：prefers-reduced-motion / 视口 <768px / deviceMemory<4
     任一命中（matchMedia change、resize rAF 节流实时增删）；
   - `html.low-power`：Battery API 电量 <20% 且未充电（levelchange/chargingchange 监听）；
   - `.reduced-fx` 下：网格静止、扫描线消失、呼吸点停、backdrop-filter 全部关闭
     且主要玻璃面（状态栏/顶栏/搜索/抽屉/弹层等）换 `--color-surface-1` 不透明底；
   - `.low-power` 下：仅网格漂移停止（纯装饰），扫描线等反馈保留。
5. **稳态 keyframes 预算 =3**：`grid-drift` + `sysbar-breath` + Hero 扫描线。
   为守住预算，Hero 呼吸点（hp-dot）与秒杀 LIVE 点（fs-dot）改为静态辉光，
   面板打开时扫描线暂停——任何页面组合下同时运行的无限循环动画 ≤3。

## 验收自检（e2e-ambient 32 断言 + check-web 10 断言，全绿）

- ✅ 桌面网格 30s 漂移运行中、移动端/reduced-motion/低内存静止；
- ✅ 扫描线仅在 Hero 环内（商品区零循环扫描/脉冲）、opacity ≤0.25、面板打开即暂停；
- ✅ 稳态无限 keyframes ≤3（面板打开后仍 ≤3）；
- ✅ 卡片 hover 边框变青、transform 保持 none；
- ✅ reduced-fx 下 backdrop-filter 关闭、状态栏不透明底 rgb(15,20,28)、页面完整可用；
- ✅ 低电量只停网格、不误伤 reduced-fx 与扫描线；
- ✅ 四种环境（桌面/移动/reduced-motion/低内存/低电量）控制台零错误。

## 已知限制

- 「稳态 ≤3」的口径：无限循环的装饰动画；一次性过渡（toast、入场、单次扫线）不计入。
- 网格漂移动画的是 background-position（本步规格指定做法），已用极慢周期把重绘
  成本压到最低；若后续要进一步省电可改双层 transform 方案。
- fx.js 的 resize 监听用 rAF 节流，不拦截连续缩放中间态。

---

# 详情页 3D/360° + AR 入口（最轻方案）— 交付总览

> 只在商品详情页增加 3D/360° 与 AR 的入口与演示态，其余区域一行未改。
> 零 WebGL、零重型依赖：刻意不引 Three.js / model-viewer，首屏网络面板零 3D 请求。

## 交付内容

1. **360° 查看器**（`web/js/pdpImmersive.js`）：主图上方「图片 / 360° 查看」切换
   （等宽 11px，选中态青色细线）——24 帧图片序列切帧；横向拖拽/滑动按距离映射
   帧索引（18px/帧），松手惯性阻尼（0.94/16ms 衰减，速度 <0.02 停）、首尾无缝
   回绕；键盘 ← → 切帧（stage 可聚焦，role=slider + aria-valuetext）。
   无真实序列图时同一张图占位 + 左上角「演示」等宽小字，交互骨架完整。
2. **懒加载与进度**：360° 舞台首次进入才初始化；帧预载显示 1px 青色进度细线
   （scaleX 只动 transform）；任一帧失败 → 「3D 预览暂不可用」+「切回图片」按钮。
3. **AR 渐进增强**：「AR 预览」按钮——桌面端弹层提示「请在移动设备上使用 AR 预览」
   （零脚本加载）；移动端探测 WebXR immersive-ar：支持才**动态 import**
   `web/js/arPreview.js` 演示占位层（全屏、标注「演示模式」、44px 关闭热区、
   诚实说明「真实会话需接入 model-viewer / WebXR」），不支持则降级回图片查看
   并给出一行说明（绝不静默失败、绝不放假按钮）。
4. **降级纪律**：默认永远图片模式；reduced-motion / 低端设备 3D 入口仍可见但需
   主动点击，reduced-motion 下拖到哪停哪（无惯性）；页面切换时 rAF 检测
   `isConnected` 自停 + AbortController 释放全部监听，零泄漏。

## 验收自检

- ✅ 「图片 / 360°」切换可拖拽切帧（e2e：−300px 映射帧变化）
- ✅ AR 在桌面（提示弹层）与移动端（不支持 → 一行说明；支持桩 → 演示层）都有明确降级
- ✅ 重型脚本按需加载：首屏请求断言零 three/model-viewer/glb/arPreview；
  arPreview.js 请求发生在点击之后（e2e 逐条断言）
- ✅ 加载失败有兜底（`window.Image` 桩确定性触发失败态 + 切回图片可用）
- ✅ 移动端无横向滚动、控制台零错误；check-web 新增 11 断言组全绿

## 已知限制

- 演示序列为同图占位（种子数据无实拍序列帧）；接入真实序列时给商品加
  `spinFrames: [url×12–24]` 字段即可，查看器自动识别为实拍模式；
- AR 演示层是占位实现（不建立真实 WebXR 会话），接入点已用 TODO 标注。

---

# AI 助手升级（触发器 / 面板 / 反馈）— 交付总览

> 只升级 AI 导购的入口、面板和反馈：全局触发器、上浮面板、扫描过程可见化、MATCH 商品卡。
> 推荐逻辑、`/api/ai/*` 接口与商品卡数据结构一行未改。

## 交付内容

1. **全局触发器**（`#ai-fab`）：48×48 圆形（移动 44×44、距边 20px），surface-1 底 +
   1px cyan-line 描边 + 几何细线 AI 符号（四角星 + 中心点，不用机器人形象）；
   外圈 1px 青色细环默认 0.28 透明度、面板打开时提亮到 0.85；hover 边框变青、
   :active scale(0.96)；点击即开、再点即关（Esc 同样可关）。z-index 75：
   高于内容（45）低于遮罩抽屉（80–90）与弹层（120+）。
2. **面板**（`#ai-panel`）：400px 浮层（surface-1 + border-glow + 16px 圆角 +
   浮起阴影），打开 160ms 上浮（translateY 8px→0 + scale 0.98→1）+ 顶部 1px 青色
   横线 300ms 从左到右扫过**一次**（不循环）；顶部状态行 = 6px 青色呼吸点 +
   `AI ASSISTANT / 在线`（等宽 11px）+ 44px 关闭热区；导购/客服/问答 tabs 保留。
   移动端变**全宽底部抽屉**（80vh 上限、顶部 16px 圆角；PDP/招商/工作台吸底栏
   出现时面板自动让位，e2e 逐页断言不遮挡）。
3. **AI 工作过程可见化**：提交需求后先插系统消息——8px 青色细线指示器
   **只转一轮**（900ms 后停止并隐藏，绝不无限转圈）+ 三行等宽 11px 读数
   （`扫描 N 件商品`——真实目录数现取 / `交叉比价中` / `过滤 3 个维度`）
   每 300ms 逐条出现，总时长 900ms（600–900ms 规格区间），然后才回 AI 流式回复。
4. **MATCH 商品卡**：卡顶等宽小字 `AI MATCH 88–99%`（与首页扫描流同一 id 稳定
   哈希口径），卡底数量步进器（1–9）+ 加购按钮——**加购走真实链路**（进购物袋、
   角标实时 +N、按钮 1.4s 反馈「已加入 ✓」），卡体点击仍进详情（原打点保留）。
5. **消息区**：AI 消息 surface-2 底左对齐、用户消息青色微底右对齐；流式文本渲染
   完成后数字段自动包 `.mono-num`（等宽 + tabular-nums，安全转义）。
   输入框 void 底 + hairline 边 + focus 变青 + `caret-color: cyan` + 48px 高。
6. **降级与纪律**：打开面板锁背景滚动——**html+body 双锁**（body 自带
   `overflow-x:hidden` 会打断 overflow 向视口传播，单锁 body 锁不住）；关闭恢复。
   `prefers-reduced-motion`：取消上浮与扫线（只做 opacity 切换）、指示器不旋转、
   呼吸点停止。无全屏覆盖、无粒子/音效/3D、无 JARVIS 视觉、无循环扫线。

## 验收自检

- ✅ 触发器全局可达、规格逐项断言（48/44px、距边 20px、圆形、层级 75）
- ✅ 打开有一次性上浮（160ms iteration 1）+ 扫线（300ms iteration 1）
- ✅ 回复前有系统扫描消息，600–900ms 内三行全部出现、指示器停止并隐藏
- ✅ AI 商品卡有 MATCH 标注且可加购（角标 +2 实测）
- ✅ 移动端全宽底部抽屉、≤80vh、不遮挡吸底操作栏（让位 78px 实测）
- ✅ 滚动锁（wheel 实测锁定/恢复）+ Esc 关闭 + 开关语义
- ✅ 桌面/移动控制台零错误；check-web 新增 11 断言组全绿

## 已知限制

- `扫描 N 件商品` 的 N 来自 `getProducts()`（服务端目录或演示库），首次预热失败
  时回退演示口径 1,240；
- MATCH 为演示口径（稳定哈希），不是真实推荐分——与首页扫描流同口径，两处一致；
- 移动端抽屉打开时触发器被抽屉盖住（关闭走状态行按钮或 Esc），属预期交互。

---

# 首页信息架构重构（全息任务面板）— 交付总览

> 只动首页（`#/`）的信息架构与视觉重心：从「商品列表页」变成「全息任务面板」。
> 分类页、详情页、结算、商家端一行未改。

## 新信息架构（顺序 = 用户决策链）

1. **任务简报**（首屏）：`AI SCAN ACTIVE / 扫描中` 呼吸状态行 → 300 字重大标题
   「让 AI 替你完成一次精准扫描」（两行封顶，clamp 42–56px / 移动 30–34px）→
   副文案 ≤2 行 → 主 CTA「开始扫描」（实心青 + void 字 + 12px 圆角，48px 高）
   + 次 CTA「查看全部甄选」（透明底 + cyan-line 边框）；右侧**极简扫描环**：
   三圈细线同心圆 + 一条 60° 弧线（SVG，cyan 26% 不透明度，240–320px），
   弧线只扫一圈（1.4s 一次性，不循环，reduced-motion 下静止）。
2. **系统读数胶囊** ×3：已匹配 / 优于均价 / 隐藏选项——**全部从商品池现算**：
   匹配数 = 商品总数，均价优势 = 平均折扣，「隐藏选项」= 折扣 ≥25% 且销量 <200
   （在真实数据上验证过口径，53 个，不是拍脑袋的示例数字）。
   移动端横滚不换行 + 隐藏滚动条。
3. **功能模块卡** ×6（替代旧分类胶囊）：01 AI 导购（开面板）/ 02 分类 /
   03 甄选 / 04 洞察 / 05 货源市场 / 06 我的订单；3×2（移动 2 列）；
   hover 只把描边过渡到 cyan-line（150ms），无位移无阴影。
4. **AI 任务条带**（页面中段）：AI TASK RUNNING + 「比价 3 渠道 / 预计节省 ¥N」
   （节省额 = 结果前三条的真实原价差合计）+ 1px 细线进度条（一次性 600ms → 68%）。
5. **扫描结果流** ×8：等宽标题 `SCAN RESULTS / 扫描结果` + 「查看全部」细线链接；
   每张卡顶部带 `MATCH 88–99%`（id 稳定哈希，刷新不变、不留 100%）与
   `PRICE INDEX −N%`（有原价用真实折扣）；首条跨两列横向排版（重点结果）；
   1 跨两列 + 7 单列 = **3×3 网格正好铺满**；选品 = 编辑位 4 席 + 商家上新 ≤2 席
   + 类目补齐（直接 pickEditorial(8) 会被 8 个固定位占满，商家商品永远进不来）。
6. **秒杀**挪到结果流之后：首屏属于「系统在运行」，秒杀是时间窗活动位。
   最近浏览 / AI 工坊保留在尾部。

**动效**：简报→读数→模块→任务带→结果依次 fade-up（240ms，块间 40ms，≤400ms 封顶），
仅本次加载首次进首页播放（SPA 回切不重放）；呼吸/扫掠/进度条/级联在
`prefers-reduced-motion` 下全部静止。

## 验收自检（对应任务要求逐项）

- ✅ 首屏第一眼是「系统在运行」而非「在卖货」（首块 DOM 断言 + 截图：首屏无商品图）
- ✅ 有任务简报、读数胶囊、6 个编号模块卡、扫描结果流、AI 任务条带（e2e 逐块断言）
- ✅ 商品卡有 MATCH 和 PRICE INDEX 读数（7 条卡逐条断言，88–99 区间，刷新不变）
- ✅ 移动端首屏不拥挤、无横向滚动（390px 溢出 0；单列时重点卡收回 span——
  `grid-column: span 2` 在 1 列网格会硬撑出第二列，这个坑单独有断言）
- ✅ 控制台无错误（pageerror + console.error 过滤网络类后为空）
- ✅ 其他页面零回归（**check-web 全绿；全量 e2e 24 套全绿**，含网关 e2e-merchant-apply 42/42；
  e2e-flash / e2e-merchant-link / e2e-home 均按新 IA 更新断言口径）

## 已知限制

1. MATCH / PRICE INDEX 是演示口径的「算出来的读数」：MATCH 来自 id 稳定哈希
   （确定性，不是真推荐分），PRICE INDEX 有原价时是真实折扣率。
   接真实推荐服务后替换 `matchScore` 一个函数即可。
2. 任务条带的「3 个渠道」为固定文案，节省额是真实数据计算。
3. 旧首页的 .hero/.qtile/.rail/.bento CSS 成为死样式（JS 已删），留待下轮样式清理。
4. 扫描环弧线按「禁止旋转循环 / 无限装饰动画」只扫一圈即停；若要常驻雷达扫掠，
   加一行 `animation-iteration-count: infinite` 并在 reduced-motion 中关掉即可。

---
# （上一轮）全局 HUD 框架层（系统状态栏 / 四角角标 / 界面层分隔线）

> 本轮在深空令牌之上加一层「取景框」chrome：**只描述机器在运行，不承载任何交互**。
> 不改页面内容、不改业务逻辑、不新增功能。

## 本轮做了什么

1. **顶部系统状态栏 `.sysbar`**（结构在 index.html，零 JS 依赖渲染）：
   - sticky 置顶，30px（移动端 26px），`rgba(7,9,12,0.82) + blur(12px)` 玻璃底 + hairline 下边；
   - 左：6px 青色圆点（2s opacity 0.4→1→0.4 呼吸，只动 opacity）+ SYSTEM ONLINE / 系统在线；
   - 中：mock 读数带（延迟 24ms · AI 模型就绪 · 今日扫描 1,240 件 · 3 个价格异动），
     数字用信号青，永不换行、超宽裁切 + 淡出遮罩，移动端整条收起；
   - 右：4 格 2×10px 信号条（亮青灭线）+ 等宽时钟（`hud.js` 每秒走字，页面隐藏自动停表）；
   - 整条 `pointer-events:none` + `aria-hidden`：不挡下层导航点击、不进读屏树。
2. **顶栏让位与吸顶联动**：新增 `--sysbar-h` 变量；顶栏 sticky top 由 `0` 改为
   `var(--sysbar-h)`；筛栏 / 结算侧栏 / 购物袋合计 / 工作台侧栏四处吸顶偏移全部
   `calc(var(--sysbar-h) + 原值)`——一处变量改动，整条 chrome 让位关系一起走。
3. **四角 HUD 角标 `.hud-frame`**：fixed 层（z-index 60，压过 chrome、低于弹层），
   `pointer-events:none`；四角 L 形细线 1px 宽 / 14px 臂长 / 边距 16px，
   色值 `--color-border-glow`（极淡）。移动端缩小到 10px、只留上两角
   （底部两角给吸底 CTA / 工作台标签栏让位）。
4. **界面层分隔线**：`.topbar::after` absolute 定位，青色渐变 1px、透明度 0.35，
   不占布局高度（全站不会因此下移 1px），随顶栏吸顶常驻。
5. **z-index 地图**写进 styles.css HUD 段注释：45 内容 / 50 顶栏 / 55 状态栏 /
   60 角标 / 72-75 吸底与浮窗 / 80-90 遮罩抽屉 / 120+ 弹层。

## 验收自检（对应任务要求逐项）

- ✅ 每个页面顶部都有状态栏且不遮挡导航（e2e 逐页断言 top=0、topbarTop=30；
  滚动 900px 后双层吸顶不散架；点导航正常路由）
- ✅ 四角有极淡 L 形角标、不遮挡内容（pointer-events 全关实测）
- ✅ 移动端状态栏只保留左侧状态与右侧信号条（中部读数带 display:none，26px 实测）
- ✅ 减少动效设置下呼吸停止（reducedMotion:reduce 实测 animationName=none、opacity=1）
- ✅ 导航 / 分类 / 详情 / 结算 / 商家工作台无布局回归（全量 e2e 回归）
- ✅ 控制台无 JS 错误（pageerror + console.error 过滤网络类后为空）
- ✅ 移动端无横向滚动（390px 实测溢出 0）
- ✅ 状态栏 ≤36px（30/26）；无发光溢出文字；无图标堆叠；无扫描线动画

## 已知限制

1. 中部读数带按规格 `pointer-events:none`，overflow-x:auto 实际无法拖动——
   视觉上用淡出遮罩表达「还有内容」，宽屏（≥1440）下四条读数全量可见，实际裁切概率极低。
2. 状态栏读数是静态 mock（延迟 / 扫描量 / 价格异动不抖动）：刻意为之，
   每帧跳动的假数字会让用户以为页面在刷新。接真实网关后把 `hud.js` 扩展为读
   `/api/config` 即可，DOM 结构无需改。
3. 桌面端右下角角标在 AI 买手浮窗附近会局部被浮窗（z75 > 60）覆盖，
   属预期层级关系（浮窗优先）。

---
# （上一轮）全站深空令牌（Deep Space Command 底色层）

> 本轮只做三件事：**令牌、底色、基础质感**。不改任何页面结构、不改组件布局、不加业务功能。

## 本轮做了什么

1. **全局令牌**（`web/styles.css` `:root`）：落地全套 `--color-*`（void #07090C /
   surface-1 #0F141C / surface-2 #141B25 / border-glow / cyan #22D3EE / cyan-dim /
   cyan-line / text-primary #E8EDF2 / text-muted #8B95A3 / hairline-dark）与 `--font-mono`；
   圆角沿用 16/12/999；阴影降级为深色两档（card 0 1px 2px + 0 8px 24px、float 0 16px 48px）。
   旧令牌（--canvas/--surface/--ink/--body/--muted/--gold*/--line*/--glass*）**别名**到新令牌，
   1800+ 处引用零改写。
2. **底色与文字**：body = #07090C + 两处极弱青色辉光；卡片/面板 = surface-1；
   主文字 #E8EDF2、辅助 #8B95A3；无大面积纯黑/纯白。
3. **网格底纹**：`html::before` 负层级固定层，1px 线 / 32px 周期 / rgba(139,149,163,0.06)
   / opacity .5 / pointer-events:none——天然在内容之下，不与 sticky 顶栏、抽屉、弹窗打架。
4. **信号焦点环**：`:root :focus-visible` = outline 1px cyan + offset 2px + cyan-dim 光晕；
   只随键盘遍历出现，绝不用整块青色填充替代；秒杀区青底主按钮单独换浅色环。
5. **读数等宽层**：价格/金额/数量/库存/百分比/单号统一 `--font-mono` + `tabular-nums`；
   属性选择器兜底（排除 `account`——它含 count）；单号/状态/时间小字加 0.02em 字距。
6. **信号色纪律**：金色系整体退役（--gold → --color-cyan）；普通价格归主文字色，
   信号青只留给关键价格（详情主价 / 结算应付 / 袋内合计）；状态色（红/绿/蓝）提亮到暗底可读；
   图表渠道色（views.js SOURCE_META）迁为「AI 渠道青 + 其余灰阶」。
7. **11k 行硬编码浅色迁移**：按声明属性上下文映射（background→深面板 / border→发丝线 /
   shadow→黑影或弱白高光 / text→提亮），共改写 409 个规则块、约 560 处颜色；
   秒杀深空层（已是暗色自洽）整段豁免。

## 验收自检（对应任务要求逐项）

- ✅ 全站底色 #07090C 系、卡片 #0F141C 系（shot-dark.mjs 探针实测 computed style）
- ✅ Tab 键遍历有青色信号环（实测 brand 链接 outline rgb(34,211,238) + 光晕）
- ✅ 价格/数字等宽（ui-monospace + tabular-nums），列表数字列对齐
- ✅ 背景有极淡网格且不抢内容（opacity 0.5 × alpha 0.06 ≈ 3% 灰青）
- ✅ 现有布局和功能零回归（check-web 全绿 + 全量 e2e 回归 22 套）
- ✅ 控制台无 JS 错误（pageerror 监听为空；404 为演示模式无网关的预期资源）
- ✅ 移动端无横向滚动（390px 实测 scrollWidth−innerWidth = 0）

## 已知限制 / 说明

- 商品插画（art.js）保留浅底：它是「内容」不是「chrome」，像电商照片白底，不影响界面质感。
- 等宽只动字体与字距，不强制 11–12px 字号——避免挤压既有密集布局。
- 嵌套面板当前统一 surface-1；surface-2 留给组件层步骤按「嵌套升级」逐处使用。

---
# （上一轮）首页顶部秒杀（Deep Space Command 深空指挥舱）

## 本轮做了什么

1. **首页顶部秒杀区**（`web/js/flashSale.js` + `web/styles.css` `.fs-*`）：
   页首第一块（Hero 之前），嵌在暖色杂志页里的一块深空指挥舱——
   近黑青绿底 `--ds-void #04090a` + 单一霓虹 `#22D3EE` + 等宽读数 + 景深网格。
   左舱 HUD：LIVE 脉冲状态灯、场次代号、`ENDS IN 01:59:58` 辉光倒计时
   （每秒走，脱离文档自动停表）、说明行、全场进度与已抢读数；
   右舱：秒杀卡片轨道（折扣角标 / 青色秒杀价 / 划线原价 / 单品进度 /
   剩 N 件 / 立即抢购 + 加购）。经确认采用**局部深空层**方案：只有这一块
   换视觉语言，其余页面一行不动。
2. **运营后台秒杀控制台**（`web/js/adminFlashSale.js`，`#/admin/flash`，
   运营台第 5 个标签）：本机运营口令门禁（首次自设、只存 FNV 哈希）；
   场次标题/代号/说明/时长可编，商品逐件配秒杀价/库存/限购（价 ≥ 原价
   就地提醒）；顶部读数条（状态/倒计时/已抢/署名时间戳）每秒刷新；
   动作：保存即开抢、开抢/暂停、+30 分钟、重置本场。
3. **数据层**（`web/js/store/flashSaleStore.js`）：场次归一化（坏数据逐字段
   夹逼）、阶段推导（pending/live/paused/ended 由时间推导，不存死状态）、
   `markSold` 进度累加、跨标签页 storage 同步；首访无配置时按商品池
   **确定性派生**默认场次（每品牌一件、55–80% 折扣、自带 15–55% 开场进度）。
4. **购买走真实链路**：秒杀条目以 `flash-<场次>` 为 skuId 进购物袋
   （与原价条目分两行互不改价），spec 标「秒杀价 · 场次名」；
   `state.js` 增加可选 `localOnly` 加购参数——秒杀价只在本机场次配置里，
   推服务端会被服务端价覆盖回原价，等于秒杀白做。

## 实时性的三层含义

① 倒计时每秒走、阶段自动流转（暂停切 HOLD、走完切 CLOSED）；
② 每成交一件进度条与「剩 N 件」立即累加；
③ 同一浏览器另一标签页改配置，前台**免刷新**跟着变（storage 事件整块重绘，
e2e 有专门断言）。

## 验证

- 截图验收 4 张：桌面秒杀舱特写、整页首屏（深色块与暖色页的过渡）、
  移动端秒杀舱、后台控制台整页。
- check-web 新增 9 项「首页秒杀（深空指挥舱）」断言，全绿。
- 新增 `scripts/e2e-flash.mjs`：19/19——位置、倒计时、秒杀价入袋、
  进度累加、直达结算、口令门（设/验/错）、跨标签页免刷新联动、
  暂停/结束态、主流程不破坏、移动端无横滚、无 JS 报错。
- 全量回归 **22/22 套全绿**（其中 e2e-merchant-review / -selfservice 的
  运营台标签数断言 4→5 已同步更新；e2e-merchant-apply 用独立临时库
  `_e2e-apply.db` 起网关后 42/42）。

## 已知限制 / 遗留候选

- 演示环境成交价以本机场次配置为准；接真实交易网关时服务端会按库价
  重新核价（若要真秒杀价，需在网关加 flash-sale 表 + 下单核价，本轮未做）。
- 秒杀库存是「显示口径」：不真正占用商品 SKU 库存，下单仍走商品自身库存。
- 候选：秒杀场次日历（多场排期）、抢购限购按账号记、倒计时到点自动换场。

---

# 首页布局参考 Amazon 改版 — 交付总览

## 问题诊断

改版前首页首屏只有 Hero 文案 + AI 工坊条带，**商品要到第二屏之后才出现**；
商品卡只有名字和价格。对照 Amazon 首页的四条可用性优势——
①一屏之内给到商品、②分类入口卡、③横向 carousel、④卡片信息完整
（价格/评分/销量/直接加购）——逐条落地。

## 本轮完成

1. **按类目速览**（参考 Amazon「Shop by category」）：Hero 之后紧跟一排
   4 张白卡，每卡 = 类目名 + 件数 + 四件真实商品封面拼的 2×2 马赛克，
   点卡直达该类目列表。凑不满四件用 `data-count` 换列数，不留空洞；
   类目少于两个时整块不出。
2. **今日好物横滑轨道**（参考 Amazon deals carousel）：折扣力度为主信号、
   销量取对数为辅打分选 12 件；**每品牌最多两件**防扎堆；横向滑动 +
   桌面端 ‹ › 翻页按钮（真实 scrollBy，实测 scrollLeft 2→1002）；
   卡片自带折扣角标、价格/划线原价、已售、金色「加购」——看完就能下手。
3. **商品卡补销量社会证明**：价格行加「已售 7,429」（过万折叠为 1.2万，
   有数据才出现，不编造）。
4. **首屏密度**：Hero 高度 580→520，速览卡探进首屏——首屏有商品影像，
   是本次最直接的「吸引力」提升。
5. 发现区数据全部来自已加载的 products + 类目树，**不额外发请求**；
   占位先挂、数据到了再填（避免跳动），数据不足时 `:empty` 零占位。
   真网关/演示双模式同样生效。

**没有搬的东西**：亚马逊的蓝橙配色与密集促销腔调。所有新块沿用本站
暖中性 + 细线 + 衬线的编辑式语言，速览卡 hover 金边、轨道卡 hover 图片
微放大——参考的是「先给入口、再给好货」的结构，不是它的视觉。

## 验证

- 截图验收 7 张：桌面首屏（速览卡探入）、速览特写、轨道特写、移动端
  速览（2 列）与轨道（152px 卡、无横滚）、整页节奏。
- 翻页按钮实测生效；移动端无横向溢出。
- check-web 新增 5 项「首页发现区」断言，全绿。
- 回归：discovery / merchant-link / pdp / search / checkout / sourcing /
  merchant-demo / coupons / fulfillment / order-tx 全部通过。

## 遗留候选

- 轨道接入个性化（基于最近浏览/购买的推荐排序）
- 速览卡支持用户自定义常逛类目
- 「今日好物」接真实促销/库存紧张信号（当前折扣+销量是静态规则）

---

# B 端页面视觉统一（深色锚点 + 细线卡片）— 交付总览

## 本轮完成

用户要求：招商页和货源市场页沿用「深色锚点 + 细线卡片」逻辑，避免 B 端页
变成粗糙后台模板。

- **招商页**：排查后确认已符合——hero 右侧暗面板（PLATFORM NOW）+ 尾部
  暗色 CTA 带（NEXT STEP），中间细线编辑段，本轮未动。
- **货源市场页**：问题所在——整页纯白平铺，无任何视觉锚点。两处改造：
  1. **AI 找货块 → 页面签名暗面板**：与招商页 PLATFORM NOW 同一配方
     （#202020→#151515 暗渐变 + 金色 radial + 投影），加「AI SOURCING DESK」
     eyebrow；输入框暗场半透明（聚焦金边）；结果区推荐供应商改半透明小卡
     （白 5% 底 + 14% 细边、hover 金边），价格提亮金（#d8bd8a，暗底可读）。
  2. **尾部暗色锚带**（STILL LOOKING）：「没扫到合适的货源？」+ 两个真实
     行为按钮——滚回 AI 面板聚焦输入 / 按来路返回（带 id/key 回工作台）。
- **供应商卡保持白底细线不动**：深色开场 → 细线中段 → 深色收尾，与招商页
  同一节奏；暗场金色文字提亮到 #d8bd8a 保证对比。
- 类名与文案零改动 → e2e 断言零修改；check-web 新增 1 条断言锁「深色锚点
  语法与招商页同源」（同一条渐变字符串）。

## 验证

- 截图验收：AI 暗面板（含结果态）、收尾锚带、移动端（暗面板 + 全宽金按钮、
  锚带堆叠）全部成立，无对比度问题。
- 回归：check-web 全绿；e2e-sourcing 50/50、e2e-merchant-link 27/27、
  e2e-merchant 27/27、e2e-merchant-demo 45/45。

---

# 商家侧 ↔ 消费者侧数据联动（演示闭环）— 交付总览

## 本轮完成

第五步：最小的数据联动演示——商家端新增或上架的商品出现在消费者端，
不做实时同步，刷新或重进列表即最新。

### 现状说明（为什么这么做）

「商家商品进消费者商城」其实有两条路，本轮把它们对齐了：

- **真网关链路**（上一轮已通）：商家商品真写入 `products` 表，过审后
  商城列表/搜索/详情/加购/下单处处真实生效（`e2e-merchant-workspace` 覆盖）。
- **演示模式闭环**（本轮补齐）：无网关（如纯静态站）时，工作台演示仓里的
  货此前只存在于商家工作台，消费者端完全看不见——本轮把这条断路接上了。

### 1. 桥接层（不造第二份数据源）

用户建议「写入一个共享 mock 商品数据源（localStorage 中的 products）」，
但 `merchantShopStore` 的 localStorage 分桶**本来就是**共享货源，再建一个
`products` 桶就是两个真源，必然漂移。所以做的是**桥接读**：

- `merchantShopStore.listMerchantMallProducts()`：遍历所有商家的桶，
  把「商家自建且在售」的商品映射成商城商品形状（默认 SKU、库存、店铺名
  作品牌、演示标注）。
- `views.js`：演示模式下 `getProducts()` / 本地搜索把桥接结果现读拼入。
  每次取数都现读（不进 `productsCache`）——这正是「不做实时同步，刷新即最新」。

### 2. 三条口径（与平台库一致）

1. **种子演示商品不进商城**：种子商品带 `seed` 字段，只有商家自建的货才桥接。
   否则每逛一家演示店，商城就多三件「手作粗陶马克杯」，演示数据污染真实浏览。
2. **审核中/已下架处处不存在**：列表、计数、分类、详情、搜索都看不见，
   和真链路的 `review_status` / 下架过滤同一条规则。
3. **跨店 id 防撞号**：消费者侧 id 用 `商家编号::商品id`——两家店的 MP0001
   不能是同一件货。购物车存快照，天然兼容。

### 3. 消费者端呈现（样式不动）

- **首页精选**：给商家上新留**保底位**（最多 3 个、不占首卡）。原先 9 个坑
  会被固定编辑选品清单占满，商家商品永远露不了脸——这是实现验收标准时发现的坑。
- **卡片**：其余样式零改动，只在图片角落加一枚极小「商家」金棕胶囊标签，
  meta 行标「店铺名 · 商家直供」。
- **商品列表 / 分类筛选 / 关键词搜索**：商家商品照常参与分面计数与筛选。
- **详情页**：可打开、可加购（toast 正常、购物车徽章更新）。
- **网关模式自动关闭桥接**（`isDemoMode()` 才拼）：那批货已真进平台库，
  再拼反而会把演示货漏进真实商城。

### 4. 上下架联动

- 商家下架 → 消费者端列表/首页/搜索全部消失；
- 重新上架 → 刷新即回来（页面级验证了「工作台数据层建品→放行→消费者可见」
  的整条链，包括第二家店的货，跨店不串）。

## 测试

- 新增 `scripts/e2e-merchant-link.mjs`：**27/27 通过**（静态站即可，不需要网关）。
  覆盖：首页/列表/搜索可见 + 商家徽章、PDP 可看可加购、下架消失/上架回来
  （刷新即最新）、种子商品不漏进商城、跨店不串、主流程不破坏、移动端无横滚、
  全程无 JS 错误。
- `check-web` 新增 6 项「商家消费者联动」断言（桥接不复制数据源、只拼自建在售、
  跨店防撞号、现读仅演示模式、徽章只给商家商品）。
- 全量回归 **21 套 e2e 全绿**（含新增 link、货源市场 50、工作台真链路 50、
  apply 42、跨设备同步 33 等）+ `check-web` 全绿。
- 视觉验收：商家卡片特写截图确认徽章样式与卡片布局完好。

## 过程中的坑（已解决）

1. `addInitScript` 每次导航/刷新都会执行——预置 localStorage 必须判空再写，
   否则页内改动（下架、第二家店）被冲掉，表现为「下架后列表不消失」。
2. 首页路由是 `#/` 不是 `#/home`，e2e 首跑全空。

## 遗留候选

- 商家商品在消费者端展示销量/评分（演示数据无销售，当前排在列表尾部的
  「综合」排序里）
- 桥接商品进 AI 检索（网关向量库未收录演示商品，属预期）
- 联动升级为真同步事件（websocket 推送），目前按需求明确不做
