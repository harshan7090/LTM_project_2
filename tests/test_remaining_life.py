"""
Tests for pressure design, remaining life and B31G.

Two classes of bug these exist to catch:

  Unit errors. The dataset mixes millimetres, inches, psi and mils per year.
  A wrong conversion does not raise — it produces a confident number that is
  off by 25.4, which is exactly the kind of thing that survives review.

  Domain errors in B31G. The Folias factor's quadratic form goes negative for
  large z, so the two-branch definition is load-bearing rather than a nicety.
"""
import math

import pytest

from src.integrity.remaining_life import (
    DEFAULT_JOINT_FACTOR, DEFAULT_TEMP_FACTOR, SMYS_PSI, assess_from_row,
    assess_remaining_life, design_factor, folias_factor, inches_to_mm,
    min_required_wall_in, mm_to_inches, modified_b31g_failure_pressure_psi,
    mpy_to_inches_per_year, pressure_for_wall_psi,
)


# ------------------------------------------------------------------ units --

def test_mm_inch_round_trip():
    assert inches_to_mm(mm_to_inches(12.7)) == pytest.approx(12.7)
    assert mm_to_inches(25.4) == pytest.approx(1.0)


def test_mils_per_year_is_thousandths_of_an_inch():
    """12 mpy is 0.012 in/yr, not 12 in/yr and not 0.3 mm/yr by accident."""
    assert mpy_to_inches_per_year(12.0) == pytest.approx(0.012)
    assert mpy_to_inches_per_year(1000.0) == pytest.approx(1.0)


# -------------------------------------------------------- pressure design --

def test_barlow_round_trip():
    """t_min for a pressure, then the pressure that wall supports, returns the
    original pressure. Guards the rearrangement of the two forms."""
    smys, d, f, p = 52000.0, 24.0, 0.72, 1000.0
    t = min_required_wall_in(p, d, smys, f)
    back = pressure_for_wall_psi(t, d, smys, f)
    assert back == pytest.approx(p, rel=1e-9)


def test_min_wall_matches_hand_calculation():
    # (1000 * 24) / (2 * 52000 * 0.72) = 0.32051 in
    t = min_required_wall_in(1000.0, 24.0, 52000.0, 0.72,
                             DEFAULT_JOINT_FACTOR, DEFAULT_TEMP_FACTOR)
    assert t == pytest.approx(0.32051, abs=1e-5)


def test_higher_grade_needs_less_wall():
    thin = min_required_wall_in(1000.0, 24.0, SMYS_PSI["X70"], 0.72)
    thick = min_required_wall_in(1000.0, 24.0, SMYS_PSI["Grade B"], 0.72)
    assert thin < thick


def test_design_factor_follows_class_location_for_gas():
    """B31.8 Table 841.1.6-1 — a Class 4 location gets a much lower factor,
    which means a thicker required wall for the same pressure."""
    assert design_factor("Natural Gas", 1) == 0.72
    assert design_factor("Natural Gas", 2) == 0.60
    assert design_factor("Natural Gas", 3) == 0.50
    assert design_factor("Natural Gas", 4) == 0.40


def test_liquid_uses_a_single_design_factor():
    """B31.4 does not use the class-location table."""
    assert design_factor("Crude Oil", 1) == design_factor("Crude Oil", 4) == 0.72


def test_class_4_gas_requires_more_wall_than_class_1():
    t1 = min_required_wall_in(1000.0, 24.0, 52000.0, design_factor("Natural Gas", 1))
    t4 = min_required_wall_in(1000.0, 24.0, 52000.0, design_factor("Natural Gas", 4))
    assert t4 > t1


def test_zero_diameter_does_not_divide_by_zero():
    assert min_required_wall_in(1000.0, 0.0, 52000.0, 0.72) == 0.0
    assert pressure_for_wall_psi(0.3, 0.0, 52000.0, 0.72) == 0.0


# ------------------------------------------------------------------ B31G --

def test_folias_matches_hand_calculation_below_the_branch():
    # z = 4^2 / (24 * 0.3) = 2.2222
    m = folias_factor(4.0, 24.0, 0.3)
    z = 16.0 / 7.2
    assert m == pytest.approx(math.sqrt(1 + 0.6275 * z - 0.003375 * z * z), rel=1e-9)


def test_folias_uses_the_linear_branch_above_z_50():
    """The quadratic under the root turns over and goes negative for large z.
    Without the second branch this is a math domain error, not a conservative
    answer."""
    long_defect = 60.0   # z well above 50 for these dimensions
    m = folias_factor(long_defect, 24.0, 0.3)
    assert math.isfinite(m)
    assert m > 3.3


def test_folias_is_monotonic_in_defect_length():
    short = folias_factor(2.0, 24.0, 0.3)
    mid = folias_factor(10.0, 24.0, 0.3)
    long = folias_factor(40.0, 24.0, 0.3)
    assert short < mid < long


def test_deeper_defect_lowers_failure_pressure():
    base = dict(length_in=6.0, wall_in=0.40, diameter_in=24.0, smys_psi=52000.0)
    shallow = modified_b31g_failure_pressure_psi(depth_in=0.05, **base)
    deep = modified_b31g_failure_pressure_psi(depth_in=0.25, **base)
    assert deep < shallow


def test_longer_defect_lowers_failure_pressure():
    base = dict(depth_in=0.15, wall_in=0.40, diameter_in=24.0, smys_psi=52000.0)
    short = modified_b31g_failure_pressure_psi(length_in=2.0, **base)
    long = modified_b31g_failure_pressure_psi(length_in=20.0, **base)
    assert long < short


