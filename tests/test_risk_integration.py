"""
Integration between consequence, remaining life, inspection planning and the
scheduler.

These cover the seams rather than the individual calculations — specifically
the two places where a regulatory fact has to survive being turned into
something else: a statutory interval becoming an inspection interval, and an
inspection interval becoming a hard constraint in the CP-SAT model.
"""
import pytest

import src.integrity.scheduler as sched
from src.integrity.inspection import (
    HCA_MAX_INTERVAL_MONTHS_GAS, HCA_MAX_INTERVAL_MONTHS_LIQUID,
    recommend_inspection,
)


def _detail(**kw):
    """A minimal ScoringService.get_segment()-shaped dict."""
    base = {
        "segment_id": "SEG-1",
        "risk_band": "normal",
        "predicted_rate_mpy": 1.0,
        "attributes": {
            "pipe_age_years": 10, "diameter_inches": 24, "wall_thickness_mm": 12,
            "soil_resistivity_ohm_cm": 9000, "operating_pressure_psi": 500,
            "operating_temperature_c": 20, "last_inspection_years_ago": 1,
            "historical_repair_count": 0, "cathodic_protection": True,
            "material": "Carbon Steel", "coating_type": "FBE",
            "soil_type": "Loam", "product_type": "Crude Oil", "region": "Northern",
        },
    }
    attrs = kw.pop("attributes", {})
    base["attributes"].update(attrs)
    base.update(kw)
    return base


# ------------------------------------------------- backwards compatibility --

def test_plan_still_builds_without_consequence_or_remaining_life():
    """Both blocks are optional. A caller that has not been updated must get
    the old behaviour, not a KeyError."""
    plan = recommend_inspection(_detail())
    assert plan.segment_id == "SEG-1"
    assert plan.interval_months > 0
    assert plan.regulatory_deadline_months is None
    assert plan.is_hca is False


# ----------------------------------------------------------- statutory cap --

def test_hca_liquid_caps_the_interval_at_five_years():
    plan = recommend_inspection(_detail(
        risk_band="normal",
        consequence={"is_hca": True, "hca_basis": ["drinking water source"],
                     "regulatory_regime": "49 CFR 195 (hazardous liquid)"},
    ))
    assert plan.is_hca
    assert plan.regulatory_deadline_months == HCA_MAX_INTERVAL_MONTHS_LIQUID
    assert plan.interval_months <= HCA_MAX_INTERVAL_MONTHS_LIQUID


def test_hca_gas_caps_the_interval_at_seven_years():
    plan = recommend_inspection(_detail(
        risk_band="normal",
        attributes={"product_type": "Natural Gas"},
        consequence={"is_hca": True, "hca_basis": ["Class 3 location"],
                     "regulatory_regime": "49 CFR 192 (gas transmission)"},
    ))
    assert plan.regulatory_deadline_months == HCA_MAX_INTERVAL_MONTHS_GAS


def test_the_cap_only_ever_shortens_the_interval():
    """A risk-based interval shorter than the statutory maximum must survive.
    The cap is a ceiling, not a target — an engine that relaxed a 6-month
    interval out to 60 because the law permits it would be actively unsafe."""
    plan = recommend_inspection(_detail(
        risk_band="critical",
        consequence={"is_hca": True, "hca_basis": ["high population area"],
                     "regulatory_regime": "49 CFR 195 (hazardous liquid)"},
    ))
    assert plan.interval_months == 6
    assert plan.regulatory_deadline_months == HCA_MAX_INTERVAL_MONTHS_LIQUID
    assert any("shorter and governs" in n for n in plan.notes)


def test_non_hca_segment_gets_no_statutory_deadline():
    plan = recommend_inspection(_detail(
        consequence={"is_hca": False, "hca_basis": [],
                     "regulatory_regime": "49 CFR 195 (hazardous liquid)"}))
    assert plan.regulatory_deadline_months is None


def test_hca_status_appears_as_a_driver():
    plan = recommend_inspection(_detail(
        consequence={"is_hca": True, "hca_basis": ["Class 4 location"],
                     "regulatory_regime": "49 CFR 192 (gas transmission)"}))
    assert any("High Consequence Area" in d for d in plan.drivers)


# ---------------------------------------------------------- remaining life --

