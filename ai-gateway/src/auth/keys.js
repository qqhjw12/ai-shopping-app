// 签名密钥解析：优先环境变量；local 演示模式未配置时生成临时密钥（进程内）。
// 生产要求固定密钥：AUTH_REQUIRED=true 且未配置时，这里会直接抛错，由启动流程快速失败。
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

let cached = null;
let generated = false;

/** 返回 HS256 签名密钥；未配置且非强制鉴权时生成临时密钥 */
export function getSecret() {
  if (cached) return cached;
  if (config.auth.secret) {
    cached = config.auth.secret;
    return cached;
  }
  if (config.auth.required) {
    throw new Error('AUTH_REQUIRED=true 但 AUTH_JWT_SECRET 未设置，拒绝启动');
  }
  cached = randomBytes(32).toString('hex');
  generated = true;
  return cached;
}

/** 是否使用了自动生成的临时密钥（用于启动告警 / 健康检查展示） */
export const isEphemeralSecret = () => generated;
