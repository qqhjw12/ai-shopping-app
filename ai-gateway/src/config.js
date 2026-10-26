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
  // 限流：每 IP 每分钟请求数（0 表示不限流，仅演示）
  rateLimitPerMin: Number(env.RATE_LIMIT_PER_MIN || 60),
  rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 60000),
  // 若 Gateway 前置了反向代理（如 nginx），从 X-Forwarded-For 取真实客户端 IP
  trustProxy: env.TRUST_PROXY === 'true',
  // 本地 SQLite 数据文件（local 模式的商品/订单/会话/埋点全部落这里，重启不丢）
  dbFile: env.DB_FILE || 'data/shop.db',
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
  return warns;
}

// 是否优先使用真实外部服务（docker 模式）
export const useReal = () => config.runMode === 'docker';

// Dify 是否就绪：docker 模式且两个 App 的 API Key 都已配置
export const difyEnabled = () =>
  config.runMode === 'docker' &&
  !!config.dify.customerServiceApiKey &&
  !!config.dify.productQaApiKey;
