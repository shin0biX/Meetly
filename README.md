# Meetly — Live Video Call & Chat

A real-time video call + chat web app built with **FastAPI**, **WebRTC**, **WebSockets**, **SQLite**, and **LiveKit Cloud** for scalable SFU (Selective Forwarding Unit) media routing.

## Features

- **Live video & audio calls** via LiveKit Cloud SFU (scalable beyond mesh WebRTC limits)
- **User accounts**: register/login with bcrypt-hashed passwords + JWT auth
- **Persistent rooms**: create rooms (auto or custom code), join public rooms, see available rooms
- **Persistent chat**: messages stored in SQLite and replayed when you join a room
- **Authenticated WebSockets**: signaling connection validates JWT before accepting
- Mic / camera toggles, auto-mute badges, name tags, live video grid
- **Fallback to TURN/coturn**: Uses your self-hosted coturn as backup if LiveKit Cloud unreachable
- **Mesh WebRTC fallback**: Direct peer-to-peer if neither SFU nor TURN available

## How It Works

```
[User]  --WebSocket (JWT-auth)-->  [FastAPI Signaling Server]
                                    │
                                    ├────> [LiveKit Cloud SFU] ────> Media (SFU)
                                    │
                                    └────> [coturn TURN] ────> Media (relay fallback)
                                    │
                                    └────> [Peer-to-Peer WebRTC] ──> Media (direct fallback)
```

- **Signaling**: Handled by your FastAPI server (authenticated WebSockets)
- **Media Transport**: 
  1. **Primary**: LiveKit Cloud SFU (global scalable infrastructure)
  2. **Fallback 1**: Your coturn TURN server (ports 3478 UDP/TCP) 
  3. **Fallback 2**: Direct peer-to-peer WebRTC (mesh topology)
- **Chat & Room State**: Persisted in SQLite, coordinated by FastAPI
- **IceServers**: Dynamically provided based on available services

## Stack

- **Backend**: FastAPI + uvicorn, SQLAlchemy + SQLite (`backend/meetly.db`)
- **Auth**: bcrypt (passlib) + JWT (python-jose)
- **Frontend**: vanilla JS + Tailwind (CDN), LiveKit WebSocket client in `frontend/js/room.js`
- **Media SFU**: LiveKit Cloud (primary) + coturn TURN (fallback) + WebRTC P2P (last resort)
- **STUN/TURN**: Google STUN + your coturn TURN + LiveKit Cloud built-in TURN

## Environment Variables (`.env` - **gitignored**)

```bash
# Required for Meetly
MEETLY_SECRET_KEY=your_32_byte_hex_secret_here

# LiveKit Cloud (get from https://cloud.livekit.io)
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
LIVEKIT_URL=wss://your_project.livekit.cloud

# Optional: TURN configuration (if using coturn)
TURN_SECRET=your_turn_secret
TURN_REALM=your_domain_or_ip
```

Get your LiveKit Cloud credentials at: https://cloud.livekit.io (free tier available)

## Run Locally (Development)

```bash
cd Meetly
python3 -m venv venv
./venv/bin/pip install -r requirements.txt

# Create .env file (gitignored)
echo "MEETLY_SECRET_KEY=$(./venv/bin/python -c 'import secrets;print(secrets.token_hex(32))')" >> .env
echo "LIVEKIT_API_KEY=your_key_from_cloud.livekit.io" >> .env
echo "LIVEKIT_API_SECRET=your_secret_from_cloud.livekit.io" >> .env
echo "LIVEKIT_URL=wss://your_project.livekit.cloud" >> .env

./venv/bin/uvicorn backend.main:app --reload --port 7000
```

Open **http://localhost:7000** → register → create/join a room.

## Deploy as a Service (systemd)

```bash
sudo ./deploy.sh     # writes /etc/systemd/system/meetly.service, enables & starts on port 7000
```

This runs your Meetly application as a background service that will:
1. Use LiveKit Cloud for media when available
2. Fall back to your coturn TURN server if LiveKit Cloud unreachable  
3. Fall back to peer-to-peer WebRTC if neither is available

## Project Layout

```
Meetly/
├── backend/
│   ├── main.py              # FastAPI app, serves frontend, handles signaling
│   ├── config.py            # JWT secret & LiveKit config from env/.env
│   ├── database.py          # SQLAlchemy engine/session
│   ├── models.py            # User, Room, ChatMessage
│   └── routes/
│       ├── auth.py          # register / token / me
│       ├── rooms.py         # create / list / get / messages (chat history)
│       ├── realtime.py      # WebSocket signaling + chat persistence
│       └── turn.py          # TURN credentials endpoint (for coturn)
├── frontend/
│   ├── index.html           # login / register
│   ├── dashboard.html       # room list + create/join
│   ├── room.html            # video grid + chat panel
│   └── js/ (api.js, room.js)
├── test_e2e.py              # full user-journey test (register→login→room→chat)
├── deploy.sh                # systemd deployment (run with sudo)
├── setup_infra.sh           # Setup coturn + nginx (run with sudo)
├── add_to_tunnel.sh         # Add hostname to Cloudflare tunnel (run with sudo)
├── .gitignore               # Excludes .env, venv, __pycache__, meetly.db, etc.
└── requirements.txt
```

## Important Notes

### 🌐 **Current Media Flow Priority**
1. **LiveKit Cloud SFU** - Primary (scalable, global, includes built-in TURN)
2. **coturn TURN Server** - Your self-hosted backup (ports 3478) 
3. **Peer-to-Peer WebRTC** - Direct mesh (last resort, limited to ~6-8 users)

### 🔧 **Infrastructure Still in Place**
- **coturn TURN server**: Still installed and running as fallback
- **nginx reverse proxy**: Configured via `setup_infra.sh` (if used)
- **Cloudflare tunnel**: Still forwarding `meetly.ujjawalcodes.site` to localhost:7000

### 📱 **Port Requirements**
- **Incoming**: Only port 80/443 (via Cloudflare tunnel) needed for signaling
- **Media**: Handled by LiveKit Cloud global network (no port forwarding needed!)
- **TURN fallback**: Uses coturn on ports 3478 UDP/TCP (if LiveKit Cloud unreachable)

### 🆓 **LiveKit Cloud Free Tier**
- 10,000 participant minutes per month
- 1 GB egress bandwidth per month
- Global SFU infrastructure
- Built-in TURN servers (redundant with your coturn)
- **No credit card required** for signup

## Verification

Check that services are running:
```bash
# Your Meetly app
systemctl is-active meetly.service  # Should show: active

# Your coturn TURN (fallback)
systemctl is-active coturn.service  # Should show: active  

# LiveKit local service (should be inactive since we're using Cloud)
systemctl is-active livekit.service  # Should show: inactive (expected)

# Test connectivity
curl -s http://localhost:7000/ | head -5  # Should return HTML
```

## Next Steps

1. **Monitor usage**: Visit https://cloud.livekit.io to track your free tier usage
2. **Scale as needed**: LiveKit Cloud handles automatic scaling beyond mesh limits
3. **Backup strategy**: Your coturn TURN provides reliable fallback if needed
4. **Custom domains**: Configure LiveKit Cloud with your own domain if desired (optional)

---

**Meetly is now configured for reliable, scalable video conferencing using LiveKit Cloud as the primary media transport, with your self-hosted TURN server as a robust fallback.**