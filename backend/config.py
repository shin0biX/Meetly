"""Meetly configuration.

JWT secret comes from the environment (or a gitignored .env). We refuse to
start without it so a misconfigured deployment fails loudly.
"""
import os

ALGORITHM = "HS256"
# Sessions last 30 days by default and are silently renewed on each app load
# (see the /auth/refresh endpoint), so active users stay signed in without
# re-entering credentials. Override with the MEETLY_TOKEN_EXPIRE_MINUTES
# environment variable (value in minutes) for a shorter/longer window.
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("MEETLY_TOKEN_EXPIRE_MINUTES") or 60 * 24 * 30)


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
