from pathlib import Path
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

import models
from database import engine, run_migrations
from routes import auth, rooms, realtime, turn, livekit_token

# Apply additive/nullable migrations before create_all
run_migrations()
# Create tables if not present
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Meetly — Live Video Call & Chat")


# Don't let Cloudflare (or any cache) serve stale frontend files for 4 hours.
# This was causing "I updated the code but the site still shows the old version"
# bugs (the cached-JS issue). Static assets are revalidated every request.
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        path = request.url.path
        # Apply to HTML and frontend JS; let other assets (images) cache normally.
        if path.endswith(".html") or path.startswith("/js/"):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response


app.add_middleware(NoCacheMiddleware)

app.include_router(auth.router)
app.include_router(rooms.router)
app.include_router(realtime.router)
app.include_router(turn.router)
app.include_router(livekit_token.router)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if not FRONTEND_DIR.exists():
    FRONTEND_DIR.mkdir(parents=True)

app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
