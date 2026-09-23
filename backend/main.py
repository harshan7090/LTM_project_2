"""
IntegrityAI Console — backend API.

Run with:  uvicorn backend.main:app --reload --port 8010
Then open: http://localhost:8010
"""
import io
import os
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
# Before any provider makes an HTTPS call. On a network with an intercepting
# proxy, Python's bundled CA list rejects the re-signed certificate and every
# provider reports itself unreachable - see src/net_trust.py.
from src.net_trust import enable as _enable_os_trust  # noqa: E402
_enable_os_trust()
from backend import assistant, auth, tiles  # noqa: E402
from backend.llm import (  # noqa: E402
    LLMError, auto_select, encode_image, ollama_embed, select_vision_provider,
)
from backend.ml import get_service  # noqa: E402
from config.settings import settings  # noqa: E402
from src.integrity import scheduler as sched  # noqa: E402
from src.integrity.inspection import recommend_inspection  # noqa: E402
from src.integrity.repair import recommend_repair  # noqa: E402
from src.integrity import workorders as wo  # noqa: E402
from src.integrity import routes as wo_routes  # noqa: E402
from src.integrity.rag import DENSE_MODEL, get_knowledge_base  # noqa: E402

# Interactive API docs are a convenience in development and an inventory of
# the attack surface in production. Off unless explicitly enabled.
IS_PRODUCTION = os.getenv("INTEGRITYAI_ENV", "development").lower() == "production"

app = FastAPI(
    title="IntegrityAI Console",
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None,
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)

