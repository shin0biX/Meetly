# Meetly — Live Video Call & Chat

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A scalable, real-time video conferencing and chat application built with modern web technologies. Meetly provides secure video calls with automatic fallback mechanisms for reliable connectivity in any network environment.

## ✨ Features

- **High-Quality Video & Audio**: Powered by WebRTC with LiveKit Cloud SFU for scalable media routing
- **Secure Authentication**: JWT-based auth with bcrypt password hashing
- **Persistent Chat**: Message history stored in SQLite and replayed on room join
- **Smart Fallbacks**: Automatic fallback to TURN server and peer-to-peer WebRTC
- **User-Friendly Interface**: Clean UI with mic/camera controls, video grid, and real-time chat
- **Room Management**: Create rooms with custom codes, browse public rooms, and join instantly
- **Responsive Design**: Works on desktop and mobile browsers
- **Easy Deployment**: Systemd service scripts and Docker support

## 🏗️ How It Works

Meetly uses a hybrid approach to media transport, prioritizing reliability and scalability:

```
[User Browser] 
        │
        ├─ Signaling → FastAPI WebSocket (JWT authenticated)
        │
        └─ Media → [Primary] LiveKit Cloud SFU
                    │
                    ├─ [Fallback 1] Self-hosted coturn TURN server
                    │
                    └─ [Fallback 2] Direct peer-to-peer WebRTC
```

**Key Components:**
1. **Signaling Server**: FastAPI handles WebSocket connections for session initialization and chat messages
2. **Media Transport**: 
   - Primary: LiveKit Cloud SFU (Selective Forwarding Unit) for scalable media distribution
   - Fallback 1: Your coturn TURN server for relay when direct connections fail
   - Fallback 2: Peer-to-peer WebRTC mesh for LAN/Wi-Fi direct communication
3. **Data Persistence**: SQLite database stores user accounts, rooms, and chat history
4. **Client**: Vanilla JavaScript frontend with Tailwind CSS and LiveKit WebSocket SDK

## 📦 Tech Stack

**Backend:**
- **Framework**: FastAPI (ASGI) for high-performance async APIs
- **Database**: SQLAlchemy ORM with SQLite for simplicity and reliability
- **Authentication**: Python-JWT for tokens, Passlib for bcrypt password hashing
- **Real-time**: WebSockets for bidirectional client-server communication
- **Media SFU**: LiveKit Cloud (primary) with coturn TURN fallback

**Frontend:**
- **Language**: Vanilla JavaScript (ES6+) for no-build simplicity
- **Styling**: Tailwind CSS via CDN for rapid UI development
- **Media**: LiveKit WebSocket client SDK for WebRTC handling
- **Templating**: Plain HTML5 with semantic structure

**Infrastructure:**
- **TURN Server**: coturn for media relay fallback
- **Reverse Proxy**: Nginx configuration available via setup script
- **Process Manager**: Systemd service for production deployment
- **Tunneling**: Cloudflare tunnel support for local development exposure

## 🚀 Getting Started

### Prerequisites
- Python 3.8+
- Git
- (Optional) Docker for containerized deployment
- (Optional) coturn for self-hosted TURN fallback

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/meetly.git
   cd meetly
   ```

2. **Set up virtual environment**
   ```bash
   python3 -m venv venv
   source venv/bin/activate  # Linux/Mac
   # or
   .\venv\Scripts\activate   # Windows
   ```

3. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your configuration:
   ```env
   # Required
   MEETLY_SECRET_KEY=your_32_byte_hex_secret_here

   # LiveKit Cloud (get from https://cloud.livekit.io)
   LIVEKIT_API_KEY=your_livekit_api_key
   LIVEKIT_API_SECRET=your_livekit_api_secret
   LIVEKIT_URL=wss://your_project.livekit.cloud

   # Optional: TURN configuration
   TURN_SECRET=your_turn_secret
   TURN_REALM=your_domain_or_ip
   ```

5. **Start the development server**
   ```bash
   uvicorn backend.main:app --reload --port 7000
   ```

6. **Open your browser**
   Visit `http://localhost:7000` to register, log in, and start video calls!

## 🐳 Docker Deployment

### Quick Start with Docker Compose
```bash
docker-compose up -d
```
The app will be available at `http://localhost:7000`

### Manual Docker Build
```bash
docker build -t meetly .
docker run -p 7000:7000 --env-file .env meetly
```

