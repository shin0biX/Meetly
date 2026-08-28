#!/usr/bin/env bash
# Add meetly.ujjawalcodes.site to the Cloudflare tunnel. Run with sudo.
set -euo pipefail
sudo -S -p '' cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak
# Insert meetly ingress before the catch-all 404
sudo -S -p '' sed -i '/- service: http_status:404/i\  - hostname: meetly.ujjawalcodes.site\n    service: http://localhost:7000\n' /etc/cloudflared/config.yml
echo "==> New config:"
sudo -S -p '' cat /etc/cloudflared/config.yml
echo "==> Validating + restarting tunnel"
sudo -S -p '' systemctl restart cloudflared
sleep 3
sudo -S -p '' systemctl --no-pager status cloudflared | head -8
echo "==> Done. https://meetly.ujjawalcodes.site should respond shortly."