# This was allow_origins=["*"] with allow_methods/headers ["*"].
#
# It was not directly exploitable — the session token travels in an
# Authorization header rather than a cookie, and allow_credentials was never
# set, so a hostile page could not ride an existing session. But "*" on an
# application serving pipeline integrity data is one config change away from
# being a real hole, and the frontend is served from the same origin as the
# API, so the permissive setting bought nothing.
ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv(
        "INTEGRITYAI_ALLOWED_ORIGINS",
        "http://localhost:8010,http://127.0.0.1:8010,http://localhost:5173",
    ).split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Baseline response hardening.

    The CSP matters most here: model output is rendered in the browser, and
    although it goes through react-markdown rather than dangerouslySetInnerHTML,
    a defence that does not depend on that staying true is worth having.
    'unsafe-inline' for styles is required by the Tailwind build; scripts are
    restricted to same-origin.
    """
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "script-src 'self'; connect-src 'self'; "
        "object-src 'none'; frame-ancestors 'none'; base-uri 'self'",
    )
    return response


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


def _client_ip(request: Request) -> str:
    """Best-effort client address for throttling.

    X-Forwarded-For is spoofable when nothing trusted sets it, so it is only
    consulted when a reverse proxy is declared. Trusting it unconditionally
    would let an attacker rotate the header and defeat the lockout entirely.
    """
    if os.getenv("INTEGRITYAI_BEHIND_PROXY", "").lower() in ("1", "true", "yes"):
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.post("/api/login")
def login(payload: LoginRequest, request: Request):
    try:
        user = auth.authenticate(payload.username, payload.password,
                                 ip=_client_ip(request))
    except auth.AuthError as exc:
        # 429 when refusing on rate, 401 when the credentials are simply
        # wrong. The message is identical for unknown-user and wrong-password
        # so the response does not reveal which accounts exist.
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(status_code=429 if exc.retry_after else 401,
                            detail=exc.message, headers=headers)
    token = auth.create_token(user)
    return {"token": token, "name": user.name, "role": user.role,
            "region": user.region,
            "session_expires_in": auth.TOKEN_TTL_SECONDS}


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


# -------------------------------------------------- inspection planning ----

@app.get("/api/segments/{segment_id}/inspection")
def segment_inspection(segment_id: str, user: auth.User = Depends(current_user)):
    """Which inspection techniques this segment needs, and why.

    Deterministic — same inputs always give the same plan. The LLM explains it
    but never decides it, because method selection has to be auditable.
    """
    svc = get_service()
    detail = svc.get_segment(segment_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if user.role == "inspector" and detail["region"] != user.region:
        raise HTTPException(status_code=403, detail="This segment is outside your assigned region")
    return recommend_inspection(detail).to_dict()


class ScheduleRequest(BaseModel):
    periods: int = 4
    days_per_period: float = 20.0
    crews_per_region: int = 1
    candidate_limit: int = 120
    region_locked: bool = True
    risk_bands: list[str] = ["critical", "elevated"]


@app.post("/api/schedule")
def build_inspection_schedule(
    payload: ScheduleRequest,
    user: auth.User = Depends(require_role("supervisor", "admin")),
):
    """Optimises which segments to inspect, when, and by which crew.

    Supervisor/admin only — this is a fleet-planning operation, and an
    inspector scoped to one region has no business allocating other regions'
    crews.
    """
    if not 1 <= payload.periods <= 12:
        raise HTTPException(status_code=400, detail="periods must be between 1 and 12")
    if not 1 <= payload.candidate_limit <= 500:
        raise HTTPException(status_code=400, detail="candidate_limit must be between 1 and 500")
    if payload.days_per_period <= 0:
        raise HTTPException(status_code=400, detail="days_per_period must be positive")

    svc = get_service()

    # Build the candidate pool from the requested risk bands, highest RISK
    # first — not highest corrosion rate. Truncating a 5,000-segment fleet to
    # `candidate_limit` by rate would drop exactly the segments consequence
    # modelling exists to surface: modest corrosion under a populated area.
    pool = []
    for band in payload.risk_bands:
        pool.extend(svc.list_segments(risk_band=band))
    pool.sort(key=lambda s: (-s.get("risk_score", 0.0), -s["predicted_rate_mpy"]))
    pool = pool[: payload.candidate_limit]

    candidates = []
    for s in pool:
        detail = svc.get_segment(s["segment_id"])
        if detail is None:
            continue
        plan = recommend_inspection(detail)
        # Translate a statutory interval in months into a period index. A
        # period is `days_per_period` working days; ~21 working days a month.
        deadline_period = None
        if plan.regulatory_deadline_months is not None:
            months_per_period = max(payload.days_per_period / 21.0, 0.1)
            deadline_period = int(plan.regulatory_deadline_months / months_per_period)
            # Clamp into the horizon. A deadline beyond the horizon is not a
            # constraint on this schedule at all, so it is dropped rather than
            # clamped to the last period, which would wrongly forbid nothing
            # while still marking the segment as deadline-bound.
            if deadline_period >= payload.periods:
                deadline_period = None
        candidates.append(sched.SchedulableSegment(
            segment_id=s["segment_id"],
            region=s["region"],
            risk_band=s["risk_band"],
            predicted_rate_mpy=s["predicted_rate_mpy"],
            est_days=plan.total_est_days,
            methods=[m.code for m in plan.methods],
            risk_score=s.get("risk_score"),
            deadline_period=deadline_period,
            is_hca=bool(s.get("is_hca", False)),
            latitude=s.get("latitude"),
            longitude=s.get("longitude"),
        ))

    regions = sorted({c.region for c in candidates})
    crews = sched.default_crews(
        regions,
        per_region=max(1, payload.crews_per_region),
        days_per_period=payload.days_per_period,
    )

    result = sched.build_schedule(
        candidates, crews,
        periods=payload.periods,
        region_locked=payload.region_locked,
    )
    return result.to_dict()


# --------------------------------------------------------- repair work ----

@app.get("/api/segments/{segment_id}/repair")
def segment_repair(segment_id: str, user: auth.User = Depends(current_user)):
    """What repair or mitigation this segment needs, and why.

    Deterministic, like inspection method selection — 49 CFR 192.713 / 195.422
    constrain which repairs are permissible for which defect, so the choice
    has to be reproducible and auditable.
    """
    svc = get_service()
    detail = svc.get_segment(segment_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if user.role == "inspector" and detail["region"] != user.region:
        raise HTTPException(status_code=403,
                            detail="This segment is outside your assigned region")
    return recommend_repair(detail).to_dict()


class WorkOrderRequest(BaseModel):
    candidate_limit: int = 40
    days_available: float = 20.0
    travel_penalty_per_day: float = wo.TRAVEL_PENALTY_PER_DAY
    risk_bands: list[str] = ["critical", "elevated"]
    require_immediate: bool = True
    regions: list[str] | None = None


@app.post("/api/workorders/assign")
def assign_workorders(
    payload: WorkOrderRequest,
    user: auth.User = Depends(require_role("supervisor", "admin")),
):
    """Build repair work orders from the highest-risk segments and assign them
    to the nearest qualified technician.

    Supervisor/admin only — dispatching another region's crews is a
    fleet-level decision, and an inspector scoped to one region has no
    business making it.
    """
    if not 1 <= payload.candidate_limit <= 200:
        raise HTTPException(status_code=400,
                            detail="candidate_limit must be between 1 and 200")
    if payload.days_available <= 0:
        raise HTTPException(status_code=400,
                            detail="days_available must be positive")
    if payload.travel_penalty_per_day < 0:
        raise HTTPException(status_code=400,
                            detail="travel_penalty_per_day cannot be negative")

    svc = get_service()

    pool = []
    for band in payload.risk_bands:
        pool.extend(svc.list_segments(risk_band=band))
    if payload.regions:
        wanted = set(payload.regions)
        pool = [s for s in pool if s["region"] in wanted]
    pool.sort(key=lambda s: -s.get("risk_score", 0.0))
    pool = pool[: payload.candidate_limit]

    orders = []
    for summary in pool:
        detail = svc.get_segment(summary["segment_id"])
        if detail is None:
            continue
        plan = recommend_repair(detail).to_dict()
        # A monitor-only plan is not work. Creating an order for it would
        # consume crew-days doing nothing and crowd out real repairs.
        if plan["urgency"] == "monitor" or plan["total_est_days"] <= 0:
            continue
        orders.extend(wo.work_orders_from_repair(summary, plan))

    if not orders:
        return wo.AssignmentResult(
            "NO_ORDERS", True, [], [], 0.0,
            message="No segment in the selected bands needs repair work.",
        ).to_dict()

    technicians = wo.default_technicians(
        sorted({o.region for o in orders}),
        days_available=payload.days_available,
    )

    result = wo.assign_work_orders(
        orders, technicians,
        travel_penalty_per_day=payload.travel_penalty_per_day,
        require_immediate=payload.require_immediate,
    )
    return result.to_dict()


@app.get("/api/technicians")
def list_technicians(user: auth.User = Depends(require_role("supervisor", "admin"))):
    """The field roster, with home depot and certifications."""
    svc = get_service()
    regions = sorted({s["region"] for s in svc.list_segments()})
    return {"technicians": [t.to_dict() for t in wo.default_technicians(regions)]}


@app.get("/api/map/config")
def map_config(user: auth.User = Depends(current_user)):
    """What the console needs to draw a basemap, minus the secret.

    Deliberately returns no key. The browser asks this origin for tiles and
    the server attaches the credential, so there is nothing here worth
    intercepting.
    """
    return {
        "provider": tiles.provider(),
        "style": tiles.style(),
        "available": tiles.available(),
        "attribution": tiles.attribution(),
        "min_zoom": tiles.MIN_ZOOM,
        "max_zoom": tiles.MAX_ZOOM,
        "tile_size": 256,
    }


@app.get("/api/map/tile/{z}/{x}/{y}.png")
def map_tile(z: int, x: int, y: int, user: auth.User = Depends(current_user)):
    """One raster tile, relayed.

    A failure returns 502 rather than a placeholder image: the console
    watches for it and drops to the vector outline, which is a better
    answer than a grid of identical grey squares that looks like the map
    loaded and the country vanished.
    """
    try:
        payload, ctype = tiles.fetch(z, x, y)
    except tiles.TileError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(
        content=payload,
        media_type=ctype,
        # Tiles do not change. Let the browser keep them for a day.
        headers={"Cache-Control": "public, max-age=86400"},
    )


@app.get("/api/map/routes")
def map_routes(user: auth.User = Depends(current_user)):
    """The pipeline corridors the segments were placed on.

    Served rather than duplicated in the frontend. These same waypoints
    decide where every segment sits, so a second copy in TypeScript would
    eventually drift and the symptom would be segments floating beside
    their own route with nothing to explain it.

    Scoped like everything else: an inspector sees their region's corridors,
    which are the only ones they have segments on.
    """
    routes = wo_routes.routes_payload()
    if user.role == "inspector" and user.region:
        routes = [r for r in routes if r["region"] == user.region]
    return {"routes": routes}


@app.get("/api/risk-matrix")
def risk_matrix(user: auth.User = Depends(current_user)):
    """The 5x5 likelihood x consequence grid for the caller's scope.

    Region-scoped for an inspector, like every other route - the matrix
    would otherwise be a way to read the whole fleet's shape without
    permission to read any of its rows.
    """
    region = user.region if user.role == "inspector" else None
    return get_service().risk_matrix(region)


@app.get("/api/segments/{segment_id}/history")
def segment_history(segment_id: str, user: auth.User = Depends(current_user)):
    """Back-cast corrosion-rate series for the register sparkline."""
    svc = get_service()
    detail = svc.get_segment(segment_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="Segment not found")
    if user.role == "inspector" and detail["region"] != user.region:
        raise HTTPException(status_code=403,
                            detail="This segment is outside your assigned region")
    return {"segment_id": segment_id, "series": svc.rate_history(segment_id),
            "reconstructed": True}


class HistoryRequest(BaseModel):
    """Ids to back-cast, for the register sparklines."""

    # Hard cap. The register is virtualised, so the client only ever asks for
    # the rows on screen plus overscan - about forty. The cap is what stops a
    # crafted request turning one call into five thousand back-casts.
    segment_ids: list[str] = []


MAX_HISTORY_IDS = 120


@app.post("/api/history")
def bulk_history(req: HistoryRequest, user: auth.User = Depends(current_user)):
    """Back-cast series for many segments in one call.

    The alternative - one request per visible row - means forty round trips
    every time the register scrolls. Batching keeps it to one, and the client
    caches by id so a row is only ever back-cast once per session.

    Region scoping is applied per id rather than by rejecting the batch: an
    inspector asking for a mixed list gets the rows they may see and silently
    not the others, which is the same rule the register itself applies.
    """
    if len(req.segment_ids) > MAX_HISTORY_IDS:
        raise HTTPException(
            status_code=400,
            detail=f"At most {MAX_HISTORY_IDS} segments per request",
        )
    svc = get_service()
    region = user.region if user.role == "inspector" else None
    out: dict[str, list[float]] = {}
    for sid in req.segment_ids:
        row = svc.df[svc.df["segment_id"] == sid]
        if row.empty:
            continue
        if region is not None and row.iloc[0]["region"] != region:
            continue
        out[sid] = svc.rate_history(sid)
    return {"series": out, "reconstructed": True}


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


# ------------------------------------------------------- AI assistant ----
#
# The LLM is called SERVER-SIDE only. The API key never leaves this process and
# is never sent to the browser — that's the whole reason these endpoints proxy
# the model instead of the frontend calling the provider directly.

_provider = None
_vision_provider = None
_vision_resolved = False


def get_provider():
    global _provider
    if _provider is None:
        _provider = auto_select(settings)
    return _provider


def get_vision_provider():
    """May be a different backend from the text provider — see
    select_vision_provider(). Returns None when nothing can see images."""
    global _vision_provider, _vision_resolved
    if not _vision_resolved:
        _vision_provider = select_vision_provider(settings, get_provider())
        _vision_resolved = True
    return _vision_provider


class ChatRequest(BaseModel):
    question: str
    segment_id: str | None = None          # anchors the answer to one segment
    history: list[dict] = []               # [{role, content}, ...]
    use_rag: bool = True                   # retrieve supporting reference material


@app.get("/api/assistant/status")
def assistant_status(user: auth.User = Depends(current_user)):
    """Lets the UI tell the user honestly which backend is live, whether photo
    analysis is actually available, and what to do if it isn't."""
    status = get_provider().status().as_dict()
    status["knowledge_base"] = get_knowledge_base().stats

    # Vision may come from a different backend than text, so report it
    # separately rather than letting the text provider speak for it.
    vp = get_vision_provider()
    if vp is None:
        status["supports_vision"] = False
        status["vision_provider"] = None
        status["vision_model"] = None
        status["vision_detail"] = (
            "No vision-capable model available. Install one locally with "
            "`ollama pull moondream` (~1.7 GB) or `ollama pull llama3.2-vision` "
            "(~8 GB), then restart the server."
        )
    else:
        vs = vp.status()
        status["supports_vision"] = True
        status["vision_provider"] = vs.name
        status["vision_model"] = vs.vision_model
        status["vision_detail"] = (
            f"Photos are read by '{vs.vision_model}' ({vs.name}); the "
            f"engineering assessment is written by '{status['model']}' "
            f"({status['provider']})."
        )
    return status


