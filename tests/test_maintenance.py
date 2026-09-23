"""
Tests for repair selection, geography, and proximity-based crew assignment.

The assignment tests are written against constructed geometry rather than the
real dataset, because "did it send the nearest qualified person" is only a
meaningful assertion when you know in advance who that is.
"""
import pytest

from src.integrity import workorders as wo
from src.integrity.geo import (
    REGION_CENTROIDS, haversine_km, road_distance_km, region_centroid,
    travel_days, travel_hours,
)
from src.integrity.repair import recommend_repair


# ------------------------------------------------------------------- geo ---

def test_haversine_known_distance():
    """Houston to Midland, roughly 680 km great circle."""
    d = haversine_km(29.76, -95.37, 31.99, -102.08)
    assert 640 < d < 720


def test_haversine_is_zero_for_the_same_point():
    assert haversine_km(30.0, -95.0, 30.0, -95.0) == pytest.approx(0.0, abs=1e-9)


def test_haversine_is_symmetric():
    a = haversine_km(29.76, -95.37, 41.88, -93.10)
    b = haversine_km(41.88, -93.10, 29.76, -95.37)
    assert a == pytest.approx(b)


def test_haversine_handles_antipodes_without_a_domain_error():
    """Floating-point error can push the term above 1 and make asin raise."""
    d = haversine_km(0.0, 0.0, 0.0, 180.0)
    assert 19_900 < d < 20_100


def test_road_distance_exceeds_straight_line():
    straight = haversine_km(29.76, -95.37, 31.99, -102.08)
    road = road_distance_km(29.76, -95.37, 31.99, -102.08)
    assert road > straight


def test_travel_days_counts_the_return_leg():
    """Ignoring the return halves the true cost and makes distant work look
    cheap, which is the error that produces silly assignments."""
    one_way = travel_days(500.0, round_trip=False)
    both = travel_days(500.0, round_trip=True)
    assert both == pytest.approx(one_way * 2)


def test_travel_hours_scales_with_distance():
    assert travel_hours(130.0) == pytest.approx(2.0, rel=0.01)


def test_every_region_has_a_centroid():
    for region in ("Western", "Northern", "Eastern", "Southern", "North Eastern"):
        assert region in REGION_CENTROIDS


def test_unknown_region_falls_back_rather_than_raising():
    lat, lon = region_centroid("Atlantis")
    assert -90 <= lat <= 90 and -180 <= lon <= 180


# ---------------------------------------------------------------- repair ---

def _detail(**kw):
    base = {
        "segment_id": "SEG-1",
        "predicted_rate_mpy": 5.0,
        "attributes": {
            "pipe_age_years": 20, "diameter_inches": 24, "wall_thickness_mm": 12,
            "soil_resistivity_ohm_cm": 9000, "operating_pressure_psi": 600,
            "operating_temperature_c": 20, "last_inspection_years_ago": 2,
            "historical_repair_count": 0, "cathodic_protection": True,
            "material": "Carbon Steel", "coating_type": "FBE",
            "soil_type": "Loam", "product_type": "Crude Oil", "region": "Northern",
        },
        "consequence": {"is_hca": False, "hca_basis": [],
                        "regulatory_regime": "49 CFR 195 (hazardous liquid)"},
        "remaining_life": {"verdict": "monitor", "remaining_life_years": 30.0,
                           "erf": 0.5, "safe_operating_pressure_psi": 1200.0,
                           "current_wall_in": 0.47, "min_required_wall_in": 0.14},
    }
    base["attributes"].update(kw.pop("attributes", {}))
    base["consequence"].update(kw.pop("consequence", {}))
    base["remaining_life"].update(kw.pop("remaining_life", {}))
    base.update(kw)
    return base


def test_healthy_segment_gets_monitor_only():
    plan = recommend_repair(_detail())
    assert plan.urgency == "monitor"
    assert [a.code for a in plan.actions] == ["MON"]
    assert plan.total_est_cost_usd == 0


