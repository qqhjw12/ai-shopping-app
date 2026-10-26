# web 前端（AI 购物助手 · 网页版）

原生零依赖静态前端（HTML + CSS + ES Module），对接 `ai-gateway`。无需 `npm install`。

## 目录结构

```
web/
├── index.html        # 应用外壳：顶栏(智能搜索/导航/购物车) + 视图容器 + AI 助手浮窗 + 购物车抽屉
├── styles.css        # 商店前台样式（响应式）
└── js/
    ├── api.js        # 类型化 fetch 封装（4xx 不重试 / 5xx 重试 3 次 / 离线提示）
    ├── state.js      # 购物车(localStorage) + 匿名 userId(sessionStorage)
    ├── ui.js         # DOM 构建 / 弹窗 / 抽屉 / toast / 商品卡片复用
    ├── router.js     # 极简 hash 路由
├── views.js      # 首页 / 商品列表 / 智能搜索 / 商品详情(路由页) / 购物车
├── assistant.js  # AI 助手浮窗：导购 / 客服 / 问答(均流式)
├── tools.js      # AI 工具箱：运营文案 / 订单售后
└── app.js        # 入口：装配路由与交互
```

## 运行方式

### A. 经 nginx 反代（推荐，生产形态）
按 `scripts/setup-https-proxy.sh` 一键启动后，浏览器直接打开 `https://localhost:8443/`。
前端与 `/api` 同源，API Key 由 nginx 注入，无需任何额外配置。

### B. 本地直连（开发调试）
```bash
# 1) 启动网关（local 演示模式）
cd ../ai-gateway && RUN_MODE=local node src/server.js   # 默认 :8080

# 2) 启动静态前端
cd web && python -m http.server 5500

# 3) 打开 http://localhost:5500/?api=http://localhost:8080
```
`?api=` 用于覆盖默认同源地址（本地前端在 5500、网关在 8080，必须显式指定）。

## 功能（6 大 AI 模块全覆盖）

| 区域 | 端点 | 说明 |
|------|------|------|
| 智能搜索（顶栏） | `POST /api/search` | 向量 + 关键词混合检索，首页 / 商品页 / 详情均可触发 |
| 商品详情（路由页） | `GET /api/products/:id` | 真实路由 `#/product/:id`，可深链分享；含「相关推荐」 |
| AI 导购（浮窗） | `POST /api/ai/guide` | 一句话需求 → 导购话术（SSE 逐字）+ 商品卡片 |
| 智能客服（浮窗） | `POST /api/ai/chat` | 多轮客服对话（SSE 逐字渲染） |
| 商品问答（浮窗 / 详情） | `POST /api/ai/qa` | 按商品聚焦问答（详情页「问我这件商品」），SSE 逐字 + 关联商品卡片 |
| 运营文案（AI 工具箱） | `POST /api/ai/copywrite` | 多版本标题 / 详情 / 种草文案 |
| 订单售后（AI 工具箱） | `POST /api/ai/aftersale` | 按 userId / 订单号查单 + 退换货指引 |

## 流式（SSE）说明
- 导购、客服、商品问答均默认走流式：`streamApi()` 发送 `stream:true`，网关以 `text/event-stream` 逐段回传
  `data: {"text":"…"}`，结束后回传结构化数据（`products` / `results` / `conversationId`），最后 `data: [DONE]`。
- docker 模式且配置了 Dify App Key 时，网关代理 Dify 的 `chat-messages` 流式；否则本地按字切片模拟打字机（演示也可见逐字效果）。
- 通过 nginx 反代时，`/api/` 已关闭 `proxy_buffering`，保证流式不被攒批。若网关返回普通 JSON（未启用流式），`streamApi` 自动整体回调，向前兼容。

## 深链分享（含来源埋点）
- 商品详情为真实路由：`#/product/p002` 可直接复制链接分享；打开后按 ID 取数并渲染，含「相关推荐」。
- 顶栏 / 商品卡「详情」均跳转该路由，支持浏览器后退。
- 跳转时携带来源埋点：`#/product/:id?from=guide|search|list|home|rec`。详情页据此在顶部回显「📍 来自：AI 导购推荐」等渠道标签；「🔗 复制分享链接」会把 `?from=` 一并写入分享 URL，便于分享归因。深链直达（无 `from`）时不显示标签。

## 工程要点（对照全栈规范）
- 类型化请求封装 `api()`：4xx 不重试；5xx / 网络异常自动重试最多 3 次；离线优先提示。`streamApi()` 负责 SSE 解析与回退。
- 每个交互都有加载态与友好错误 banner，错误不暴露内部细节。
- 同源访问免跨域；密钥经反代注入，前端不持有。
- 购物车本地持久化，结算为演示（无真实支付）。
- 会话连续性：前端生成匿名 `userId`（sessionStorage），便于 Dify 多轮上下文。
