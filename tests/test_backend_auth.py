import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

client = TestClient(app)


def _login(username, password):
    resp = client.post("/api/login", json={"username": username, "password": password})
    assert resp.status_code == 200
    return resp.json()["token"]


def test_login_rejects_wrong_password():
    resp = client.post("/api/login", json={"username": "inspector1", "password": "wrong"})
    assert resp.status_code == 401


def test_login_succeeds_with_correct_credentials():
    token = _login("inspector1", "inspect123")
    assert token


def test_unauthenticated_request_is_rejected():
    resp = client.get("/api/segments")
    assert resp.status_code == 401


def test_inspector_cannot_reach_fleet_stats():
    token = _login("inspector1", "inspect123")
    resp = client.get("/api/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_supervisor_can_reach_fleet_stats():
    token = _login("supervisor1", "supervise123")
    resp = client.get("/api/stats", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_segments"] == 5000


def test_inspector_is_scoped_to_their_region():
    token = _login("inspector1", "inspect123")
    resp = client.get("/api/segments", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    regions = {s["region"] for s in resp.json()["segments"]}
    assert regions == {"Western"}


def test_inspector_cannot_view_segment_outside_their_region():
    token = _login("inspector1", "inspect123")
    # Find a segment that is NOT in Western via the admin view first.
    admin_token = _login("admin", "admin123")
    all_segments = client.get("/api/segments", headers={"Authorization": f"Bearer {admin_token}"}).json()["segments"]
    other_region_segment = next(s for s in all_segments if s["region"] != "Western")

    resp = client.get(f"/api/segments/{other_region_segment['segment_id']}", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403


def test_segment_detail_includes_shap_explanation():
    token = _login("admin", "admin123")
    segments = client.get("/api/segments", headers={"Authorization": f"Bearer {token}"}).json()["segments"]
    seg_id = segments[0]["segment_id"]
    resp = client.get(f"/api/segments/{seg_id}", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert "contributions" in body["explanation"]
    assert len(body["explanation"]["contributions"]) > 0


def test_acknowledge_then_reflected_in_detail():
    token = _login("admin", "admin123")
    segments = client.get("/api/segments", headers={"Authorization": f"Bearer {token}"}).json()["segments"]
    seg_id = segments[0]["segment_id"]

    ack = client.post(f"/api/segments/{seg_id}/acknowledge", headers={"Authorization": f"Bearer {token}"})
    assert ack.status_code == 200

    detail = client.get(f"/api/segments/{seg_id}", headers={"Authorization": f"Bearer {token}"}).json()
    assert detail["acknowledged"] is not None
    assert detail["acknowledged"]["by"] == "System Admin"


def test_export_csv_has_no_duplicate_columns():
    token = _login("supervisor1", "supervise123")
    resp = client.get("/api/export.csv", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    header = resp.text.splitlines()[0].split(",")
    assert len(header) == len(set(header)), f"Duplicate columns in export: {header}"