@app.get("/api/knowledge/search")
def knowledge_search(q: str, top_k: int = 4, user: auth.User = Depends(current_user)):
    """Direct retrieval against the knowledge base, without the LLM.

    Useful on its own (an engineer can look something up without waiting for a
    generated answer) and invaluable for debugging RAG quality — if the
    assistant cites something odd, this shows exactly what was retrieved.
    """
    if not q.strip():
        raise HTTPException(status_code=400, detail="Query is empty")
    kb = get_knowledge_base()
    hits = kb.search(q, top_k=max(1, min(top_k, 10)), embed_fn=_query_embedder())
    return {"query": q, "results": [h.to_dict() for h in hits], "stats": kb.stats}


def _context_for(question_scope: str | None, user: auth.User) -> str:
    """Builds the grounding context: one segment if the user is asking about a
    specific one, otherwise a fleet summary scoped to what they may see."""
    svc = get_service()
    if question_scope:
        detail = svc.get_segment(question_scope)
        if detail is None:
            raise HTTPException(status_code=404, detail="Segment not found")
        if user.role == "inspector" and detail["region"] != user.region:
            raise HTTPException(status_code=403, detail="This segment is outside your assigned region")
        return assistant.build_segment_context(detail)
    return assistant.build_fleet_context(svc, _region_scope(user))


