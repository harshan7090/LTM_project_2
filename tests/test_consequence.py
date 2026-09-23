"""
Tests for consequence modelling and the risk product.

The one that matters most is `test_consequence_columns_are_not_model_features`.
If a consequence attribute ever becomes an input to the corrosion model, the
two halves of risk stop being independent and `risk = likelihood x
consequence` becomes circular — the model would be predicting corrosion partly
from where the pipe is. Nothing would crash; the numbers would just quietly
stop meaning what the dashboard says they mean.
"""
import math

import pytest

from src.data.preprocessing import FEATURE_COLS
from src.integrity.consequence import (
    CONSEQUENCE_COLUMNS, ConsequenceInputs, assess_consequence,
    consequence_inputs_from_row, determine_hca, potential_impact_radius_ft,
    risk_band, risk_score,
)


# --------------------------------------------------------------- leakage ---

def test_consequence_columns_are_not_model_features():
    overlap = set(FEATURE_COLS) & set(CONSEQUENCE_COLUMNS)
    assert overlap == set(), (
        f"Consequence attributes leaked into the corrosion model: {overlap}. "
        f"Risk would become circular."
    )


# ------------------------------------------------------------------- PIR ---

def test_pir_matches_published_formula():
    """r = 0.69 * sqrt(p * d^2), per 49 CFR 192.903."""
    r = potential_impact_radius_ft(24.0, 1000.0, "Natural Gas")
    assert r == pytest.approx(0.69 * math.sqrt(1000.0 * 24.0 ** 2), rel=1e-9)
    assert r == pytest.approx(523.7, abs=0.5)


def test_pir_is_none_for_liquid_products():
    """PIR is a thermal-radiation concept for ignited gas. A crude oil spill
    has no impact radius, and reporting one would be a category error."""
    for product in ("Crude Oil", "Refined Products", "Produced Water"):
        assert potential_impact_radius_ft(24.0, 1000.0, product) is None


def test_pir_scales_linearly_with_diameter():
    small = potential_impact_radius_ft(12.0, 1000.0, "Natural Gas")
    large = potential_impact_radius_ft(24.0, 1000.0, "Natural Gas")
    assert large == pytest.approx(2 * small, rel=1e-9)


def test_pir_handles_zero_inputs_without_raising():
    assert potential_impact_radius_ft(0.0, 1000.0, "Natural Gas") == 0.0
    assert potential_impact_radius_ft(24.0, 0.0, "Natural Gas") == 0.0


# ------------------------------------------------------------------- HCA ---

def test_gas_class_3_is_hca():
    inp = ConsequenceInputs("S1", product_type="Natural Gas", diameter_inches=24,
                            operating_pressure_psi=800, class_location=3)
    is_hca, basis, regime = determine_hca(inp)
    assert is_hca
    assert "192" in regime
    assert any("Class 3" in b for b in basis)


def test_gas_class_1_with_no_nearby_site_is_not_hca():
    inp = ConsequenceInputs("S1", product_type="Natural Gas", diameter_inches=6,
                            operating_pressure_psi=200, class_location=1)
    is_hca, _, _ = determine_hca(inp)
    assert not is_hca


def test_liquid_drinking_water_is_hca_even_in_class_1():
    """The two regimes genuinely differ. Applying the gas class-location test
    to a liquid line would miss this segment entirely."""
    inp = ConsequenceInputs("S1", product_type="Crude Oil", diameter_inches=12,
                            operating_pressure_psi=600, class_location=1,
                            drinking_water_source=True)
    is_hca, basis, regime = determine_hca(inp)
    assert is_hca
    assert "195" in regime
    assert any("drinking water" in b for b in basis)


def test_gas_drinking_water_alone_does_not_trigger_the_gas_rule():
    """Symmetry check on the above: 192.903 keys off class location and the
    impact radius, not off water crossings."""
    inp = ConsequenceInputs("S1", product_type="Natural Gas", diameter_inches=6,
                            operating_pressure_psi=150, class_location=1,
                            drinking_water_source=True)
    is_hca, _, _ = determine_hca(inp)
    assert not is_hca


def test_occupied_site_within_pir_makes_gas_segment_hca():
    inp = ConsequenceInputs("S1", product_type="Natural Gas", diameter_inches=16,
                            operating_pressure_psi=700, class_location=1,
                            occupied_site_within_pir=True)
    is_hca, basis, _ = determine_hca(inp)
    assert is_hca
    assert any("identified site" in b for b in basis)


# ----------------------------------------------------------- consequence ---

