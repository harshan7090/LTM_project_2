"""
Tests for inspection method selection, OR-Tools scheduling, and RAG retrieval.

None of these call an LLM. The inspection plan and the schedule are both
deterministic by design, which is exactly what makes them testable — and the
reason they are code rather than prompts.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402
from src.integrity import scheduler as sched  # noqa: E402
from src.integrity.inspection import recommend_inspection  # noqa: E402
from src.integrity.rag import get_knowledge_base  # noqa: E402

client = TestClient(app)


def _login(username, password):
    r = client.post("/api/login", json={"username": username, "password": password})
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


def _segment(**overrides):
    """A plausible baseline segment; override individual attributes per test."""
    attrs = {
        "pipe_age_years": 20.0,
        "diameter_inches": 12,
        "wall_thickness_mm": 12.0,
        "soil_resistivity_ohm_cm": 8000.0,
        "operating_pressure_psi": 600.0,
        "operating_temperature_c": 70.0,
        "last_inspection_years_ago": 2.0,
        "historical_repair_count": 0,
        "cathodic_protection": True,
        "material": "Carbon Steel",
        "coating_type": "FBE",
        "soil_type": "Sandy",
        "product_type": "Crude Oil",
        "region": "Northern",
    }
    attrs.update(overrides.pop("attributes", {}))
    base = {
        "segment_id": "SEG-TEST",
        "region": "Northern",
        "risk_band": "normal",
        "predicted_rate_mpy": 1.0,
        "last_inspection_years_ago": attrs["last_inspection_years_ago"],
        "attributes": attrs,
        "explanation": {"base_value": 2.8, "contributions": []},
    }
    base.update(overrides)
    return base


# ------------------------------------------------ inspection method rules ---

def test_absent_cp_triggers_a_potential_survey():
    plan = recommend_inspection(_segment(attributes={"cathodic_protection": False}))
    assert "CIPS" in [m.code for m in plan.methods]
    assert any("cathodic protection" in d.lower() for d in plan.drivers)


def test_tape_coating_triggers_coating_survey_and_shielding_warning():
    """The shielding caveat is the whole point — a passing CIPS on tape-coated
    pipe does not prove protection, and the plan must say so."""
    plan = recommend_inspection(_segment(attributes={"coating_type": "Polyethylene Tape"}))
    assert "DCVG" in [m.code for m in plan.methods]
    assert any("shield" in n.lower() for n in plan.notes)


def test_uncoated_pipe_triggers_coating_defect_survey():
    plan = recommend_inspection(_segment(attributes={"coating_type": "Uncoated"}))
    assert "DCVG" in [m.code for m in plan.methods]


def test_small_diameter_high_risk_routes_to_direct_assessment_not_ili():
    """A 4-inch line can't take a conventional ILI tool, so the plan must route
    to ECDA instead of recommending something physically impossible."""
    plan = recommend_inspection(_segment(
        risk_band="critical", predicted_rate_mpy=9.0,
        attributes={"diameter_inches": 4},
    ))
    codes = [m.code for m in plan.methods]
    assert "ECDA" in codes
    assert not any(c.startswith("ILI") for c in codes)


def test_large_diameter_high_risk_routes_to_ili():
    plan = recommend_inspection(_segment(
        risk_band="critical", predicted_rate_mpy=9.0,
        attributes={"diameter_inches": 24},
    ))
    assert any(m.code.startswith("ILI") for m in plan.methods)


def test_ili_recommendation_always_carries_a_piggability_caveat():
    """Diameter is only a proxy for piggability; the plan must not imply
    certainty it doesn't have."""
    plan = recommend_inspection(_segment(
        risk_band="critical", predicted_rate_mpy=9.0,
        attributes={"diameter_inches": 24},
    ))
    assert any("piggab" in n.lower() for n in plan.notes)


def test_cui_flagged_only_in_the_susceptible_temperature_band():
    hot = recommend_inspection(_segment(attributes={
        "operating_temperature_c": 95.0, "pipe_age_years": 30.0}))
    assert "CUI" not in [m.code for m in hot.methods]

    warm = recommend_inspection(_segment(attributes={
        "operating_temperature_c": 40.0, "pipe_age_years": 30.0}))
    assert "CUI" in [m.code for m in warm.methods]
    # and it must be labelled conditional, since the dataset has no insulation field
    assert any("insulation" in n.lower() for n in warm.notes)


def test_repeat_repairs_trigger_direct_examination():
    plan = recommend_inspection(_segment(attributes={"historical_repair_count": 5}))
    assert "DIG" in [m.code for m in plan.methods]


