# 购物 App 开源项目调研与实现方案

> 调研时间：2026-10-26 ｜ 数据来源：GitHub API 实测（star/fork 为当日快照）
> 状态：**方案待确认，暂不写代码**。用户确认选型后再进入实现阶段。

---

## 一、候选项目清单（GitHub 实测）

| # | 项目 | Star | 语言/栈 | 形态 | 许可 | 维护状态 |
|---|------|-----:|---------|------|------|----------|
| 1 | [macrozheng/mall](https://github.com/macrozheng/mall) | 84.9k | Java / Spring Boot + MyBatis | 全栈（前台+后台） | Apache-2.0 | 活跃 |
| 2 | [medusajs/medusa](https://github.com/medusajs/medusa) | 36.9k | TypeScript / Node.js | Headless 电商引擎 | MIT* | 非常活跃 |
| 3 | [bagisto/bagisto](https://github.com/bagisto/bagisto) | 28.3k | PHP / Laravel + Vue | 全栈 + 多商户 | MIT | 活跃 |
| 4 | [saleor/saleor](https://github.com/saleor/saleor) | 23.5k | Python / Django + GraphQL | Headless 电商 API | BSD-3 | 活跃 |
| 5 | [linlinjava/litemall](https://github.com/linlinjava/litemall) | 20.4k | Java / Spring Boot | 轻量全栈（四端） | MIT | 较活跃 |
| 6 | [bagisto/opensource-ecommerce-mobile-app](https://github.com/bagisto/opensource-ecommerce-mobile-app) | 16.1k | Dart / Flutter | 移动 App（配 Bagisto 后端） | MIT | 活跃 |
| 7 | [macrozheng/mall-swarm](https://github.com/macrozheng/mall-swarm) | 13.2k | Java / Spring Cloud Alibaba | 微服务版商城 | Apache-2.0 | 较活跃 |
| 8 | [newbee-ltd/newbee-mall](https://github.com/newbee-ltd/newbee-mall) | 11.7k | Java / Spring Boot + Vue3 | 全栈（多版本） | GPL-3.0 | 较活跃 |
| 9 | [evershopcommerce/evershop](https://github.com/evershopcommerce/evershop) | 10.5k | TypeScript / Node + React | 全栈（前台 SSR+后台） | GPL-3.0 | 活跃 |
| 10 | [macrozheng/mall-app-web](https://github.com/macrozheng/mall-app-web) | 1.1k | Vue3 / uni-app | 移动端（App/H5/小程序） | Apache-2.0 | 较活跃 |
| 11 | [abuanwar072/E-commerce-Complete-Flutter-UI](https://github.com/abuanwar072/E-commerce-Complete-Flutter-UI) | 4.8k | Dart / Flutter | 纯 UI 模板（无后端） | 自定义 | 活跃 |
| 12 | [TheAlphamerc/flutter_ecommerce_app](https://github.com/TheAlphamerc/flutter_ecommerce_app) | 3.5k | Dart / Flutter | App 示例 | BSD-2 | 停更（2022） |

> \* Medusa 为自定义许可（核心 MIT，部分云组件受限），商用前需读 LICENSE。

---

## 二、横向对比

### 2.1 功能覆盖

| 功能 | mall | litemall | newbee | bagisto | saleor | medusa | evershop | bagisto App | Flutter UI |
|------|:----:|:--------:|:------:|:-------:|:------:|:------:|:--------:|:-----------:|:----------:|
| 商品/分类/SKU | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | UI |
| 购物车 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | UI |
| 订单/售后流程 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | UI |
| 支付对接 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 会员/权限后台 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 营销（优惠券/秒杀） | ✅ | 部分 | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| 搜索（ES） | ✅ | ❌ | ❌ | ✅ | ✅ | 插件 | ✅ | — | — |
| 多商户 | ❌ | ❌ | ❌ | ✅ | ✅ | 插件 | ❌ | — | — |
| 多语言/多货币 | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 移动 App | uni-app | 小程序/H5 | Vant | Flutter 官方 | Storefront 模板 | Next.js | — | 本体 | 本体 |

### 2.2 架构模式

| 项目 | 架构风格 | 前后端关系 | 数据库 | 关键中间件 |
|------|----------|-----------|--------|-----------|
| mall | 单体分层（Controller→Service→Dao） | 前后端分离（REST） | MySQL | Redis、ES、MongoDB、RabbitMQ |
| mall-swarm | 微服务 | 网关 + REST | MySQL | Nacos、Sentinel、Seata、Gateway |
| litemall | 单体分层 | 前后端分离（REST） | MySQL | Redis |
| bagisto | Laravel MVC + Package 扩展 | 前后端分离（REST/GraphQL） | MySQL | Redis、Elasticsearch |
| saleor | Django + GraphQL API 优先 | Headless（任意前端） | PostgreSQL | Redis、Celery |
| medusa | 模块化（Commerce Modules + Workflows） | Headless（REST） | PostgreSQL | Redis、事件总线 |
| evershop | 模块化全栈 + SSR | 一体（前台 SSR + 后台） | PostgreSQL | Redis |

### 2.3 优缺点分析

**macrozheng/mall（Java 系标杆）**
- 优点：功能最全、中文文档与教程生态最好（配套 mall-learning）、Docker 一键部署、社区基数最大、有微服务版可参考演进路径。
- 缺点：技术栈重（Java + 5 个中间件），本地跑起来成本高；部分代码为教学风格，业务耦合较深；移动端要另起 uni-app 项目。适合：**学习/参考/Java 团队二次开发**。

**litemall（轻量 Java）**
- 优点：代码量小、结构清晰、MIT、同时给出 Vue 后台 + 小程序 + H5 四端，读代码最快。
- 缺点：功能精简、无 ES/消息队列、无营销体系。适合：**快速读懂电商全貌、小项目直接改**。

**bagisto（PHP/Laravel 系）**
- 优点：Laravel 开发效率高、MIT 宽松、多商户开箱即用、官方提供 Flutter App 与 Next.js storefront，前后端移动端全家桶。
- 缺点：PHP 技术栈；深度定制要理解其 Package 扩展机制；高并发下需自行优化。适合：**PHP 团队 / 想最快上线多商户商城**。

**saleor（Python/GraphQL Headless）**
- 优点：企业级 API 优先设计、GraphQL 灵活、OMS/PIM 完整、多语言多货币成熟、有商业云托管。
- 缺点：Python/Django 栈；本地部署组件多、学习曲线陡；GraphQL 对前端类型安全友好但调试门槛高。适合：**中大型/出海业务**。

**medusa（Node/TS Headless，最流行）**
- 优点：TypeScript 生态最热门；v2 模块化 + Workflows 编排，扩展点清晰；REST API；自带 React 管理后台；Next.js Storefront 模板；社区非常活跃。
- 缺点：v2 仍在快速演进，API 有变动风险；深度定制需读框架源码。适合：**Node/React 团队自建品牌商城**。

**evershop（Node/TS 全栈）**
- 优点：一套代码同时含 SSR 前台 + 管理后台，开箱即用；模块化扩展系统；GraphQL + REST 双 API；PostgreSQL。
- 缺点：GPL-3.0（二次开发需开源）；体量不小。适合：**想快速跑起来再逐步改造的全栈团队**。

**移动端三兄弟**
- bagisto Flutter App：**有真实后端闭环**的 Flutter 电商 App 参考，UI/交互/接口对接完整，但绑定 Bagisto。
- abuanwar072 Flutter UI：页面最全的纯 UI 模板，适合当**设计稿参考**，无业务逻辑。
- mall-app-web（uni-app）：一套代码编译 App/H5/微信小程序，适合**国内小程序场景**，但绑定 mall 后端。

### 2.4 选型结论（按场景）

| 你的情况 | 推荐 |
|----------|------|
| Java 背景 / 想学企业级电商架构 | mall（+ mall-swarm 看微服务演进） |
| 想快速上线、PHP 团队 | bagisto（+ 官方 Flutter App） |
| Node/TS/React 团队、要品牌定制 | medusa 或自研（见方案） |
| 只想读懂电商业务全貌 | litemall |
| 出海/多语言/大型 | saleor |
| 需要微信小程序 + App | mall + mall-app-web 组合 |
| 只要一个漂亮的购物 App 界面 | abuanwar072 Flutter UI 模板 |

---

## 三、实现方案（待确认）

### 3.1 三条路线对比

| 维度 | 路线 A：开源二次开发 | 路线 B：开源后端 + 自研前端 | 路线 C：完全自研（推荐） |
|------|---------------------|---------------------------|------------------------|
| 代表 | bagisto / evershop / mall | medusa / saleor | Node+TS 自研 |
| 上线速度 | 最快（周级） | 中（月级） | 慢（2-3 个月到可投产） |
| 定制自由度 | 低-中（受框架约束） | 高（前端全自定） | 完全自由 |
| 代码归属 | 需遵守 GPL/MIT 等 | MIT 较宽松 | 完全自有 |
| 长期维护成本 | 依赖上游版本演进 | 中 | 自己完全可控 |
| 适合 | 验证生意、赶时间 | 有品牌定制需求 | 学习全栈 + 长期产品 |

**推荐路线 C（自研），理由**：你的目标是做一个自己的购物 App，自研才能完全掌握数据模型、接口契约与部署链路；开源项目作为**架构参考**（mall 的分层、medusa 的模块划分、bagisto App 的 Flutter 交互），而不是运行时依赖。

### 3.2 推荐技术栈（路线 C）

```
┌─────────────────────────────────────────────────────┐
│  客户端层                                            │
│  React 18 + Vite + TS (Web/H5)                      │
│  Flutter (iOS/Android App，可选二期)                 │
├─────────────────────────────────────────────────────┤
│  API 层   REST /api/v1 · JWT 短令牌+httpOnly 刷新令牌 │
│  中间件   请求ID · 结构化日志 · 限流 · CORS · 安全头   │
├─────────────────────────────────────────────────────┤
│  服务层   NestJS（控制器→服务→仓储 三层）             │
│           Zod 输入校验 · Prisma ORM · 事务            │
├─────────────────────────────────────────────────────┤
│  数据层   PostgreSQL 15 · Redis 7（缓存/限流）        │
├─────────────────────────────────────────────────────┤
│  基础设施   Docker Compose · GitHub Actions CI       │
└─────────────────────────────────────────────────────┘
```

| 决策点 | 选择 | 一句话理由 |
|--------|------|-----------|
| 后端框架 | NestJS + TypeScript | 分层与依赖注入内建，控制器/服务/仓储天然分离，可测试性最好 |
| ORM | Prisma | 类型安全 + 迁移可回滚，schema 即文档 |
| 数据库 | PostgreSQL | 事务与 JSON 支持强，开源栈标配 |
| 缓存 | Redis | 购物车热点数据、限流、刷新令牌存储 |
| 认证 | JWT 15min + 刷新令牌 7d（httpOnly Cookie） | 兼顾安全与体验，服务端可吊销 |
| 前端 | React + Vite + React Query | 请求缓存/重试/401 自动刷新开箱即用 |
| 移动端 | Flutter（二期）或 React Web 响应式先行 | 先验证业务再投入双端 |
| 支付 | 沙箱模式（可切换微信/Stripe） | 不接真实资金也能跑通全流程 |
| 部署 | Docker Compose + Nginx | 单机可投产，后续可拆 K8s |

### 3.3 核心数据模型（ER 概要）

```
users ──< addresses
users ──< orders ──< order_items >── products
products >── categories（多级）
products ──< product_skus（规格/库存/价格）
users ──< cart_items >── product_skus
orders ── payments
products ──< reviews
coupons（优惠券）/ banners（运营位）
```

### 3.4 API 设计要点（REST）

- `POST /api/v1/auth/register|login|refresh|logout`
- `GET /api/v1/products?category&keyword&page`（列表分页、ES 后期替换）
- `GET /api/v1/products/:id`（含 SKU 与库存）
- `GET|POST|PATCH|DELETE /api/v1/cart`（购物车，未登录用匿名 token 合并）
- `POST /api/v1/orders`（下单，事务内扣库存）→ `GET /api/v1/orders` → `POST /api/v1/orders/:id/pay`
- `POST /api/v1/payments/webhook`（支付回调，幂等）
- `/api/v1/admin/*`（RBAC：admin/operator 两角色）
- 错误结构统一：`{ code, message, requestId }`；4xx 不重试、5xx 前端最多重试 3 次

### 3.5 里程碑拆分

| 阶段 | 内容 | 验收标准 |
|------|------|----------|
| M0 脚手架 | 配置校验、错误体系、日志、迁移、健康检查、Docker | `/health` 通，启动即失败快速报错 |
| M1 商品域 | 分类/商品/SKU/搜索/详情 | 商品 CRUD + 列表分页可用 |
| M2 用户域 | 注册/登录/JWT/刷新/地址 | 401 自动刷新重试链路通过 |
| M3 交易域 | 购物车/下单/订单/支付沙箱/回调幂等 | 端到端下单-支付-查单通过 |
| M4 运营与加固 | 管理后台、RBAC、限流、安全头、CI、部署 | 冒烟 + 集成测试全绿，可上线 |

---

## 四、需要你确认的问题（确认后我再动手）

1. **终端形态**：先做 Web（手机浏览器可用的响应式），还是直接要 iOS/Android App（Flutter）？是否要微信小程序？
2. **技术栈**：接受 Node.js + TypeScript 推荐栈吗？如果团队/个人更熟 Java 或 PHP，我改为对应栈。
3. **路线选择**：路线 C 自研 / 路线 B 接 medusa / 路线 A bagisto 或 mall 二次开发？
4. **数据库**：PostgreSQL 可以吗（需要本机 Docker）？还是先用 SQLite 做演示版？
5. **支付**：先做沙箱模拟支付，还是必须接真实微信支付/支付宝（需要商户资质）？
6. **部署目标**：本地 Docker Compose 即可，还是要部署到云服务器（有域名/HTTPS 需求）？
7. **规模预期**：个人学习/作品集，还是准备真实运营（影响是否需要秒杀、优惠券、多商户等复杂度）？

---

## 五、关键参考链接

- mall 全套生态：https://github.com/macrozheng/mall （配套教程 mall-learning）
- medusa v2：https://github.com/medusajs/medusa （模块化参考）
- bagisto + Flutter App：https://github.com/bagisto/bagisto
- evershop：https://github.com/evershopcommerce/evershop
- Flutter 电商 UI 模板：https://github.com/abuanwar072/E-commerce-Complete-Flutter-UI
- uni-app 移动端：https://github.com/macrozheng/mall-app-web
