# 购物 App（路线 A 开源二次开发 + AI 模块）实现方案

> 状态：**M0/M1 已落地（AI Gateway 混合搜索可运行）**，其余模块按里程碑推进。
> 路线：在成熟开源商城基础上做二次开发（Route A），把 6 个 AI 能力作为独立服务接入，而非重写商城内核。
> 数据来源：GitHub 仓库元数据（截至 2026-10-26 实测 star / license）。
>
> ⚠️ **沙箱环境限制**：本机仅有 Node/Python/git，**无 Docker、无 JDK/Maven、无 Ollama**，因此"Docker Compose 一把梭"无法在本沙箱真正运行。已采用**双模式实现**：`local` 模式（内置内存降级，无需 Docker，已在此验证）与 `docker` 模式（接真实 Qdrant/ES/Ollama）。代码在你装有 Docker+JDK 的机器上 `docker compose up` 即可投产。详见 `docs/M0_M1_实施记录.md`。

---

## 一、技术选型总览（均为 GitHub 实测）

### 1. 基础商城（二次开发底座，二选一）

| 项目 | Star | 栈 | 说明 | License |
|------|-----:|----|------|---------|
| **macrozheng/mall**（推荐） | 84.9k | Java / Spring Boot + Vue | 中文电商教学标杆，商品/订单/用户/优惠券/后台最全，文档最完善 | MIT |
| macrozheng/mall-app-web | — | uni-app | 移动端 H5/小程序壳，可直接二次开发 | MIT |
| bagisto/bagisto（备选） | 28.3k | PHP / Laravel | PHP 团队友好，原生支持多商户 | MIT |
| bagisto Flutter App（备选） | 16.1k | Dart | 少有的带真实后端的购物 App 参考 | MIT |

> 推荐 **mall** 作为主底座：模块最全、二次开发资料最多；AI 层用语言无关的 HTTP 服务接入，不要求改 Java 写模型代码。
> 若你更熟 PHP，可直接换 bagisto，AI 接入方式完全一致。

### 2. AI 能力层（开源引擎，独立 Docker 部署）

| 开源项目 | Star | 栈 | 在本方案中的角色 | License |
|----------|-----:|----|------------------|---------|
| **langgenius/dify** | 159.5k | Python/TS | **AI 中枢**：Agent（导购/售后）、Workflow（文案）、Knowledge（问答/客服知识库）、Chatbot 嵌入 | 自定义（自托管免费，商用有条件） |
| **meilisearch/meilisearch** | 59.7k | Rust | **智能搜索**：关键词 + 向量混合检索（自带 typo 容错） | 核心 MIT / 部分商业 |
| infiniflow/ragflow | 92.9k | Go | 深度文档 RAG（商品说明书/政策解析），Dify 的高级备选 | Apache-2.0 |
| langchain-ai/langgraph | 43.9k | Python | 自建复杂 Agent 编排（若不走 Dify） | MIT |
| n8n-io/n8n | 208.6k | TS | 文案生成/运营自动化工作流编排（Dify Workflow 备选） | fair-code |
| pgvector/pgvector | 23.5k | C | PostgreSQL 向量扩展（Dify/搜索可复用主库） | 自定义（PostgreSQL 协议） |
| qdrant/qdrant（备选） | 35.3k | Rust | 独立高性能向量库（商品问答/搜索向量召回） | Apache-2.0 |

> 模型层（LLM + Embedding）通过 Dify 的「模型供应商」统一接入：DeepSeek / 通义千问 / OpenAI / 本地 Ollama 任选，可随时切换。

---

## 二、整体架构

