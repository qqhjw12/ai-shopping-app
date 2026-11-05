# 拼团 + 心愿单助力 — 交付总览

> **本步范围**：新增「拼团」与「心愿单助力」，让购买有「一起玩」的理由。
> 拼团：详情页发起弹层（2/3/5 人）→ 团号 → 待成团 → 模拟好友参团 → 已成团 → 按团价结算 → 订单标记；
> 心愿单：收藏页公开开关 → 免登录公开页 → 访客助力 → 阶梯奖励 → 主人领券。
> **明确不动**：商品对比（`compare.js` / `outfit.js` / `compareStore.js` / `outfitStore.js` 源码零改动）、
> AI 盲盒（`blindbox.js` 零改动）—— 两侧都有断言守着。
> **设计语言**：沿用 Deep Space Command 深空令牌，未引入任何新色系。

---

## 一、架构决策

| # | 决策 | 一句话理由 |
|---|---|---|
| 1 | 团状态**不落盘、只推导**：`groupStatus(group, now)` 由「成员数 vs 成团人数」+「now vs deadlineAt」算出 | 落盘状态一定会过期，出现「已满员却显示待成团」；推导则刷新、改系统时间都不会说谎 |
| 2 | 团价 = 单买价 × 档位折扣，实时算且写进团快照，同一数值直接作为购物袋价格 | 用户看到的团价 == 结算金额，杜绝「标 8 折、结算按原价」的虚标 |
| 3 | 团的两根时间线分离：`groupBuy` 独立一列，不覆盖订单 `status` | 团生命周期（待成团/已成团/失败）与履约状态（待付款/待发货）正交，塞进一个字段必然互相覆盖 |
| 4 | 心愿单公开出去的是**最小快照**（商品 id / 理由 / 助力记录），不是收藏夹本身 | 一个链接不该把整份收藏公开；索引独立成一张跨 scope 可读的键 |
| 5 | 奖励只写 `couponId`，面额由券目录决定；校验函数 `validateTiers(catalog)` 在仓储层 | 运营改券不用改代码，也不会出现「页面写减 20、券包实际减 10」 |
| 6 | 整页只起**一个** `setInterval`，节点被路由摘掉（`!isConnected`）或全部非待成团即自停 | 每张卡片各起一个定时器是最经典的「切页后还在跑」写法 |
| 7 | 分享/二维码全部 mock：复制本站 hash 链接 + 5×5 纯 CSS 点阵占位 | 规格明确禁止真实分享 SDK；引一个二维码库为了一张占位图不值得 |

---

## 二、文件清单

### 新增（7 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `web/js/store/groupBuyConfig.js` | 123 | 拼团唯一规则源：2/3/5 三档（10%/18%/28%）、24h mock 截止、昵称池、三态词表、分享奖励（引用积分 `share1`）、文案 |
| `web/js/store/groupBuyStore.js` | 422 | 团号生成、建团、模拟参团、三态/剩余人数/倒计时纯函数、`scopeId()` 分桶、结算草稿（30min TTL） |
| `web/js/store/wishlistConfig.js` | 100 | 心愿单规则源：助力阶梯（3/10 人）、奖励 `couponId`、理由长度、每访客一次、可否自助力、文案 |
| `web/js/store/wishlistStore.js` | 447 | 公开索引（跨 scope）、发布/收回/改理由、访客助力去重、阶梯进度、主人通知、领奖标记 |
| `web/js/groupBuy.js` | 443 | PDP 发起弹层、`#/group-buy` 大厅、`#/group-buy/:id` 详情（单一 ticker） |
| `web/js/wishlist.js` | 306 | 收藏页公开面板 + `#/wishlist/:id` 免登录公开页 |
| `scripts/e2e-group.mjs` | 415 | 62 条浏览器验收断言 |

### 改动（8 个）

| 文件 | 改动 |
|---|---|
| `web/js/app.js` | 三条路由（`/group-buy`、`/group-buy/:id`、`/wishlist/:id`）+ 导航归属 + `has-pdp-bar` 覆盖新吸底页 |
| `web/js/views.js` | 详情页次要操作区加 `groupBuyButton(p)`（1 行接线，无其它改动） |
| `web/js/account.js` | 订单卡加「拼团」标记 + 团状态胶囊 + 「查看团」入口；收藏页顶部挂公开面板 |
| `web/js/checkout.js` | 读拼团草稿写入 draft → 清单顶部拼团说明条 → 下单成功后清理草稿 |
| `web/js/store/orderStore.js` | `normalizeGroupBuy()` + `groupStatusText()` + `groupBuyOf()`；`createOrder` / `normalizeRemote` 白名单透传 |
| `web/styles.css` | +571 行 `.gb-*` / `.wl-*`（surface-1 + 1px 细线卡、1px 青色进度条、圆形头像、移动端单列吸底、reduced-fx） |
| `web/index.html` | 页脚加「拼团大厅」；收藏链接改为「我的收藏 / 心愿单」 |
| `scripts/check-web.mjs` | 新增 24 条断言块；**并把对比块 1 条脆断言改成语义匹配**（见第六节说明） |