def test_healthy_segment_still_gets_a_baseline_plan():
    """A plan with no methods would be a bug — routine monitoring is still a
    plan."""
    plan = recommend_inspection(_segment())
    assert plan.methods
    assert plan.urgency == "routine"


def test_urgency_and_interval_track_risk_band():
    crit = recommend_inspection(_segment(risk_band="critical"))
    norm = recommend_inspection(_segment(risk_band="normal"))
    assert crit.urgency == "immediate"
    assert norm.urgency == "routine"
    assert crit.interval_months < norm.interval_months


def test_long_overdue_inspection_shortens_the_interval():
    plan = recommend_inspection(_segment(
        risk_band="normal", attributes={"last_inspection_years_ago": 9.5}))
    assert plan.interval_months <= 12


def test_plan_is_deterministic():
    seg = _segment(risk_band="critical", attributes={"cathodic_protection": False})
    a, b = recommend_inspection(seg).to_dict(), recommend_inspection(seg).to_dict()
    assert a == b


def test_every_method_explains_itself():
    """A recommendation an engineer can't justify to a regulator is useless."""
    plan = recommend_inspection(_segment(
        risk_band="critical", attributes={"cathodic_protection": False}))
    for m in plan.methods:
        assert m.rationale.strip()
        assert m.est_days > 0


# ------------------------------------------------------------- scheduler ---

def _seg(sid, region="Northern", band="critical", rate=10.0, days=5.0):
    return sched.SchedulableSegment(sid, region, band, rate, days, ["CIPS"])


def test_scheduler_respects_crew_capacity():
    segments = [_seg(f"S{i}", days=5.0) for i in range(20)]
    crews = [sched.Crew("A", "Crew A", "Northern", days_per_period=10.0)]
    result = sched.build_schedule(segments, crews, periods=2)

    # 10 days/period x 2 periods / 5 days each = at most 4 segments.
    assert result.scheduled_count <= 4
    load: dict[tuple[str, int], float] = {}
    for a in result.assignments:
        key = (a.crew_id, a.period)
        load[key] = load.get(key, 0) + a.est_days
    assert all(v <= 10.0 + 1e-6 for v in load.values())


def test_scheduler_prefers_higher_risk_segments():
    segments = [_seg("LOW", rate=1.0), _seg("HIGH", rate=100.0)]
    crews = [sched.Crew("A", "Crew A", "Northern", days_per_period=5.0)]
    result = sched.build_schedule(segments, crews, periods=1)
    assert [a.segment_id for a in result.assignments] == ["HIGH"]


def test_region_locking_prevents_cross_region_assignment():
    segments = [_seg("GULF", region="Western")]
    crews = [sched.Crew("MID", "Northern crew", "Northern", days_per_period=20.0)]

    locked = sched.build_schedule(segments, crews, periods=2, region_locked=True)
    assert locked.scheduled_count == 0

    unlocked = sched.build_schedule(segments, crews, periods=2, region_locked=False)
    assert unlocked.scheduled_count == 1


def test_oversized_work_package_is_reported_not_silently_dropped():
    """The bug this guards against: CP-SAT happily returns a proven-OPTIMAL
    empty schedule when no segment fits in a crew-period, giving no clue why."""
    segments = [_seg("BIG", days=30.0)]
    crews = [sched.Crew("A", "Crew A", "Northern", days_per_period=5.0)]
    result = sched.build_schedule(segments, crews, periods=4)

    assert result.scheduled_count == 0
    assert len(result.oversized) == 1
    assert result.oversized[0]["segment_id"] == "BIG"
    assert result.warnings
    assert result.status == "ALL_OVERSIZED"


def test_unscheduled_critical_counts_oversized_segments_too():
    """An operator needs to know a critical segment went uncovered regardless
    of whether capacity ran out or the package was too big."""
    segments = [_seg("BIG", band="critical", days=30.0), _seg("OK", band="critical", days=2.0)]
    crews = [sched.Crew("A", "Crew A", "Northern", days_per_period=5.0)]
    result = sched.build_schedule(segments, crews, periods=1)
    assert result.unscheduled_critical == 1


def test_scheduler_handles_empty_input():
    result = sched.build_schedule([], [sched.Crew("A", "A", None)], periods=2)
    assert result.scheduled_count == 0
    assert result.status == "EMPTY"


def test_scheduler_reports_no_crews():
    assert sched.build_schedule([_seg("S1")], [], periods=2).status == "NO_CREWS"


