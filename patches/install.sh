#!/usr/bin/env bash
# =============================================================================
# Toonflow 自定义版本 —— 一键部署到新 instabox 服务器
# =============================================================================
# 用法（在全新机器上）：
#   1. 把整个 toonflow-backup 目录上传到新机器
#   2. bash install.sh
#
# 前提：机器已装 docker（instabox 默认自带）
#
# 这个脚本做四件事：
#   1. 克隆上游 Toonflow-app 到固定 commit（保证补丁能干净应用）
#   2. 应用我们的补丁（自动上画布 + 视频参考图强制）
#   3. 构建镜像并启动容器
#   4. 装 nginx 反代（修 Host/Origin，解决 403）+ 监控面板
# =============================================================================
set -euo pipefail

APP_DIR=/data/home/apps/Toonflow-app
DATA_DIR=/data/home/toonflow/data
IMAGE=toonflow:app
UPSTREAM=https://github.com/HBAI-Ltd/Toonflow-app.git
BASE_COMMIT=30139c9
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 这些值在首次运行时自动推断，也可以用环境变量覆盖：
#   APP_PORT=3000 PUBLIC_PORT=8080 MACHINE_DOMAIN=xxxx bash install.sh
APP_PORT="${APP_PORT:-3000}"
PUBLIC_PORT="${PUBLIC_PORT:-8080}"
MACHINE_DOMAIN="${MACHINE_DOMAIN:-}"

echo "=============================================="
echo " Toonflow 部署开始"
echo "=============================================="

# ---------------------------------------------------------------- 1. 推断域名
if [ -z "$MACHINE_DOMAIN" ]; then
  # instabox 的公网域名里带机器 id（去掉 m_ 前缀），从环境里捞不到时让用户填。
  echo "[!] 未提供 MACHINE_DOMAIN"
  echo "    请用：MACHINE_DOMAIN=xxxxx bash install.sh"
  echo "    （在 instabox 控制台能看到，形如 a1b2c3d4e5f6g7h8i9j0k1l2m3）"
  MACHINE_DOMAIN="REPLACE_ME"
fi
PUBLIC_HOST="${PUBLIC_PORT}-${MACHINE_DOMAIN}.instabox.tech"
echo "    公网地址: https://${PUBLIC_HOST}/"

# ---------------------------------------------------------------- 2. 源码
echo "[1/6] 准备源码"
mkdir -p /data/home/apps
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$UPSTREAM" "$APP_DIR"
fi
cd "$APP_DIR"

# 补丁是针对 BASE_COMMIT 生成的；上游 HEAD 前进了可能冲突，所以钉住版本。
git fetch --all --tags 2>/dev/null || true
git checkout -f "$BASE_COMMIT" 2>/dev/null || {
  echo "    [!] 找不到 $BASE_COMMIT，尝试从远端拉全量历史"
  git fetch --unshallow 2>/dev/null || true
  git checkout -f "$BASE_COMMIT"
}
git reset --hard "$BASE_COMMIT"
git clean -fd

# ---------------------------------------------------------------- 3. 打补丁
echo "[2/6] 应用补丁"
if [ -f "$HERE/toonflow-custom.patch" ]; then
  # 用 --3way 容忍行尾差异；失败则回退到直接覆盖文件
  if git apply --3way "$HERE/toonflow-custom.patch" 2>/dev/null; then
    echo "    patch 应用成功"
  else
    echo "    [!] patch 冲突，改用直接覆盖方式"
    cp -r "$HERE/source/." "$APP_DIR/"
  fi
else
  cp -r "$HERE/source/." "$APP_DIR/"
fi

echo "    校验补丁："
for probe in \
  "apps/web/src/lib/canvasAutoplace.ts" \
  "apps/web/src/components/agent/conversation.vue"
do
  [ -e "$probe" ] && echo "      ok  $probe"