---

## 三、关键代码

### 1. 三态推导（纯函数，任何时刻都在说真话）

```js
// web/js/store/groupBuyStore.js
export function groupStatus(group, now = Date.now()) {
  const size = Math.max(1, Number(g.size) || 1);
  const joined = Array.isArray(g.members) ? g.members.length : 0;
  if (joined >= size) return GB_STATUS.FORMED;          // 成团是终态：过期也不回退
  const deadline = Date.parse(g.deadlineAt || '');
  if (Number.isFinite(deadline) && now > deadline) return GB_STATUS.FAILED;
  return GB_STATUS.OPEN;
}
```

### 2. 整页一个倒计时（只改文本，断开即停）

```js
// web/js/groupBuy.js
function mountCountdowns(pairs) {
  const tick = () => {
    if (!live.some((p) => p.node.isConnected)) { stop(); return; }   // 路由切走 → 收手
    const anyOpen = live.map(paint).some(Boolean);
    if (!anyOpen) stop();                                           // 全部非待成团 → 收手
  };
  tick();
  timer = setInterval(tick, GB_TICK_MS);
  return stop;
}
```

### 3. 订单层登记拼团元数据（白名单，不登记就静默丢失）

```js
// web/js/store/orderStore.js
export function normalizeGroupBuy(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  if (!r || !r.groupId) return null;
  return { groupId, no, size, unitPrice, groupPrice, productName,
           status: GB_STATUS_TEXT[r.status] ? String(r.status) : 'formed', createdAt };
}
// createOrder 内：
...(normalizeGroupBuy(draft.groupBuy) ? { groupBuy: normalizeGroupBuy(draft.groupBuy) } : {}),
```

### 4. 助力跨阈值才推通知（同档只推一次）

```js
// web/js/store/wishlistStore.js —— help()
const before = helpCount(pub);
pub.helps = [...pub.helps, { scope, at }];
const after = helpCount(pub);
const crossed = WL_TIERS.filter((t) => before < t.threshold && after >= t.threshold);
```

### 5. 结算衔接：团价直接进购物袋 + 草稿 30 分钟 TTL

```js
// web/js/groupBuy.js → 去结算
addToCart({ ...product, price: group.groupPrice }, 1, null);  // 状态层按 product.price 记账
setPendingCheckout(group);
navigate('#/checkout');
// checkout.js finish() → clearPendingCheckout()（留着会污染下一笔普通订单）
```

---

## 四、访问路径

| 路径 | 说明 |
|---|---|
| `#/product/<id>` → 「发起拼团」 | 详情页次要操作区，选 2/3/5 人 → 团价实时预览 → 开团 |
| `#/group-buy` | 拼团大厅，「进行中 / 已结束」两栏 |
| `#/group-buy/<id>` | 团详情：团号、倒计时、成员头像、二维码占位、邀请好友、模拟好友参团、去结算 |
| `#/group-buy/<id>?invite=1` | 分享落地（顶部多了「好友分享」提示条） |
| `#/favorites` | 收藏页顶部「公开心愿单」开关 + 理由编辑 + 复制链接 + 主人通知条 |
| `#/wishlist/<id>` | 公开心愿单，**免登录**；访客可助力，主人可领券 |
| `#/orders` | 拼团单带「拼团」标记 + 团状态胶囊 + 「查看团」 |

---

## 五、验收自检（逐项对照规格）

### 一、拼团

| 规格要求 | 结果 | 证据 |
|---|---|---|
| 详情页「发起拼团」，选 2/3/5 人与 mock 团价（低 10–30%） | ✅ | 三档 `10%/18%/28%`；弹层实时预览；`e2e-group` 断言「团价 = 单买价 × 82%」「团价确实低于单买价」「省 N%」 |
| 生成 mock 团号，状态「待成团」 | ✅ | `GB` + yyMMdd + 4 位序号，同日递增；`/^GB\d{10}$/` 双端断言 |
| `#/group-buy` 列表：进行中、剩余人数、倒计时 | ✅ | 两栏切换；卡片含状态胶囊/团号/团价对比/成员头像/剩余人数/倒计时 |
| `#/group-buy/:id` 详情：团信息、成员头像占位、分享按钮 | ✅ | 圆形占位（昵称首字，不加载真实头像）+ 二维码占位 + 吸底操作条 |
| 拼团分享：mock 链接/二维码，「邀请好友」复制 + 10 积分（与步骤 3 打通） | ✅ | 复制 `#/group-buy/<id>?invite=1`；`recordBehavior('share')` 让积分 `share1` 任务 +1（断言 `progress 0→1`）；文案如实写「任务已记录，去积分页领取」 |
| 不显眼的「模拟好友参团」，人数 +1，满员成团，可进结算 | ✅ | `.gb-sim` 虚线次要按钮；满员后按钮消失、状态转「已成团」、结算按钮解禁 |
| 订单列表标记「拼团」，状态含待成团/已成团/拼团失败 | ✅ | 订单头 `[拼团]` + 团状态胶囊（三态词表齐全且由纯函数推导，见 `check-web` 第 12 条） |

