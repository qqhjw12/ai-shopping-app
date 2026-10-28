#!/usr/bin/env bash
# 一键本地启动：AI 网关（:8080）+ 静态前端（:5500）
#
#   bash scripts/dev-local.sh                # 默认 8080 + 5500
#   PORT=9090 WEB_PORT=5501 bash scripts/dev-local.sh
#   SKIP_GATEWAY=1 bash scripts/dev-local.sh # 只起前端（网关已在跑 / 连远程网关）
#
# 静态服务优先用本机 Python（scripts/dev_server.py：no-store + MIME 补全）：
# 有 Python 就用 Python，Python 缺失或启动失败时自动降级到 Node 实现
# （scripts/static-server.mjs）。两者行为一致，都不需要装第三方包。
#
# 首次运行会自动建库并灌入商品种子（ai-gateway/data/shop.db）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GW_PORT="${PORT:-8080}"
WEB_PORT="${WEB_PORT:-5500}"
WEB_BIND="${WEB_BIND:-127.0.0.1}"
SKIP_GATEWAY="${SKIP_GATEWAY:-0}"
GW_PID=""
WEB_PID=""

# ── 工具函数 ────────────────────────────────────────────────────────────────

# HTTP 探活（用 Node 自带 fetch，免得受 curl 代理/证书配置影响）
http_ok() {
  node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(1500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$1" >/dev/null 2>&1
}

# TCP 端口占用探测（不用 lsof/netstat，跨平台一致）
port_busy() {
  node -e 'const net=require("node:net");const s=net.connect({host:"127.0.0.1",port:Number(process.argv[1])});s.setTimeout(500);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>{s.destroy();process.exit(1)})' "$1"
}

stop_pid() {
  local pid="$1" label="$2"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    echo "· 已停止${label} (pid $pid)"
  fi
}

# 静默收尸：用于「起了但没就绪」的失败进程，不必告诉用户"已停止"
kill_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  # 先停前端再停网关；清空 PID 让重复触发（INT + EXIT）保持幂等
  stop_pid "$WEB_PID" "前端"
  WEB_PID=""
  stop_pid "$GW_PID" "网关"
  GW_PID=""
}
trap cleanup EXIT INT TERM

die() { echo "✗ $*" >&2; exit 1; }

# 端口被占时给出可直接执行的排查命令（Windows / Unix 都覆盖）
port_conflict_hint() {
  local port="$1" who="$2"
  echo "✗ ${who}端口 ${port} 已被占用" >&2
  echo "  换个端口：  WEB_PORT=$((port + 1)) bash scripts/dev-local.sh" >&2
  echo "  或先查占用：netstat -ano | grep ':${port} '" >&2
  echo "              taskkill //PID <pid> //F        # Windows" >&2
  echo "              lsof -ti:${port} | xargs kill   # macOS / Linux" >&2
  exit 1
}

detect_python() {
  local cand
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import http.server' >/dev/null 2>&1; then
      printf '%s' "$cand"
      return 0
    fi
  done
  # Windows 的 py 启动器：PATH 里常常只有 py 没有 python
  if command -v py >/dev/null 2>&1 && py -3 -c 'import http.server' >/dev/null 2>&1; then
    printf 'py -3'
    return 0
  fi
  return 1
}

# ── 0. 前置检查 ─────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js 20+（网关依赖 node:sqlite）"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || die "Node 版本过低（当前 $(node -v)），需要 20+"

# ── 1. 启动网关 ─────────────────────────────────────────────────────────────

