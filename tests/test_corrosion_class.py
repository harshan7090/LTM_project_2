"""
The absolute corrosion-rate scale (NACE SP0775) and its separation from risk.

Pins the fix for a detail panel that put the RISK band beside the corrosion
rate, so a fast-corroding 9.29 mpy segment read as "normal".
"""
import pytest

from src.integrity.corrosion_class import CATEGORIES, classify_rate, rate_category


@pytest.mark.parametrize("mpy, expected", [
    (0.0, "low"), (0.99, "low"),
    (1.0, "moderate"), (4.9, "moderate"), (4.99, "moderate"),
    (5.0, "high"), (9.29, "high"), (10.0, "high"),
    (10.01, "severe"), (19.4, "severe"),
])
def test_nace_sp0775_bands(mpy, expected):
    assert rate_category(mpy) == expected


def test_lower_is_better_and_the_scale_is_monotonic():
    order = {c: i for i, c in enumerate(CATEGORIES)}
    rates = [0, 0.5, 1, 2, 5, 7.5, 10, 12, 20]
    ranks = [order[rate_category(r)] for r in rates]
    assert ranks == sorted(ranks)


def test_classification_carries_its_basis_and_band():
    c = classify_rate(9.29)
    assert c == {"category": "high", "label": "High", "range": "5-10 mpy",
                 "basis": "NACE SP0775 general corrosion scale"}


def test_negative_or_missing_rates_read_as_low():
    assert rate_category(-1) == "low"
    assert rate_category(None) == "low"


def test_rate_category_is_independent_of_risk():
    # The scoring service exposes both, and they must be allowed to disagree:
    # a fast rate in a low-consequence place is high corrosion, normal risk.
    from backend.ml import get_service
    svc = get_service()
    rows = svc.list_segments()
    assert all("rate_category" in r for r in rows)
    disagree = [r for r in rows if r["rate_category"] in ("high", "severe")
                and r["risk_band"] == "normal"]
    assert disagree, "expected fast-corroding but low-consequence segments in the fleet"
