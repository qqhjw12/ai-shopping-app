# mall-ai 集成模块（独立部署形态）

在 fork 的 [macrozheng/mall](https://github.com/macrozheng/mall) 中新增的 Maven 模块，向 **ai-gateway** 暴露**只读**商品接口，
供「智能搜索 / 商品问答 / 运营文案 / 订单售后 / AI 导购」等模块回调与同步数据。商城内核（订单、支付、会员等）完全不动。

> 设计要点：本模块是**一个独立的 Spring Boot 应用**，独立占用 `8081` 端口、直连 mall 数据库，
> 而非嵌入 mall-admin。这样契合 ai-gateway 的 `MALL_BASE_URL=http://...:8081/api/ai/products` 约定，
> 也避免了改动 mall-admin 复杂的 SecurityConfig。

## 目录结构

```
mall-ai/
├── pom.xml                              # 独立可打包的 Spring Boot 模块
├── Dockerfile                           # 多阶段：Maven 编译 -> JRE 运行（构建上下文= mall fork 根）
├── src/main/java/com/macro/mall/ai/
│   ├── MallAiApplication.java           # @SpringBootApplication 启动类
│   ├── controller/AiProductController.java   # GET /api/ai/products, /{id}
│   ├── service/AiProductService.java
│   ├── service/impl/AiProductServiceImpl.java
│   ├── dto/AiProductDTO.java            # 暴露给 Gateway 的精简商品结构
│   └── filter/AiGatewayAuthFilter.java  # 可选内部鉴权（X-AI-Gateway-Key）
└── src/main/resources/application.yml   # 端口 8081 / 数据源 / mybatis 扫描
```

## 依赖关系（编译期）

`mall-ai` 作为 mall fork 的 Maven 模块，编译时被 `-am` 自动带上两个上游模块：

- `mall-common`（提供 `CommonResult` 等通用封装）
- `mall-mbg`（提供 `PmsProduct` 模型与 `PmsProductMapper`）

运行时只需 mall 的 MySQL 库（同一套 `mall` 数据库）。

## 一键接入（推荐 Docker 路径，本机无需 JDK）

```bash
# 1) 克隆 mall、植入 mall-ai、改根 pom、准备 mall.sql（无需 JDK）
bash scripts/setup-mall-ai-env.sh --prepare-only

# 2) 起数据库 + mall-ai（Maven 编译在容器内完成）
docker compose up -d mall-mysql mall-ai

# 3) 验证
curl http://localhost:8081/api/ai/products
curl http://localhost:8081/api/ai/products/1
```

## 本地编译路径（需 JDK17 + Maven）

```bash
bash scripts/setup-mall-ai-env.sh            # 会自动尝试本地 mvn 编译
# 或手动：
cd mall-fork && mvn -q -pl mall-ai -am -DskipTests package
docker compose up -d mall-mysql              # 先起库
java -jar mall-fork/mall-ai/target/mall-ai.jar
```

## 注入根 pom（脚本已自动完成，手工步骤备查）

在 mall fork 根 `pom.xml` 的 `<modules>` 中加入：

```xml
<module>mall-ai</module>
```

## 配置项（application.yml，均支持环境变量覆盖）

| 配置 | 默认值 | 说明 |
|------|--------|------|
| `server.port` | `8081` | 服务端口 |
| `DB_HOST` | `localhost` | MySQL 主机（Docker 下为 `mall-mysql`） |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` / `DB_PASSWORD` | `mall` / `mall` | 数据库账号 |
| `ai.gateway-key` | 空 | 与 ai-gateway 的 `AI_GATEWAY_KEY` 一致则启用内部鉴权 |

## 接口约定（ai-gateway 回调依据）

| 方法 | 路径 | 说明 | 返回 |
|------|------|------|------|
| GET | `/api/ai/products?pageSize=20&pageNum=0` | 已上架、未删除商品列表 | `CommonResult<List<AiProductDTO>>` |
| GET | `/api/ai/products/{id}` | 商品详情 | `CommonResult<AiProductDTO>` |

`AiProductDTO` 字段：id、name、subtitle、price、originalPrice、pic、stock、sale、brand、category、description、tags。
字段与 `ai-gateway/src/data/products.js` 对齐，保证离线（内置样本）与在线（真实 mall）数据可无缝切换。

## 安全说明

- 该端点只读，不暴露写操作；建议在**内网**部署，或通过网关 `AI_GATEWAY_API_KEY` + `ai.gateway-key` 双向校验。
- `AiGatewayAuthFilter` 默认放行（未配置 key 时）；生产环境务必配置 `AI_GATEWAY_KEY` 与 `ai.gateway-key`。
