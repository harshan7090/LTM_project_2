"""
Regression tests for the security hardening.

Each test corresponds to a specific weakness that was present before. They are
written to fail if the fix is ever reverted, because every one of these is
invisible in normal use — the application behaves identically whether or not
passwords are cheap to crack or tokens ever expire.
"""
import time

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend.main import ALLOWED_ORIGINS, app, _sniff_image_type

JPEG = bytes([0xFF, 0xD8, 0xFF]) + b"\x00" * 32
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 32


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_throttle():
    """Lockout state is process-global; isolate tests from each other."""
    auth._FAILED.clear()
    yield
    auth._FAILED.clear()


# ------------------------------------------------------ password hashing ---

def test_passwords_are_not_stored_in_plaintext():
    record = auth._USERS["admin"]
    assert "admin123" not in str(record)
    assert record["password_hash"] != "admin123"


def test_each_user_has_a_distinct_salt():
    """A single shared salt means one rainbow table covers every account."""
    salts = {u["salt"] for u in auth._USERS.values()}
    assert len(salts) == len(auth._USERS)


def test_hashing_is_slow_by_construction():
    """PBKDF2 with a real work factor. A fast hash (plain SHA-256) is the
    weakness this replaced — GPUs try billions of candidates a second."""
    assert auth.PBKDF2_ITERATIONS >= 100_000


def test_same_password_hashes_differently_for_different_salts():
    h1, s1 = auth.hash_password("hunter2")
    h2, s2 = auth.hash_password("hunter2")
    assert s1 != s2
    assert h1 != h2


def test_verify_accepts_correct_and_rejects_wrong():
    h, s = auth.hash_password("correct-horse")
    assert auth.verify_password("correct-horse", h, s)
    assert not auth.verify_password("wrong-horse", h, s)


def test_verify_rejects_malformed_salt_without_raising():
    h, _ = auth.hash_password("x")
    assert auth.verify_password("x", h, "not-hex") is False


# ------------------------------------------------------- user enumeration --

def test_unknown_user_and_wrong_password_give_the_same_message():
    """Different messages let an attacker enumerate valid usernames."""
    with pytest.raises(auth.AuthError) as unknown:
        auth.authenticate("no-such-user", "whatever", ip="1.1.1.1")
    with pytest.raises(auth.AuthError) as wrong:
        auth.authenticate("admin", "wrong-password", ip="1.1.1.2")
    assert unknown.value.message == wrong.value.message


def test_unknown_user_still_does_hashing_work():
    """If the miss path returned early it would be measurably faster than the
    hit path, which is user enumeration by stopwatch. Both must pay PBKDF2."""
    t0 = time.perf_counter()
    with pytest.raises(auth.AuthError):
        auth.authenticate("definitely-not-a-user", "x", ip="1.1.1.3")
    unknown_elapsed = time.perf_counter() - t0

    t0 = time.perf_counter()
    with pytest.raises(auth.AuthError):
        auth.authenticate("admin", "x", ip="1.1.1.4")
    known_elapsed = time.perf_counter() - t0

    # Generous bound — this asserts the dummy hash runs at all, not a precise
    # timing equality, which would be flaky on a shared runner.
    assert unknown_elapsed > known_elapsed * 0.3


# ------------------------------------------------------------- throttling --

def test_login_locks_out_after_repeated_failures():
    for _ in range(auth.MAX_FAILED_ATTEMPTS):
        with pytest.raises(auth.AuthError):
            auth.authenticate("admin", "wrong", ip="9.9.9.9")

    with pytest.raises(auth.AuthError) as exc:
        auth.authenticate("admin", "admin123", ip="9.9.9.9")
    assert exc.value.retry_after is not None
    assert "Too many failed" in exc.value.message


def test_lockout_is_scoped_to_username_and_ip():
    """One attacker must not be able to lock every account out, nor lock a
    user out from their own address by failing from elsewhere."""
    for _ in range(auth.MAX_FAILED_ATTEMPTS):
        with pytest.raises(auth.AuthError):
            auth.authenticate("admin", "wrong", ip="9.9.9.9")

    # Same user, different address — unaffected.
    user = auth.authenticate("admin", "admin123", ip="8.8.8.8")
    assert user.role == "admin"


def test_successful_login_clears_the_failure_counter():
    for _ in range(auth.MAX_FAILED_ATTEMPTS - 1):
        with pytest.raises(auth.AuthError):
            auth.authenticate("admin", "wrong", ip="7.7.7.7")
    auth.authenticate("admin", "admin123", ip="7.7.7.7")
    assert ("admin", "7.7.7.7") not in auth._FAILED


