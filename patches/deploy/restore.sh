#!/usr/bin/env bash
# Toonflow @ instabox restore script (ASCII only, encoding-safe)
# Rebuilds the app container plus the nginx front proxy. The proxy fixes two
# gateway behaviours that otherwise make every business API answer 403:
#   1. the gateway rewrites Host to 127.0.0.1:3000 and puts the real domain in
#      X-Forwarded-Host, while Toonflow requires Origin.host == Host;
#   2. a browser same-origin GET carries no Origin, and the gateway sends
#      Referrer-Policy: no-referrer so Referer is missing too - the proxy
#      synthesises Origin when it is absent.
# Usage: bash /data/home/toonflow/restore.sh
set -euo pipefail

APP_DIR=/data/home/apps/Toonflow-app
DATA_DIR=/data/home/toonflow/data
IMAGE_TGZ=/data/home/toonflow/toonflow-local.tar.gz
IMAGE=toonflow:app
NGINX_CONF=/data/home/toonflow/nginx.conf
APP_PORT=3000
# machine id without the m_ prefix; override with MACHINE_DOMAIN=... bash restore.sh
PUBLIC_PORT=8080
MACHINE_DOMAIN="${MACHINE_DOMAIN:-}"
PUBLIC_HOST="${PUBLIC_PORT}-${MACHINE_DOMAIN}.instabox.tech"

# NOTE on patching the app
#   /app is baked into the image; only /app/data is a bind mount. Source edits made in
#   the container or on the host are therefore lost when this script recreates the
#   container unless they were committed into the image first:
#     docker commit --change 'CMD ["bun","build/server/index.js"]' toonflow toonflow:app
#   The image tag toonflow:app already carries the canvas autoplace and
#   reference-image-preference patches; keep that tag when restoring.

echo "[1/6] prepare directories"
mkdir -p "$DATA_DIR" /data/home/logs

echo "[2/6] ensure docker image toonflow:local"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ -f "$IMAGE_TGZ" ]; then
    echo "  loading from local archive (about 525MB)"
    gunzip -c "$IMAGE_TGZ" | docker load
  else
    echo "  archive missing, rebuilding from source"
    mkdir -p /data/home/apps
    [ -d "$APP_DIR/.git" ] || git clone --depth 1 https://github.com/HBAI-Ltd/Toonflow-app.git "$APP_DIR"
    ( cd "$APP_DIR" && docker build -t "$IMAGE" . )
  fi
fi

echo "[3/6] write nginx config at $NGINX_CONF"
cat > "$NGINX_CONF" <<'NGINX'
worker_processes 1;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log off;
  client_max_body_size 2048m;

  map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
  }
  map $http_x_forwarded_host $real_host {
    default $http_x_forwarded_host;
    ""      $host;
  }
  map $http_x_forwarded_proto $real_scheme {
    default $http_x_forwarded_proto;
    ""      $scheme;
  }
  map $http_origin $effective_origin {
    default $http_origin;
    ""      $real_scheme://$real_host;
  }

  server {
    listen 8080;
    proxy_http_version 1.1;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $real_host;
      proxy_set_header Origin $effective_origin;
      proxy_set_header Referer $real_scheme://$real_host/;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $real_scheme;
      proxy_set_header X-Forwarded-Host $real_host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_cache off;
      chunked_transfer_encoding on;
    }
  }
}
NGINX

echo "[4/6] start app container"
docker rm -f toonflow >/dev/null 2>&1 || true
docker run -d --name toonflow --restart unless-stopped \
  -p ${APP_PORT}:3000 \
  -v "$DATA_DIR":/app/data \
  -e NODE_ENV=production \
  -e TOONFLOW_DATA_DIR=/app/data \
  -e TOONFLOW_SERVER_PORT=3000 \
  -e TOONFLOW_PUBLIC_BASE_URL="https://$PUBLIC_HOST" \
  "$IMAGE" bun build/server/index.js

echo "[5/6] start proxy container"
docker rm -f toonflow-proxy >/dev/null 2>&1 || true
docker run -d --name toonflow-proxy --restart unless-stopped --network host \
  -v "$NGINX_CONF":/etc/nginx/nginx.conf:ro \
  nginx:alpine

echo "[6/6] wait until ready"
for i in $(seq 1 40); do
  if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PUBLIC_PORT}/"; then
    echo "  proxy ready after ${i}s"
    break
  fi
  sleep 1
done

docker ps --format '{{.Names}} | {{.Status}} | {{.Ports}}'
curl -sS -o /dev/null -w 'app_local=%{http_code}\n' -m 10 "http://127.0.0.1:${APP_PORT}/"
curl -sS -o /dev/null -w 'proxy_local=%{http_code}\n' -m 10 "http://127.0.0.1:${PUBLIC_PORT}/"
# the decisive check: a bare request (no Origin/Referer) must pass the guard
curl -sS -o /dev/null -w 'proxy_api_bare=%{http_code}\n' -m 10 \
  -H "x-toonflow-workspace: 1" \
  -H "X-Forwarded-Host: ${PUBLIC_HOST}" \
  -H "X-Forwarded-Proto: https" \
  "http://127.0.0.1:${PUBLIC_PORT}/api/settings/get"
echo "public app: https://${PUBLIC_HOST}/"