done
grep -q "placeAgentMedia" apps/web/src/components/agent/conversation.vue \
  && echo "      ok  自动上画布已注入" \
  || { echo "      FAIL 自动上画布缺失"; exit 1; }
grep -q "promptGuidelines" packages/tools/mediaGeneration/src/index.ts \
  && echo "      ok  视频参考图规则已注入" \
  || { echo "      FAIL 参考图规则缺失"; exit 1; }

# ---------------------------------------------------------------- 4. 构建
echo "[3/6] 构建镜像（首次约 5-10 分钟）"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" .
else
  echo "    镜像已存在，跳过构建（要强制重建：docker rmi $IMAGE && bash install.sh）"
fi

# ---------------------------------------------------------------- 5. 数据目录
echo "[4/6] 准备数据目录"
mkdir -p "$DATA_DIR" /data/home/logs
# 如果备份里带了 data，恢复它
if [ -d "$HERE/data-backup" ] && [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  echo "    恢复数据备份"
  cp -a "$HERE/data-backup/." "$DATA_DIR/"
fi

# ---------------------------------------------------------------- 6. 启动
echo "[5/6] 启动容器"
docker rm -f toonflow >/dev/null 2>&1 || true
docker run -d --name toonflow --restart unless-stopped \
  -p "${APP_PORT}:3000" \
  -v "$DATA_DIR":/app/data \
  -e NODE_ENV=production \
  -e TOONFLOW_DATA_DIR=/app/data \
  -e TOONFLOW_SERVER_PORT=3000 \
  -e TOONFLOW_PUBLIC_BASE_URL="https://${PUBLIC_HOST}" \
  "$IMAGE" bun build/server/index.js

# ---------------------------------------------------------------- 7. nginx
echo "[6/6] 启动 nginx 反代 + 监控面板"
mkdir -p /data/home/monitor
mkdir -p /data/home/monitor
cp "$HERE/deploy/metrics-panel.js" /data/home/monitor/metrics-panel.js 2>/dev/null || true

# nginx.conf 里没有任何硬编码域名：它从 X-Forwarded-Host 动态取值，
# 所以直接复制即可，换机器不用改配置。
cp "$HERE/deploy/nginx.conf" /data/home/toonflow/nginx.conf

docker rm -f toonflow-proxy >/dev/null 2>&1 || true
if [ -f /data/home/toonflow/nginx.conf ]; then
  docker run -d --name toonflow-proxy --restart unless-stopped --network host \
    -v /data/home/toonflow/nginx.conf:/etc/nginx/nginx.conf:ro \
    nginx:alpine
fi

# 监控面板（可选，需要 node）
if command -v node >/dev/null 2>&1 && [ -f "$HERE/deploy/install-metrics-service.sh" ]; then
  bash "$HERE/deploy/install-metrics-service.sh" >/dev/null 2>&1 || echo "    [!] 监控面板安装失败（不影响主服务）"
fi

# ---------------------------------------------------------------- 8. 验证
echo "=============================================="
echo " 等待服务就绪"
for i in $(seq 1 40); do
  if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PUBLIC_PORT}/" 2>/dev/null; then
    echo "    就绪（${i}s）"
    break
  fi
  sleep 1
done

echo "=============================================="
docker ps --format '{{.Names}} | {{.Status}}'
echo "----------------------------------------------"
curl -sS -o /dev/null -w '  首页        = %{http_code}\n' -m 10 "http://127.0.0.1:${PUBLIC_PORT}/" || true
curl -sS -o /dev/null -w '  业务 API    = %{http_code}\n' -m 10 \
  -H "x-toonflow-workspace: 1" \
  "http://127.0.0.1:${PUBLIC_PORT}/api/settings/get" || true
echo "----------------------------------------------"
echo "  公网访问: https://${PUBLIC_HOST}/"
echo "  监控面板: https://${PUBLIC_HOST}/metrics/"
echo "=============================================="
echo " 完成。如果业务 API 返回 403，检查 nginx.conf 里的域名是否正确。"
