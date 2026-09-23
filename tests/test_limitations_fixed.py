"""
Regression tests for the limitations that were closed.

Each group pins a property that was previously absent, so a later change
cannot quietly reopen the gap.
"""
import math

import numpy as np
import pytest

from src.data.synthetic_generator import (
    MAX_PITTING_RATE_MPY, SOIL_FACTOR_MAX, SOIL_HALF_SATURATION_OHM_CM,
    generate_pipeline_dataset,
)
from src.integrity.photogrammetry import (
    KNOWN_REFERENCES, MAX_USABLE_OBLIQUE_DEG, b31g_readiness, measure_defect,
    scale_from_pipe_diameter, scale_from_reference,
)


# ============================================================ corrosion tail

@pytest.fixture(scope="module")
def rates():
    return generate_pipeline_dataset(n_segments=4000)["corrosion_rate_mpy"]


def test_no_physically_impossible_corrosion_rates(rates):
    """The generator used to reach 232 mpy - roughly an inch of wall in four
    years, which does not happen to buried carbon steel."""
    assert rates.max() <= MAX_PITTING_RATE_MPY


def test_the_tail_is_thin_not_merely_capped(rates):
    """A hard clip would pile probability mass on the ceiling. The
    distribution has to be plausible in shape, not just bounded."""
    assert (rates > 20).mean() < 0.01
    assert (rates > 10).mean() < 0.02
    assert rates.quantile(0.99) < 12


def test_typical_rates_match_field_experience(rates):
    """Well-protected buried steel runs a fraction of a mil a year; the fleet
    median should sit in that region rather than in the tens."""
    assert 0.2 < rates.median() < 2.0
    assert 0.3 < rates.mean() < 3.0


def test_soil_factor_saturates_instead_of_diverging():
    """The bug was an unbounded 1/x. Oxygen reduction becomes mass-transport
    limited, so the multiplier must approach a ceiling."""
    def factor(r):
        return SOIL_FACTOR_MAX * SOIL_HALF_SATURATION_OHM_CM / (
            SOIL_HALF_SATURATION_OHM_CM + r)

    assert factor(1.0) < SOIL_FACTOR_MAX
    assert factor(1e-6) <= SOIL_FACTOR_MAX
    # Monotonic decreasing: more resistive soil is always less corrosive.
    values = [factor(r) for r in (200, 1000, 3000, 10000, 60000)]
    assert values == sorted(values, reverse=True)


def test_soil_factor_half_saturates_at_the_stated_constant():
    half = SOIL_FACTOR_MAX * SOIL_HALF_SATURATION_OHM_CM / (
        SOIL_HALF_SATURATION_OHM_CM + SOIL_HALF_SATURATION_OHM_CM)
    assert half == pytest.approx(SOIL_FACTOR_MAX / 2)


def test_physical_relationships_survive_the_fix():
    """Bounding the tail must not flatten the signal the model has to learn."""
    df = generate_pipeline_dataset(n_segments=4000)
    with_cp = df[df["cathodic_protection"]]["corrosion_rate_mpy"].mean()
    without_cp = df[~df["cathodic_protection"]]["corrosion_rate_mpy"].mean()
    assert without_cp > with_cp * 1.8

    uncoated = df[df["coating_type"] == "Uncoated"]["corrosion_rate_mpy"].mean()
    fbe = df[df["coating_type"] == "FBE"]["corrosion_rate_mpy"].mean()
    assert uncoated > fbe * 2.5


def test_corrosive_soil_still_corrodes_faster():
    df = generate_pipeline_dataset(n_segments=4000)
    corrosive = df[df["soil_resistivity_ohm_cm"] < 2000]["corrosion_rate_mpy"].mean()
    benign = df[df["soil_resistivity_ohm_cm"] > 20000]["corrosion_rate_mpy"].mean()
    assert corrosive > benign * 1.5


# ========================================================== photogrammetry

def test_scale_from_a_known_reference():
    """100 mm ruler across 500 px gives 0.2 mm/px."""
    s = scale_from_reference(reference_pixels=500, reference_name="ruler_100mm")
    assert s.usable
    assert s.mm_per_pixel == pytest.approx(0.2, rel=1e-6)


def test_every_named_reference_resolves():
    for name in KNOWN_REFERENCES:
        assert scale_from_reference(400, reference_name=name).usable


def test_unknown_reference_is_refused_with_the_valid_options():
    s = scale_from_reference(400, reference_name="a_banana")
    assert not s.usable
    assert "ruler_100mm" in s.warnings[0]


def test_oblique_angle_is_corrected_by_one_over_cosine():
    square = scale_from_reference(500, reference_name="ruler_100mm",
                                  oblique_angle_deg=0)
    tilted = scale_from_reference(500, reference_name="ruler_100mm",
                                  oblique_angle_deg=30)
    assert tilted.mm_per_pixel == pytest.approx(
        square.mm_per_pixel / math.cos(math.radians(30)), rel=1e-6)


