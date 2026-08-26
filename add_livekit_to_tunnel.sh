#!/usr/bin/env bash
# Add livekit.ujjawalcodes.site to the Cloudflare tunnel, pointing at the
# LiveKit signaling port (7880). This carries ONLY the WebSocket control
# channel -- the actual audio/video (UDP 7882) bypasses Cloudflare and needs
# a direct router port-forward instead (see setup_livekit.sh).
# Run with sudo. Also add a DNS record for livekit.ujjawalcodes.site in
# Cloudflare pointing at the tunnel, same as you did for the meetly hostname.
set -euo pipefail
sudo -S -p '' cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak
sudo -S -p '' sed -i '/- service: http_status:404/i\  - hostname: livekit.ujjawalcodes.site\n    service: http://localhost:7880\n' /etc/cloudflared/config.yml
echo "==> New config:"
sudo -S -p '' cat /etc/cloudflared/config.yml
echo "==> Validating + restarting tunnel"
sudo -S -p '' systemctl restart cloudflared
sleep 3
sudo -S -p '' systemctl --no-pager status cloudflared | head -8
echo "==> Done. wss://livekit.ujjawalcodes.site should respond shortly."
