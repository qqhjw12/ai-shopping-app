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
- [部署演示站点（GitHub Pages + Actions）](#部署演示站点github-pages--actions)
- [演示模式（前端离线兜底）](#演示模式前端离线兜底)
- [安全与配置](#安全与配置)
- [许可证](#许可证)

---

## 项目简介

本仓库是「宏之蓝 / macrozheng mall」生态的一个 AI 增强示例（Route A）：

- **后端 `ai-gateway`**：Node.js（ESM）网关，提供商品检索、AI 导购/客服/问答流式接口，以及对 Dify 中枢的编排。
  - `RUN_MODE=local`：内置内存商品库 + 本地哈希嵌入 + 打字机式 SSE，**零外部依赖即可演示**。
  - `RUN_MODE=docker`：接入真实 Qdrant（向量）、Elasticsearch（关键词）、Ollama（嵌入）、Dify（智能客服 / 商品问答 / 导购 Agent / 运营文案 / 订单售后），失败自动降级。
- **前端 `web/`**：原生 ES Module 单页应用，hash 路由、购物车本地持久化、AI 浮窗（导购/客服/问答均 SSE 逐字渲染）、商品详情深链分享（含来源埋点）。

适合作为**作品集 / 面试项目**：架构清晰、工程规范、可一键本地演示，也能切换到生产级 docker 栈。

---

## 功能特性

| 模块 | 入口 | 说明 |
|------|------|------|
| 🔍 智能搜索 | 顶栏搜索 | 向量 + 关键词混合检索，首页 / 列表 / 搜索页通用 |
| 📦 商品详情 | `#/product/:id` | 真实路由，可深链分享；含「相关推荐」、来源渠道色条与埋点 |
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
| `categories` | 类目（8 个：手机数码 / 电脑办公 / 音频耳机 / 家用电器 / 服饰鞋包 / 食品生鲜 / 家居家具 / 运动户外） |
| `products` | 商品主数据（64 款，含品牌 / 现价 / 原价 / 标签 / 评分 / 销量） |
| `product_skus` | 规格变体与库存（150 个 SKU，按阶梯定价） |
| `users` / `addresses` | 演示用户与收货地址 |
| `orders` / `order_items` | 订单与订单项（含物流公司、运单号、状态机） |
| `reviews` | 商品真实评价（供问答引用口碑） |
| `faqs` / `policies` | 客服 FAQ 与退换货 / 物流 / 质保 / 发票 / 支付政策 |
| `conversations` / `messages` | 会话与消息（多轮上下文、可回放，重启不丢） |
| `track_events` | 埋点事件（替代原内存环形缓冲，聚合走 SQL） |

`npm run db:seed` 幂等灌数据，`npm run db:reset` 清空重灌；两端都在启动时自动执行迁移 + 缺数据才种子。

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
│   hash 路由 · 购物车(localStorage) · AI 浮窗(SSE 逐字)        │
└───────────────┬─────────────────────────────────────────────┘
                │  fetch /api/*（同源 或 ?api= 覆盖）
                ▼
┌─────────────────────────────────────────────────────────────┐
│  ai-gateway (Node.js ESM)                                    │
│  ├─ /api/products · /api/products/:id · /api/search          │
│  ├─ /api/ai/{guide,chat,qa,copywrite,aftersale}  (SSE 流式)  │
│  ├─ 混合检索: vectorStore(Qdrant) + searchStore(ES)          │
│  ├─ 本地数据: SQLite（商品/SKU/订单/会话/埋点）              │
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
│       ├── track.js         # 埋点上报（fire-and-forget）+ stats 拉取
│       ├── analytics.js     # 分析看板（渠道占比 / 行为分布 / Top 商品 / 事件流）
│       ├── demo.js          # 演示模式标志（网关不可达时置位）
│       └── demo-data.js     # 内置示例商品库（离线兜底）
├── ai-gateway/              # Node.js 后端网关（local / docker 双模式）
│   ├── src/
│   │   ├── db/              # SQLite：connection / schema(迁移) / seedDb(种子)
│   │   ├── repositories/    # 仓储层：product / order / conversation / track
│   │   ├── services/        # chatEngine(对话引擎) / llmClient(可选大模型)
│   │   ├── data/catalog.js  # 商品目录种子（64 款 / 8 类目 / 150 SKU）
│   │   └── server / config / middleware / search / copywrite / aftersale …
│   ├── data/shop.db         # 本地数据库（gitignore，可 db:reset 重建）
│   ├── Dockerfile
│   └── dify-workflows/      # Dify 工作流 spec（售后 / 文案）
├── mall-ai/                 # macrozheng/mall 的 AI 增强模块（Java）
├── nginx/                   # 反代模板（envsubst，密钥不入库）
├── scripts/                 # setup-https-proxy.sh / setup-mall-ai-env.sh
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

无需 Docker、无需安装数据库：网关内置 **SQLite**（Node 22 自带 `node:sqlite`）与**本地对话引擎**，首次启动自动建表并灌入 64 款商品。

```bash
# 1) 启动后端网关（local 模式，默认 :8080）
cd ai-gateway
npm start            # 等价于 node --disable-warning=ExperimentalWarning src/server.js
#    首次启动会自动建库 + 种子：data/shop.db（64 商品 / 150 SKU / 订单 / 评价 / FAQ）

# 2) 另开终端，启动静态前端（任意静态服务器均可）
cd web
python -m http.server 5500        # 或 npx serve .

# 3) 打开浏览器
#    同源时直接访问 http://localhost:5500
#    跨端口时显式指定网关：http://localhost:5500/?api=http://localhost:8080
```

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
| `HTTPS_PORT` / `DOMAIN` | nginx 反代对外端口与域名 |

---

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/products` | 商品列表 |
| GET  | `/api/products/:id` | 商品详情 |
| POST | `/api/search` | 混合检索 `{ query, topK }` |
| POST | `/api/ai/guide` | AI 导购（SSE）`{ message, userId, stream }` |
| POST | `/api/ai/chat` | 智能客服（SSE）`{ message, userId, conversationId, stream }` |
| POST | `/api/ai/qa` | 商品问答（SSE）`{ query, userId, productId, stream }` |
| POST | `/api/ai/copywrite` | 运营文案 `{ product, sellingPoints, tone, platform, count }` |
| POST | `/api/ai/aftersale` | 订单售后 `{ userId, orderId, query }` |
| POST | `/api/track` | 推荐来源埋点 `{ event, source?, productId?, userId?, meta? }`（202 异步落 ES/内存） |
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

## 演示模式（前端离线兜底）

为让 GitHub Pages 这类**未连接后端**的纯静态站点也能展示完整店面，前端做了优雅降级：

- 商品列表 / 详情 / 搜索 / 相关推荐：网关不可达时，自动回退到内置示例商品库（`web/js/demo-data.js`），页面顶部显示「演示模式」提示条。
- AI 导购 / 客服 / 问答 / 文案 / 售后：演示模式下给出友好提示，引导本地启动网关后体验。
- 分析看板 `#/analytics`：演示模式下用**内置示例统计**兜底（顶部明确标注「示例数据」，不冒充真实埋点）；埋点上报本身静默失败，不影响浏览。
- 接入真实网关后（同源或 `?api=`），自动切换为实时数据，提示条消失。

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
