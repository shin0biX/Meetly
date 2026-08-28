#!/usr/bin/env bash
# One-shot deploy of Meetly as a systemd service (run with sudo).
set -euo pipefail

SERVICE=/etc/systemd/system/meetly.service
APP_DIR=/home/shin0bix/Meetly
VENV=$APP_DIR/venv

echo "==> Writing $SERVICE"
sudo tee "$SERVICE" > /dev/null <<EOF
[Unit]
Description=Meetly Live Video Call & Chat
After=network.target

[Service]
User=shin0bix
WorkingDirectory=$APP_DIR/backend
Environment="PATH=$VENV/bin"
EnvironmentFile=$APP_DIR/.env
ExecStart=$VENV/bin/uvicorn main:app --host 0.0.0.0 --port 7000
Restart=always

[Install]
WantedBy=multi-user.target
EOF

echo "==> Reloading systemd + enabling service"
sudo systemctl daemon-reload
sudo systemctl enable meetly.service
sudo systemctl restart meetly.service

echo "==> Waiting for startup..."
sleep 3
sudo systemctl --no-pager status meetly.service | head -12

echo
echo "==> Health check"
curl -sS -o /dev/null -w "GET / -> %{http_code}\n" --max-time 8 http://127.0.0.1:7000/ || echo "(app not responding yet)"

echo
echo "Done. Open http://localhost:7000"