def test_login_endpoint_returns_429_when_throttled(client):
    for _ in range(auth.MAX_FAILED_ATTEMPTS):
        client.post("/api/login", json={"username": "admin", "password": "no"})
    r = client.post("/api/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 429
    assert "Retry-After" in r.headers


# ----------------------------------------------------------- token expiry --

def test_token_expires_after_absolute_ttl(monkeypatch):
    user = auth.authenticate("admin", "admin123", ip="1.2.3.4")
    token = auth.create_token(user)
    assert auth.get_user(token) is not None

    future = time.time() + auth.TOKEN_TTL_SECONDS + 1
    monkeypatch.setattr(time, "time", lambda: future)
    assert auth.get_user(token) is None


def test_token_expires_after_idle_timeout(monkeypatch):
    user = auth.authenticate("admin", "admin123", ip="1.2.3.4")
    token = auth.create_token(user)

    future = time.time() + auth.TOKEN_IDLE_SECONDS + 1
    monkeypatch.setattr(time, "time", lambda: future)
    assert auth.get_user(token) is None


def test_activity_slides_the_idle_window(monkeypatch):
    user = auth.authenticate("admin", "admin123", ip="1.2.3.4")
    token = auth.create_token(user)

    half = time.time() + auth.TOKEN_IDLE_SECONDS * 0.5
    monkeypatch.setattr(time, "time", lambda: half)
    assert auth.get_user(token) is not None      # touches last_seen

    later = half + auth.TOKEN_IDLE_SECONDS * 0.75
    monkeypatch.setattr(time, "time", lambda: later)
    assert auth.get_user(token) is not None      # still inside the window


def test_expired_sessions_do_not_accumulate(monkeypatch):
    """The token store is unbounded memory if nothing prunes it."""
    for _ in range(5):
        auth.create_token(auth.User("admin", "A", "admin", None))
    before = auth.active_session_count()
    assert before >= 5

    future = time.time() + auth.TOKEN_TTL_SECONDS + 1
    monkeypatch.setattr(time, "time", lambda: future)
    assert auth.active_session_count() == 0


def test_revoked_token_stops_working():
    user = auth.authenticate("admin", "admin123", ip="1.2.3.4")
    token = auth.create_token(user)
    auth.revoke_token(token)
    assert auth.get_user(token) is None


# ------------------------------------------------------------------ CORS ---

def test_cors_is_not_a_wildcard():
    assert "*" not in ALLOWED_ORIGINS


def test_cors_rejects_an_unlisted_origin(client):
    r = client.get("/api/me", headers={"Origin": "https://evil.example"})
    assert r.headers.get("access-control-allow-origin") != "https://evil.example"


# -------------------------------------------------------- security headers --

def test_security_headers_are_present(client):
    r = client.post("/api/login", json={"username": "admin", "password": "admin123"})
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert "Content-Security-Policy" in r.headers


def test_csp_blocks_framing_and_objects(client):
    r = client.get("/api/me")
    csp = r.headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in csp
    assert "object-src 'none'" in csp
    assert "script-src 'self'" in csp


# ------------------------------------------------------------ image sniff --

def test_sniff_recognises_real_signatures():
    assert _sniff_image_type(JPEG) == "image/jpeg"
    assert _sniff_image_type(PNG) == "image/png"
    assert _sniff_image_type(b"RIFF\x00\x00\x00\x00WEBP") == "image/webp"
    assert _sniff_image_type(b"GIF89a-----") == "image/gif"


def test_sniff_rejects_non_images():
    assert _sniff_image_type(b"<?php system($_GET[0]); ?>") is None
    assert _sniff_image_type(b"MZ\x90\x00") is None      # PE executable
    assert _sniff_image_type(b"") is None


def test_upload_rejects_mislabelled_content(client):
    """A caller declaring image/png over arbitrary bytes must be refused —
    content_type is attacker-controlled and was previously the only check."""
    user = auth.authenticate("admin", "admin123", ip="1.2.3.4")
    token = auth.create_token(user)
    r = client.post(
        "/api/assistant/analyze-image",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": ("payload.png", b"not an image at all", "image/png")},
    )
    # 400 for the content mismatch, or 503 if no vision model is installed —
    # both are refusals. What must not happen is the bytes reaching the model.
    assert r.status_code in (400, 503)
    if r.status_code == 400:
        assert "does not appear to be" in r.json()["detail"]


def test_upload_requires_authentication(client):
    r = client.post(
        "/api/assistant/analyze-image",
        files={"file": ("x.png", PNG, "image/png")},
    )
    assert r.status_code == 401
