"""
Crew identity and crew-load reporting in the inspection scheduler.

Pins two bugs that reached the console: "Northern" and "North Eastern" both
became crew NOR, so each showed the other's work (122 of 80 crew-days), and
the crew-load figure counted inspection days but not travel, although the
solver charges both to the same budget.
"""
import pytest

from src.integrity import scheduler as sched
from src.integrity.geo import DEPOT_CITY, REGION_CENTROIDS, region_code

ZONES = ["Western", "Northern", "Eastern", "Southern", "North Eastern"]


def test_zone_codes_are_unique():
    codes = [region_code(z) for z in ZONES]
    assert len(set(codes)) == len(codes), codes
    assert region_code("North Eastern") == "NE"
    assert region_code("Northern") == "NOR"


def test_default_crews_have_unique_ids_and_a_depot():
    crews = sched.default_crews(ZONES)
    ids = [c.crew_id for c in crews]
    assert len(set(ids)) == len(ids)
    assert all(c.depot == DEPOT_CITY[c.region] for c in crews)


def test_two_crews_per_zone_stay_unique():
    ids = [c.crew_id for c in sched.default_crews(ZONES, per_region=2)]
    assert len(set(ids)) == len(ids) == 10


def test_a_duplicate_crew_id_fails_loudly(monkeypatch):
    monkeypatch.setattr(sched, "region_code", lambda region: "XX")
    with pytest.raises(ValueError, match="not unique"):
        sched.default_crews(["Northern", "North Eastern"])


def _segments():
    out = []
    for z in ZONES:
        lat, lon = REGION_CENTROIDS[z]
        for i in range(6):
            out.append(sched.SchedulableSegment(
                segment_id=f"{region_code(z)}-{i}", region=z,
                risk_band="critical" if i < 2 else "elevated",
                predicted_rate_mpy=3.0 - i * 0.2, est_days=6.0,
                methods=["CIPS"], risk_score=80 - i, is_hca=True,
                latitude=lat + 0.5 + i * 0.1, longitude=lon + 0.5,
            ))
    return out


def test_crew_load_includes_travel_and_respects_capacity():
    crews = sched.default_crews(ZONES, days_per_period=20)
    result = sched.build_schedule(_segments(), crews, periods=2)
    assert result.crews, "a crew summary is expected"
    for c in result.crews:
        assert c["travel_days"] > 0, "segments off the depot cost travel"
        assert c["days_committed"] == pytest.approx(c["days_used"] + c["travel_days"], abs=0.11)
        # Work AND travel must fit: that is the constraint the solver enforced.
        assert c["days_committed"] <= c["days_available"] + 1e-6, c
    # Each zone's crew reports only its own zone's segments.
    by_crew = {c["crew_id"]: c["segments"] for c in result.crews}
    assert by_crew[region_code("Northern")] <= 6 and by_crew[region_code("North Eastern")] <= 6


def test_the_optimality_gap_is_reported_and_the_wording_matches_it():
    result = sched.build_schedule(_segments(), sched.default_crews(ZONES), periods=2)
    d = result.to_dict()
    assert d["optimality_gap_pct"] is not None and d["optimality_gap_pct"] >= 0
    if d["optimal"]:
        assert d["optimality_gap_pct"] < 0.005 and d["message"].startswith("Proven optimal")
    else:
        assert d["message"].startswith("Proven within")