def test_exhausted_remaining_life_forces_immediate_urgency():
    plan = recommend_inspection(_detail(
        risk_band="normal",
        remaining_life={"verdict": "repair_now", "remaining_life_years": 0.0}))
    assert plan.urgency == "immediate"
    assert plan.interval_months <= 6


def test_derate_verdict_lifts_a_routine_segment_to_scheduled():
    plan = recommend_inspection(_detail(
        risk_band="normal",
        remaining_life={"verdict": "derate", "remaining_life_years": 12.0}))
    assert plan.urgency == "scheduled"


def test_short_remaining_life_shortens_the_interval():
    plan = recommend_inspection(_detail(
        risk_band="normal",
        remaining_life={"verdict": "plan_repair", "remaining_life_years": 3.0}))
    assert plan.interval_months <= 12
    assert any("remaining life" in n for n in plan.notes)


# ----------------------------------------------------------- scheduler ------

def _seg(sid, region="Northern", risk=50.0, days=4.0, deadline=None, hca=False,
         band="elevated"):
    return sched.SchedulableSegment(
        segment_id=sid, region=region, risk_band=band,
        predicted_rate_mpy=5.0, est_days=days, methods=["CIPS"],
        risk_score=risk, deadline_period=deadline, is_hca=hca)


def test_objective_weight_prefers_risk_over_rate_when_present():
    with_risk = _seg("A", risk=80.0)
    without = sched.SchedulableSegment(
        segment_id="B", region="Northern", risk_band="elevated",
        predicted_rate_mpy=5.0, est_days=4.0)
    assert with_risk.objective_weight == 80.0
    assert without.objective_weight == 5.0


def test_deadline_is_a_hard_constraint_not_a_preference():
    """One crew, two periods, capacity for one segment per period. The
    deadline-bound segment must land in period 0 even though the other
    segment carries more risk and would otherwise be placed first."""
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=5.0)]
    segments = [
        _seg("URGENT", risk=10.0, days=5.0, deadline=0),
        _seg("RICHER", risk=99.0, days=5.0),
    ]
    result = sched.build_schedule(segments, crews, periods=2, region_locked=False)
    placed = {a.segment_id: a.period for a in result.assignments}
    assert "URGENT" in placed, "deadline-bound segment was dropped"
    assert placed["URGENT"] == 0


def test_missed_deadline_is_reported_not_silently_dropped():
    """Capacity for one segment, two segments both due in period 0. The one
    that cannot fit must surface as a compliance breach rather than simply
    being absent from the schedule."""
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=5.0)]
    segments = [
        _seg("A", risk=90.0, days=5.0, deadline=0, hca=True),
        _seg("B", risk=10.0, days=5.0, deadline=0, hca=True),
    ]
    result = sched.build_schedule(segments, crews, periods=1, region_locked=False)
    assert len(result.missed_deadlines) == 1
    assert result.missed_deadlines[0]["segment_id"] == "B"
    assert any("compliance exposure" in w for w in result.warnings)


def test_no_missed_deadlines_when_everything_fits():
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=20.0)]
    segments = [_seg("A", days=4.0, deadline=1), _seg("B", days=4.0, deadline=1)]
    result = sched.build_schedule(segments, crews, periods=2, region_locked=False)
    assert result.missed_deadlines == []
    assert not any("compliance exposure" in w for w in result.warnings)


def test_hca_coverage_is_reported():
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=20.0)]
    segments = [_seg("A", hca=True, days=4.0), _seg("B", hca=True, days=4.0),
                _seg("C", hca=False, days=4.0)]
    result = sched.build_schedule(segments, crews, periods=1, region_locked=False)
    assert result.hca_total == 2
    assert result.hca_scheduled == 2
    assert result.hca_coverage_pct == pytest.approx(100.0)


def test_hca_coverage_pct_is_zero_not_a_crash_when_no_hca_segments():
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=20.0)]
    result = sched.build_schedule([_seg("A")], crews, periods=1, region_locked=False)
    assert result.hca_total == 0
    assert result.hca_coverage_pct == 0.0


def test_risk_covered_uses_the_same_scale_as_risk_total():
    """Mixing risk_score into one and predicted_rate_mpy into the other would
    make coverage percentage meaningless — and it would still render."""
    crews = [sched.Crew("C1", "Crew 1", region=None, days_per_period=20.0)]
    segments = [_seg("A", risk=60.0, days=4.0), _seg("B", risk=40.0, days=4.0)]
    result = sched.build_schedule(segments, crews, periods=1, region_locked=False)
    assert result.risk_total == pytest.approx(100.0)
    assert result.risk_covered == pytest.approx(100.0)


