import { randomUUID } from 'node:crypto';

// 不记录到日志的敏感头字段
const SENSITIVE_HEADERS = [
  'authorization',
  'x-api-key',
  'x-ai-gateway-key',
  'cookie',
  'set-cookie',
];

// 脱敏：返回头字段的副本，敏感值替换为占位符
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.includes(k.toLowerCase()) ? '<redacted>' : v;
  }
  return out;
}

function emit(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(entry);
  // 错误走 stderr，其余走 stdout（便于容器按级别采集）
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

export { randomUUID };
