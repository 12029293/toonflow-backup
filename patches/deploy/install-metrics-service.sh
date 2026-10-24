#!/usr/bin/env bash
# Install the metrics panel as a systemd service.
#
# The panel is a plain Node script with no dependencies, but it must survive a sandbox
# restart and crash restarts, so systemd owns it rather than a bare nohup. It also
# restarts on failure, which matters because the Docker socket can briefly be
# unavailable while dockerd comes back up.
set -euo pipefail

cat > /etc/systemd/system/toonflow-metrics.service <<'UNIT'
[Unit]
Description=Toonflow host metrics panel
Documentation=file:/data/home/monitor/README.md
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=user
Group=docker
ExecStart=/usr/bin/node /data/home/monitor/metrics-panel.js
Restart=always
RestartSec=5
StandardOutput=append:/data/home/monitor/panel.log
StandardError=append:/data/home/monitor/panel.log

[Install]
WantedBy=multi-user.target
UNIT

# Kill the manually started copy so the service can take over the port.
pkill -f "node /data/home/monitor/metrics-panel.js" 2>/dev/null || true
sleep 1

systemctl daemon-reload
systemctl enable toonflow-metrics.service >/dev/null 2>&1
systemctl restart toonflow-metrics.service
sleep 3

echo "--- service state ---"
systemctl is-enabled toonflow-metrics.service
systemctl is-active toonflow-metrics.service
echo "--- probe ---"
curl -s -o /dev/null -w "local_root=%{http_code}\n" http://127.0.0.1:3003/
curl -s -o /dev/null -w "local_api=%{http_code}\n" http://127.0.0.1:3003/api/metrics
