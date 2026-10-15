"""Single-admin session auth (standard library only).

Enabled only when SENTINEL_ADMIN_PASSWORD is set. On a laptop it stays off and
the API is reachable only on 127.0.0.1; on a server it must be on, because the
API can restart containers.

Session: an HttpOnly, SameSite=Strict cookie holding `user.expiry.signature`,
signed with HMAC-SHA256 under SENTINEL_SESSION_SECRET. SameSite=Strict plus the
origin check on writes covers CSRF.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

from . import config

COOKIE = "sentinel_session"


def enabled() -> bool:
    return bool(config.ADMIN_PASSWORD)


def _secret() -> bytes:
    return config.SESSION_SECRET.encode()


def _sign(payload: str) -> str:
    mac = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def check_credentials(username: str, password: str) -> bool:
    user_ok = hmac.compare_digest(username.encode(), config.ADMIN_USER.encode())
    pass_ok = hmac.compare_digest(password.encode(), config.ADMIN_PASSWORD.encode())
    return user_ok and pass_ok


def issue(username: str) -> str:
    expiry = int(time.time()) + config.SESSION_TTL_SEC
    payload = f"{username}.{expiry}"
    return f"{payload}.{_sign(payload)}"


def verify(token: str | None) -> str | None:
    """The username for a valid, unexpired token, else None."""
    if not token:
        return None
    parts = token.rsplit(".", 2)
    if len(parts) != 3:
        return None
    username, expiry, signature = parts
    if not hmac.compare_digest(signature, _sign(f"{username}.{expiry}")):
        return None
    try:
        if int(expiry) < time.time():
            return None
    except ValueError:
        return None
    return username


class LoginLimiter:
    """At most LOGIN_MAX_FAILURES failed logins per client per window."""

    def __init__(self) -> None:
        self._failures: dict[str, list[float]] = {}

    def blocked(self, client: str) -> bool:
        now = time.monotonic()
        recent = [t for t in self._failures.get(client, []) if now - t < config.LOGIN_WINDOW_SEC]
        self._failures[client] = recent
        return len(recent) >= config.LOGIN_MAX_FAILURES

    def fail(self, client: str) -> None:
        self._failures.setdefault(client, []).append(time.monotonic())

    def clear(self, client: str) -> None:
        self._failures.pop(client, None)


def random_secret() -> str:
    return secrets.token_urlsafe(48)