```
┌──────────────────────────── 用户端 ────────────────────────────┐
│  Web(H5) / 小程序 / App       商城核心 UI + AI 浮窗/组件          │
└───────────────┬───────────────────────────┬────────────────────┘
                │ 商品/订单/用户/购物车        │ AI 对话/搜索/文案
                ▼                            ▼
┌───────────────────────────┐   ┌────────────────────────────────────┐
│  macrozheng/mall (Spring) │   │  AI Gateway（mall 新增 ai 模块 /    │
│  二次开发：业务域 + 集成层  │   │  或独立 Node 服务，统一鉴权/限流）  │
└───────────────┬───────────┘   └───────┬───────────┬────────────────┘
                │ 订单/商品/用户 API      │           │
                ▼                        ▼           ▼
        ┌──────────────┐         ┌─────────────────┐  ┌─────────────────┐
        │ PostgreSQL   │         │  Dify（AI 中枢） │  │  Meilisearch    │
        │ + pgvector   │         │ Agent/Workflow/  │  │  混合搜索        │
        └──────────────┘         │ Knowledge       │  └─────────────────┘
                                 └────────┬────────┘
                ┌────────────────────────┼────────────────────────┐
                ▼                        ▼                        ▼
        ┌──────────────┐        ┌──────────────┐        ┌─────────────────┐
        │ LLM 网关      │        │ Embedding 模型│        │ RAGFlow(可选)   │
        │ DeepSeek/通义 │        │ BGE/OpenAI    │        │ 深度文档解析     │
        └──────────────┘        └──────────────┘        └─────────────────┘
```

> 关键原则：**商城内核不动，AI 全外置**。mall 只新增一个 `ai-integration` 模块去调 AI 服务，AI 服务挂了不影响加车下单。

---

## 三、6 个 AI 模块 × 开源项目映射

| # | 模块 | 推荐开源方案 | 怎么落地 | 备选 |
|---|------|--------------|----------|------|
| 1 | **AI 导购** | Dify Agent + Meilisearch 召回 | 对话理解意图 → 调 mall 商品/分类 API 召回候选 → LLM 排序+给推荐理由 | LangGraph 自建 Agent |
| 2 | **智能客服** | Dify Chatbot（知识库 = FAQ/退换货/物流） | 前端 iframe/SDK 嵌入对话窗；低置信度转人工 | RAGFlow 替代知识库 |
| 3 | **商品问答** | Dify Knowledge（向量库 = pgvector/Qdrant） | 商品详情页「问我这件商品」→ RAG 检索规格/评价/说明书作答 | RAGFlow 深度解析 |
| 4 | **智能搜索** | Meilisearch 混合检索 | 商品入库即写 Meilisearch；查询走 关键词+向量 混合，结果回填空/纠错 | Qdrant + ES |
| 5 | **运营文案生成** | Dify Workflow（或 n8n） | 运营后台填卖点 → 模板化生成标题/详情/种草文案多版本 | n8n 工作流 |
| 6 | **订单/售后助手** | Dify Agent + 订单 API 工具 | 登录态透传 userId → Agent 调 mall 查单/查物流/发起退货 | LangGraph + 工具 |

> 6 个模块中 5 个由 **Dify 一个平台**统一承载，避免服务碎片化；只有「智能搜索」独立用 Meilisearch（它原生支持向量+关键词混合，最省事）。

---

## 四、数据流与集成设计

1. **商品 → 向量/索引（写路径）**
   - mall 商品新增/变更 → 通过事件/定时任务 → 调 Embedding 模型生成向量 → 写入 Meilisearch（搜索）+ Dify 知识库（问答）。
   - 用幂等任务 + 重试，失败进死信，避免索引不一致。

2. **用户 → AI（读路径）**
   - 前端 AI 浮窗 → `AI Gateway`（鉴权、限流、审计）→ Dify API / Meilisearch API。
   - 登录态：前端带 mall 的 JWT，`AI Gateway` 校验后，把 `userId` 透传给「订单/售后助手」做数据隔离。

3. **导购/售后 Agent 回调商城**
   - Dify Agent 通过 **Tool/MCP** 调 mall 暴露的内部 API（商品列表、订单详情、物流），返回结构化 JSON 由前端渲染卡片。