def _query_embedder():
    """Embedding function for retrieval, or None when dense is not in play.

    Returns None unless a dense index is actually loaded — calling Ollama to
    embed a query whose vectors nothing will be compared against is a wasted
    round trip on the request path, and on CPU that is seconds, not
    milliseconds.
    """
    if not settings.RAG_DENSE_QUERIES:
        return None
    kb = get_knowledge_base()
    if not kb.stats.get("dense_enabled"):
        return None
    return lambda texts: ollama_embed(texts, DENSE_MODEL)


@app.post("/api/assistant/chat")
def assistant_chat(payload: ChatRequest, user: auth.User = Depends(current_user)):
    """Streams the answer back as plain text chunks so the UI can render it
    progressively — a local CPU model can take 20s+ to finish, and a spinner
    that long feels broken."""
    question = (payload.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is empty")
    if len(question) > 2000:
        raise HTTPException(status_code=400, detail="Question is too long (2000 char limit)")

    # Layer 1 of the domain gate — deterministic, costs nothing, catches the
    # blatant cases without an LLM round trip. Layer 2 is the system prompt.
    if not assistant.is_in_domain(question):
        return StreamingResponse(iter([assistant.REFUSAL]), media_type="text/plain")

    context = _context_for(payload.segment_id, user)

    # RAG: retrieve supporting passages from the corrosion knowledge base.
    reference, citations = ("", [])
    if payload.use_rag:
        reference, citations = assistant.retrieve_reference(
            question, embed_fn=_query_embedder())

    messages = assistant.build_chat_messages(question, payload.history, context, reference)
    provider = get_provider()

    def generate():
        # Emit the citations first, as a single machine-readable line the
        # client strips off before rendering. This lets the UI show its sources
        # immediately rather than after the whole (possibly slow) answer.
        if citations:
            import json as _json
            yield "\x00CITATIONS\x00" + _json.dumps(
                [{"citation": c["citation"], "score": c["score"]} for c in citations]
            ) + "\x00\n"
        try:
            for chunk in provider.stream(messages):
                yield chunk
        except LLMError as e:
            yield f"\n\n**Assistant unavailable.** {e}"
        except Exception:  # noqa: BLE001 - do not 500 mid-stream
            # Anything else may carry a file path, a driver string, or
            # part of a request URL that could include an API key.
            # Logged server-side, generic to the client.
            import traceback
            traceback.print_exc()
            yield ("\n\n**Unexpected error while generating the answer.** "
                   "The details were logged on the server.")

    return StreamingResponse(generate(), media_type="text/plain")


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Read in 64 KB chunks so an oversized upload is rejected while it arrives
# rather than after it has all been buffered.
UPLOAD_CHUNK_BYTES = 64 * 1024


def _sniff_image_type(head: bytes) -> str | None:
    """Identify an image from its leading bytes.

    `file.content_type` is whatever the client chose to send. Trusting it
    means a caller can label anything image/png and have it forwarded to
    the vision model. This checks what the bytes actually are; the
    declared type still has to agree.

    Signatures are built with bytes([...]) rather than escape sequences so
    the non-printable bytes are unambiguous on the page.
    """
    JPEG = bytes([0xFF, 0xD8, 0xFF])
    PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    if head.startswith(JPEG):
        return "image/jpeg"
    if head.startswith(PNG):
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


async def _read_capped(file: UploadFile, limit: int) -> bytes:
    """Read an upload, aborting as soon as it exceeds `limit`.

    The previous version did `await file.read()` and checked the length
    afterwards, which means the 413 only fires once the whole body is already
    in memory — a large enough upload exhausts the process before the check
    it was supposed to trip.
    """
    buf = bytearray()
    while True:
        chunk = await file.read(UPLOAD_CHUNK_BYTES)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > limit:
            limit_mb = limit / (1024 * 1024)
            raise HTTPException(
                status_code=413,
                detail=f"Image exceeds the {limit_mb:.0f} MB limit.",
            )
    return bytes(buf)


@app.post("/api/assistant/analyze-image")
async def analyze_image(
    file: UploadFile = File(...),
    segment_id: str | None = Form(default=None),
    note: str | None = Form(default=None),
    user: auth.User = Depends(current_user),
):
    """Photo analysis, fused with the segment's numeric context.

    The image is held in memory and discarded after the call — nothing is
    written to disk. That keeps the new attack surface as small as possible
    and avoids an unbounded upload directory.
    """
    vision = get_vision_provider()
    if vision is None:
        raise HTTPException(
            status_code=503,
            detail="No vision-capable model available. Install one locally with "
                   "`ollama pull moondream` (~1.7 GB), then restart the server.",
        )

    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported image type '{file.content_type}'. "
                   f"Use JPEG, PNG, WebP or GIF.",
        )

    raw = await _read_capped(file, settings.MAX_IMAGE_BYTES)
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # The bytes must actually be the image type the client claimed.
    sniffed = _sniff_image_type(raw[:16])
    if sniffed is None:
        raise HTTPException(
            status_code=400,
            detail="File does not appear to be a JPEG, PNG, WebP or GIF image.",
        )
    if sniffed != file.content_type:
        raise HTTPException(
            status_code=400,
            detail=f"Declared type '{file.content_type}' does not match the "
                   f"file contents ({sniffed}).",
        )

    context = _context_for(segment_id, user)
    text = get_provider()
    vision_status = vision.status()

    # --- Stage 1: SEE. The vision model gets no segment context on purpose —
    # telling it the pipe is predicted to corrode fast would bias it toward
    # reporting corrosion it cannot actually see.
    try:
        observations = vision.chat_with_image(
            assistant.build_observe_messages(note),
            encode_image(raw),
            file.content_type,
            # A plain description needs a few hundred tokens at most. A high cap
            # just gives a small model room to loop.
            max_tokens=320,
        )
    except LLMError as e:
        raise HTTPException(status_code=502, detail=f"Image reading failed: {e}") from e

    observations = assistant.dedupe_observations(observations)

    if not observations.strip():
        raise HTTPException(
            status_code=502,
            detail="The vision model returned an empty description of the image.",
        )

    # --- Stage 2: REASON. A text model turns those observations plus the
    # segment's data into the structured assessment, where the "never estimate
    # wall loss" rules are actually followed.
    try:
        analysis = text.chat(
            assistant.build_assessment_messages(observations, context, note),
            # Four sections with a full recommended-action list runs long; at
            # 1400 the Limitations section was being cut off mid-sentence,
            # which is exactly the part that must not go missing.
            max_tokens=2600,
        )
    except LLMError as e:
        # Stage 1 succeeded, so return what was actually seen rather than
        # losing the (slow, expensive) vision result entirely.
        analysis = (
            "**Visual observations**\n\n"
            f"{observations}\n\n"
            f"**Assessment unavailable.** The reasoning step failed: {e}"
        )

    return {
        "segment_id": segment_id,
        "analysis": analysis,
        "observations": observations,
        "provider": text.status().name,
        "model": text.status().model,
        "vision_provider": vision_status.name,
        "vision_model": vision_status.vision_model,
    }


