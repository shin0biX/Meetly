#!/usr/bin/env bash
# Installs and starts a self-hosted LiveKit SFU alongside Meetly on this
# laptop, as a systemd service (like meetly.service / coturn already are).
# Run with sudo.
set -euo pipefail

APP_DIR=/home/shin0bix/Meetly
LIVEKIT_VERSION="1.10.0"
INSTALL_PATH=/usr/local/bin

echo "==> [1/6] Downloading livekit-server v${LIVEKIT_VERSION}"
ARCH="amd64"
case "$(uname -m)" in
  aarch64) ARCH="arm64" ;;
esac
TMP=$(mktemp -d)
curl -sSL -o "$TMP/livekit.tar.gz" \
  "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_${ARCH}.tar.gz"
tar xzf "$TMP/livekit.tar.gz" -C "$TMP"
sudo install -m 0755 "$TMP/livekit-server" "$INSTALL_PATH/livekit-server"
rm -rf "$TMP"
livekit-server --version

echo "==> [2/6] Generating API key/secret"
if [ -f "$APP_DIR/.env" ]; then set -a; source "$APP_DIR/.env"; set +a; fi
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-lk$(python3 -c 'import secrets;print(secrets.token_hex(8))')}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-$(python3 -c 'import secrets;print(secrets.token_hex(24))')}"

echo "==> [3/6] Writing $APP_DIR/livekit.yaml"
sudo tee "$APP_DIR/livekit.yaml" > /dev/null <<EOF
port: 7880
bind_addresses:
  - "127.0.0.1"

rtc:
  udp_port: 7882
  tcp_port: 7881
  use_external_ip: true

keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}

log_level: info
EOF

echo "==> [4/6] Recording LiveKit env vars in $APP_DIR/.env"
# LIVEKIT_URL is what the BROWSER connects to -- the public wss:// hostname
# via your Cloudflare tunnel, NOT localhost. Matches the domain pattern in
# add_to_tunnel.sh; change it if you use a different subdomain.
grep -q "^LIVEKIT_API_KEY=" "$APP_DIR/.env" 2>/dev/null || \
  printf "LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\nLIVEKIT_URL=%s\n" \
    "$LIVEKIT_API_KEY" "$LIVEKIT_API_SECRET" "wss://livekit.ujjawalcodes.site" \
    >> "$APP_DIR/.env"

echo "==> [5/6] Opening firewall for the RTC media port (bypasses Cloudflare)"
for p in 7882/udp 7881/tcp; do
  sudo ufw allow "$p" 2>/dev/null || true
done
echo "    NOTE: you also need to port-forward UDP 7882 (and TCP 7881) on"
echo "    your ROUTER to this laptop's LAN IP -- same as you already did"
echo "    for coturn's 3478 + relay range. This is the one step I can't"
echo "    do for you from here."

echo "==> [6/6] Writing systemd service + starting it"
sudo tee /etc/systemd/system/livekit.service > /dev/null <<EOF
[Unit]
Description=LiveKit SFU (Meetly media server)
After=network.target

[Service]
User=shin0bix
WorkingDirectory=$APP_DIR
ExecStart=$INSTALL_PATH/livekit-server --config $APP_DIR/livekit.yaml
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable livekit.service
sudo systemctl restart livekit.service
sleep 2
sudo systemctl --no-pager status livekit.service | head -10

echo
echo "==> Restarting meetly.service to pick up LIVEKIT_* env vars"
sudo systemctl restart meetly.service

echo
echo "===== DONE ====="
echo "LiveKit control port: 127.0.0.1:7880 (add to your tunnel next, see add_livekit_to_tunnel.sh)"
echo "LiveKit media port:   UDP 7882 + TCP 7881 (needs router port-forward, see above)"
echo "API key:              $LIVEKIT_API_KEY  (secret stored in $APP_DIR/.env)"
