"""
Pipe walls are designed, and remaining life counts down from the wall the
pipe has today.

These pin the fix for walls that were drawn uniformly from 5-25 mm with no
relation to diameter or pressure: 4-inch pipe with an 18 mm wall, and a
median remaining life of 420 years.
"""
import numpy as np
import pytest

import src.data.synthetic_generator as gen
from src.data.preprocessing import FEATURE_COLS
from src.integrity.remaining_life import (
    PLANNING_HORIZON_YEARS, assess_from_row, min_required_wall_in,
)


@pytest.fixture(autouse=True)
def _own_design_stream(monkeypatch):
    # The design stream is module state; tests use their own so they cannot
    # shift the walls of a dataset generated later in the same session.
    monkeypatch.setattr(gen, "DESIGN_RNG", np.random.default_rng(0))


def _design(diameters, product="Natural Gas", class_location=1, pressure=1000.0,
            material="Carbon Steel"):
    n = len(diameters)
    return gen.design_pipe(
        np.array(diameters, dtype=float), np.array([material] * n),
        np.array([product] * n), np.array([class_location] * n),
        np.full(n, pressure),
    )


def test_designed_walls_are_realistic_for_their_diameter():
    diameters = [4, 8, 12, 24, 36, 48] * 20
    _grade, wall_mm, _maop = _design(diameters)
    d_over_t = np.array(diameters) * 25.4 / wall_mm
    # Real line pipe sits roughly between D/t 15 and 100.
    assert d_over_t.min() >= 15 and d_over_t.max() <= gen.MAX_D_OVER_T + 1e-6
    small = wall_mm[np.array(diameters) == 4]
    assert small.max() <= 6.5, "a 4-inch line does not carry an 18 mm wall"


def test_designed_wall_holds_its_maop_and_is_a_standard_size():
    grade, wall_mm, maop = _design([24] * 50)
    for g, w, p in zip(grade, wall_mm, maop):
        t_min = min_required_wall_in(p, 24, gen.SMYS_PSI[g], 0.72)
        assert w / 25.4 >= t_min - 1e-9
        assert np.isclose(gen.STANDARD_WALLS_IN, w / 25.4).any()


def test_hdpe_follows_its_dimension_ratio_not_barlow():
    grade, wall_mm, _ = _design([4, 8], material="HDPE")
    assert list(grade) == ["", ""]
    assert np.allclose(wall_mm, np.array([4, 8]) / gen.HDPE_SDR * 25.4)


def test_measured_wall_never_exceeds_nominal_and_reflects_history():
    diam = np.array([12.0] * 200)
    mat = np.array(["Carbon Steel"] * 200)
    prod = np.array(["Crude Oil"] * 200)
    cls = np.array([1] * 200)
    press = np.full(200, 900.0)
    grade, nominal, _ = gen.design_pipe(diam, mat, prod, cls, press)
    young = gen.measured_wall(nominal, np.full(200, 2.0), np.full(200, 1.0),
                              mat, diam, prod, cls, press, grade)
    old = gen.measured_wall(nominal, np.full(200, 2.0), np.full(200, 40.0),
                            mat, diam, prod, cls, press, grade)
    assert (young <= nominal).all() and (old <= nominal).all()
    assert (nominal - old).mean() > (nominal - young).mean(), \
        "forty years of corrosion must remove more wall than one"


def test_measured_wall_is_not_a_model_feature():
    # It is derived from the corrosion label; as a feature it would leak it.
    assert "measured_wall_mm" not in FEATURE_COLS


def _row(**kw):
    base = dict(segment_id="T-1", diameter_inches=12.0, operating_pressure_psi=900.0,
                material="Carbon Steel", product_type="Crude Oil", class_location=1,
                pipe_grade="X52")
    base.update(kw)
    return base


def test_remaining_life_counts_down_from_the_measured_wall():
    out = assess_from_row(_row(wall_thickness_mm=10.0, measured_wall_mm=6.0), 2.0).to_dict()
    assert out["current_wall_mm"] == pytest.approx(6.0, abs=0.01)
    assert out["nominal_wall_mm"] == pytest.approx(10.0, abs=0.01)
    assert out["wall_loss_pct"] == pytest.approx(40.0, abs=0.1)


def test_a_record_without_a_measurement_falls_back_to_the_nominal_wall():
    out = assess_from_row(_row(wall_thickness_mm=8.0), 2.0).to_dict()
    assert out["current_wall_mm"] == pytest.approx(8.0, abs=0.01)
    assert out["nominal_wall_mm"] is None and out["wall_loss_pct"] is None


def test_new_pipe_designed_near_its_minimum_is_not_derated():
    # Real pipe is designed close to its Barlow minimum. Judged on margin
    # alone, brand-new pipe used to be flagged for derating.
    t_min_mm = min_required_wall_in(900.0, 12.0, 52000, 0.72) * 25.4
    wall = round(t_min_mm * 1.1, 2)
    out = assess_from_row(_row(wall_thickness_mm=wall, measured_wall_mm=wall), 0.5).to_dict()
    assert out["verdict"] != "derate"


def test_most_of_the_allowance_gone_is_a_derate():
    t_min_mm = min_required_wall_in(900.0, 12.0, 52000, 0.72) * 25.4
    nominal = t_min_mm + 4.0
    measured = t_min_mm + 0.6        # 85% of the allowance consumed
    out = assess_from_row(_row(wall_thickness_mm=nominal, measured_wall_mm=measured), 0.3).to_dict()
    assert out["verdict"] == "derate"


def test_remaining_life_past_the_horizon_is_flagged_not_hidden():
    out = assess_from_row(_row(wall_thickness_mm=12.0, measured_wall_mm=11.5), 0.2).to_dict()
    assert out["remaining_life_years"] > PLANNING_HORIZON_YEARS
    assert out["beyond_horizon"] is True
    assert out["planning_horizon_years"] == PLANNING_HORIZON_YEARS
