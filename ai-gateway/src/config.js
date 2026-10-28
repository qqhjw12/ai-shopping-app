import process from 'node:process';

const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  // local: 全部走内置内存降级；docker: 优先接真实服务，失败再降级
  runMode: env.RUN_MODE || 'local',
  embeddingProvider: env.EMBEDDING_PROVIDER || 'local',
  ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaEmbedModel: env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  qdrantUrl: env.QDRANT_URL || 'http://localhost:6333',
  elasticsearchUrl: env.ELASTICSEARCH_URL || 'http://localhost:9200',
  mallBaseUrl: env.MALL_BASE_URL || 'http://localhost:8081',
  vectorWeight: Number(env.VECTOR_WEIGHT || 0.6),
  keywordWeight: Number(env.KEYWORD_WEIGHT || 0.4),
  collection: 'products',
  esIndex: 'products',
  // Dify 中枢：一套管 5 个 AI 模块（含本阶段智能客服 + 商品问答）
  dify: {
    apiUrl: env.DIFY_API_URL || 'http://dify:5001/v1',
    customerServiceApiKey: env.DIFY_CS_API_KEY || '',
    productQaApiKey: env.DIFY_PQA_API_KEY || '',
    datasetId: env.DIFY_DATASET_ID || '',
    datasetApiKey: env.DIFY_DATASET_API_KEY || '',
    // AI 导购 App Key（Dify Agent，可回调 mall /api/ai/products）
    shoppingGuideApiKey: env.DIFY_SG_API_KEY || '',
    // 运营文案 Workflow App Key（运营同事在 Dify 控制台自助使用，即「无代码后台」）
    copywriteApiKey: env.DIFY_CW_API_KEY || '',
    // 订单售后 Workflow App Key（运营/用户在 Dify 控制台或前端自助查单、发起售后）
    aftersaleApiKey: env.DIFY_AS_API_KEY || '',
    // 智能客服 / 商品问答走 Dify 知识库检索时，单次召回条数
    retrievalLimit: Number(env.DIFY_RETRIEVAL_LIMIT || 3),
  },
  // CORS：逗号分隔的显式来源；留空则默认允许本地演示来源（生产必须显式配置，严禁 '*'）
  corsOrigins: (() => {
    const list = (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : ['http://localhost:5500', 'http://127.0.0.1:5500'];
  })(),
  // AI Gateway 访问鉴权：设置后所有业务接口（除 /health、/ready）需携带 X-API-Key
  aiGatewayApiKey: env.AI_GATEWAY_API_KEY || '',
  // 运营配置写入密钥（PUT /api/config 的 X-Admin-Key）。
  // 未设置 = 关闭写入，只读接口照常可用；生产必须显式配置，绝不使用默认值。
  adminApiKey: env.ADMIN_API_KEY || '',
  // 限流：每 IP 每分钟请求数（0 表示不限流，仅演示）
  rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 60),
  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
  // 演示开关：模拟发货 / 模拟签收两个端点。
  // 只影响「订单详情的演示按钮」，正常下单、支付、取消、售后路径完全不受影响。
  // 默认开（本站是演示站）；生产部署必须显式设 false，否则任何人都能把别人的订单推进状态。
  demoActions: env.DEMO_ACTIONS !== 'false',
  // 若 Gateway 前置了反向代理（如 nginx），从 X-Forwarded-For 取真实客户端 IP
  trustProxy: env.TRUST_PROXY === 'true',
  // 快递物流推送（webhook）：carrier → 密钥，格式 'sf:xxx,yd:yyy'。
  // 每家一把：共用一把的话，泄露一次全部渠道都要换，且分不清是谁发来的。
  // 未配置某家 → 该家的推送一律 401（端点公开，没配密钥就是没开通，不是免验证）。
  logisticsWebhook: (() => {
    const keys = new Map();
    for (const part of String(env.LOGISTICS_WEBHOOK_KEYS || '').split(',')) {
      const [carrier, secret] = part.split(':');
      const c = String(carrier || '').trim().toLowerCase();
      const s = String(secret || '').trim();
      if (c && s) keys.set(c, s);
    }
    return {
      keys,
      // 时间戳容差（秒）：超出窗口的推送一律拒，防止把抓到的旧请求重放一遍
      toleranceSec: Number(env.LOGISTICS_WEBHOOK_TOLERANCE_SEC || 300),
    };
  })(),
  // 买家秀上传加固：单请求重（base64 可达 6MB），需独立的频率 / 并发 / 配额约束
  upload: {
    // 单张原始字节上限（base64 解码后的图片大小）
    maxBytes: Number(env.UPLOAD_MAX_BYTES || 6 * 1024 * 1024),
    // 每用户每分钟上传次数（0 关闭）
    ratePerMin: Number(env.UPLOAD_RATE_PER_MIN || 10),
    // 每用户每 24 小时上传配额（0 关闭）
    dailyQuota: Number(env.UPLOAD_DAILY_QUOTA || 200),
    // 全局同时在处理的上传数上限，防并发大 body 打爆内存（0 关闭）
    maxConcurrent: Number(env.UPLOAD_MAX_CONCURRENT || 4),
  },
  // 认证：JWT 短时效访问令牌 + 服务端存储的刷新令牌
  auth: {
    // HS256 签名密钥；留空时 local 模式自动生成临时密钥（重启后旧令牌失效），生产必须显式配置
    secret: env.AUTH_JWT_SECRET || '',
    // 访问令牌有效期（秒），默认 15 分钟
    accessTtlSec: Number(env.AUTH_ACCESS_TTL_SEC || 900),
    // 刷新令牌有效期（秒），默认 14 天
    refreshTtlSec: Number(env.AUTH_REFRESH_TTL_SEC || 14 * 24 * 3600),
    // true：业务接口必须携带有效访问令牌（/api/auth/login、/api/auth/refresh 除外）
    required: env.AUTH_REQUIRED === 'true',
    // 刷新令牌 Cookie 名
    cookieName: env.AUTH_COOKIE_NAME || 'rt',
    // 生产走 HTTPS 时必须置 true（Cookie 加 Secure）
    cookieSecure: env.AUTH_COOKIE_SECURE === 'true',
    issuer: 'ai-gateway',
  },
  // 本地 SQLite 数据文件（local 模式的商品/订单/会话/埋点全部落这里，重启不丢）
  dbFile: env.DB_FILE || 'data/shop.db',
  // 买家秀等用户上传内容的存放位置
  //   local: 落 data/uploads（零依赖，适合本地演示 / 无外部服务的部署）
  //   s3   : 落 S3 兼容对象存储（SeaweedFS / MinIO / OSS / R2 / AWS），读取走预签名 URL
  storage: {
    driver: (env.STORAGE_DRIVER || 'local').toLowerCase() === 's3' ? 's3' : 'local',
    endpoint: (env.S3_ENDPOINT || '').replace(/\/+$/, ''),
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET || 'review-media',
    accessKeyId: env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    // 本地 S3 替身（MinIO/SeaweedFS）只认 path-style；真 AWS 设 0
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== '0',
    // 预签名 URL 有效期（秒）。短一点更安全：链接被转发出去也会自然失效
    mediaUrlTtl: Number(env.MEDIA_URL_TTL_SECONDS || 900),
    // 孤儿对象清理周期（秒）：回收上传未发布/删除后残留的图片对象。0 关闭
    sweepIntervalSec: Number(env.STORAGE_SWEEP_INTERVAL_SEC || 1800),
  },
  // 可选：OpenAI 兼容大模型（DeepSeek / 通义 / Kimi / OpenAI 皆可）。
  // 未配置 LLM_API_KEY 时自动使用内置本地对话引擎（零外部依赖）。
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || 'deepseek-chat',
    temperature: Number(env.LLM_TEMPERATURE || 0.5),
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 30000),
  },
};