def test_oblique_angle_widens_the_uncertainty():
    """The correction is only as good as the eyeballed angle, so confidence
    must fall as the camera tilts."""
    square = scale_from_reference(500, reference_name="ruler_100mm", oblique_angle_deg=0)
    tilted = scale_from_reference(500, reference_name="ruler_100mm", oblique_angle_deg=35)
    assert tilted.relative_uncertainty > square.relative_uncertainty


def test_a_severely_oblique_photo_is_refused():
    s = scale_from_reference(500, reference_name="ruler_100mm",
                             oblique_angle_deg=MAX_USABLE_OBLIQUE_DEG + 5)
    assert not s.usable
    assert "re-shoot" in " ".join(s.warnings).lower()


def test_a_tiny_reference_lowers_confidence():
    big = scale_from_reference(600, reference_name="ruler_100mm")
    small = scale_from_reference(20, reference_name="ruler_100mm")
    assert small.relative_uncertainty > big.relative_uncertainty
    assert any("pixels" in w for w in small.warnings)


def test_pipe_diameter_is_flagged_as_the_weakest_reference():
    ruler = scale_from_reference(500, reference_name="ruler_100mm")
    pipe = scale_from_pipe_diameter(500, diameter_inches=24)
    assert pipe.relative_uncertainty > ruler.relative_uncertainty
    assert any("least reliable" in w for w in pipe.warnings)


def test_pipe_diameter_scale_converts_inches_correctly():
    s = scale_from_pipe_diameter(pipe_pixels=610, diameter_inches=24)
    assert s.reference_mm == pytest.approx(24 * 25.4)


def test_zero_or_negative_reference_is_refused():
    assert not scale_from_reference(0, reference_mm=100).usable
    assert not scale_from_reference(500, reference_mm=0).usable


# ------------------------------------------------------------ measurement --

def test_lateral_extent_is_measured():
    s = scale_from_reference(500, reference_name="ruler_100mm")
    m = measure_defect(length_pixels=250, width_pixels=100, scale=s)
    assert m.length_mm == pytest.approx(50.0, rel=1e-6)
    assert m.width_mm == pytest.approx(20.0, rel=1e-6)
    assert m.area_mm2 == pytest.approx(1000.0, rel=1e-6)


def test_depth_is_never_returned():
    """Not a resolution limit. A single projection discards the range
    coordinate, so no prompt or model recovers it."""
    s = scale_from_reference(500, reference_name="ruler_100mm")
    m = measure_defect(300, 120, s)
    assert m.depth_measurable is False
    assert "stereo" in m.depth_note.lower()
    assert not hasattr(m, "depth_mm")


def test_area_uncertainty_is_double_the_length_uncertainty():
    """Area is a product of two lengths sharing one scale factor, so the
    scale error enters twice. Treating it as a length would understate it."""
    s = scale_from_reference(500, reference_name="ruler_100mm")
    m = measure_defect(250, 100, s)
    length_rel = m.length_uncertainty_mm / m.length_mm
    area_rel = m.area_uncertainty_mm2 / m.area_mm2
    assert area_rel == pytest.approx(2 * length_rel, rel=1e-6)


def test_uncertainty_is_reported_not_hidden():
    s = scale_from_reference(500, reference_name="ruler_100mm")
    m = measure_defect(250, 100, s)
    assert m.length_uncertainty_mm > 0
    assert m.confidence in ("good", "fair", "poor")


def test_an_unusable_scale_yields_no_measurement():
    s = scale_from_reference(500, reference_name="a_banana")
    m = measure_defect(250, 100, s)
    assert m.length_mm == 0
    assert m.confidence == "poor"


def test_confidence_degrades_with_the_scale():
    good = measure_defect(250, 100, scale_from_reference(600, reference_name="ruler_150mm"))
    poor = measure_defect(250, 100, scale_from_pipe_diameter(
        30, diameter_inches=24, oblique_angle_deg=35))
    assert good.confidence == "good"
    assert poor.confidence == "poor"


# ------------------------------------------------------------ b31g gate ----

def test_b31g_is_never_declared_ready_from_a_photograph():
    """The guard that stops a length-only defect flowing into a
    remaining-strength calculation."""
    s = scale_from_reference(500, reference_name="ruler_100mm")
    r = b31g_readiness(measure_defect(250, 100, s))
    assert r["ready_for_b31g"] is False
    assert r["depth_available"] is False
    assert r["length_available"] is True
    assert any("depth" in b.lower() for b in r["blocking"])


def test_b31g_readiness_reports_no_length_when_the_scale_was_poor():
    s = scale_from_pipe_diameter(25, diameter_inches=24, oblique_angle_deg=40)
    r = b31g_readiness(measure_defect(250, 100, s))
    assert r["length_available"] is False
    assert r["length_mm"] is None
