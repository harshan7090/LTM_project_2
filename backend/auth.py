"""
Token-based auth for the console.

Still not a production identity system — there is no SSO, no MFA, and the
token store is in memory so it empties on restart. What it is now is free of
the specific weaknesses that made the previous version unsafe even as a demo:

  Password hashing was SHA-256 with one salt shared by every account. SHA-256
  is designed to be fast, which is the opposite of what you want here: a
  commodity GPU tries billions of candidates a second, and a shared salt means
  one rainbow table covers every user at once. Now PBKDF2-HMAC-SHA256 with a
  per-user random salt and a work factor.

  Password comparison used `!=` on strings, which returns as soon as it finds
  a differing byte. That leaks how much of a hash matched. Now
  `secrets.compare_digest`.

  An unknown username returned before hashing anything, so it answered
  measurably faster than a known one with a wrong password — free user
  enumeration. Now a dummy verification runs on the miss path so both take the
  same work.

  Tokens never expired. A token captured once was valid until the process
  restarted. Now absolute and idle expiry.

  Login was unmetered, so the three demo passwords could be brute-forced at
  whatever rate the network allowed. Now a per-username-and-IP lockout.

All of this uses the standard library only — no new dependency.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass

# PBKDF2 work factor. 600k matches current OWASP guidance for
# PBKDF2-HMAC-SHA256 and costs a few hundred milliseconds here, which is
# irrelevant for a login and ruinous for an attacker at scale.
PBKDF2_ITERATIONS = 600_000
SALT_BYTES = 16

# Token lifetimes.
TOKEN_TTL_SECONDS = 12 * 60 * 60     # absolute — re-authenticate after this
TOKEN_IDLE_SECONDS = 60 * 60         # idle — an abandoned session dies

# Login throttle. Counted per (username, ip) so one attacker cannot lock every
# account out by failing against each in turn.
MAX_FAILED_ATTEMPTS = 5
LOCKOUT_SECONDS = 15 * 60
ATTEMPT_WINDOW_SECONDS = 15 * 60


class AuthError(Exception):
    """Raised for a refused login. `retry_after` is set when throttled."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    """Returns (hex_hash, hex_salt). A fresh random salt unless one is given."""
    salt = salt or os.urandom(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return digest.hex(), salt.hex()


def verify_password(password: str, hex_hash: str, hex_salt: str) -> bool:
    try:
        salt = bytes.fromhex(hex_salt)
    except ValueError:
        return False
    candidate, _ = hash_password(password, salt)
    # Constant-time: never short-circuit on the first differing byte.
    return hmac.compare_digest(candidate, hex_hash)


@dataclass
class User:
    username: str
    name: str
    role: str           # inspector | supervisor | admin
    region: str | None  # inspectors are scoped to one region; None = sees all


def _demo_user(password: str, name: str, role: str, region: str | None) -> dict:
    hex_hash, hex_salt = hash_password(password)
    return {"password_hash": hex_hash, "salt": hex_salt,
            "name": name, "role": role, "region": region}


# Demo accounts. Passwords are in the README — change them before this goes
# anywhere near a real network.
_USERS: dict[str, dict] = {
    "inspector1": _demo_user("inspect123", "Raj Kumar", "inspector", "Western"),
    "supervisor1": _demo_user("supervise123", "Priya Nair", "supervisor", None),
    "admin": _demo_user("admin123", "System Admin", "admin", None),
}

# A salt/hash pair used only to burn the same CPU on an unknown username as on
# a known one. Without it, "no such user" returns in microseconds while a real
# user's wrong password takes the full PBKDF2 cost, and the difference is
# measurable over the network.
_DUMMY_HASH, _DUMMY_SALT = hash_password(secrets.token_urlsafe(32))


@dataclass
class _Session:
    user: User
    created_at: float
    last_seen: float


_TOKENS: dict[str, _Session] = {}
_FAILED: dict[tuple[str, str], list[float]] = defaultdict(list)


def _prune_attempts(key: tuple[str, str], now: float) -> list[float]:
    recent = [t for t in _FAILED[key] if now - t < ATTEMPT_WINDOW_SECONDS]
    _FAILED[key] = recent
    return recent


def throttle_status(username: str, ip: str) -> int | None:
    """Seconds remaining on a lockout, or None if not locked out."""
    now = time.time()
    recent = _prune_attempts((username, ip), now)
    if len(recent) < MAX_FAILED_ATTEMPTS:
        return None
    unlock_at = recent[-1] + LOCKOUT_SECONDS
    remaining = int(unlock_at - now)
    return remaining if remaining > 0 else None


def authenticate(username: str, password: str, ip: str = "unknown") -> User:
    """Verify credentials. Raises AuthError; never returns None.

    Raising rather than returning None means a caller cannot accidentally
    treat a falsy result as success, and it carries the throttle state that
    the endpoint needs for its Retry-After header.
    """
    retry_after = throttle_status(username, ip)
    if retry_after is not None:
        raise AuthError(
            "Too many failed sign-in attempts. Try again later.",
            retry_after=retry_after,
        )

    record = _USERS.get(username)
    if record is None:
        # Same work as the real path, so timing does not reveal which
        # usernames exist.
        verify_password(password, _DUMMY_HASH, _DUMMY_SALT)
        _FAILED[(username, ip)].append(time.time())
        raise AuthError("Invalid username or password")

    if not verify_password(password, record["password_hash"], record["salt"]):
        _FAILED[(username, ip)].append(time.time())
        raise AuthError("Invalid username or password")

    _FAILED.pop((username, ip), None)
    return User(username=username, name=record["name"],
                role=record["role"], region=record["region"])


def create_token(user: User) -> str:
    now = time.time()
    token = secrets.token_urlsafe(32)
    _TOKENS[token] = _Session(user=user, created_at=now, last_seen=now)
    _sweep_expired(now)
    return token


def get_user(token: str) -> User | None:
    """Resolve a token, enforcing both expiry clocks and sliding the idle one."""
    session = _TOKENS.get(token)
    if session is None:
        return None

    now = time.time()
    if now - session.created_at > TOKEN_TTL_SECONDS:
        _TOKENS.pop(token, None)
        return None
    if now - session.last_seen > TOKEN_IDLE_SECONDS:
        _TOKENS.pop(token, None)
        return None

    session.last_seen = now
    return session.user


def revoke_token(token: str) -> None:
    _TOKENS.pop(token, None)


def _sweep_expired(now: float) -> None:
    """Drop dead sessions so the in-memory store cannot grow without bound.

    Run on token creation rather than on a timer: it is the only moment the
    store grows, so it is the only moment the bound can be breached.
    """
    dead = [
        t for t, s in _TOKENS.items()
        if now - s.created_at > TOKEN_TTL_SECONDS
        or now - s.last_seen > TOKEN_IDLE_SECONDS
    ]
    for t in dead:
        _TOKENS.pop(t, None)


def active_session_count() -> int:
    _sweep_expired(time.time())
    return len(_TOKENS)
