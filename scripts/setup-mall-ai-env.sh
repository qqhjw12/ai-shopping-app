#!/usr/bin/env bash
#
# setup-mall-ai-env.sh
# ───────────────────────────────────────────────────────────────────────────
# 自动把 mall-ai 模块编译进 macrozheng/mall 的 fork，并配置好运行环境。
#
# 设计原则：
#   - 克隆 mall 到 mall-fork/，把本仓库的 mall-ai/ 植入，并幂等注入
#     <module>mall-ai</module> 到 mall 根 pom.xml。
#   - 默认「本地编译」路径需要 JDK17 + Maven（脚本会检测并提示安装）。
#   - --prepare-only 只做「克隆 + 植入 + 改 pom」，不编译——之后请用 Docker
#     路径（docker compose up -d mall-mysql mall-ai），由 Maven 容器编译，
#     【本机无需安装 JDK】。
#
# 用法：
#   bash scripts/setup-mall-ai-env.sh            # 克隆+植入+尝试本地编译
#   bash scripts/setup-mall-ai-env.sh --prepare-only
#   MALL_FORK_DIR=/path/to/fork bash scripts/setup-mall-ai-env.sh --prepare-only
# ───────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MALL_FORK_DIR="${MALL_FORK_DIR:-$PROJECT_ROOT/mall-fork}"
MALL_AI_SRC="$PROJECT_ROOT/mall-ai"
MALL_REPO_URL="https://github.com/macrozheng/mall.git"

PREPARE_ONLY=0
for a in "$@"; do
  case "$a" in
    --prepare-only) PREPARE_ONLY=1 ;;
    *) echo "未知参数: $a" >&2; exit 2 ;;
  esac
done

log()  { echo -e "\033[32m[setup]\033[0m $*"; }
warn() { echo -e "\033[33m[warn]\033[0m $*"; }
err()  { echo -e "\033[31m[error]\033[0m $*" >&2; }

# 优先 python3，其次 python
PYBIN=""
if command -v python3 >/dev/null 2>&1; then PYBIN=python3
elif command -v python >/dev/null 2>&1; then PYBIN=python
fi

log "PROJECT_ROOT = $PROJECT_ROOT"
log "MALL_FORK_DIR = $MALL_FORK_DIR"

# 1) 克隆 / 复用 mall fork
if [ -d "$MALL_FORK_DIR/.git" ]; then
  log "检测到已存在的 mall-fork，跳过克隆（如需重新拉取请删除该目录）。"
else
  log "克隆 macrozheng/mall -> $MALL_FORK_DIR"
  if ! command -v git >/dev/null 2>&1; then
    err "未找到 git，请先安装 Git（https://git-scm.com）。"
    exit 1
  fi
  git clone --depth 1 "$MALL_REPO_URL" "$MALL_FORK_DIR"
fi

# 2) 植入 mall-ai 模块（幂等：先清后拷）
log "植入 mall-ai 模块到 fork ..."
rm -rf "$MALL_FORK_DIR/mall-ai"
cp -r "$MALL_AI_SRC" "$MALL_FORK_DIR/mall-ai"

# 2.1) 复制 mall.sql 到 db/，供 mall-mysql 自动导入（compose 挂载 ./db）
mkdir -p "$PROJECT_ROOT/db"
if [ -f "$MALL_FORK_DIR/mall.sql" ]; then
  cp "$MALL_FORK_DIR/mall.sql" "$PROJECT_ROOT/db/01-mall.sql"
  log "已复制 mall.sql -> db/01-mall.sql（mall-mysql 将自动建库建表）"
else
  warn "未找到 $MALL_FORK_DIR/mall.sql，mall-mysql 将只有空库；请按 mall 官方文档手动导入数据。"
fi

# 3) 幂等注入 <module>mall-ai</module> 到根 pom.xml
ROOT_POM="$MALL_FORK_DIR/pom.xml"
if [ ! -f "$ROOT_POM" ]; then
  err "未在 $ROOT_POM 找到 mall 根 pom.xml，fork 结构异常，终止。"
  exit 1
fi

if grep -q "<module>mall-ai</module>" "$ROOT_POM"; then
  log "根 pom 已包含 mall-ai 模块，跳过注入。"
else
  log "向根 pom 注入 <module>mall-ai</module> ..."
  if [ -n "$PYBIN" ]; then
    "$PYBIN" - "$ROOT_POM" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if '<modules>' not in s:
    sys.stderr.write('根 pom 未找到 <modules>，请手动加入 <module>mall-ai</module>\n')
    sys.exit(1)
s2 = re.sub(r'(<modules>\s*)', r'\1<module>mall-ai</module>\n    ', s, count=1)
open(p, 'w', encoding='utf-8').write(s2)
print('patched')
PY
  else
    # 退化方案：用 sed 在 <modules> 后插入（兼容性较差，仅在无 python 时启用）
    warn "未找到 python，尝试用 sed 注入（可能不兼容复杂格式）。"
    sed -i.bak 's#<modules>#<modules>\n    <module>mall-ai</module>#' "$ROOT_POM"
  fi
  grep -q "<module>mall-ai</module>" "$ROOT_POM" \
    && log "注入成功。" \
    || err "注入失败，请手动在根 pom 的 <modules> 中加入 <module>mall-ai</module>。"
fi

# 4) 编译（除非 --prepare-only）
if [ "$PREPARE_ONLY" -eq 1 ]; then
  log "--prepare-only：跳过编译。"
else
  if command -v mvn >/dev/null 2>&1; then
    log "使用本地 Maven 编译 mall-ai 及其上游依赖（跳过测试）..."
    ( cd "$MALL_FORK_DIR" && mvn -q -pl mall-ai -am -DskipTests package )
    log "本地编译完成：mall-fork/mall-ai/target/mall-ai.jar"
  else
    warn "未检测到本地 Maven。可用 Docker 路径自动编译（无需本机 JDK）："
    warn "  docker compose up -d mall-mysql mall-ai"
  fi
fi

# 5) 收尾提示
echo
log "======================== 完成 ========================"
log "mall-ai 已植入: $MALL_FORK_DIR/mall-ai"
if [ "$PREPARE_ONLY" -eq 1 ]; then
  log "已选择 prepare-only，请运行 Docker 路径编译并启动："
  echo "    docker compose up -d mall-mysql mall-ai"
else
  log "运行方式二选一："
  echo "  [Docker 路径 · 推荐，无需本机 JDK]"
  echo "    docker compose up -d mall-mysql mall-ai"
  echo "  [本地路径 · 已编译]"
  echo "    docker compose up -d mall-mysql      # 先起数据库"
  echo "    java -jar $MALL_FORK_DIR/mall-ai/target/mall-ai.jar"
fi
echo
log "验证接口："
echo "    curl http://localhost:8081/api/ai/products"
echo "    curl http://localhost:8081/api/ai/products/1"
echo
log "数据说明：mall-mysql 会自动导入 mall-fork/mall.sql 建库建表；"
log "若数据为空，请确认 mall.sql 已就位，或按 mall 官方文档手动导入。"
