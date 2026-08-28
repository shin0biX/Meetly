"""Shared rate limiting. Two shapes, for two different threat models:

- rate_limit_check(): per-IP sliding window for REST endpoints (used by
  auth.py already; other routes should call this too rather than staying
  unlimited).
- ConnectionRateLimiter: a small per-WebSocket-connection token bucket, for
  throttling how fast a single already-open connection can send messages.
  A per-IP REST limiter doesn't help here since one WS connection can send
  thousands of frames without ever making a new "request" a limiter would see.
"""
import time
from collections import defaultdict

from fastapi import HTTPException, Request

_rate_store: dict[str, list[float]] = defaultdict(list)


def rate_limit_check(request: Request, key_prefix: str, window: int = 60, max_requests: int = 30) -> None:
    """Raise 429 if this client IP has exceeded max_requests within window
    seconds, scoped to key_prefix (so /rooms and /livekit/token don't share
    one bucket and falsely throttle each other)."""
    client_ip = request.client.host if request.client else "unknown"
    key = f"{key_prefix}:{client_ip}"
    now = time.time()
    window_start = now - window

    timestamps = _rate_store[key]
    _rate_store[key] = [t for t in timestamps if t > window_start]

    if len(_rate_store[key]) >= max_requests:
        raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")
    _rate_store[key].append(now)


class ConnectionRateLimiter:
    """Token bucket for a single WebSocket connection's message rate.

    This is what actually stops the flood we reproduced: it caps how many
    WS messages one already-connected client can push per second,
    independent of any per-IP/per-request limiting (which never sees
    individual WS frames at all).
    """

    def __init__(self, rate_per_sec: float = 15, burst: int = 30):
        self.rate = rate_per_sec
        self.capacity = burst
        self.tokens = float(burst)
        self.last_check = time.monotonic()
        self.violations = 0

    def allow(self) -> bool:
        now = time.monotonic()
        elapsed = now - self.last_check
        self.last_check = now
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        self.violations += 1
        return False