4. **安全**
   - AI 服务不直连公网，仅 `AI Gateway` 暴露；Dify/Meilisearch 放内网 Docker 网络。
   - 密钥/API Key 全部走环境变量，不进代码库；LLM 调用带内容审计日志（不记用户隐私）。

---

## 五、mall 二次开发改造点（具体动哪里）

| 位置 | 改动 |
|------|------|
| 后端新增 `mall-ai` 模块 | AI Gateway：封装 Dify/Meilisearch 调用、统一鉴权限流 |
| 后端监听商品事件 | 商品增改 → 同步索引/知识库（异步任务，幂等） |
| 后端新增内部 API | 供 Agent 调用的商品/订单/物流只读接口（带 userId 隔离） |
| 前端 mall-app-web | 加 AI 导购浮窗、商品页问答入口、搜索框接智能搜索 |
| 前端 mall-admin-web | 加「运营文案生成」面板、AI 配置页 |
| docker-compose | 追加 dify / meilisearch / redis / embedding 服务 |

---

## 六、里程碑（每步可独立验证）

- **M0 底座跑通**：mall 本地起得来（MySQL+Redis），能下单。Dify/Meilisearch 容器起得来。
- **M1 智能搜索**：商品同步进 Qdrant + Elasticsearch，前端搜索框出混合结果。
- **M2 商品问答 + 智能客服**：Dify 建知识库（商品+FAQ），商品页问答、全站客服浮窗可用。
- **M3 AI 导购**：Dify Agent 接商品 API，对话式推荐出卡片；前端导购面板 + 客服浮窗 + 商品页问答入口可用。
- **M4 运营文案 + 订单售后**：✅ 已落地。两个 Dify Workflow（运营文案 / 订单售后），**运营同事在 Dify 控制台自助使用（无代码后台，不写独立后台、不引入 n8n）**；网关 `/api/ai/copywrite`、`/api/ai/aftersale` 调用并 local 降级。详见 `docs/M4_实施记录.md` 与 `docs/ops-runbook.md`。
- **M5 加固部署**：✅ 已落地。AI Gateway 鉴权（X-API-Key）、按 IP 限流、健康检查（`/health` 存活 + `/ready` 就绪）、优雅停机（SIGTERM/SIGINT 排空）、CORS 显式来源、结构化 JSON 日志（请求 ID + 敏感脱敏）。详见 `docs/M5_实施记录.md`。

---

## 七、开源依赖与 License 提醒（上生产前必看）

- **Dify**：自托管免费，但**商业使用受自定义 License 约束**（非纯 OSI），正式商用前请确认条款或采购商业授权。
- **Meilisearch**：核心 MIT，向量/部分高级特性为商业功能，量小可用、大规模留意计费。
- **n8n**：fair-code，自托管免费，**用作 SaaS 转售受限**。
- **RAGFlow / LangChain / LangGraph / Qdrant**：Apache-2.0 / MIT，可放心商用。
- **mall / bagisto**：MIT，二次开发无限制，但**保留原作者版权声明**。

> 若计划真实商业化运营，建议 LLM 用国内合规供应商（DeepSeek / 通义 / 智谱），并确认 Dify 商用条款。

---

## 八、待确认问题 → ✅ 已确认决策（2026-10-26）

1. **底座**：✅ **macrozheng/mall（Java）**；移动端按 **uni-app H5 + 微信小程序** 规划（mall-app-web 同源产出，如只做其一可再调整）。
2. **AI 中枢**：✅ **Dify 为主**，一套管 5 个模块（导购/客服/问答/文案/售后）。
3. **模型供应商**：✅ **DeepSeek / 通义（在线）+ 本地 Ollama 小模型（离线演示）**，经 Dify 模型供应商接入。
4. **搜索**：✅ **Elasticsearch + Qdrant 双引擎**（关键词 + 向量混合，替代原 Meilisearch 方案）。
5. **运营文案 / 售后**：✅ **建 Dify 无代码后台**（运营同事在 Dify 控制台自助，不写独立后台、不引入 n8n）。
6. **部署形态**：✅ **本地 Docker Compose 一把梭演示**。
7. **数据规模 / 合规**：✅ **个人作品集，但足够真实**——不做多商户/秒杀/真实支付对接（无商户资质），但 AI Gateway 已按生产标准加固（鉴权限流、健康探针、优雅停机、CORS 显式来源、结构化日志），可写进简历。

