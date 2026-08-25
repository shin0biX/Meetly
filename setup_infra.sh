#!/usr/bin/env bash
# Full infra setup for Meetly: coturn (TURN) + nginx reverse proxy.
# Run with sudo. Requires the DNS record meetly.ujjawalcodes.site -> <server-ip>
# (Cloudflare proxied, "orange cloud") to exist first.
set -euo pipefail

APP_DIR=/home/shin0bix/Meetly
PUBLIC_IP="$(curl -sS --max-time 8 https://api.ipify.org)"
DOMAIN="meetly.ujjawalcodes.site"

# --- TURN secret ---
if [ -f "$APP_DIR/.env" ]; then
  set -a; source "$APP_DIR/.env"; set +a
fi
TURN_SECRET="${TURN_SECRET:-$(python3 -c 'import secrets;print(secrets.token_hex(16))')}"
if ! grep -q "^TURN_SECRET=" "$APP_DIR/.env"; then
  printf "TURN_SECRET=%s\nTURN_REALM=%s\n" "$TURN_SECRET" "$PUBLIC_IP" >> "$APP_DIR/.env"
fi

echo "==> [1/4] Writing /etc/turnserver.conf"
sudo tee /etc/turnserver.conf > /dev/null <<EOF
listening-port=3478
tls-listening-port=5349
realm=$PUBLIC_IP
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=$TURN_SECRET
external-ip=$PUBLIC_IP
min-port=60000
max-port=61000
no-cli
EOF

echo "==> [2/4] Opening firewall ports"
for p in 3478/tcp 3478/udp 5349/tcp 60000:61000/udp 80/tcp 443/tcp; do
  sudo ufw allow "$p" 2>/dev/null || true
done

echo "==> [3/4] Restarting coturn"
sudo systemctl enable coturn 2>/dev/null || true
sudo systemctl restart coturn

echo "==> [4/4] Writing nginx reverse proxy for $DOMAIN"
sudo tee /etc/nginx/sites-available/meetly > /dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/meetly /etc/nginx/sites-enabled/meetly
sudo nginx -t && sudo systemctl reload nginx

echo "==> Restarting meetly service (loads TURN secret + /turn route)"
sudo systemctl restart meetly.service
sleep 2

echo
echo "===== DONE ====="
echo "TURN:     $PUBLIC_IP:3478 (secret in $APP_DIR/.env)"
echo "Web app:  http://$DOMAIN  (HTTPS via Cloudflare once DNS proxy is on)"
echo
echo "NEXT: add a DNS A record in Cloudflare:"
echo "  Name:  meetly"
echo "  Type:  A"
echo "  Value: $PUBLIC_IP"
echo "  Proxy: PROXIED (orange cloud)"
echo
echo "Then test: curl -sI https://$DOMAIN"