def test_erf_over_one_triggers_an_immediate_derate():
    """The only action available the same day, so it must be present and
    first."""
    plan = recommend_repair(_detail(
        remaining_life={"verdict": "repair_now", "erf": 1.05,
                        "safe_operating_pressure_psi": 700.0,
                        "remaining_life_years": 0.0}))
    assert plan.urgency == "immediate"
    assert plan.actions[0].code == "DERATE"
    assert plan.window_days <= 7


def test_missing_cp_adds_a_mitigation_not_just_a_patch():
    """Reinforcing a pipe whose CP has failed moves the next defect a few
    metres along. The plan must address the cause too."""
    plan = recommend_repair(_detail(attributes={"cathodic_protection": False}))
    codes = [a.code for a in plan.actions]
    assert "CP-UP" in codes
    assert any(a.category == "mitigation" for a in plan.actions)


def test_uncoated_pipe_gets_recoated():
    plan = recommend_repair(_detail(attributes={"coating_type": "Uncoated"}))
    assert "RECOAT" in [a.code for a in plan.actions]


def test_tape_coating_is_treated_as_a_shielding_risk():
    plan = recommend_repair(_detail(attributes={"coating_type": "Polyethylene Tape"}))
    recoat = next(a for a in plan.actions if a.code == "RECOAT")
    assert "disbond" in recoat.rationale.lower() or "shield" in recoat.rationale.lower()


def test_deep_wall_loss_requires_a_pressure_containing_sleeve():
    """Type A composite cannot contain pressure, so it is wrong this close to
    through-wall."""
    plan = recommend_repair(_detail(
        remaining_life={"verdict": "repair_now", "remaining_life_years": 1.0,
                        "current_wall_in": 0.30, "min_required_wall_in": 0.28,
                        "erf": 0.95}))
    codes = [a.code for a in plan.actions]
    assert "SLV-B" in codes
    assert "SLV-A" not in codes


def test_moderate_loss_prefers_the_non_welded_repair():
    plan = recommend_repair(_detail(
        remaining_life={"verdict": "repair_now", "remaining_life_years": 2.0,
                        "current_wall_in": 0.47, "min_required_wall_in": 0.20,
                        "erf": 0.8}))
    assert "SLV-A" in [a.code for a in plan.actions]
    assert not plan.requires_shutdown


def test_repeatedly_repaired_segment_becomes_a_replacement():
    plan = recommend_repair(_detail(
        attributes={"historical_repair_count": 5},
        remaining_life={"verdict": "repair_now", "remaining_life_years": 1.0}))
    assert "CUTOUT" in [a.code for a in plan.actions]
    assert plan.requires_shutdown


def test_small_diameter_cannot_be_sleeved():
    plan = recommend_repair(_detail(
        attributes={"diameter_inches": 3},
        remaining_life={"verdict": "repair_now", "remaining_life_years": 1.0}))
    assert "CUTOUT" in [a.code for a in plan.actions]


def test_hca_compresses_the_repair_window():
    outside = recommend_repair(_detail(attributes={"cathodic_protection": False}))
    inside = recommend_repair(_detail(
        attributes={"cathodic_protection": False},
        consequence={"is_hca": True, "hca_basis": ["high population area"]}))
    assert inside.window_days < outside.window_days
    assert any("High Consequence Area" in n for n in inside.notes)


def test_plan_reports_the_skills_it_needs():
    plan = recommend_repair(_detail(
        attributes={"cathodic_protection": False, "coating_type": "Uncoated"}))
    assert "cathodic_protection" in plan.skills_required
    assert "coating" in plan.skills_required


def test_costs_and_days_sum_over_actions():
    plan = recommend_repair(_detail(
        attributes={"cathodic_protection": False, "coating_type": "Uncoated"}))
    assert plan.total_est_cost_usd == sum(a.est_cost_usd for a in plan.actions)
    assert plan.total_est_days == pytest.approx(sum(a.est_days for a in plan.actions))


