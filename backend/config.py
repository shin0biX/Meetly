"""Meetly configuration.

JWT secret comes from the environment (or a gitignored .env). We refuse to
start without it so a misconfigured deployment fails loudly.
"""
import os

ALGORITHM = "HS256"
# Access tokens are short-lived (30 minutes by default) and may be renewed while valid
# (see the /auth/refresh endpoint), so active users stay signed in without
# re-entering credentials. Override with the MEETLY_TOKEN_EXPIRE_MINUTES
# environment variable (value in minutes) for a shorter/longer window.
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("MEETLY_ACCESS_TOKEN_EXPIRE_MINUTES") or 20)
REFRESH_TOKEN_EXPIRE_DAYS = int(os.environ.get("MEETLY_REFRESH_TOKEN_EXPIRE_DAYS") or 30)
MAX_SESSION_LIFETIME_DAYS = int(os.environ.get("MEETLY_MAX_SESSION_LIFETIME_DAYS") or 60)


def _load_secret() -> str:
    secret = os.environ.get("MEETLY_SECRET_KEY", "").strip()
    if not secret:
        try:
            from dotenv import load_dotenv
            load_dotenv()
            secret = os.environ.get("MEETLY_SECRET_KEY", "").strip()
        except Exception:
            secret = ""
    if not secret:
        raise RuntimeError(
            "MEETLY_SECRET_KEY is not set. Set it in the environment or a .env file."
        )
    return secret


SECRET_KEY = _load_secret()


def _load_allowed_origins() -> set[str]:
    """Return the browser origins allowed to open Meetly WebSockets.

    Configure production origins with MEETLY_ALLOWED_ORIGINS as a comma-separated
    list. Localhost origins are included by default for local development.
    """
    defaults = {
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://meetly.ujjawalcodes.site",
    }
    configured = {
        origin.strip().rstrip("/")
        for origin in os.environ.get("MEETLY_ALLOWED_ORIGINS", "").split(",")
        if origin.strip()
    }
    return defaults | configured


ALLOWED_ORIGINS = _load_allowed_origins()
