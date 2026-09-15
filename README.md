# Meetly — Live Video Call & Chat

A real-time peer-to-peer video call + chat web app built with **FastAPI**, **WebRTC**, **WebSockets**, and **SQLite**, with optional **LiveKit SFU** integration for scalable media routing.

## Features

- **Live video & audio calls** via WebRTC (mesh topology — every peer connects to every other) **or** LiveKit SFU
- **User accounts**: register/login with bcrypt-hashed passwords + JWT auth
- **Persistent rooms**: create rooms (auto or custom code), join public rooms, see available rooms
- **Persistent chat**: messages are stored in SQLite and replayed when you join a room
- **Authenticated WebSockets**: the signaling connection validates your JWT before accepting
- Mic / camera toggles, auto-mute badges, name tags, live video grid
- **LiveKit integration**: when configured, media flows through LiveKit's managed SFU instead of peer-to-peer mesh

## How it works

```text
[Peer A]  --offer/answer/ICE/chat (WebSocket, JWT-auth)-->  [FastAPI signaling]  --relay-->  [Peer B]
    \                                                                                           /
     \\----------------------  WebRTC P2P media (direct, not through server) ------------------/
```

- The server **coordinates** connections and **persists chat**; actual video/audio flows **peer-to-peer** (or via LiveKit SFU when configured)
- Room membership & signaling state live in memory, so the app runs as a **single worker**

## Stack

- **Backend**: FastAPI + uvicorn, SQLAlchemy + SQLite (`backend/meetly.db`)
- **Auth**: bcrypt (passlib) + JWT (python-jose)
- **Frontend**: vanilla JS + Tailwind (CDN), `RTCPeerConnection` in `frontend/js/room.js`
- **Media Relay**: 
  - Default: Google public STUN servers (for P2P)
  - Optional: LiveKit (when `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL` are set in `.env`)
- **LiveKit Cloud**: Managed SFU for scalable media routing (no per-peer upload fan-out, includes relay infrastructure)

## Run locally (dev)

```bash
cd Meetly
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
# create a secret (gitignored .env):
echo "MEETLY_SECRET_KEY=$(./venv/bin/python -c 'import secrets;print(secrets.token_hex(32))')" >> .env
# Optional: LiveKit configuration
# echo "LIVEKIT_URL=wss://your-livekit-project.livekit.cloud" >> .env
# echo "LIVEKIT_API_KEY=APIxxxxxxxxxxxx" >> .env
# echo "LIVEKIT_API_SECRET=your_secret_key" >> .env
./venv/bin/uvicorn backend.main:app --reload --port 7000
```

Open **http://localhost:7000** → register → create/join a room. Open a second tab, log in with another account, and join the same room to test a call.

## Deploy as a service (systemd)

```bash
sudo ./deploy.sh     # writes /etc/systemd/system/meetly.service, enables & starts on port 7000
```

## Project layout

```
Meetly/
├── backend/
│   ├── main.py              # FastAPI app, creates tables, serves frontend
│   ├── config.py            # JWT secret from env/.env
│   ├── database.py          # SQLAlchemy engine/session
│   ├── models.py            # User, Room, ChatMessage
│   └── routes/
│       ├── auth.py          # register / token / me
│       ├── rooms.py         # create / list / get / messages (chat history)
│       ├── realtime.py      # WebSocket signaling + chat persistence
│       ├── turn.py          # TURN server endpoints (if self-hosted)
│       └── livekit.py       # LiveKit Cloud media token issuance
├── frontend/
│   ├── index.html           # login / register
│   ├── dashboard.html       # room list + create/join
│   ├── room.html            # video grid + chat panel
│   └── js/ (api.js, room.js)
├── test_e2e.py              # full user-journey test (register→login→room→chat)
├── deploy.sh                # systemd deployment
└── requirements.txt
```

## Notes & next steps

- **TURN server needed for real-world calls**: STUN only works when both peers aren't behind symmetric NAT. Deploy **coturn** and add its `iceServers` to `room.js` (`CONFIG`).
- **HTTPS required** for `getUserMedia` on non-localhost. Behind a reverse proxy, use `wss://`.
- Mesh topology degrades beyond ~6-8 participants; use an **SFU** (LiveKit / mediasoup) for larger calls.
- `hosting` secrets live in `.env` (gitignored); the DB `backend/meetly.db` is also gitignored.

### WebSocket origin security

Meetly validates the browser `Origin` header before accepting WebSocket connections.
The production domain `https://meetly.ujjawalcodes.site` and common localhost development
origins are allowed by default. Additional origins can be configured with:

```env
MEETLY_ALLOWED_ORIGINS=https://meetly.ujjawalcodes.site
```

Use a comma-separated list if you intentionally host Meetly on multiple origins.

### LiveKit configuration

When LiveKit credentials are provided in `.env`:
- Media (audio/video) flows through LiveKit's managed SFU instead of peer-to-peer mesh
- This eliminates per-peer upload fan-out and provides built-in relay/TURN capabilities
- Signaling (room membership, chat) still goes through Meetly's FastAPI WebSocket
- Trust model: LiveKit identity is derived from a server-signed meeting ticket, ensuring consistency between Meetly room members and LiveKit participants