def test_plan_is_deterministic():
    d = _detail(attributes={"cathodic_protection": False})
    a = recommend_repair(d).to_dict()
    b = recommend_repair(d).to_dict()
    assert a == b


# ----------------------------------------------------- work order split ----

def _segment(**kw):
    base = {"segment_id": "SEG-1", "region": "Northern", "latitude": 41.9,
            "longitude": -93.1, "risk_score": 50.0, "is_hca": False}
    base.update(kw)
    return base


def test_orders_split_by_trade():
    """A plan needing coating AND cathodic protection is two trucks, not one
    technician holding both certificates. Bundling them produced 27 false
    'skill gap' blocks on the real roster."""
    plan = recommend_repair(_detail(
        attributes={"cathodic_protection": False, "coating_type": "Uncoated"})).to_dict()
    orders = wo.work_orders_from_repair(_segment(), plan)
    skills = {tuple(o.skills_required) for o in orders}
    assert len(orders) >= 2
    assert ("coating",) in skills
    assert ("cathodic_protection",) in skills


def test_split_orders_preserve_total_work_days():
    plan = recommend_repair(_detail(
        attributes={"cathodic_protection": False, "coating_type": "Uncoated"})).to_dict()
    orders = wo.work_orders_from_repair(_segment(), plan)
    assert sum(o.est_days for o in orders) == pytest.approx(plan["total_est_days"])


def test_split_orders_each_carry_full_risk():
    """Dividing risk across trades would make a two-trade segment rank below a
    one-trade segment of equal risk, which inverts the priority."""
    plan = recommend_repair(_detail(
        attributes={"cathodic_protection": False, "coating_type": "Uncoated"})).to_dict()
    orders = wo.work_orders_from_repair(_segment(risk_score=72.0), plan)
    assert all(o.risk_score == 72.0 for o in orders)


def test_actions_sharing_a_trade_stay_together():
    plan = recommend_repair(_detail(attributes={"coating_type": "Uncoated"})).to_dict()
    orders = wo.work_orders_from_repair(_segment(), plan)
    coating = [o for o in orders if o.skills_required == ["coating"]]
    assert len(coating) == 1


# ------------------------------------------------------------ assignment ---

def _tech(tid, lat, lon, skills=("general", "welding"), days=20.0):
    return wo.Technician(tid, f"Tech {tid}", lat, lon, skills, days, None)


def _order(oid, lat, lon, skills=("welding",), days=2.0, risk=50.0,
           urgency="scheduled"):
    return wo.WorkOrder(oid, oid, "R", lat, lon, urgency, 90, days, risk,
                        list(skills))


def test_nearest_qualified_technician_wins():
    """The core claim. Both are certified; only distance separates them."""
    near = _tech("NEAR", 41.9, -93.1)
    far = _tech("FAR", 29.8, -95.4)
    order = _order("O1", 41.95, -93.15)
    result = wo.assign_work_orders([order], [near, far])
    assert result.optimal
    assert order.assigned_to == "NEAR"


def test_an_unqualified_nearer_technician_is_not_chosen():
    """Skills are a hard constraint. There is no partial credit for nearly
    holding the certificate."""
    close_but_wrong = _tech("CLOSE", 41.9, -93.1, skills=("general", "coating"))
    far_but_right = _tech("RIGHT", 29.8, -95.4, skills=("general", "welding"))
    order = _order("O1", 41.95, -93.15, skills=("welding",))
    result = wo.assign_work_orders([order], [close_but_wrong, far_but_right])
    assert order.assigned_to == "RIGHT"


def test_travel_consumes_the_same_budget_as_work():
    """A distant job must cost more capacity than a near one of equal size."""
    tech = _tech("T", 41.9, -93.1, days=20.0)
    near = _order("NEAR", 41.95, -93.15, days=2.0)
    far = _order("FAR", 29.8, -95.4, days=2.0)
    wo.assign_work_orders([near, far], [tech])
    assert far.travel_days > near.travel_days
    assert far.travel_km > near.travel_km