def test_b31g_refuses_past_80_percent_wall_loss():
    """B31G is not valid there. Returning a number would invite someone to
    operate on it; a defect that deep is a repair, not a calculation."""
    p = modified_b31g_failure_pressure_psi(
        depth_in=0.35, length_in=6.0, wall_in=0.40,
        diameter_in=24.0, smys_psi=52000.0)
    assert p == 0.0


def test_undamaged_pipe_failure_pressure_approaches_flow_stress_form():
    """With a negligible defect, P_f -> 2 * S_flow * t / D."""
    t, d, smys = 0.40, 24.0, 52000.0
    p = modified_b31g_failure_pressure_psi(1e-9, 1e-6, t, d, smys)
    assert p == pytest.approx(2 * (smys + 10000.0) * t / d, rel=1e-3)


# -------------------------------------------------------- remaining life --

def _steel(**kw):
    base = dict(segment_id="SEG-1", wall_thickness_mm=12.0, diameter_inches=24.0,
                operating_pressure_psi=800.0, corrosion_rate_mpy=10.0,
                material="Carbon Steel", product_type="Crude Oil",
                class_location=1, grade="X52")
    base.update(kw)
    return assess_remaining_life(**base)


def test_remaining_life_is_allowance_over_rate():
    a = _steel()
    expected = a.corrosion_allowance_in / mpy_to_inches_per_year(10.0)
    assert a.remaining_life_years == pytest.approx(expected, rel=1e-9)


def test_doubling_the_rate_halves_remaining_life():
    slow = _steel(corrosion_rate_mpy=5.0)
    fast = _steel(corrosion_rate_mpy=10.0)
    assert fast.remaining_life_years == pytest.approx(slow.remaining_life_years / 2, rel=1e-9)


def test_half_life_is_half_the_remaining_life():
    a = _steel()
    assert a.half_life_years == pytest.approx(a.remaining_life_years / 2, rel=1e-9)


def test_hdpe_is_refused_rather_than_given_a_meaningless_number():
    a = _steel(material="HDPE")
    assert a.applicable is False
    assert a.remaining_life_years is None
    assert "HDPE" in a.reason


def test_zero_corrosion_rate_gives_no_projection_not_infinity():
    a = _steel(corrosion_rate_mpy=0.0)
    assert a.remaining_life_years is None
    assert any("zero or negative" in n for n in a.notes)


def test_wall_already_below_minimum_is_repair_now():
    a = _steel(wall_thickness_mm=3.0, operating_pressure_psi=1400.0)
    assert a.corrosion_allowance_in == 0.0
    assert a.remaining_life_years == 0.0
    assert a.verdict == "repair_now"


def test_erf_above_one_forces_repair_now():
    """ERF >= 1 means operating pressure has met or passed the pressure the
    present wall safely supports — an industry-standard repair trigger."""
    a = _steel(wall_thickness_mm=8.0, operating_pressure_psi=1440.0, grade="Grade B")
    assert a.erf is not None and a.erf >= 1.0
    assert a.verdict == "repair_now"


def test_thick_wall_low_pressure_is_monitor():
    a = _steel(wall_thickness_mm=25.0, operating_pressure_psi=300.0,
               corrosion_rate_mpy=0.5)
    assert a.verdict == "monitor"
    assert a.erf is not None and a.erf < 1.0


def test_verdict_severity_is_ordered_by_remaining_life():
    near = _steel(wall_thickness_mm=9.0, corrosion_rate_mpy=40.0)
    far = _steel(wall_thickness_mm=20.0, corrosion_rate_mpy=1.0)
    assert near.remaining_life_years < far.remaining_life_years
    assert near.verdict in ("repair_now", "plan_repair", "derate")
    assert far.verdict == "monitor"


def test_to_dict_reports_both_unit_systems():
    """The source record is metric; the calculation is imperial. Reporting
    only one forces the reader to convert, which is where errors come from."""
    d = _steel().to_dict()
    assert d["current_wall_mm"] == pytest.approx(12.0, abs=0.01)
    assert d["current_wall_in"] == pytest.approx(mm_to_inches(12.0), abs=1e-4)


def test_gas_in_class_4_needs_more_wall_than_liquid_at_same_pressure():
    gas = _steel(product_type="Natural Gas", class_location=4)
    liquid = _steel(product_type="Crude Oil", class_location=4)
    assert gas.min_required_wall_in > liquid.min_required_wall_in
    assert gas.remaining_life_years < liquid.remaining_life_years


def test_assess_from_row_reads_grade_and_class_location():
    row = {
        "segment_id": "SEG-7", "wall_thickness_mm": 14.0, "diameter_inches": 30,
        "operating_pressure_psi": 900, "material": "Carbon Steel",
        "product_type": "Natural Gas", "pipe_grade": "X65", "class_location": 3,
    }
    a = assess_from_row(row, corrosion_rate_mpy=8.0)
    assert a.grade == "X65"
    assert a.design_factor == 0.50
    assert a.applicable


def test_assess_from_row_falls_back_when_grade_is_blank():
    """HDPE rows carry an empty grade, and so would any pre-existing dataset."""
    row = {"segment_id": "SEG-8", "wall_thickness_mm": 10.0, "diameter_inches": 12,
           "operating_pressure_psi": 500, "material": "Carbon Steel",
           "product_type": "Crude Oil", "pipe_grade": ""}
    a = assess_from_row(row, corrosion_rate_mpy=5.0)
    assert a.grade in SMYS_PSI