### 二、心愿单助力

| 规格要求 | 结果 | 证据 |
|---|---|---|
| 收藏夹「公开心愿单」开关，开启后生成 mock 分享链接 | ✅ | 开关 + 理由输入 + 复制链接 + 预览公开页 |
| `#/wishlist/:id` 展示商品、理由、助力进度条 | ✅ | 「已获 N 人助力，再 M 人可享奖励」+ 1px 青色进度条 + 阶梯胶囊 |
| 访客点「助力」人数 +1；达阈值主人收到通知并可领券 | ✅ | 每访客一次（重复助力 `reason: 'done'`）；跨阈值推通知；主人领券真进券包（断言券包数 +1） |
| 助力规则与奖励抽成配置，不写死 | ✅ | `WL_TIERS` 只含 `{threshold, couponId}`；断言「阶梯里不含面额字样」+「券必须真实存在于券目录」 |

### 三、数据与样式

| 规格要求 | 结果 | 证据 |
|---|---|---|
| 拼团/助力数据按用户隔离存 localStorage；倒计时用 mock 截止时间 | ✅ | `maison_groupbuy_v1::<scopeId>` / `maison_wishlist_v1::<scopeId>`；截止 = 建团时间 + 24h |
| 拼团卡 surface-1 + 1px 细线；进度条 1px 青色细线；头像圆形占位 | ✅ | 断言直接量 CSS：`background: var(--color-surface-1)`、`border: 1px solid var(--color-hairline-dark)`、`height: 1px` + `background: var(--color-cyan)`、`border-radius: 50%` |
| 移动端单列、分享按钮吸底、热区 ≥44px | ✅ | 390×844 实测：无横向滚动、`.gb-bar` / `.wl-bar` `position: fixed`、按钮高度 44px |

### 四、禁止项

| 禁止 | 结果 | 证据 |
|---|---|---|
| 真实支付 / 真实分享 SDK | ✅ | 断言源码不含 `qrcode|wx\.|window\.open|shareSDK|alipay|wxpay`；二维码为纯 CSS 点阵 |
| 倒计时无限循环导致性能问题 | ✅ | 断言 `groupBuy.js` 里 `setInterval` 恰好 1 处且带 `clearInterval` + `isConnected` 自停；`wishlist.js` 零定时器 |
| 拼团价虚标后无法成团 | ✅ | 团价与档位折扣同源计算并写进快照，结算单价断言等于团价；成团仅需成员数达标（模拟参团可达） |
| 心愿单强制登录才能看公开页 | ✅ | 清掉登录态后仍能打开并渲染（断言 hash 未被重定向、进度卡可见） |

### 五、总体验收

| 项 | 结果 |
|---|---|
| 可发起拼团、生成团号、模拟参团、成团后进结算 | ✅ 62/62 e2e 全过 |
| 拼团订单在订单列表有标记和状态 | ✅ |
| 心愿单可公开、可助力、进度和奖励正确 | ✅ |
| 分享按钮可用（复制 mock 链接） | ✅ 剪贴板读回含 `#/group-buy/gb_...&invite=1` |
| 刷新状态不丢 | ✅ 团状态、助力数、领取标记均持久 |
| 移动端可用 | ✅ |
| 控制台无错误 | ✅ |

---

## 六、断言脚本自身的修复（不是产品问题）

`e2e-group` 首轮 12 条红、`check-web` 首轮 2 条红，全部出在断言脚本上，已逐条修正并留注释：

| 现象 | 真因 | 修法 |
|---|---|---|
| 详情页找不到「发起拼团」 | 商品 id 取自 `store/products.js` 的 mock 库，不在 `views.getProducts()` 的消费者池里 → 页面显示「商品已下架」 | 断言改用与前台一致的取数入口 |
| 大厅 `.gb-card` 超时 | 默认「进行中」栏本来就该是空的（唯一团已成团） | 先断言空态，再切「已结束」栏断言卡片 |
| 开关 `check()` 超时 | input 视觉隐藏（1px + `opacity:0`） | 点可见轨道 `.wl-switch-track` |
| 公开页打不开 | `browser.newPage()` 是**独立 context**，localStorage 为空 | 同一 context 内清 `current_user` 后导航 |
| 主人收不到通知 | 同一 context 里另一个页面改了 storage，主页面停在旧渲染 | 恢复登录态后显式 `reload()` |
| 移动端找不到团 | 新 context 里没有团数据 | 改 `page.setViewportSize()` 复用同一页 |
| 移动端找不到 `.wl-bar` | 主人视角本来就没有助力按钮 | 改用匿名页（访客视角）验 |

