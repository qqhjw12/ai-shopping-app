#!/usr/bin/env bash
#
# setup-https-proxy.sh
# ───────────────────────────────────────────────────────────────────────────
# 一键为「AI Gateway + Web 前端」套上 HTTPS 反向代理（nginx 终止 TLS + 注入 API Key）。
#
# 做了什么：
#   1. 读取 .env（若存在）拿到 AI_GATEWAY_API_KEY / HTTPS_PORT / DOMAIN 等。
#   2. 未提供正式证书（TLS_CERT/TLS_KEY）时，用 openssl 生成自签名证书到 nginx/tls/。
#   3. 用 Docker 启动 nginx：监听 HTTPS_PORT，同源托管 web/ 静态文件，并把
#      /api、/health、/ready 反向代理到 ai-gateway，且在网关侧注入 X-API-Key
#      —— 前端不再持有密钥，浏览器同源访问免跨域。
#   4. 同时把网关的 TRUST_PROXY 置 true、CORS_ORIGINS 设为 nginx 的 https 来源，
#      使限流按真实客户端 IP 计算、同源访问无需 CORS。
#   5. 冒烟检测：轮询 https://DOMAIN:HTTPS_PORT/health 直到 200。
#
# 前置：Docker（含 compose）、openssl。无需本机安装 nginx / JDK。
# 用法：
#   bash scripts/setup-https-proxy.sh
#   HTTPS_PORT=443  DOMAIN=shop.example.com  bash scripts/setup-https-proxy.sh
#   TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem bash scripts/setup-https-proxy.sh
# ───────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# 若存在 .env 则加载（仅用于读取 AI_GATEWAY_API_KEY 等；不覆盖已导出的环境变量）
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# 参数（均可被环境变量覆盖）
HTTPS_PORT="${HTTPS_PORT:-8443}"
DOMAIN="${DOMAIN:-localhost}"
GATEWAY_UPSTREAM="${GATEWAY_UPSTREAM:-ai-gateway:8080}"
AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY:-}"
TLS_CERT="${TLS_CERT:-}"
TLS_KEY="${TLS_KEY:-}"

NGINX_DIR="$PROJECT_ROOT/nginx"
TLS_DIR="$NGINX_DIR/tls"
TEMPLATE_SRC="$NGINX_DIR/templates/default.conf.template"

log()  { echo -e "\033[32m[https]\033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m $*"; }
err()  { echo -e "\033[31m[error]\033[0m $*" >&2; }

# 0) 依赖检查
command -v docker  >/dev/null 2>&1 || { err "未检测到 docker，请先安装 Docker Desktop / Docker Engine。"; exit 1; }
command -v openssl >/dev/null 2>&1 || { err "未检测到 openssl，无法生成自签名证书。"; exit 1; }
[ -f "$TEMPLATE_SRC" ] || { err "未找到 nginx 模板：$TEMPLATE_SRC"; exit 1; }

# 1) 准备 TLS 证书
mkdir -p "$TLS_DIR"
CERT_DST="$TLS_DIR/fullchain.pem"
KEY_DST="$TLS_DIR/privkey.pem"

if [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ]; then
  log "使用提供的证书：$TLS_CERT"
  cp -f "$TLS_CERT" "$CERT_DST"
  cp -f "$TLS_KEY"  "$KEY_DST"
elif [ -f "$CERT_DST" ] && [ -f "$KEY_DST" ]; then
  log "复用已存在的自签名证书（删除 nginx/tls/ 可重新生成）。"
else
  warn "未提供 TLS_CERT/TLS_KEY，将生成自签名证书（浏览器会提示不安全，仅演示用）。"
  if openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_DST" -out "$CERT_DST" -days 825 \
        -subj "/CN=${DOMAIN}" \
        -addext "subjectAltName=DNS:${DOMAIN},IP:127.0.0.1" >/dev/null 2>&1; then
    :
  else
    # 旧版 openssl 不支持 -addext，退回不带 SAN 的版本
    openssl req -x509 -newkey rsa:2048 -nodes \
        -keyout "$KEY_DST" -out "$CERT_DST" -days 825 \
        -subj "/CN=${DOMAIN}" >/dev/null 2>&1
  fi
  log "已生成自签名证书 -> $CERT_DST"
fi

# 2) 启动（合并主栈 + nginx 覆盖文件，共享 shopping-ai_default 网络）
export HTTPS_PORT DOMAIN GATEWAY_UPSTREAM AI_GATEWAY_API_KEY
# 让网关：信任反代拿真实客户端 IP、并允许 nginx 的 https 来源（同源免跨域）
export TRUST_PROXY=true
export CORS_ORIGINS="https://${DOMAIN}:${HTTPS_PORT}"

log "启动 nginx 反向代理（HTTPS :${HTTPS_PORT}，域名 ${DOMAIN}）..."
docker compose -f docker-compose.yml -f docker-compose.nginx.yml up -d nginx

# 3) 冒烟检测
URL="https://${DOMAIN}:${HTTPS_PORT}/health"
log "等待网关就绪：$URL"
for i in $(seq 1 30); do
  if curl -fsS -k "$URL" >/dev/null 2>&1; then
    log "✅ 健康检查通过，代理已就绪！"
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "健康检查超时，请排查：docker compose -f docker-compose.yml -f docker-compose.nginx.yml logs nginx"
  fi
  sleep 2
done

echo
log "============================ 完成 ============================"
log "前端 + API 统一访问地址： https://${DOMAIN}:${HTTPS_PORT}/"
log "  - 静态前端由 nginx 同源托管（浏览器免跨域）"
log "  - /api、/health、/ready 已由 nginx 反向代理到 ai-gateway"
log "  - API Key 在 nginx 侧注入（X-API-Key），前端不持有密钥"
echo
log "停止： docker compose -f docker-compose.yml -f docker-compose.nginx.yml down"
log "换正式证书： 把证书放到 nginx/tls/{fullchain,privkey}.pem，或设 TLS_CERT/TLS_KEY 后重跑本脚本"
[ -z "$AI_GATEWAY_API_KEY" ] && warn "当前 AI_GATEWAY_API_KEY 为空，网关处于开放状态；生产务必设置该密钥。"