// 是否启用真实大模型（配置了 Key 才启用，避免无谓请求）
export const llmEnabled = () => !!config.llm.apiKey;

// 启动期告警（仅打印一次）
export function startupWarnings() {
  const warns = [];
  if (config.corsOrigins.includes('*')) {
    warns.push('CORS_ORIGINS 含 "*"，生产环境存在跨站风险，请改为显式来源列表');
  }
  if (!config.aiGatewayApiKey) {
    warns.push('AI_GATEWAY_API_KEY 未设置，AI Gateway 当前对外开放（仅限演示/内网），生产请启用 API Key 鉴权');
  }
  if (config.storage.driver === 'local') {
    warns.push('STORAGE_DRIVER=local：买家秀落本地磁盘，多实例部署会读不到彼此的文件，生产建议切到 s3');
  }
  if (config.auth.required && !config.auth.secret) {
    warns.push('AUTH_REQUIRED=true 但 AUTH_JWT_SECRET 未设置：将拒绝启动（生产必须配置固定密钥）');
  } else if (!config.auth.secret) {
    warns.push('AUTH_JWT_SECRET 未设置：local 模式将生成临时密钥，进程重启后已签发的访问/刷新令牌全部失效');
  }
  if (!config.adminApiKey) {
    warns.push('ADMIN_API_KEY 未设置：运营配置接口（PUT /api/config）为只读，无法调整运费与券返还规则');
  }
  if (config.demoActions) {
    warns.push('DEMO_ACTIONS 未关闭：模拟发货 / 模拟签收端点对外开放（仅演示站可接受，生产请设 DEMO_ACTIONS=false）');
  }
  return warns;
}

// 是否优先使用真实外部服务（docker 模式）
export const useReal = () => config.runMode === 'docker';

// Dify 是否就绪：docker 模式且两个 App 的 API Key 都已配置
export const difyEnabled = () =>
  config.runMode === 'docker' &&
  !!config.dify.customerServiceApiKey &&
  !!config.dify.productQaApiKey;