## 🛠️ Production Deployment

### Systemd Service
```bash
sudo ./deploy.sh   # Installs and enables meetly.service
```
This creates a systemd service that:
- Runs the FastAPI application with Gunicorn workers
- Automatically restarts on failure
- Logs to journalctl
- Binds to port 7000 (adjustable via environment)

### Manual Systemd Setup
1. Copy the service file:
   ```bash
   sudo cp deploy.sh /etc/systemd/system/meetly.service
   ```
2. Enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable meetly
   sudo systemctl start meetly
   ```

## 📁 Project Structure

```
meetly/
├── backend/                 # FastAPI backend
│   ├── main.py             # Application entry point
│   ├── config.py           # Configuration from environment
│   ├── database.py         # SQLAlchemy setup
│   ├── models.py           # Database models (User, Room, Message)
│   └── routes/             # API route handlers
│       ├── auth.py         # Registration, login, token endpoints
│       ├── rooms.py        # Room creation, listing, management
│       ├── realtime.py     # WebSocket signaling and chat
│       └── turn.py         # TURN credentials for clients
├── frontend/               # Static frontend files
│   ├── index.html          # Landing page (login/register)
│   ├── dashboard.html      # Room listing and creation
│   ├── room.html           # Video call interface
│   └── js/                 # JavaScript modules
│       ├── api.js          # REST API wrapper
│       └── room.js         # Video room logic with LiveKit
├── scripts/                # Deployment and utility scripts
│   ├── deploy.sh           # Systemd service installer
│   ├── setup_infra.sh      # coturn + nginx setup
│   └── add_to_tunnel.sh    # Cloudflare tunnel helper
├── test_e2e.py             # End-to-end test suite
├── requirements.txt        # Python dependencies
└── .env.example            # Environment variables template
```

## ⚙️ Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `MEETLY_SECRET_KEY` | Secret key for JWT signing | Yes | (randomly generated) |
| `LIVEKIT_API_KEY` | LiveKit Cloud API key | Yes | - |
| `LIVEKIT_API_SECRET` | LiveKit Cloud API secret | Yes | - |
| `LIVEKIT_URL` | LiveKit WebSocket URL (wss://...) | Yes | - |
| `TURN_SECRET` | Shared secret for coturn TURN | No | - |
| `TURN_REALM` | Realm for TURN authentication | No | - |
| `PORT` | Port to bind the server | No | `7000` |
| `HOST` | Host to bind the server | No | `0.0.0.0` |

## 🔐 Security Features

- **Password Security**: Bcrypt hashing with salt
- **Token Security**: JWT with HS256 algorithm and expiration
- **Input Validation**: Pydantic models for request validation
- **CORS Protection**: Configured origins for frontend
- **SQL Injection Prevention**: SQLAlchemy ORM usage
- **Static File Safety**: Proper serving of frontend assets

## 📱 Browser Support

Meetly works in all modern browsers that support WebRTC:
- Chrome (desktop/Android)
- Firefox (desktop/Android)
- Safari (desktop/iOS)
- Edge
- Opera

*Note: iOS Safari requires HTTPS for getUserMedia; development uses HTTP localhost which is exempt.*

## 🧪 Testing

### Run the test suite
```bash
python test_e2e.py
```
This performs a full user journey test:
1. Register a new user
2. Log in and get JWT
3. Create a room
4. Join the room
5. Send/receive chat messages
6. Verify video/audio functionality

### Backend Testing
```bash
# Run specific test modules
pytest backend/tests/  # If you add unit tests
```

## 📈 Scaling Considerations

- **LiveKit Cloud**: Handles automatic scaling for SFU needs
- **Stateless Design**: Backend can be scaled horizontally behind a load balancer
- **Database**: For high chat volume, consider upgrading from SQLite to PostgreSQL
- **TURN Server**: Scale coturn based on expected fallback traffic
- **Caching**: Add Redis for session storage if needed

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [LiveKit](https://livekit.io/) for the excellent SFU infrastructure
- The open-source WebRTC community
- FastAPI team for the amazing Python framework
- Tailwind CSS for utility-first styling

---

**Meetly** provides reliable, scalable video conferencing with intelligent fallbacks to ensure connectivity in any network environment. Built with modern Python and JavaScript technologies, it's easy to deploy, customize, and extend.