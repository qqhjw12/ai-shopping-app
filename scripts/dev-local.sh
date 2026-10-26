#!/usr/bin/env bash
# 一键本地启动：AI 网关（:8080）+ 静态前端（:5500）
# 用法：bash scripts/dev-local.sh
# 首次运行会自动建库并灌入 256 款商品（ai-gateway/data/shop.db）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GW_PORT="${PORT:-8080}"
WEB_PORT="${WEB_PORT:-5500}"

cleanup() {
  if [[ -n "${GW_PID:-}" ]] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
    echo "· 已停止网关 (pid $GW_PID)"
  fi
}
trap cleanup EXIT INT TERM

echo "▶ 启动 AI 网关（local 模式，SQLite）…"
cd "$ROOT/ai-gateway"
node --disable-warning=ExperimentalWarning src/server.js &
GW_PID=$!

# 等网关就绪（最多 15s）
for _ in $(seq 1 30); do
  if curl -fsS --noproxy '*' "http://127.0.0.1:${GW_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS --noproxy '*' "http://127.0.0.1:${GW_PORT}/health" >/dev/null 2>&1; then
  echo "✗ 网关启动失败，请检查上面的报错日志" >&2
  exit 1
fi

PRODUCTS=$(curl -fsS --noproxy '*' "http://127.0.0.1:${GW_PORT}/api/products" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).products.length)}catch{console.log('?')}})")

cat <<EOF

✅ 已就绪
   网关:  http://localhost:${GW_PORT}   （商品 ${PRODUCTS} 款）
   数据库: ai-gateway/data/shop.db

🌐 打开前端: http://localhost:${WEB_PORT}/?api=http://localhost:${GW_PORT}

   （前端与网关跨端口，脚本已默认放行 CORS；按 Ctrl+C 同时停止两者）

EOF

echo "▶ 启动静态前端…"
cd "$ROOT/web"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$WEB_PORT"
else
  python -m http.server "$WEB_PORT"
fi