def test_job_too_big_for_anyone_is_left_unassigned():
    tech = _tech("T", 41.9, -93.1, days=3.0)
    order = _order("BIG", 41.9, -93.1, days=10.0)
    result = wo.assign_work_orders([order], [tech], require_immediate=False)
    assert order.status != "assigned"
    assert result.assigned_count == 0


def test_skill_gap_is_reported_as_staffing_not_scheduling():
    """A job nobody is certified for must not look like the solver chose to
    skip it."""
    tech = _tech("T", 41.9, -93.1, skills=("general", "coating"))
    order = _order("O1", 41.9, -93.1, skills=("welding",))
    result = wo.assign_work_orders([order], [tech], require_immediate=False)
    assert len(result.skill_gaps) == 1
    assert result.skill_gaps[0]["missing_skills"] == ["welding"]
    assert order.status == "blocked"
    assert any("staffing gap" in w for w in result.warnings)


def test_immediate_work_is_prioritised_over_cheaper_nearby_work():
    """Without the hard requirement the solver drops an urgent distant job for
    two cheap local ones — arithmetically right, operationally wrong."""
    tech = _tech("T", 41.9, -93.1, days=12.0)
    urgent_far = _order("URGENT", 29.8, -95.4, days=2.0, risk=40.0, urgency="immediate")
    cheap_near = [_order(f"C{i}", 41.9, -93.1, days=2.0, risk=60.0) for i in range(4)]
    result = wo.assign_work_orders([urgent_far] + cheap_near, [tech],
                                   require_immediate=True)
    assert urgent_far.status == "assigned"
    assert result.unassigned_immediate == 0


def test_capacity_is_never_exceeded():
    tech = _tech("T", 41.9, -93.1, days=6.0)
    orders = [_order(f"O{i}", 41.9, -93.1, days=2.0) for i in range(10)]
    result = wo.assign_work_orders(orders, [tech], require_immediate=False)
    row = next(r for r in result.technicians if r["tech_id"] == "T")
    assert row["days_used"] <= 6.0 + 1e-6


def test_raising_the_travel_penalty_reduces_distance_travelled():
    """The knob has to actually do something, in the stated direction."""
    techs = [_tech("A", 41.9, -93.1, days=30.0), _tech("B", 29.8, -95.4, days=30.0)]
    orders = [_order(f"O{i}", 35.0 + i * 0.5, -94.0, days=2.0) for i in range(6)]

    cheap = wo.assign_work_orders(
        [_order(o.order_id, o.latitude, o.longitude) for o in orders],
        techs, travel_penalty_per_day=0.0, require_immediate=False)
    dear = wo.assign_work_orders(
        [_order(o.order_id, o.latitude, o.longitude) for o in orders],
        techs, travel_penalty_per_day=50.0, require_immediate=False)
    assert dear.total_travel_km <= cheap.total_travel_km


def test_empty_inputs_are_handled():
    assert wo.assign_work_orders([], [_tech("T", 0, 0)]).status == "NO_ORDERS"
    assert wo.assign_work_orders([_order("O", 0, 0)], []).status == "NO_TECHNICIANS"


def test_default_roster_covers_every_skill_the_catalogue_asks_for():
    techs = wo.default_technicians(["Northern"])
    covered = {s for t in techs for s in t.skills}
    assert set(wo.ALL_SKILLS) <= covered


def test_result_totals_are_internally_consistent():
    techs = wo.default_technicians(["Northern", "Western"], days_available=30.0)
    orders = [_order(f"O{i}", 41.9 + i * 0.1, -93.1, days=2.0) for i in range(8)]
    r = wo.assign_work_orders(orders, techs, require_immediate=False)
    assigned = [o for o in r.orders if o.status == "assigned"]
    assert r.assigned_count == len(assigned)
    assert r.total_work_days == pytest.approx(sum(o.est_days for o in assigned))
    assert r.total_travel_days == pytest.approx(sum(o.travel_days for o in assigned))
    assert 0 <= r.travel_share_pct <= 100
