# AI 购物助手 · 全栈 Demo（Route A）

> 一个融合 **6 大 AI 能力** 的电商购物应用：AI 导购、智能客服、商品问答、智能搜索、运营文案、订单售后。
> 前端为**原生零构建**静态站点（HTML + CSS + ES Module），后端 `ai-gateway` 采用「local 降级 / docker 真实服务」双模式。
>
> 🔗 在线演示：<https://qqhjw12.github.io/ai-shopping-app/> （GitHub Pages 自动部署，默认演示模式，可 `?api=` 接入本地网关）

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [数据层与对话引擎](#数据层与对话引擎)
  - [SQLite 数据库（local 模式）](#sqlite-数据库local-模式)
  - [购物交易链路（后端）](#购物交易链路后端)
  - [收货地址跨设备（服务端为准）](#收货地址跨设备服务端为准)
  - [对话引擎（srcserviceschatenginejs）](#对话引擎srcserviceschatenginejs)
- [系统架构](#系统架构)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
  - [方式 A：本地零依赖演示（推荐先跑这个）](#方式-a本地零依赖演示推荐先跑这个)
  - [方式 B：Docker 真实服务（Qdrant / ES / Ollama / Dify / mall）](#方式-bdocker-真实服务qdrant--es--ollama--dify--mall)
  - [方式 C：HTTPS 反向代理（nginx 一键脚本）](#方式-chttps-反向代理nginx-一键脚本)
- [环境变量](#环境变量)
- [API 一览](#api-一览)
  - [推荐来源埋点（全链路数据闭环）](#推荐来源埋点全链路数据闭环)
- [买家秀对象存储（预签名 URL）](#买家秀对象存储预签名-url)
  - [真实商品数据导入（合规开放数据源）](#真实商品数据导入合规开放数据源)
- [部署演示站点（GitHub Pages + Actions）](#部署演示站点github-pages--actions)
- [商品视觉（程序化 SVG）](#商品视觉程序化-svg)
- [演示模式（前端离线兜底）](#演示模式前端离线兜底)
- [本地自检](#本地自检)
- [安全与配置](#安全与配置)
- [许可证](#许可证)

---

## 项目简介

本仓库是「宏之蓝 / macrozheng mall」生态的一个 AI 增强示例（Route A）：

- **后端 `ai-gateway`**：Node.js（ESM）网关，提供商品检索、AI 导购/客服/问答流式接口，以及对 Dify 中枢的编排。
  - `RUN_MODE=local`：内置 **SQLite 数据库**——示例种子 256 款，经 `npm run db:ingest` 已灌入真实开放数据商品至 **12313 款 / 12639 SKU / 36939 评价 / 3210 品牌**（含食品生鲜 12023 款、带真实商品图 12057 款）+ 本地哈希嵌入 + 本地对话引擎，**零外部依赖即可演示**。
  - `RUN_MODE=docker`：接入真实 Qdrant（向量）、Elasticsearch（关键词）、Ollama（嵌入）、Dify（智能客服 / 商品问答 / 导购 Agent / 运营文案 / 订单售后），失败自动降级。
- **前端 `web/`**：原生 ES Module 单页应用，hash 路由、购物车服务端持久化（离线回落 localStorage）、AI 浮窗（导购/客服/问答均 SSE 逐字渲染）、商品详情深链分享（含来源埋点）、程序化生成的 SVG 商品图。

适合作为**作品集 / 面试项目**：架构清晰、工程规范、可一键本地演示，也能切换到生产级 docker 栈。

---

## 功能特性

| 模块 | 入口 | 说明 |
|------|------|------|
| 🔍 智能搜索 | 顶栏搜索 | 向量 + 关键词混合检索，首页 / 列表 / 搜索页通用 |
| 📦 商品详情 | `#/product/:id` | 真实路由，可深链分享；SKU 规格切换联动价格库存、服务承诺、相关推荐、来源渠道色条与埋点；评价区支持 **写评价 / 买家秀上传 / 追评 / 有用投票**（走网关 API 持久化，断网自动降级 localStorage） |
| 🗂️ 分类浏览 | `#/categories` | 16 个一级类目 + 48 个二级类目，每个类目用真实商品封面拼图，点进即按类目筛选 |
| 🛒 商品列表 | `#/products` | 侧边栏两级类目 / 价格区间 / 品牌筛选 + 6 种排序，筛选条件全走 URL 可分享 |
| 🛒 购物车 | 顶栏购物车抽屉 | 服务端持久化，换设备/清缓存不丢；数量增减（受库存夹逼，边界置灰）、行内小计、删除后可撤销、金额明细与「再买 ¥X 包邮」提示、库存不足拦截结算 |
| 🧾 结算下单 | `#/checkout` | 收货地址（**与个人中心共用同一份地址簿，服务端存储、跨设备同步**；可新增，离线落本机待联网补推）+ 优惠券（自动选中省得最多的那张、不可用券显示差额）+ 商品清单内直接改数量/删除 + 金额明细（含「再买 ¥X 包邮」）+ 提交订单（防重复点击）+ 支付 |
| 📦 我的订单 | `#/orders` | 订单状态机（待支付/已支付/已发货/已完成）、去支付、再次购买、物流信息 |
| ❤️ 我的收藏 | `#/favorites` | 服务端收藏夹，详情页「♡ 收藏」同步，可取消 |
| 🎨 商品视觉 | 全局 | **程序化 SVG 商品图**：按商品数据生成「渐变底 + 类目线稿」，零外部依赖、离线可用 |
| 📊 分析看板 | 顶栏「📊 分析」 | 渠道占比 / 行为分布 / Top 商品 / 最近事件流，按渠道着色，数据来自埋点聚合 |
| 🤖 AI 导购 | 浮窗「导购」 | 一句话需求 → 导购话术（SSE 逐字）+ 商品卡片 |
| 💬 智能客服 | 浮窗「客服」 | 多轮对话（SSE 逐字），可接 Dify 知识库 |
| ❓ 商品问答 | 浮窗「问答」/ 详情页「问我这件商品」 | 按商品聚焦问答，SSE 逐字 + 关联商品卡片 |
| ✍️ 运营文案 | AI 工具箱 | 多版本标题 / 详情 / 种草文案（多平台语气） |
| 🛠️ 订单售后 | AI 工具箱 | 按用户 ID / 订单号查单 + 退换货指引 |

---

## 数据层与对话引擎

### SQLite 数据库（local 模式）

用 Node 22 内置的 `node:sqlite`，**零依赖、零安装、单文件持久化**（`ai-gateway/data/shop.db`），开启 WAL 与外键约束，结构通过版本化迁移管理（`PRAGMA user_version`）。

| 表 | 用途 |
|---|---|
| `categories` | **两级类目树**：16 个一级（手机数码 / 电脑办公 / 音频耳机 / 家用电器 / 服饰鞋包 / 食品生鲜 / 家居家具 / 运动户外 / 美妆个护 / 母婴玩具 / 图书文娱 / 厨具餐具 / 宠物用品 / 车载出行 / 健康保健 / 办公文具）+ 48 个二级（自引用 `parent_id`） |
| `brands` | 品牌（23 个，从商品派生，带主营类目与程序化 logo 色） |
| `products` | 商品主数据（256 款示例；可经 `db:ingest` 追加真实开放数据商品，含品牌 / 现价 / 原价 / 标签 / 评分 / 销量 / 封面渐变色 / 一句话卖点 / 服务承诺 / **二级类目** / 真实商品图 URL `image_url`） |
| `product_skus` | 规格变体与库存（150 个 SKU，按阶梯定价） |
| `users` / `addresses` | 演示用户与收货地址（下单时自动为新用户建档 + **三张体验优惠券**，避免新访客卡包为空导致优惠券区永远显示「暂无可用」）。地址按 `user_id` 隔离存在服务端，同一账号换设备登录即跟随；迁移 v8 补齐 `province` / `city` / `postal` / `updated_at`，老数据按 `region` 空格自动回填省市 |
| `orders` / `order_items` | 订单与订单项（含物流公司、运单号、状态机、金额拆分） |
| `reviews` | 商品评价（**768 条，覆盖全部 256 款**，每款 3 条带作者与星级，供问答引用口碑）。迁移 v6 起支持 `parent_id`（追评）/ `images`（买家秀）/ `sku_spec` / `source` |
| `review_votes` | 有用投票：主键 `(review_id, user_id)`，天然幂等——同一用户重复请求在「赞 / 取消」间切换 |
| `cart_items` | 购物车（服务端持久化，按 user+sku 唯一，重复加购累加） |
| `favorites` | 收藏夹 |
| `coupons` / `user_coupons` | 优惠券模板与用户卡包（满减 / 折扣，领用核销） |
| `faqs` / `policies` | 客服 FAQ 与退换货 / 物流 / 质保 / 发票 / 支付政策 |
| `conversations` / `messages` | 会话与消息（多轮上下文、可回放，重启不丢） |
| `track_events` | 埋点事件（替代原内存环形缓冲，聚合走 SQL） |

种子规模：**256 商品（示例）/ 556 SKU / 16 一级类目 / 48 二级类目 / 23 品牌 / 768 评价 / 7 订单 / 8 FAQ / 5 政策 / 6 张券**。执行 `npm run db:ingest` 后可扩至 **12313 商品 / 12639 SKU / 3210 品牌 / 36939 评价**——其中 Free-Ecommerce 50 款 + Open Food Facts 12007 款真实商品（食品生鲜 12023 款，全部带真实商品图）。
`npm run db:seed` 幂等灌数据，`npm run db:reset` 清空重灌；两端都在启动时自动执行迁移 + 缺数据才种子。

### 购物交易链路（后端）

`/api/cart` → `/api/orders/preview` → `/api/orders` → `/api/orders/:id/pay`，全流程落在 SQLite：

- **下单在一个事务里完成**：校验库存 → 算钱（商品小计 / 运费 / 优惠）→ 扣 SKU 库存 → 建订单与订单项 → 清空已购购物车项 → 核销优惠券。任一环节失败全部回滚。
- **运费规则与 FAQ 政策一致**：满 99 包邮，否则 10 元（券前/券后金额以商品小计减优惠后判定）。
- **库存不足返回 409** 并提示剩余件数，而非静默失败；重复支付返回 409，订单按 `userId` 隔离（查他人订单 404）。。

### 收货地址跨设备（服务端为准）

同一个手机号/邮箱登录出来的 `userId` 是稳定的（由标识哈希得出），地址簿按 `userId` 存在服务端 `addresses` 表，所以**同一账号换设备登录，地址自动跟随**。

前端的读写策略是「缓存先出、服务端校准」：

| 时机 | 行为 |
|---|---|
| 进入个人中心 / 结算页 | 先用 localStorage 缓存秒开（不闪骨架），同时 `GET /api/addresses` 拉服务端覆盖缓存 |
| 新增 / 编辑 / 设默认 / 删除 | 乐观写缓存 → 调 API → 用服务端返回的清单覆盖；业务错误（400/404/409）回滚本地并提示 |
| 网关不可达 | 保留本地结果并标记 `pending: true`（卡片显示「仅本机」），下次进入页面自动逐条补推 |

几条不显眼但必要的约束：

- **默认地址有且仅有一条**：新增/更新/删除后由服务端 `settleDefault` 收敛（删掉默认项时剩余第一条接任），不靠前端自觉。
- **删除是软删除**：`orders.address_id` 外键指向 `addresses`，硬删会被外键挡下（下过单的用户永远删不掉那条地址）。迁移 v9 起改为打 `deleted_at` 时间戳、列表查询过滤——用户视角就是「已删除」，历史订单仍能追溯，软删除的条目也不占 20 条上限。
- **越权改不到别人的地址**：更新/删除都是 `WHERE id = ? AND user_id = ?` 双条件，拿别人地址 id 请求返回 404。
- **只传 `region` 也能存**：结算页的地区是单个输入框，服务端会按空格拆出 `province` / `city`，否则回个人中心编辑时省份下拉选不中、再保存一次就把地区写丢。
- **`ensureUser` 不再自动塞示例地址**：否则每次登录都会凭空多一条「游客 · 示例路 1 号」，跨设备后尤其刺眼。兜底只在「结算时地址簿为空」这一处发生。
- **结算页与个人中心共用一份存储**：`loadAddresses` 直接委托地址簿模块，不再各自维护一份，避免「个人中心加了地址、结算页看不到」。

### 对话引擎（`src/services/chatEngine.js`）

**先检索真实数据，再组织语言**——价格、库存、物流、政策一律查 SQLite，绝不交给模型编造。

```
用户输入 → 意图识别 → SQLite 检索 → 事实草稿 ─┬─ 未配 LLM：直接作为答案（规则模板）
                                              └─ 配了 LLM：连同商品/政策/订单上下文喂给模型润色
```

| 意图 | 触发示例 | 数据来源 |
|---|---|---|
| `greeting` / `thanks` | 你好 / 谢谢 | 类目与商品统计 |
| `recommend` | 预算1500的降噪耳机、送礼500以内 | 预算 + 类目 + 标签多条件 SQL |
| `price` / `stock` | 声海耳机多少钱 / 有货吗 | `products` + `product_skus` |
| `compare` | 这两款哪个好 | 双商品对比（价格/评分/销量/标签） |
| `logistics` | SO2026… 到哪了、我买的笔记本到哪了 | `orders` + `order_items`（按商品名匹配订单） |
| `aftersale` | 七天无理由怎么退、保修多久、开发票 | `policies` + `faqs` + 订单状态 |
| `product-detail` | 详情页「问我这件商品」 | 商品详情 + SKU + 真实评价 |

要点：

- **中文关键词匹配**：没有分词器，就用「商品标签 + 品牌 + 类目 + 常见名词」组词表做最长匹配，`预算1500的降噪耳机` 能正确命中「降噪」而不是整句 LIKE。
- **多轮上下文**：预算 / 类目 / 上次商品写入 `conversations.context`，所以「有货吗」「那便宜点的呢」能承接上文。
- **LLM 可选且可降级**：配 `LLM_API_KEY` 走 OpenAI 兼容协议（支持 SSE 流式）；模型调用失败自动回退本地引擎，服务不会因此不可用。商品卡片始终由网关检索产出，不依赖模型。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器（web/ 原生 ES Module 单页应用）                       │
│   hash 路由 · 购物车(服务端+离线镜像) · AI 浮窗(SSE 逐字)   │
│   程序化 SVG 商品图 · 结算/订单/收藏 · hash 来源埋点          │
└───────────────┬─────────────────────────────────────────────┘
                │  fetch /api/*（同源 或 ?api= 覆盖）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  ai-gateway (Node.js ESM)                                    │
│  ├─ /api/products · /api/products/:id · /api/search          │
│  ├─ /api/cart · /api/orders · /api/favorites · /api/coupons   │
│  ├─ /api/ai/{guide,chat,qa,copywrite,aftersale}  (SSE 流式)  │
│  ├─ 混合检索: vectorStore(Qdrant) + searchStore(ES)          │
│  ├─ SQLite: 商品/SKU/订单/购物车/收藏/券/会话/埋点            │
│  ├─ 对话引擎: 意图识别 + SQL 检索 (+ 可选 LLM 润色)          │
│  └─ Dify 编排: 客服 / 问答 / 导购 Agent / 文案 / 售后         │
└───────┬───────────────────────┬──────────────────────────────┘
        │ (docker 模式)          │ (可选) HTTPS 终止 + 注入 API Key
        ▼                        ▼
 Qdrant · ES · Ollama      nginx 反代 (TLS, X-API-Key 注入)
        │
     Dify（智能体 / 知识库 / 工作流）
        │
     mall（macrozheng/mall 商品 & 订单，mall-ai 模块回调）
```

**设计要点**

- 前端零构建、后端分层（控制器 / 服务 / 仓储），配置全部来自环境变量并在启动时校验。
- 双模式契约：`local` 保证任何环境都能跑起来；`docker` 接真实向量/搜索/LLM 与 Dify，未就绪时自动降级。
- 流式统一用 `text/event-stream`：网关逐段回传 `data: {"text":"…"}`，末事件携带结构化数据，最后 `data: [DONE]`；未启用流式时回退为普通 JSON（前端 `streamApi` 自动兼容）。

---

## 技术栈

- **前端**：原生 HTML + CSS + ES Module（无框架、无打包器）；hash 路由、Fetch + SSE。
- **后端**：Node.js 20+（ESM，仅用内置模块 + 少量依赖）；`http` 自建服务，分层架构。
- **本地数据**：SQLite（Node 22 内置 `node:sqlite`，零依赖零安装，单文件持久化 + 版本化迁移）。
- **对话**：内置意图识别 + SQL 检索引擎；可选接 OpenAI 兼容大模型（DeepSeek / 通义 / Kimi / OpenAI）。
- **检索 / 模型**：Qdrant（向量）、Elasticsearch（关键词）、Ollama（嵌入，可换 `local` 哈希嵌入）。
- **AI 中枢**：Dify（智能客服 / 商品问答 / 导购 Agent / 运营文案 / 订单售后 工作流）。
- **电商底座**：macrozheng/mall（商品 & 订单）+ `mall-ai` 自定义模块。
- **运维**：Docker Compose（网关 / Qdrant / ES / Ollama / Dify / mall）、nginx 反代一键脚本（TLS 终止 + API Key 注入）。
- **部署**：GitHub Pages + GitHub Actions（自动发布 `web/`）。

---

## 目录结构

```
.
├── web/                     # 原生零构建前端（静态站点，可直托 GitHub Pages）
│   ├── index.html
│   ├── styles.css
│   └── js/                  # api / state / ui / router / views / assistant / tools / app
│       ├── art.js           # 程序化商品图：双色渐变 + 16 类目线稿（SVG）
│       ├── categories.js    # 分类浏览页（两级类目 + 商品封面拼图）
│       ├── checkout.js      # 结算页：地址 + 优惠券 + 金额明细 + 提交 + 支付
│       ├── account.js       # 我的订单 / 我的收藏
│       ├── track.js         # 埋点上报（fire-and-forget）+ stats 拉取
│       ├── analytics.js     # 分析看板（渠道占比 / 行为分布 / Top 商品 / 事件流）
│       ├── demo.js          # 演示模式标志（网关不可达时置位）
│       ├── demo-data.js     # 内置示例商品库（离线兜底，由 catalog 生成，256 款）
│       └── demo-real-data.js # 真实开放数据商品（离线兜底，由 ingest-real-data.mjs 生成）
├── ai-gateway/              # Node.js 后端网关（local / docker 双模式）
│   ├── src/
│   │   ├── db/              # SQLite：connection / schema(版本迁移 v1-v3) / seedDb(种子)
│   │   ├── repositories/    # 仓储层：product / order / conversation / track
│   │   │                    #          cart(购物车) / user(收藏·券·地址)
│   │   ├── storage/         # 买家秀对象存储：s3Client(SigV4 手写) / index(驱动门面+签名解析)
│   │   ├── services/        # chatEngine(对话引擎) / llmClient(可选大模型)
│   │   │                    #          orderService(下单事务·金额·库存)
│   │   ├── data/catalog.js  # 商品目录种子（256 款 / 16 一级类目 / 48 二级 / 556 SKU / 768 评价）
│   │   └── server / config / middleware / search / copywrite / aftersale …
│   ├── data/shop.db         # 本地数据库（gitignore，可 db:reset 重建）
│   ├── Dockerfile
│   └── dify-workflows/      # Dify 工作流 spec（售后 / 文案）
├── mall-ai/                 # macrozheng/mall 的 AI 增强模块（Java）
├── nginx/                   # 反代模板（envsubst，密钥不入库）
├── scripts/                 # dev-local.sh(一键起前后端) / dev-storage.sh(本地 S3 替身)
│                            #   / dev_server.py·static-server.mjs(静态开发服务)
│                            #   / check-web.mjs(前端自检) / setup-https-proxy.sh / setup-mall-ai-env.sh
├── docker-compose*.yml      # 网关 / nginx / dify / 全家桶
├── docs/                    # 实施记录与方案文档
├── .env.example             # 环境变量模板（真实密钥勿提交）
├── .gitattributes           # 统一换行符（eol=lf）
├── LICENSE                  # MIT
└── README.md                # 本文件
```

---

## 快速开始

### 方式 A：本地零依赖演示（推荐先跑这个）

无需 Docker、无需安装数据库：网关内置 **SQLite**（Node 22 自带 `node:sqlite`）与**本地对话引擎**，首次启动自动建表并灌入 256 款商品。

**一键启动（推荐）**：

```bash
bash scripts/dev-local.sh
# 网关 :8080 + 前端 :5500 一起起，就绪后打印访问地址；Ctrl+C 一并停止
```

脚本做的事：起网关 → 轮询 `/health` 直到就绪（最多 20s，失败直接报错并给出日志位置）→
起静态前端 → 轮询 `index.html` 确认能访问 → 打印横幅。端口被占用时会直接告诉你怎么换端口/查占用进程。

可调环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 网关端口 |
| `WEB_PORT` | `5500` | 前端端口 |
| `WEB_BIND` | `127.0.0.1` | 前端绑定地址（局域网调试可设 `0.0.0.0`） |
| `SKIP_GATEWAY` | `0` | 设 `1` 只起前端（网关已在跑或连远程网关时用） |

```bash
PORT=9090 WEB_PORT=5501 bash scripts/dev-local.sh   # 换端口
SKIP_GATEWAY=1 bash scripts/dev-local.sh            # 只起前端
```

手动分两步：

```bash
# 1) 启动后端网关（local 模式，默认 :8080）
cd ai-gateway
npm start            # 等价于 node --disable-warning=ExperimentalWarning src/server.js
#    首次启动会自动建库 + 种子：data/shop.db（256 商品 / 556 SKU / 48 二级类目 / 订单 / 评价 / FAQ）

# 2) 另开终端，启动静态前端（任意静态服务器均可）
python scripts/dev_server.py --port 5500 --directory web   # 有 Python 用它（推荐）
node scripts/static-server.mjs --port 5500 --root web      # 没 Python 的等价实现

# 3) 打开浏览器
#    同源时直接访问 http://localhost:5500
#    跨端口时显式指定网关：http://localhost:5500/?api=http://localhost:8080
```

> 为什么不用 `python -m http.server`：它依赖系统 mimetypes，Windows 上常把 `.js` 报成
> `text/plain`，ES Module 会被浏览器以严格 MIME 检查拒绝执行；也不会发 `no-store`，
> 改完 CSS/JS 容易拿到缓存旧版。`scripts/dev_server.py` 与 `scripts/static-server.mjs`
> 都强制 `text/javascript` + `Cache-Control: no-store`，并拦截 `.git`/`.env` 等隐藏路径。
> `dev-local.sh` 优先用 Python，Python 缺失或启动失败会自动降级到 Node 版本。

数据库维护命令：

```bash
npm run db:seed      # 幂等：缺数据才灌
npm run db:reset     # 清空业务表后重灌（商品/订单/评价/FAQ/会话/埋点）
```

冒烟测试：

```bash
curl -s http://localhost:8080/api/products | head
curl -s -X POST http://localhost:8080/api/search -H 'Content-Type: application/json' \
  -d '{"query":"降噪耳机","topK":3}'
curl -s -N -X POST http://localhost:8080/api/ai/guide -H 'Content-Type: application/json' \
  -d '{"message":"预算1500的降噪耳机","userId":"demo","stream":true}'
# 多轮：把上一轮返回的 conversationId 带上，即可承接上下文
curl -s -N -X POST http://localhost:8080/api/ai/chat -H 'Content-Type: application/json' \
  -d '{"message":"有货吗","userId":"demo","conversationId":"<上一步的 id>","stream":true}'
```

**想让 AI 更聪明？** 在 `.env` 里填三行即可从「内置引擎」升级为真大模型（OpenAI 兼容，DeepSeek / 通义 / Kimi / OpenAI 均可）：

```bash
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxxxxxx
LLM_MODEL=deepseek-chat
```

### 方式 B：Docker 真实服务（Qdrant / ES / Ollama / Dify / mall）

```bash
# 复制并填写 .env（至少配置 Dify 相关 App Key 才会切换真实流式）
cp .env.example .env
# 编辑 .env：RUN_MODE=docker，填入 DIFY_*_API_KEY 等

# 启动全家桶（网关 + Qdrant + ES + Ollama + Dify + mall）
docker compose -f docker-compose.yml up -d
# 仅网关 + 依赖（不含 Dify/mall）：
docker compose -f docker-compose.yml up -d ai-gateway qdrant elasticsearch ollama
```

> 未配置 Dify Key 时，网关自动从真实检索降级为本地模拟，保证可用。

### 方式 C：HTTPS 反向代理（nginx 一键脚本）

脚本会读取 `.env` → 生成自签名证书 → 启动 nginx（TLS 终止）并在网关侧**注入 API Key**（覆盖客户端自带头，防伪造），自动设置 `TRUST_PROXY` 与 `CORS_ORIGINS`：

```bash
bash scripts/setup-https-proxy.sh
# 浏览器打开 https://localhost:8443/  （自签名证书，首次需手动信任）
```

---

## 环境变量

所有配置来自环境变量，模板见 [`.env.example`](.env.example)。关键项：

| 变量 | 说明 |
|------|------|
| `RUN_MODE` | `local`（降级演示） / `docker`（真实服务） |
| `DB_FILE` | SQLite 数据文件路径，默认 `data/shop.db`（相对 `ai-gateway/`） |
| `LLM_API_KEY` | 可选。填写后启用 OpenAI 兼容大模型；留空走内置对话引擎 |
| `LLM_BASE_URL` / `LLM_MODEL` | 大模型地址与模型名（默认 DeepSeek） |
| `EMBEDDING_PROVIDER` | `local`（哈希嵌入，零依赖） / `ollama` |
| `DIFY_*_API_KEY` | 各 AI 模块的 Dify App Key（配置后启用真实流式） |
| `CORS_ORIGINS` | 显式允许来源，**生产严禁 `*`**；留空仅放行本地演示来源 |
| `AI_GATEWAY_API_KEY` | 设置后所有业务接口需 `X-API-Key`；留空则对外开放（仅限演示） |
| `RATE_LIMIT_PER_MIN` | 每 IP 每分钟限流（0 = 不限流） |
| `UPLOAD_MAX_BYTES` / `UPLOAD_RATE_PER_MIN` / `UPLOAD_DAILY_QUOTA` / `UPLOAD_MAX_CONCURRENT` | 上传加固：单张字节上限 / 每用户每分钟次数 / 每用户 24h 配额 / 全局并发上限 |
| `AUTH_JWT_SECRET` | 访问令牌 HS256 密钥，**生产必须配置**；local 留空会生成临时密钥（重启后令牌失效） |
| `AUTH_ACCESS_TTL_SEC` / `AUTH_REFRESH_TTL_SEC` | 访问令牌（默认 900s）/ 刷新令牌（默认 14 天）有效期 |
| `AUTH_REQUIRED` / `AUTH_COOKIE_SECURE` | 是否强制业务接口带令牌 / 刷新 Cookie 是否加 `Secure`（生产 HTTPS 置 true） |
| `HTTPS_PORT` / `DOMAIN` | nginx 反代对外端口与域名 |

---

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/products` | 商品列表（含封面色 / 卖点 / 评分 / 销量）；筛选 `category`/`sub`/`brand`/`minPrice`/`maxPrice`/`sort`(default·sales·price_asc·price_desc·rating·new)/`limit`/`offset`，返回 `{ total, count, products }` |
| GET  | `/api/products/:id` | 商品详情（含 SKU、评价、相关推荐） |
| GET  | `/api/products/:id/reviews` | 评价列表：`userId`/`filter`(all·good·mid·bad)/`sort`(latest·helpful)/`limit`/`offset`，返回 `{ reviews, summary, hasMore }`，追评嵌套在主评价的 `followUps` 内 |
| POST | `/api/reviews` | 发布评价；带 `parentId` 即追评。`{ productId|parentId, userId?, author?, rating?, content, skuSpec?, images? }` |
| POST | `/api/reviews/:id/helpful` | 有用投票 `{ userId }`，幂等：再请求一次即取消，返回 `{ voted, helpful }` |
| DELETE | `/api/reviews/:id` | 删除**本人**评价（校验归属，种子数据不可删）：级联删追评与投票、回滚商品评分，并回收图片对象，返回 `{ deleted, followUpsDeleted, imagesRemoved }` |
| POST | `/api/reviews/upload` | 买家秀上传 `{ data: base64, userId? }`，≤`UPLOAD_MAX_BYTES`（默认 6MB），返回 `{ key, url, expiresIn }`；类型 JPG/PNG/WebP/GIF（文件头校验）；受「每用户频率 + 每日配额 + 全局并发」保护，超限返回 429/503 |
| POST | `/api/auth/login` | 登录（演示项目无密码，`userId` 即身份）：`{ userId?, nickname? }` → `{ accessToken, expiresIn, user }`，刷新令牌写入 **HttpOnly Cookie** |
| POST | `/api/auth/refresh` | 用 Cookie 内刷新令牌换新访问令牌；**每次刷新轮换**，旧令牌作废，重放已用令牌则整族撤销（401） |
| POST | `/api/auth/logout` | 作废当前刷新令牌并清 Cookie |
| GET  | `/api/auth/me` | 携带 `Authorization: Bearer <accessToken>` 返回当前用户 |
| GET  | `/api/uploads/:name` | 读取**历史**买家秀（`STORAGE_DRIVER=local` 时的落盘位置；文件名 UUID + 白名单扩展名） |
| GET  | `/api/categories` | 类目列表（带商品数）；加 `?tree=1` 返回两级树与各类目商品数 |
| GET  | `/api/brands` | 品牌列表（可按 `category` 过滤，带商品数） |
| GET  | `/api/stats` | 站点规模概览：商品 / SKU / 类目 / 二级类目 / 品牌 / 评价数 |
| POST | `/api/search` | 混合检索 `{ query, topK }` |
| GET  | `/api/cart?userId=` | 购物车（服务端持久化） |
| POST | `/api/cart` | 加购 `{ userId, productId, skuId?, qty }`，返回最新购物车 |
| PATCH | `/api/cart` | 改数量 `{ userId, itemId, qty }`（≤0 视为移除） |
| DELETE | `/api/cart` | 带 `itemId` 删单项，否则清空 |
| POST | `/api/orders/preview` | 结算预览（不算钱不写库）：商品小计 / 运费 / 优惠 / 实付 |
| POST | `/api/orders` | 下单（事务：校验库存→扣库存→建单→清购物车→核销券） |
| GET  | `/api/orders?userId=` | 我的订单列表 |
| GET  | `/api/orders/:id?userId=` | 订单详情（按用户隔离） |
| POST | `/api/orders/:id/pay?userId=` | 支付（演示：pending → paid，幂等） |
| GET  | `/api/favorites?userId=` | 收藏列表 |
| POST | `/api/favorites` | 收藏切换 `{ userId, productId }`，返回 `favorited` |
| DELETE | `/api/favorites` | 取消收藏 `?userId=&productId=` |
| GET  | `/api/coupons?userId=&amount=` | 卡券包（标注可用性与可省金额） |
| POST | `/api/coupons` | 领券 `{ userId, couponId }` |
| GET  | `/api/addresses?userId=` | 收货地址列表（默认地址排首位，含 `province` / `city` / `region` / `postal`） |
| POST | `/api/addresses` | 新增/更新地址 `{ userId, id?, receiver, phone, province, city, detail, postal?, isDefault? }`；带 `id` 即更新，返回 `{ id, created, addresses }` |
| POST | `/api/addresses/:id/default?userId=` | 设为默认（幂等，默认地址始终有且仅有一条） |
| DELETE | `/api/addresses/:id?userId=` | 删除地址（软删除，历史订单仍可追溯）；删掉默认地址后由剩余第一条接任，返回最新清单 |
| POST | `/api/ai/guide` | AI 导购（SSE）`{ message, userId, stream }` |
| POST | `/api/ai/chat` | 智能客服（SSE）`{ message, userId, conversationId, stream }` |
| POST | `/api/ai/qa` | 商品问答（SSE）`{ query, userId, productId, stream }` |
| POST | `/api/ai/copywrite` | 运营文案 `{ product, sellingPoints, tone, platform, count }` |
| POST | `/api/ai/aftersale` | 订单售后 `{ userId, orderId, query }` |
| POST | `/api/track` | 推荐来源埋点 `{ event, source?, productId?, userId?, meta? }`（202 异步落库） |
| GET  | `/api/track/stats` | 多维聚合 `?productId=&source=`，返回 `{ total, byEvent, bySource, byProduct, recent }` |
| GET  | `/health` · `/ready` | 健康检查 / 依赖探针 |

> 流式响应格式：`data: {"text":"…"}` 逐段 → `data: {"products"/"results"/"conversationId", mode}` 结构化 → `data: [DONE]`。

### 推荐来源埋点（全链路数据闭环）

详情页支持深链 `#/product/:id?from=<渠道>`，进入即**自动上报** `view_product` 事件，并渲染一条按渠道区分颜色的**来源色条**；详情页还会 best-effort 展示「共 N 次浏览，最多来自 X」的渠道分析。顶栏「📊 分析」进入 `#/analytics` 看板，可看全站渠道占比、行为分布、Top 商品与最近事件流。

**事件（全链路 6 类）**

| 事件 | 触发点 | 携带 source |
|------|--------|-------------|
| `view_product` | 进入商品详情页 | 首页 / 列表 / 搜索 / 导购 / 相关推荐 / 分析看板 |
| `search` | 搜索页产出结果 | `search`（meta 带 query + 命中数） |
| `add_to_cart` | 商品卡片 / 详情页加购 | 该商品所在渠道 |
| `guide_recommend_click` | 点击 AI 导购推荐卡 | `guide` |
| `qa_recommend_click` | 点击商品问答推荐卡 | `qa` |
| `share` | 复制分享链接 | 当前详情页来源 |

**渠道与配色**（`SOURCE_META`，前端色条 / 看板 / 归因共用一套）

| 渠道 | 文案 | 色值 |
|------|------|------|
| `home` | 首页精选 | `#2e7d32` |
| `list` | 商品列表 | `#1565c0` |
| `search` | 智能搜索 | `#ef6c00` |
| `guide` | AI 导购推荐 | `#6a1b9a` |
| `rec` | 相关推荐 | `#00838f` |
| `qa` | AI 问答推荐 | `#ad1457` |
| `analytics` | 分析看板 | `#455a64` |

**实现要点**

- **前端**：`web/js/track.js` 为 fire-and-forget 上报（`retries:0`，失败静默，同 `event+source+productId` 2s 内去重）；`web/js/analytics.js` 渲染看板，网关不可达时显示友好空状态而非报错。
- **后端**：`POST /api/track` 返回 `202` 后异步落库——`docker` 模式写 **Elasticsearch**（索引 `<esIndex>_events`，默认 `products_events`，启动时 best-effort 预建 keyword/date 映射模板）；`local` 模式写**内存环形缓冲**（上限 1000，演示用，重启清空）。`GET /api/track/stats` 提供聚合，`docker` 模式走 ES `terms` + `top_hits`，`local` 模式走 JS 聚合。
- **安全**：埋点失败不影响浏览；ES 写入带 2s 超时与 best-effort 容错，绝不阻塞主请求；埋点内容仅含事件名/渠道/商品 ID/匿名 userId，不含密码与令牌。

---

## 买家秀对象存储（预签名 URL）

评价图片不直接暴露存储，走「入库存键、读取现签」：

```
浏览器 ──base64──▶ 网关校验(6MB/文件头/扩展名) ──▶ 对象存储(S3)
                                                    │
浏览器 ◀── <img src=预签名URL> ◀── 评价接口现签 ◀── key(库里只有这个)
```

**为什么库里只存 key 不存 URL**：预签名 URL 有有效期（默认 900s），存下来第二天就是一堆死链。
键形如 `reviews/2026/10/<uuid>.jpg`，每次列表/详情返回时现签一次，有效期由 `MEDIA_URL_TTL_SECONDS` 控制。

### 本地怎么跑（不需要 Docker）

```bash
bash scripts/dev-storage.sh      # 起 S3 兼容替身（SeaweedFS all-in-one，单文件二进制）
                                 # 首次运行自动下载；默认 :8333，开鉴权（匿名访问 403）
```

脚本会把该用的环境变量打印出来，写进 `ai-gateway/.env` 即可（`dev-local.sh` 会自动加载）：

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=http://127.0.0.1:8333
S3_REGION=us-east-1
S3_BUCKET=review-media
S3_ACCESS_KEY_ID=shopdevaccess
S3_SECRET_ACCESS_KEY=shopdevsecret1234567890
S3_FORCE_PATH_STYLE=1
MEDIA_URL_TTL_SECONDS=900
```

不想接对象存储就不用配：`STORAGE_DRIVER=local`（默认）继续落 `ai-gateway/data/uploads`，
代码路径一致，只是渲染地址从「预签名 URL」变成 `/api/uploads/<uuid>.<ext>`。

### 一键拉起（对象存储 + 前后端）

不想分三步起服务时，用 `WITH_STORAGE=1` 让 `dev-local.sh` 顺便把 S3 替身也拉起来：

```bash
WITH_STORAGE=1 bash scripts/dev-local.sh
```

脚本会：后台启动 SeaweedFS（`scripts/dev-storage.sh`，端口就绪才继续）→ 自动注入
`STORAGE_DRIVER=s3` 与 7 个 `S3_*` 环境变量 → 再启动网关与静态前端；退出时统一回收
（网关、静态服务、S3 替身一起停）。不加 `WITH_STORAGE` 时保持原来的 local 驱动。

### 删除评价与对象回收

删除评价不只删库，还要把该评价（含追评）的图片对象一并回收，否则桶里会越积越多：

```http
DELETE /api/reviews/:id?userId=<本人>
```

- 归属校验：只有 `source=user` 且 `user_id` 匹配才能删，种子数据与别人的评价返回 403/404
- 级联：主评价删除时，DB 层 `ON DELETE CASCADE` 自动清掉追评与「有用」投票
- 统计回滚：删除后重算该商品评分/评价数/好评率（`syncProductStats`），不会留下脏计数
- 对象回收：收集主评价 + 所有追评的图片键，逐键 `DeleteObject`/删本地文件；
  单张失败不影响评价删除本身（best-effort），返回 `imagesRemoved` 反映实际回收数

### 孤儿对象清理

上传成功但最终没发布、或删除后残留的图片，会由后台定时任务清掉：

- **启动时**跑一次；之后每 `STORAGE_SWEEP_INTERVAL_SEC`（默认 1800s，0 关闭）跑一次
- 做法：读出 `reviews.images` 里所有被引用的对象键 → 与存储中 `reviews/` 前缀下的实际对象比对
  - `s3` 驱动：`ListObjectsV2`（同样走 SigV4 签名）列举后比对
  - `local` 驱动：`readdir(data/uploads)` 按 basename 比对
- 只删「没有出现在任何评价里」的对象；清理结果写结构化日志 `storage.sweep_done`，失败只告警不阻断
- 多实例部署时各实例都会扫，删除操作幂等（对象不存在不报错），可安全并发

### 生产接真 S3 / OSS / R2

```bash
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com   # OSS: https://oss-cn-hangzhou.aliyuncs.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=0                            # 真 AWS 用 vhost；OSS/R2/MinIO 视情况
```

要点：

- **桶保持私有**，只通过预签名 URL 读；不要在桶上开公共读
- 启动时 `HEAD bucket`，不存在则自动创建（失败只告警，不阻断启动）
- 签名 URL 可缓存到过期为止；接口返回的 `expiresIn` 可用于提前刷新
- 多实例部署必须用 s3：`local` 驱动下各实例只认自己磁盘上的文件
- 换存储不用迁移数据（key 与驱动无关）；历史记录里的 `/api/uploads/...` 仍由本地路由兜底

签名是手写的 SigV4（`ai-gateway/src/storage/s3Client.js`，约 200 行，零依赖），
覆盖 `PutObject / 预签名 GET / DeleteObject / HeadBucket / CreateBucket`；
已验证「过期 URL」与「篡改签名」均返回 403。

## 真实商品数据导入（合规开放数据源）

为了让数据库「更完整、更真实」，项目内置一条**合规的抓取/导入管线**，从明确可商用的开放数据源拉取真实商品、价格与图片——**绝不爬取受 ToS / 版权保护的商业站点**：

- **Free-Ecommerce-Products-Api**（GitHub 开源，开放使用）：含真实商品图（GitHub Pages 图床）与美元标价，覆盖美妆 / 电子 / 服饰 / 家居 / 健康 5 大类。
- **Open Food Facts**（ODbL 开放数据库，CC-BY 商品图）：覆盖「食品生鲜」及合规的非食品类目（美妆个护 / 宠物粮 / 母婴 / 营养补剂），按 `categories_tags` 自动分流到对应一级类目，体量可达数十万款。
- **Open Library**（开放图书元数据，封面为 Open Library 开放图）：覆盖「图书文娱」一级类目，按 subject 分流到二级类目（畅销图书 / 文创手作 / 乐器音像），只保留「有书名 + 有封面图」的真实书目，体量可达数万款。

导入后每张商品图存为 `products.image_url`，前端在「图片不可达（离线 / 图床 404）」时**自动回退**到程序化 SVG 封面，绝不出现破图。

```bash
cd ai-gateway

# 1) 先确保基础库（256 款示例 + 表结构，含 image_url 列 v5）
npm run db:seed

# 2) 导入真实商品（默认离线：用 .cache 快照；仓库已内置 Free-Ecommerce 50 款 + OFF 快照）
npm run db:ingest

# 实时抓取最新数据并写入缓存后再导入（需联网；OFF 可能限流，失败自动回退本地快照）
npm run db:ingest -- --fetch

# 快速验证：仅抓 5000 条
npm run db:ingest -- --fetch --limit 5000

# 把库做大：环境变量控制 Open Food Facts 抓取上限（默认 40000，可上不封顶）
OFF_CAP=60000 npm run db:ingest -- --fetch

# 只实时抓取指定家族（避开不可达库，其余从已提交缓存载入，不覆盖既有缓存）
INGEST_FAMILIES=obf,opf npm run db:ingest -- --fetch

# 只实时抓取图书（Open Library），其余从已提交缓存载入
INGEST_FAMILIES=ol npm run db:ingest -- --fetch

# 控制 Open Library 图书抓取上限（默认 25000）
OL_CAP=30000 npm run db:ingest -- --fetch

# 清空已导入的真实商品后重灌
npm run db:ingest -- --reset
```

要点：

- **幂等**：真实商品以 `fe_` / `off_` 前缀独立 ID，与示例商品互不覆盖；重复运行安全（`INSERT OR REPLACE` + 事务批量写入）。
- **高吞吐 + 多类目**：Open Food Facts 走 v2 搜索 API 分页抓取、按 `code` 去重、只保留「有商品名 + 有封面图」的真实条目；覆盖食品生鲜及合规非食品类目（美妆个护 / 宠物粮 / 母婴 / 营养补剂），按 `categories_tags` 自动分流到对应一级与二级类目；每个类目**增量落盘**，超时中断可续跑不丢进度。Open Library 另按 subject 翻页抓取真实书目（只留带封面图者），覆盖「图书文娱」一级类目下的畅销图书 / 文创手作 / 乐器音像二级类目。
- **演示包限幅**：数据库可以无限大，但 `web/js/demo-real-data.js` 默认按固定步长抽样至 `DEMO_CAP`（默认 3000）款，保证 GitHub Pages 首屏不被大文件拖慢；且每次导入**全量同步** fe_/off_ 商品（先清后插），重复运行不会产生重复评价。
- **容错**：限流（429/5xx）自动重试退避；断网时 `--fetch` 回退到本地快照；实时抓取与已提交缓存**合并（按 `code` 去重、只增不减）**，主食品库间歇 503 部分失败时也不会回退已抓数据，多次运行可累积增量。
- **避开不可达库**：OFF 未认证搜索每页最多返回约 100 条、深层分页（约第 11 页起）直接 401，故采用「多细分类目 `categories_tags` 浅分页」扩量；若某家族库临时不可达（如主食品库限流 503、商品事实库离线），用 `INGEST_FAMILIES=obf,opf` 只实时抓取在线家族、其余从已提交缓存载入，不拖慢整轮也不覆盖既有缓存。
- **价格**：Free-Ecommerce 为美元，按演示汇率（USD→CNY 7.1）统一为人民币；Open Food Facts 价格稀疏时按品类合理区间生成（明确为演示用途）。
- **图片版权**：均来自开放许可源；Open Food Facts 图片为 CC-BY，使用即视为遵循其署名要求。
- **离线可复现**：导入同时生成 `web/js/demo-real-data.js`，让 GitHub Pages 纯静态演示站也能展示真实商品与图片（网关不可达时回退）。

> 数据源明细与许可证见 [脚本注释](ai-gateway/scripts/ingest-real-data.mjs)。如改用自有商品库，只需替换该脚本里的两个 `map*()` 映射函数即可。

---

## 部署演示站点（GitHub Pages + Actions）

`web/` 是零构建静态站点，已通过 GitHub Actions 自动发布到 GitHub Pages。

**工作流**：[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)
（push 到 `main` 即触发，将 `web/` 作为站点根目录上传并部署）。

**首次启用（仓库设置一次性操作）**：

1. 进入仓库 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
2. 推送任意改动到 `main`，Actions 会自动构建并发布。
3. 访问 `https://<user>.github.io/ai-shopping-app/`。

**让演示站点接入真实 AI（可选）**：

- 在能访问的公网/内网启动 `ai-gateway`，并在其 `.env` 设置 `CORS_ORIGINS=https://<user>.github.io`。
- 打开演示站点时追加 `?api=https://<你的网关地址>`，即可让静态前端调用真实后端。

---

---

## 商品视觉（程序化 SVG + 真实图回退）

项目以**程序化 SVG 商品图**为兜底（`web/js/art.js`），同时支持 `products.image_url` **真实商品图**：前端优先展示真实图，加载失败时（离线 / 图床 404）自动回退到 SVG 封面，绝不出现破图。真实图来自合规开放数据源（见下一节），避免爬取受版权保护的商业站点。本地 `local` 模式的示例商品默认走 SVG，导入真实数据后自动带图。

```
商品数据 → coverColor（双色） + categoryId（线稿） + id（光斑微调） → SVG
```

- **双色渐变**：`coverColor` 由类目基准色相加商品级色相偏移生成（±13°），同类目成体系、每款又不同。
- **类目线稿**：16 套简约 line-art（手机 / 笔记本 / 耳机 / 家电 / T恤 / 碗 / 椅子 / 帐篷 / 化妆瓶 / 奶瓶 / 书 / 锅 / 爪印 / 汽车 / 心电图 / 铅笔），白色描边叠在渐变上。
- **零外部请求**：纯 SVG 字符串，GitHub Pages 离线可用；悬浮时整图轻微放大。

同一商品封面永远一致，因为颜色来自数据库字段而非随机数。

---

## 演示模式（前端离线兜底）

为让 GitHub Pages 这类**未连接后端**的纯静态站点也能展示完整店面，前端做了优雅降级：

- 商品列表 / 详情 / 搜索 / 相关推荐：网关不可达时，自动回退到内置示例商品库（`web/js/demo-data.js` 由 `catalog.js` 生成的 256 款示例 + `web/js/demo-real-data.js` 由 `ingest-real-data.mjs` 生成的真实开放数据商品），页面顶部显示「演示模式」提示条。
- 购物车：服务端不可用时回落到 localStorage，恢复连接后自动补传。
- **结算页**：拿不到服务端报价时按**与服务端一致的规则本地估算**（满 ¥99 包邮，否则 ¥10 运费），金额明细与「提交订单」按钮照常渲染，可走完「提交 → 模拟订单 → 购物车清空」的完整闭环，页面注明「本地估算、不产生真实交易」。这样演示站不会卡在「商品有价但看不到合计、也没有下单按钮」的死路上。
- 订单 / 收藏：演示模式下给出明确空状态与重试入口，不会报错堆栈。
- AI 导购 / 客服 / 问答 / 文案 / 售后：演示模式下给出友好提示，引导本地启动网关后体验。
- 分析看板 `#/analytics`：演示模式下用**内置示例统计**兜底（顶部明确标注「示例数据」，不冒充真实埋点）；埋点上报本身静默失败，不影响浏览。
- **未知路由**：渲染 404 兜底页（含首页 / 分类 / 全部商品 / 我的订单 四个入口），不再静默显示首页。
- 接入真实网关后（同源或 `?api=`），自动切换为实时数据，提示条消失。

---

## 本地自检

改完代码想快速确认「没把东西改坏」，按这三步走：

```bash
# 1) 前端模块真实加载（不只是语法解析）
#    能抓到浏览器白屏级错误：重复 import、导入不存在的导出、顶层执行期异常
node scripts/check-web.mjs

# 2) 后端语法
find ai-gateway/src -name '*.js' -exec node --check {} \;

# 3) 网关冒烟（另开终端，起服务后）
cd ai-gateway && npm start
curl -s localhost:8080/health
curl -s "localhost:8080/api/products?category=audio&sort=price_asc&limit=3"
curl -s -N -X POST localhost:8080/api/ai/guide \
  -H 'Content-Type: application/json' \
  -d '{"message":"预算1500的降噪耳机","userId":"demo","stream":true}'
```

> `node --check` 只做语法解析，**看不到**模块链接期错误（例如同名绑定重复 import 会让整个应用入口加载失败、页面白屏）。`check-web.mjs` 用极简 DOM 垫片把 16 个模块逐个 `import()` 一遍，并断言首屏能渲染、404 兜底可用。

---

## 安全与配置

- **密钥不入库**：`.env`、nginx 证书、mall-fork 等均在 `.gitignore`；仓库仅含 `.env.example` 模板。
- **CORS 显式来源**：生产必须列明来源，绝不开放 `*`。
- **网关鉴权**：设置 `AI_GATEWAY_API_KEY` 后，业务接口需携带 `X-API-Key`（nginx 侧注入，覆盖客户端自带头）。
- **限流**：默认每 IP 每分钟 60 次，可按需调整。
- **HTTPS**：反代脚本负责 TLS 终止与证书管理，后端只跑明文（同网络内）。
- **日志**：结构化 JSON 日志携带请求 ID，不记录密码 / 令牌 / 隐私数据。

---

## 许可证

[MIT](LICENSE) © 2026 qqhjw12
