"""
Authentication helpers for AttendChain.

- Passwords are stored as salted hashes (werkzeug scrypt/pbkdf2). Accounts created before
  hashing was added still hold plaintext; those are verified once and upgraded to a hash
  on the next successful login.
- After login the server issues a signed, expiring session token (itsdangerous). The
  browser sends it as "Authorization: Bearer <token>". The token says who the user is
  (role + id); it never contains or grants the server's ADMIN_TOKEN.
"""

import hmac
import os
import secrets
import threading
import time
from typing import Any, Dict, Optional

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash, generate_password_hash

HASH_PREFIXES = ("scrypt:", "pbkdf2:")

# Well-known demo passwords that ship with the project. They are refused in production.
DEMO_DEFAULT_PASSWORDS = {"faculty123", "student123"}

DEFAULT_ADMIN_TOKEN = "attendchain-admin-secret-change-me"


def is_production() -> bool:
    return os.getenv("APP_ENV", "development").strip().lower() in ("production", "prod")


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def is_hashed(stored: Any) -> bool:
    return isinstance(stored, str) and stored.startswith(HASH_PREFIXES)


def verify_password(password: str, stored: Any) -> bool:
    """Checks a password against a stored hash (or legacy plaintext)."""
    if not stored or not password:
        return False
    if is_hashed(stored):
        try:
            return check_password_hash(stored, password)
        except Exception:
            return False
    return hmac.compare_digest(password.encode("utf-8"), str(stored).encode("utf-8"))


def constant_time_equals(a: str, b: str) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


class SessionTokens:
    """Issues and verifies signed session tokens: {"role", "sub", "name"}."""

    SALT = "attendchain-session-v1"

    def __init__(self, secret_key: str, max_age_seconds: int):
        self._serializer = URLSafeTimedSerializer(secret_key, salt=self.SALT)
        self.max_age = max_age_seconds

    def issue(self, role: str, subject: str, name: str = "") -> str:
        return self._serializer.dumps({"role": role, "sub": subject, "name": name})

    def verify(self, token: str) -> Optional[Dict[str, Any]]:
        if not token:
            return None
        try:
            data = self._serializer.loads(token, max_age=self.max_age)
        except (BadSignature, SignatureExpired):
            return None
        if not isinstance(data, dict) or data.get("role") not in ("admin", "faculty", "student") or not data.get("sub"):
            return None
        return data


class LoginRateLimiter:
    """
    Slows down password guessing: at most `max_failures` failed logins per client IP and
    login id within `window_seconds`. In-memory, so it assumes a single server process
    (the production command runs one gunicorn worker).
    """

    def __init__(self, max_failures: int = 10, window_seconds: int = 900):
        self.max_failures = max_failures
        self.window = window_seconds
        self._failures: Dict[str, list] = {}
        self._lock = threading.Lock()

    def _recent(self, key: str, now: float) -> list:
        items = [t for t in self._failures.get(key, []) if now - t < self.window]
        if items:
            self._failures[key] = items
        else:
            self._failures.pop(key, None)
        return items

    def is_blocked(self, key: str) -> bool:
        with self._lock:
            return len(self._recent(key, time.time())) >= self.max_failures

    def record_failure(self, key: str) -> None:
        with self._lock:
            now = time.time()
            self._recent(key, now)
            self._failures.setdefault(key, []).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._failures.pop(key, None)


def load_secret_key() -> str:
    """SECRET_KEY signs session tokens. Required in production; random per process in development."""
    key = os.getenv("SECRET_KEY", "").strip()
    if key:
        return key
    if is_production():
        raise RuntimeError("SECRET_KEY is not set. Set a long random SECRET_KEY environment variable for production.")
    return secrets.token_urlsafe(48)