def test_each_segment_scheduled_at_most_once():
    segments = [_seg(f"S{i}", days=1.0) for i in range(5)]
    crews = [sched.Crew("A", "Crew A", "Northern", days_per_period=20.0)]
    result = sched.build_schedule(segments, crews, periods=4)
    ids = [a.segment_id for a in result.assignments]
    assert len(ids) == len(set(ids))


# -------------------------------------------------------------------- RAG ---

def test_knowledge_base_loads():
    kb = get_knowledge_base()
    assert kb.ready
    assert kb.stats["chunks"] > 10


@pytest.mark.parametrize("query,expect", [
    ("disbonded tape shields cathodic protection", "shield"),
    ("what is the -850 mV criterion", "850"),
    ("sulphate reducing bacteria black corrosion product", "MIC"),
    ("convert mils per year to mm per year", "0.0254"),
    ("how do I choose between ILI and direct assessment", "ECDA"),
])
def test_retrieval_finds_the_right_passage(query, expect):
    hits = get_knowledge_base().search(query, top_k=3)
    assert hits, f"no hits for {query!r}"
    assert any(expect.lower() in h.chunk.text.lower() for h in hits), \
        f"{expect!r} not in top hits for {query!r}"


@pytest.mark.parametrize("query", [
    "how often should I inspect",     # corpus says "inspection", query says "inspect"
    "why is my pipe corroding",       # corpus says "corrosion"
    "when should I run a pig",        # corpus says "pigging"/"in-line inspection"
])
def test_retrieval_survives_word_form_mismatch(query):
    """Word-level TF-IDF does no stemming, so "inspect" scored 0.000 against a
    corpus that says "inspection" — a real question getting no reference
    material at all. The character-n-gram view exists to fix exactly this."""
    assert get_knowledge_base().search(query, top_k=3), \
        f"{query!r} returned nothing — the char-n-gram fallback has regressed"


def test_retrieval_trims_obvious_off_topic_noise():
    """NOTE: retrieval is deliberately NOT the topic gate — see the tuning note
    in rag.py. No threshold cleanly separates on- from off-topic queries, so
    this only asserts the obvious tail is trimmed. The real boundary is the
    domain gate, covered by test_assistant.py."""
    kb = get_knowledge_base()
    noisy = [
        "who won the world cup", "best programming language to learn",
        "how to train a dog", "weather forecast tomorrow",
        "cheap flights to paris", "javascript async await tutorial",
    ]
    leaked = [q for q in noisy if kb.search(q, top_k=3)]
    assert not leaked, f"off-topic queries retrieved material: {leaked}"


def test_every_chunk_carries_a_citation():
    for chunk in get_knowledge_base().chunks:
        assert chunk.citation.strip()


# --------------------------------------------------------------- endpoints ---

def test_inspection_endpoint_requires_auth():
    assert client.get("/api/segments/SEG-00001/inspection").status_code == 401


def test_schedule_endpoint_is_supervisor_only():
    assert client.post("/api/schedule", headers=_login("inspector1", "inspect123"),
                       json={"periods": 2}).status_code == 403
    assert client.post("/api/schedule", headers=_login("supervisor1", "supervise123"),
                       json={"periods": 2, "candidate_limit": 20}).status_code == 200


def test_schedule_endpoint_validates_input():
    h = _login("supervisor1", "supervise123")
    assert client.post("/api/schedule", headers=h, json={"periods": 0}).status_code == 400
    assert client.post("/api/schedule", headers=h, json={"periods": 99}).status_code == 400
    assert client.post("/api/schedule", headers=h,
                       json={"periods": 2, "days_per_period": 0}).status_code == 400


def test_knowledge_search_endpoint():
    h = _login("supervisor1", "supervise123")
    r = client.get("/api/knowledge/search", headers=h, params={"q": "cathodic protection"})
    assert r.status_code == 200
    assert r.json()["results"]


def test_knowledge_search_rejects_empty_query():
    h = _login("supervisor1", "supervise123")
    assert client.get("/api/knowledge/search", headers=h,
                      params={"q": "   "}).status_code == 400


def test_inspector_cannot_read_out_of_region_inspection_plan():
    h = _login("supervisor1", "supervise123")
    segments = client.get("/api/segments", headers=h).json()["segments"]
    outside = next(s for s in segments if s["region"] != "Western")
    r = client.get(f"/api/segments/{outside['segment_id']}/inspection",
                   headers=_login("inspector1", "inspect123"))
    assert r.status_code == 403
