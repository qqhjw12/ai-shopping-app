#!/usr/bin/env bash
# 本地对象存储（S3 兼容）：为「评价买家秀」提供真实的上传/预签名能力
#
#   bash scripts/dev-storage.sh            # 前台启动（Ctrl+C 停止）
#   S3_PORT=8333 bash scripts/dev-storage.sh
#
# 用的是 SeaweedFS 的 all-in-one `mini` 模式（单文件二进制，无需 Docker）：
#   · S3 API  : http://127.0.0.1:8333   ← 网关走这个端点，SigV4 签名与真实 S3 一致
#   · 数据目录: .devtools/storage-data  （gitignored，删掉即清空）
#
# 首次运行会自动下载 weed.exe（约 48MB）并生成带鉴权的 s3.json ——
# 默认开启鉴权是刻意的：匿名可读的桶测不出签名逻辑，等于白搭。
#
# 生产环境把 STORAGE_DRIVER 指到真 S3/OSS/R2/MinIO 即可，本脚本只是本地替身。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT/.devtools"
BIN="${SEAWEED_BIN:-$TOOLS_DIR/weed.exe}"
DATA_DIR="${STORAGE_DATA_DIR:-$TOOLS_DIR/storage-data}"
CONF="$TOOLS_DIR/s3.json"
S3_PORT="${S3_PORT:-8333}"
BUCKET="${S3_BUCKET:-review-media}"
ACCESS_KEY="${S3_ACCESS_KEY_ID:-shopdevaccess}"
SECRET_KEY="${S3_SECRET_ACCESS_KEY:-shopdevsecret1234567890}"
VERSION="4.51"

# ── 1. 准备二进制 ───────────────────────────────────────────────────────────
if [[ ! -x "$BIN" ]]; then
  echo "▶ 未找到 SeaweedFS，正在下载 ${VERSION}（约 48MB）…"
  mkdir -p "$TOOLS_DIR"
  url="https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}/windows_amd64.zip"
  case "$(uname -s)" in
    Linux*)  url="https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}/linux_amd64.tar.gz" ;;
    Darwin*) url="https://github.com/seaweedfs/seaweedfs/releases/download/${VERSION}/darwin_amd64.tar.gz" ;;
  esac
  tmp="$TOOLS_DIR/_download"
  mkdir -p "$tmp"
  curl -sSL --ssl-no-revoke --max-time 600 -o "$tmp/pkg" "$url"
  case "$url" in
    *.zip)       unzip -o -q "$tmp/pkg" -d "$tmp" ;;
    *.tar.gz)    tar -xzf "$tmp/pkg" -C "$tmp" ;;
  esac
  found="$(find "$tmp" -maxdepth 1 -name 'weed*' -type f | head -1)"
  [[ -n "$found" ]] || { echo "✗ 下载包里没有 weed 可执行文件" >&2; exit 1; }
  mv "$found" "$BIN"
  chmod +x "$BIN"
  rm -rf "$tmp"
  echo "✓ 已安装 $("$BIN" version 2>/dev/null | head -1 || echo weed)"
fi

# ── 2. 生成带鉴权的身份配置（不存在才生成，避免覆盖手工改动） ───────────────
if [[ ! -f "$CONF" ]]; then
  cat > "$CONF" <<JSON
{
  "identities": [
    {
      "name": "shop-dev",
      "credentials": [{ "accessKey": "${ACCESS_KEY}", "secretKey": "${SECRET_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
JSON
  echo "✓ 已生成鉴权配置 $CONF（dev 凭据：${ACCESS_KEY} / ${SECRET_KEY:0:6}…）"
fi

mkdir -p "$DATA_DIR"

# ── 3. 端口预检 ─────────────────────────────────────────────────────────────
if node -e 'const n=require("node:net");const s=n.connect({host:"127.0.0.1",port:Number(process.argv[1])});s.setTimeout(400);s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1));s.on("timeout",()=>{s.destroy();process.exit(1)})' "$S3_PORT"; then
  echo "✗ S3 端口 ${S3_PORT} 已被占用" >&2
  echo "  换个端口：S3_PORT=8343 bash scripts/dev-storage.sh" >&2
  exit 1
fi

cat <<EOF

▶ 启动本地 S3（SeaweedFS mini）
   endpoint : http://127.0.0.1:${S3_PORT}
   bucket   : ${BUCKET}
   data     : ${DATA_DIR}
   access   : ${ACCESS_KEY}

   网关侧环境变量（写入 ai-gateway/.env 或直接 export）：
     STORAGE_DRIVER=s3
     S3_ENDPOINT=http://127.0.0.1:${S3_PORT}
     S3_REGION=us-east-1
     S3_BUCKET=${BUCKET}
     S3_ACCESS_KEY_ID=${ACCESS_KEY}
     S3_SECRET_ACCESS_KEY=${SECRET_KEY}
     S3_FORCE_PATH_STYLE=1

   Ctrl+C 停止（数据保留在 ${DATA_DIR}）

EOF

exec "$BIN" mini \
  -dir="$DATA_DIR" \
  -s3 \
  -s3.port="$S3_PORT" \
  -s3.config="$CONF" \
  -bucket="$BUCKET" \
  -admin.ui=false \
  -master.telemetry=false