**另修 1 条既有脆断言**：对比步骤的 `appSrc.includes("path.startsWith('/compare') ? 'products'")` 逐字匹配了导航表达式，本步往同一个 `products` 桶加 `/group-buy` 后立刻误报「对比接线断了」。改为
`/path\.startsWith\('\/compare'\)[\s\S]{0,140}?'products'/`，仍然验「它归 products 桶」这件事——断言该匹配语义，而不是匹配业务代码的字符相邻。

**自查抓到的真实缺陷 2 处**（已改）：
1. `wishlistConfig.js` 第一版 `import { COUPON_CATALOG } from './couponStore.js'` → 经 `api.js → auth.js` 把 `location` 依赖拖进纯配置层，Node 里 `location is not defined`。改为配置只存 `couponId`，校验下沉到 `validateTiers(catalog)`。
2. 邀请好友的文案原本写「+10 积分」，但机制是把积分 `share` 任务推到「可领取」，积分要用户自己去领。改为「分享任务已记录 · 10 积分在『积分与任务』里领取」。

---

## 七、已知限制

1. **跨浏览器不同步**：拼团分享链接与公开心愿单都依赖同源 localStorage，换浏览器/设备打开会显示「这个团不存在 / 这份心愿单不存在」。没有服务端就不可能真同步，页面如实提示，不做假的实时。
2. **拼团订单通常显示「已成团」**：本演示链路里只有满员后才能结算，所以订单快照基本是 formed。「待成团 / 拼团失败」两态由同一套推导函数产生，用于团列表/详情；订单上保留三态词表是为了团数据被清理后仍能如实回显当时状态。
3. **一笔订单对应一个团**：拼团结算走的是「团价加入购物袋 + 草稿标记」，如果购物袋里还有别的商品，整单都会被标记为拼团。真实业务应做行级归属。
4. **「拼团失败」在 UI 上不可达**：截止时间固定 24h，演示期内无法等到过期。该分支由 `check-web` 用构造的过期时间做纯函数断言（`groupStatus(g, T0 + DAY + 1) === 'failed'`）。
5. **心愿单一 scope 一份**：开关就是「我的收藏夹是否公开」，不支持多份并列心愿单（配置里预留的 `WL_MAX_ITEMS` 只用于公开页截断）。
6. **助力上限 10 人**：最后一个阶梯达标后按钮置灰（再助力没有新增收益）。

---

## 八、全量回归（33 套串行实跑）

| 结果 | 套数 | 说明 |
|---|---|---|
| 通过 | **30** | 含本步新增 `e2e-group`（62/62）、`check-web`（83 模块 + 24 条新断言） |
| 外部噪音 | 3 | `e2e-discovery` 45/46、`e2e-merchant` 26/27，各自只差「控制台无 JS 错误」1 条，报错是外部演示图 `net::ERR_CONNECTION_CLOSED`；`e2e-ai-panel` 42/43 差「关闭热区 ≥44px 实测 43.9998px」（上一轮已定位为父层 `matrix(0.999995)` 动画残差，属断言缺 0.01 级容差，**上一轮范围内的问题，本步未改**） |

断言合计：**1290 条通过 / 3 条已知噪音**。第二批 16 套是在本地网关（`http://127.0.0.1:8080`，`/health` 200）起来后跑的，含 `e2e-merchant-apply` 42/42。

---

## 九、闸门快照

| 闸门 | 结果 |
|---|---|
| `node scripts/check-web.mjs` | ✅ 83 模块全部加载，三块断言（积分 22 / 盲盒 24 / 对比 23 / 拼团 24）全绿 |
| `node scripts/e2e-group.mjs` | ✅ 62/62 |
| 控制台 | ✅ 无 JS 错误 |
| 移动端 390×844 | ✅ 无横向滚动，吸底条就位，热区 44px |
| 刷新持久化 | ✅ 团状态 / 助力数 / 领取标记均保持 |
| 对比与盲盒零改动 | ✅ 源码断言守着 |
| 真实支付 / 分享 SDK | ✅ 不存在 |
| 定时器 | ✅ 全站本步只新增 1 个 `setInterval`，带清理 |
| 硬编码密钥 | ✅ 无（`.env.example` 未涉及本步） |