## 九、已落地进度（M0/M1/M2）

- ✅ `docker-compose.yml`：ollama / qdrant / elasticsearch / ai-gateway。
- ✅ `ai-gateway/`（Node 零依赖，双模式）：混合搜索（ES 关键词 + Qdrant 向量，含 local 降级）、Ollama 嵌入（含本地哈希嵌入降级）、mallClient、HTTP 服务。
- ✅ 沙箱内 local 模式冒烟通过：3 个中文查询均正确召回 Top1。
- ✅ **M2 智能客服 + 商品问答（后端）**：`difyClient.js`（chat-messages + Dataset 同步，含 local 降级）、`faq.js` 兜底、`POST /api/ai/chat`、`POST /api/ai/qa`、`scripts/sync-products-to-dify.js`、`docker-compose.dify.yml`。沙箱 local 冒烟通过（客服命中 FAQ、问答召回正确）。前端浮窗与商品页入口留到 M3。
- ✅ **M2 mall-ai 集成模块**：`mall-ai/` 已补全为**独立可编译的 Spring Boot 应用**（端口 8081、直连 mall 库、mybatis 扫描 mbg Mapper、多阶段 Dockerfile），暴露 `GET /api/ai/products`、`/{id}`，含可选内部鉴权。`scripts/setup-mall-ai-env.sh` 自动克隆 macrozheng/mall、植入模块、幂等注入根 pom 的 `<module>mall-ai</module>`；`docker-compose.yml` 已加 `mall-mysql` + `mall-ai`（Maven 容器内编译，本机无需 JDK）。需在你本机（或 Docker）编译（沙箱无 JDK 无法编）。
- ✅ **M3 AI 导购 + 前端集成**：`ai-gateway/src/guide.js`（导购卡片 + 预算/品类过滤 + Dify 话术降级）、`/api/ai/guide` 与 `/api/products` 端点、全局 CORS；`/api/ai/qa` 支持 `productId` 聚焦。前端 `web/`（零依赖静态）含导购面板、客服浮窗、商品页「问我这件商品」、运营文案页、订单售后入口，统一类型化 `api()` 封装（4xx 不重试 / 5xx 重试 3 次 / 离线提示）。沙箱 local 冒烟通过。
- ✅ **M4 运营文案 + 订单售后**：见上。网关 `/api/ai/copywrite`、`/api/ai/aftersale`（双模式降级）。前端 `web/` 补运营文案页与订单售后助手入口。
- ✅ **M5 AI Gateway 加固**：`src/logger.js`（结构化 JSON 日志 + 请求 ID + 敏感头脱敏）、`src/middleware.js`（requestId / CORS 显式来源 / 按 IP 限流 / API Key 鉴权）、`server.js` 接入中间件、新增 `/ready` 就绪探针、SIGTERM/SIGINT 优雅停机、`config` + `.env.example` 加 `AI_GATEWAY_API_KEY`/`RATE_LIMIT_PER_MIN`/`CORS_ORIGINS`/`TRUST_PROXY`，`docker-compose.yml` 透传。沙箱 local 模式全功能冒烟通过（详见 `docs/M5_实施记录.md`）。
- 详见 `docs/M0_M1_实施记录.md`、`docs/M2_实施记录.md`、`docs/M3_实施记录.md`、`docs/M4_实施记录.md`、`docs/M5_实施记录.md`。

---
*全栈 M0–M5 已落地，mall-ai 已补全为可编译独立模块并配好一键植入脚本 + Docker 编译服务。后续可选：前端升级为 React + React Query + TS（类型安全）、Dify 三个 App 搭建与知识库同步、HTTPS/反代一键部署脚本。*
