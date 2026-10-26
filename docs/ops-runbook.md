# 运营无代码后台使用手册（Dify 控制台）

> 适用模块：M4 运营文案生成、订单售后助手。
> 设计原则：**AI Gateway 只负责把请求转给 Dify Workflow；运营同事直接在 Dify 控制台里自助编辑、发布，无需任何代码**——这就是交付给运营的「无代码后台」。

## 一、为什么要这样做

- 不自己写运营后台（省一套前端 + 权限 + 审计）。
- Dify 本身就是可视化工作流引擎，拖拽节点 + 改 prompt 即可，运营能自助。
- 与「Dify 一套管 5 个 AI 模块」的决策一致，不引入第二套系统（如 n8n）。

## 二、首次搭建（开发 / 运维做一遍）

1. 启动 Dify 栈：`docker compose -f docker-compose.dify.yml up -d`，浏览器开 `http://localhost:3000`。
2. 在 Dify 控制台「工作室 → 创建应用 → 工作流」：
   - 应用 A：**运营文案生成**（参考 `ai-gateway/dify-workflows/copywrite.spec.json`）
   - 应用 B：**订单售后助手**（参考 `ai-gateway/dify-workflows/aftersale.spec.json`）
3. 按蓝图配置「开始」节点输入变量、LLM 节点 prompt、结束节点输出（约 5 分钟）。
4. 应用 B（售后）如需真实查单：在 HTTP 节点填 `{{MALL_BASE_URL}}/api/ai/orders?userId=...`，并配置 M2 落地的 `mall-ai` 模块鉴权令牌。
5. 点「发布」。进入「访问 API」复制 API Key。
6. 把 Key 填回 `ai-gateway/.env`：
   - `DIFY_CW_API_KEY=` 运营文案
   - `DIFY_AS_API_KEY=` 订单售后
7. 重启 ai-gateway（`RUN_MODE=docker`）。此后网关 `/api/ai/copywrite`、`/api/ai/aftersale` 自动从 local 降级切换为真实 Dify。

> 也可用 `node scripts/create-dify-workflows.js`（需 `DIFY_ADMIN_KEY`）批量建 App 壳，再补节点。

## 三、日常运营自助（运营同事，纯无代码）

- **生成文案**：打开「运营文案生成」应用 → 填写商品名/卖点/语气/平台 → 运行 → 复制多版本标题/详情/种草文案。
- **改文案风格**：直接编辑 LLM 节点的 prompt（如「更突出性价比」），点「发布」即生效，无需找开发。
- **售后查单**：打开「订单售后助手」→ 填 userId 或订单号 → 运行 → 看状态/物流/退换货指引。
- **调整退货话术 / 转人工阈值**：编辑对应节点即可。

## 四、权限与协作

- 在 Dify「成员」里把运营同事加为「编辑者」，他们就能自助改工作流、运行，且不影响网关代码。
- 模型供应商（DeepSeek / 通义 / Ollama）在 Dify「模型供应商」统一切换，运营无感。

## 五、排错

- 网关返回 `mode: "local"` 而非 `dify`：说明未配置对应 Key 或 Dify 调用失败，已自动降级（见网关日志 `[copywrite] Dify 失败…`）。
- 文案/售后结果异常：先在 Dify 控制台单独运行该 Workflow 看输出，再比对网关入参。

---

## 附：HTTPS 反向代理一键启用（nginx 终止 TLS + 注入 API Key）

> 适用场景：对外演示 / 上线前加固。把「静态前端 + AI Gateway」统一收口到一个 HTTPS 端口，
> 由 nginx 在网关侧注入 `X-API-Key`，**前端不持有密钥**，浏览器同源访问免跨域。

**一键启用：**
```bash
# 自签名演示（默认 https://localhost:8443）
bash scripts/setup-https-proxy.sh

# 正式部署：自带证书 + 443
HTTPS_PORT=443 DOMAIN=shop.example.com \
TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem \
bash scripts/setup-https-proxy.sh
```

**做了什么：**
- 未给证书时用 `openssl` 生成自签名证书到 `nginx/tls/`。
- 用官方 `nginx:1.27-alpine` 启动，配置由 `nginx/templates/default.conf.template` 经 `envsubst` 渲染（密钥不落盘到配置模板）。
- `/api`、`/health`、`/ready` 反向代理到 `ai-gateway`，并 `proxy_set_header X-API-Key` 注入网关密钥（覆盖任何客户端自带头，防伪造）。
- 自动把网关 `TRUST_PROXY=true`、`CORS_ORIGINS=https://域名:端口`，使限流按真实客户端 IP、同源免跨域。
- 冒烟轮询 `/health` 直到 200。

**停止 / 换证书：**
```bash
docker compose -f docker-compose.yml -f docker-compose.nginx.yml down
# 换正式证书：替换 nginx/tls/{fullchain,privkey}.pem 或重跑脚本带 TLS_CERT/TLS_KEY
```