# --------------------------------------------------------------- static ----
#
# Two frontends live in this repo and the server picks whichever is present:
#
#   web/dist/   the React + TypeScript console (run `npm run build` in web/)
#   frontend/   the no-build vanilla ES-module console
#
# The React build wins when it exists. The vanilla one is kept as a genuine
# fallback, not dead code: it needs no Node, no npm and no build step, so the
# console still runs on a machine where installing the toolchain isn't an
# option. Deleting web/dist reverts to it with no code change.

ROOT = Path(__file__).resolve().parent.parent
REACT_DIST = ROOT / "web" / "dist"
VANILLA_DIR = ROOT / "frontend"

if (REACT_DIST / "index.html").exists():
    FRONTEND_DIR = REACT_DIST
    ACTIVE_FRONTEND = "react"
else:
    FRONTEND_DIR = VANILLA_DIR
    ACTIVE_FRONTEND = "vanilla"


@app.get("/api/meta")
def meta():
    """Which frontend is being served, and what optional features are live.
    Handy when the React build is stale and you're wondering why a change
    isn't showing up."""
    return {
        "frontend": ACTIVE_FRONTEND,
        "frontend_dir": str(FRONTEND_DIR),
        "react_built": (REACT_DIST / "index.html").exists(),
        "knowledge_base": get_knowledge_base().stats,
    }


LANDING_DIR = Path(__file__).resolve().parent.parent / "landing"


@app.get("/", include_in_schema=False)
def landing():
    """Public landing page. Falls through to the console if it is absent, so
    deleting the landing directory degrades rather than 404s."""
    index = LANDING_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/console", include_in_schema=False)
@app.get("/console/", include_in_schema=False)
def console():
    """The application itself.

    Serves the SPA shell directly rather than relying on the StaticFiles mount,
    because the mount now sits behind the landing page at "/". The built
    bundle references its assets by absolute path (/assets/...), which the
    mount below still serves, so no Vite base change is needed.
    """
    return FileResponse(FRONTEND_DIR / "index.html")


# The landing page's own stylesheet and script. They are external rather
# than inline because the CSP is `script-src 'self'` - an inline <script> is
# blocked outright, which is exactly what happened the first time: the page
# rendered as a black screen with only the header, because every .reveal
# element stayed at opacity:0 and no JavaScript ran to reveal them.
if LANDING_DIR.exists():
    app.mount("/landing", StaticFiles(directory=str(LANDING_DIR)), name="landing")

# Mounted last: explicit routes above win, everything else (assets, the
# vanilla fallback console, favicons) is served from here.
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=False), name="frontend")