# 可选：ai-gateway/.env 存在就导入（本地开发配置，含存储/大模型等开关；不入库）
if [[ -f "$ROOT/ai-gateway/.env" ]] && [[ "${SKIP_DOTENV:-0}" != "1" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/ai-gateway/.env"
  set +a
  echo "· 已加载 ai-gateway/.env"
fi

if [[ "$SKIP_GATEWAY" == "1" ]]; then
  echo "▶ 跳过网关（SKIP_GATEWAY=1），假定 ${GW_PORT} 已有可用网关"
else
  port_busy "$GW_PORT" && port_conflict_hint "$GW_PORT" "网关"
  echo "▶ 启动 AI 网关（local 模式，SQLite）…"
  cd "$ROOT/ai-gateway"
  node --disable-warning=ExperimentalWarning src/server.js &
  GW_PID=$!

  for _ in $(seq 1 40); do
    http_ok "http://127.0.0.1:${GW_PORT}/health" && break
    kill -0 "$GW_PID" 2>/dev/null || die "网关进程已退出，请看上面的报错日志"
    sleep 0.5
  done
  http_ok "http://127.0.0.1:${GW_PORT}/health" \
    || die "网关 20s 内未就绪，请看上面的日志（端口 ${GW_PORT}）"
fi

# /health 顺带给出 runMode 与索引商品数，避免为了显示数量去拉整库
HEALTH="$(node -e 'fetch(process.argv[1]).then(r=>r.json()).then(j=>console.log(`${j.runMode}|${j.vectorStore}|${j.storage||"-"}`)).catch(()=>console.log("?|?|-"))' "http://127.0.0.1:${GW_PORT}/health")"
RUN_MODE="${HEALTH%%|*}"
PRODUCTS="$(printf '%s' "$HEALTH" | cut -d'|' -f2)"
STORAGE_DRIVER="$(printf '%s' "$HEALTH" | cut -d'|' -f3)"

# ── 2. 启动静态前端 ─────────────────────────────────────────────────────────

port_busy "$WEB_PORT" && port_conflict_hint "$WEB_PORT" "前端"
cd "$ROOT"

WEB_KIND=""
WEB_READY=0
PY_CMD=()

start_web_node() {
  node scripts/static-server.mjs --port "$WEB_PORT" --bind "$WEB_BIND" --root "$ROOT/web" --quiet &
  WEB_PID=$!
}

wait_web() {
  for _ in $(seq 1 20); do
    http_ok "http://127.0.0.1:${WEB_PORT}/index.html" && { WEB_READY=1; return 0; }
    kill -0 "$WEB_PID" 2>/dev/null || return 1
    sleep 0.3
  done
  return 1
}

if PY="$(detect_python)"; then
  read -r -a PY_CMD <<< "$PY"
  PY_VER="$("${PY_CMD[@]}" -c 'import sys;print("%d.%d.%d"%sys.version_info[:3])' 2>/dev/null || echo '?')"
  echo "▶ 启动静态前端（Python ${PY_VER} · scripts/dev_server.py）…"
  "${PY_CMD[@]}" scripts/dev_server.py --port "$WEB_PORT" --bind "$WEB_BIND" --directory "$ROOT/web" --quiet &
  WEB_PID=$!
  WEB_KIND="python ${PY_VER}"
  wait_web || true

  # Python 起不来（极端环境 / 权限 / 端口策略）→ 自动降级，别让整条链路卡死
  if [[ "$WEB_READY" != "1" ]]; then
    echo "⚠ Python 静态服务未就绪，降级到 Node 实现…" >&2
    kill_pid "$WEB_PID"
    WEB_PID=""
    start_web_node
    WEB_KIND="node $(node -v) · Python 降级"
    wait_web || true
  fi
else
  echo "▶ 未检测到 Python，改用 Node 静态服务（scripts/static-server.mjs）…"
  start_web_node
  WEB_KIND="node $(node -v)"
  wait_web || true
fi

[[ "$WEB_READY" == "1" ]] || die "前端静态服务未能启动（端口 ${WEB_PORT}），请看上面的日志"

# ── 3. 就绪横幅 ─────────────────────────────────────────────────────────────

cat <<EOF

✅ 已就绪
   网关:   http://localhost:${GW_PORT}   （runMode=${RUN_MODE}，索引商品 ${PRODUCTS} 款，买家秀存储 ${STORAGE_DRIVER}）
   数据库: ai-gateway/data/shop.db
   前端:   http://localhost:${WEB_PORT}/   （${WEB_KIND}，no-store）

🌐 打开前端: http://localhost:${WEB_PORT}/?api=http://localhost:${GW_PORT}

   前端自检: node scripts/check-web.mjs
   停止:     Ctrl+C（网关与前端一并退出）

EOF

wait "$WEB_PID"