def test_consequence_score_stays_in_range():
    worst = ConsequenceInputs("S1", product_type="Natural Gas", diameter_inches=48,
                              operating_pressure_psi=1440, class_location=4,
                              drinking_water_source=True,
                              environmentally_sensitive=True,
                              navigable_waterway=True,
                              occupied_site_within_pir=True)
    best = ConsequenceInputs("S2", product_type="Produced Water",
                             diameter_inches=4, operating_pressure_psi=200,
                             class_location=1)
    assert 0.0 <= assess_consequence(best).consequence_score <= 100.0
    assert 0.0 <= assess_consequence(worst).consequence_score <= 100.0
    assert (assess_consequence(worst).consequence_score
            > assess_consequence(best).consequence_score)


def test_higher_class_location_raises_consequence():
    def score(cls):
        return assess_consequence(ConsequenceInputs(
            "S", product_type="Crude Oil", diameter_inches=12,
            operating_pressure_psi=600, class_location=cls)).consequence_score

    assert score(1) < score(2) < score(3) < score(4)


def test_consequence_band_thresholds_are_ordered():
    low = assess_consequence(ConsequenceInputs(
        "S", product_type="Produced Water", diameter_inches=4,
        operating_pressure_psi=200, class_location=1))
    high = assess_consequence(ConsequenceInputs(
        "S", product_type="Natural Gas", diameter_inches=42,
        operating_pressure_psi=1400, class_location=4,
        drinking_water_source=True, environmentally_sensitive=True))
    assert low.consequence_band == "low"
    assert high.consequence_band == "high"


def test_hca_appears_first_in_drivers():
    """Ordering is not cosmetic — the UI shows the first driver as the headline
    reason, and HCA status outranks any individual contributing factor."""
    a = assess_consequence(ConsequenceInputs(
        "S", product_type="Crude Oil", diameter_inches=20,
        operating_pressure_psi=900, class_location=3,
        drinking_water_source=True))
    assert a.is_hca
    assert a.drivers[0] == "In a High Consequence Area"


# ------------------------------------------------------------------ risk ---

def test_risk_is_the_product_of_both_halves():
    assert risk_score(0.5, 40.0, is_hca=False) == pytest.approx(20.0)
    assert risk_score(1.0, 80.0, is_hca=False) == pytest.approx(80.0)
    assert risk_score(0.0, 100.0, is_hca=False) == pytest.approx(0.0)


def test_zero_consequence_gives_zero_risk_however_fast_the_corrosion():
    assert risk_score(1.0, 0.0) == pytest.approx(0.0)


def test_hca_multiplier_raises_risk():
    assert risk_score(0.5, 40.0, is_hca=True) > risk_score(0.5, 40.0, is_hca=False)


def test_risk_score_is_clamped_to_100():
    assert risk_score(1.0, 100.0, is_hca=True) == pytest.approx(100.0)


def test_risk_inputs_are_clamped_not_trusted():
    """Defensive: a likelihood percentile outside 0-1 would otherwise produce a
    negative or runaway risk score that still renders as a number."""
    assert risk_score(-5.0, 50.0) == pytest.approx(0.0)
    assert risk_score(99.0, 50.0) == pytest.approx(50.0)


def test_low_likelihood_high_consequence_can_outrank_the_reverse():
    """The behavioural claim consequence modelling is built on."""
    slow_but_exposed = risk_score(0.55, 90.0, is_hca=True)
    fast_but_remote = risk_score(0.99, 15.0, is_hca=False)
    assert slow_but_exposed > fast_but_remote


def test_risk_band_thresholds():
    assert risk_band(90.0) == "critical"
    assert risk_band(40.0) == "elevated"
    assert risk_band(5.0) == "normal"


# ------------------------------------------------------------- row adapter --

def test_inputs_from_row_tolerates_missing_columns():
    """The adapter is the seam where real GIS data would arrive. It must not
    explode on a dataset built before the consequence columns existed."""
    inp = consequence_inputs_from_row({"segment_id": "SEG-1"})
    assert inp.segment_id == "SEG-1"
    assert inp.class_location == 1
    assert inp.drinking_water_source is False


def test_inputs_from_row_reads_a_full_row():
    inp = consequence_inputs_from_row({
        "segment_id": "SEG-9", "product_type": "Natural Gas",
        "diameter_inches": 30, "operating_pressure_psi": 1200,
        "class_location": 3, "drinking_water_source": True,
        "environmentally_sensitive": False, "navigable_waterway": True,
        "occupied_site_within_pir": True,
    })
    assert inp.class_location == 3
    assert inp.navigable_waterway is True
    assert assess_consequence(inp).is_hca
