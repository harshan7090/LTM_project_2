"""
Minimal token-based auth for the demo console.

IMPORTANT — this is demo-grade, not production-grade:
  - Passwords are hashed (SHA-256 + static salt) but there's no rate limiting,
    no HTTPS enforcement, and tokens live in memory (wiped on server restart).
  - A real deployment would use a proper identity provider (SSO/OAuth),
    salted+peppered password hashing (bcrypt/argon2) in a real database,
    and HTTPS-only cookies. This is enough to demonstrate role-based access
    actually being enforced server-side, which is the point for this project.
"""
import hashlib
import secrets
from dataclasses import dataclass

SALT = "integrityai-demo-salt"  # NOT how you'd salt passwords in production — see docstring


def _hash(password: str) -> str:
    return hashlib.sha256((SALT + password).encode()).hexdigest()


@dataclass
class User:
    username: str
    name: str
    role: str  # "inspector" | "supervisor" | "admin"
    region: str | None  # inspectors are scoped to one region; None = sees all


# Demo accounts. Password for every account is printed in the README —
# change these before putting this anywhere near a real network.
_USERS: dict[str, dict] = {
    "inspector1": {
        "password_hash": _hash("inspect123"),
        "name": "Raj Kumar",
        "role": "inspector",
        "region": "Gulf Coast",
    },
    "supervisor1": {
        "password_hash": _hash("supervise123"),
        "name": "Priya Nair",
        "role": "supervisor",
        "region": None,
    },
    "admin": {
        "password_hash": _hash("admin123"),
        "name": "System Admin",
        "role": "admin",
        "region": None,
    },
}

# token -> User, in-memory. Fine for a demo; use Redis/DB + expiry for real use.
_TOKENS: dict[str, User] = {}


def authenticate(username: str, password: str) -> User | None:
    record = _USERS.get(username)
    if record is None or record["password_hash"] != _hash(password):
        return None
    return User(username=username, name=record["name"], role=record["role"], region=record["region"])


def create_token(user: User) -> str:
    token = secrets.token_urlsafe(32)
    _TOKENS[token] = user
    return token


def get_user(token: str) -> User | None:
    return _TOKENS.get(token)


def revoke_token(token: str) -> None:
    _TOKENS.pop(token, None)