# ------------------------------------------------- travel-aware scheduling --

def _geo_seg(sid, lat, lon, region="R", days=4.0, risk=50.0):
    return sched.SchedulableSegment(
        segment_id=sid, region=region, risk_band="elevated",
        predicted_rate_mpy=5.0, est_days=days, methods=[],
        risk_score=risk, latitude=lat, longitude=lon)


def _depot(days=8.0):
    return sched.Crew("MID", "Northern crew", region=None, days_per_period=days,
                      home_latitude=41.88, home_longitude=-93.10)


def test_travel_is_zero_without_coordinates():
    """A caller that supplies no geography must get exactly the previous
    behaviour, not a silently distorted objective."""
    crew = sched.Crew("C", "crew", region=None, days_per_period=8.0)
    seg = sched.SchedulableSegment("A", "R", "elevated", 5.0, 4.0, [])
    assert sched._travel_days(seg, crew) == 0.0


def test_travel_is_zero_when_only_one_end_has_coordinates():
    seg = _geo_seg("A", 41.9, -93.1)
    crew = sched.Crew("C", "crew", region=None, days_per_period=8.0)
    assert sched._travel_days(seg, crew) == 0.0


def test_distant_segment_costs_more_crew_days_than_a_near_one():
    crew = _depot()
    near = _geo_seg("NEAR", 41.95, -93.15)
    far = _geo_seg("FAR", 29.76, -95.37)
    assert sched._travel_days(far, crew) > sched._travel_days(near, crew)


def test_nearer_segment_wins_at_equal_risk():
    """The point of putting travel in the objective: between two equally
    valuable segments the solver must prefer the reachable one rather than
    choosing arbitrarily."""
    crew = _depot(days=8.0)
    near = _geo_seg("NEAR", 41.95, -93.15)
    far = _geo_seg("FAR", 29.76, -95.37)
    result = sched.build_schedule([near, far], [crew], periods=1,
                                  region_locked=False)
    assert [a.segment_id for a in result.assignments] == ["NEAR"]


def test_travel_consumes_the_same_budget_as_work():
    """8 crew-days, one 4-day job 7 days of travel away — it must not fit."""
    crew = _depot(days=8.0)
    far = _geo_seg("FAR", 29.76, -95.37, days=4.0)
    result = sched.build_schedule([far], [crew], periods=1, region_locked=False)
    assert result.scheduled_count == 0


def test_a_segment_unreachable_within_capacity_is_reported_as_oversized():
    """It must surface in `oversized` rather than quietly failing to appear —
    the whole reason that list exists."""
    crew = _depot(days=8.0)
    far = _geo_seg("FAR", 29.76, -95.37, days=4.0)
    result = sched.build_schedule([far], [crew], periods=1, region_locked=False)
    assert any(o["segment_id"] == "FAR" for o in result.oversized)


def test_zero_travel_penalty_restores_distance_blind_behaviour():
    """The knob must actually do something, in the stated direction."""
    crew = _depot(days=40.0)
    segs = [_geo_seg("NEAR", 41.95, -93.15), _geo_seg("FAR", 29.76, -95.37)]
    free = sched.build_schedule(segs, [crew], periods=1, region_locked=False,
                                travel_penalty_per_day=0.0)
    dear = sched.build_schedule(segs, [crew], periods=1, region_locked=False,
                                travel_penalty_per_day=200.0)
    assert free.scheduled_count >= dear.scheduled_count


def test_default_crews_get_a_depot_at_their_region_centroid():
    crews = sched.default_crews(["Northern", "Western"])
    assert all(c.home_latitude is not None for c in crews)

    # Checked against the centroid table rather than a hardcoded latitude:
    # the previous version asserted 40 < lat < 44, which was Iowa, and it
    # broke the moment the fleet moved rather than when the depot logic did.
    from src.integrity.geo import REGION_CENTROIDS

    for crew in crews:
        want_lat, want_lon = REGION_CENTROIDS[crew.region]
        assert crew.home_latitude == pytest.approx(want_lat)
        assert crew.home_longitude == pytest.approx(want_lon)
