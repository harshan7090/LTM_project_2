"""
IntegrityAI Console — backend API.

Run with:  uvicorn backend.main:app --reload --port 8010
Then open: http://localhost:8010
"""
import io
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import auth  # noqa: E402
from backend.ml import get_service  # noqa: E402

app = FastAPI(title="IntegrityAI Console")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------------------------------------------------------------- auth ----

class LoginRequest(BaseModel):
    username: str
    password: str


def current_user(authorization: str | None = Header(default=None)) -> auth.User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    token = authorization.removeprefix("Bearer ")
    user = auth.get_user(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


def require_role(*roles: str):
    def _check(user: auth.User = Depends(current_user)) -> auth.User:
        if user.role not in roles:
            raise HTTPException(status_code=403, detail=f"'{user.role}' role cannot access this — requires {roles}")
        return user

    return _check


@app.post("/api/login")
def login(payload: LoginRequest):
    user = auth.authenticate(payload.username, payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = auth.create_token(user)
    return {"token": token, "name": user.name, "role": user.role, "region": user.region}


@app.post("/api/logout")
def logout(authorization: str | None = Header(default=None)):
    if authorization and authorization.startswith("Bearer "):
        auth.revoke_token(authorization.removeprefix("Bearer "))
    return {"ok": True}


@app.get("/api/me")
def me(user: auth.User = Depends(current_user)):
    return {"name": user.name, "role": user.role, "region": user.region}


# ------------------------------------------------------------ segments ----

def _region_scope(user: auth.User) -> str | None:
    """Inspectors only ever see their assigned region; everyone else sees all."""
    return user.region if user.role == "inspector" else None


@app.get("/api/segments")
def list_segments(risk_band: str | None = None, user: auth.User = Depends(current_user)):
    svc = get_service()
    return {"segments": svc.list_segments(region=_region_scope(user), risk_band=risk_band)}


@app.get("/api/alerts")
def list_alerts(user: auth.User = Depends(current_user)):
    svc = get_service()
    critical = svc.list_segments(region=_region_scope(user), risk_band="critical")
    elevated = svc.list_segments(region=_region_scope(user), risk_band="elevated")
    return {"critical": critical, "elevated": elevated}


@app.get("/api/segments/{segment_id}")
def segment_detail(segment_id: str, user: auth.User = Depends(current_user)):
    svc = get_service()
    detail = svc.get_segment(segment_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if user.role == "inspector" and detail["region"] != user.region:
        raise HTTPException(status_code=403, detail="This segment is outside your assigned region")
    return detail


@app.post("/api/segments/{segment_id}/acknowledge")
def acknowledge_segment(segment_id: str, user: auth.User = Depends(current_user)):
    svc = get_service()
    detail = svc.get_segment(segment_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if user.role == "inspector" and detail["region"] != user.region:
        raise HTTPException(status_code=403, detail="This segment is outside your assigned region")
    svc.acknowledge(segment_id, by=user.name)
    return {"ok": True}


# ------------------------------------------------------- fleet overview ----

@app.get("/api/stats")
def fleet_stats(user: auth.User = Depends(require_role("supervisor", "admin"))):
    return get_service().fleet_stats()


@app.get("/api/export.csv")
def export_csv(user: auth.User = Depends(require_role("supervisor", "admin"))):
    svc = get_service()
    csv_text = svc.export_at_risk_csv()
    return StreamingResponse(
        io.StringIO(csv_text),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=at_risk_segments.csv"},
    )


# --------------------------------------------------------------- static ----

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
