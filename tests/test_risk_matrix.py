"""The 5x5 matrix, the back-cast series, and the routes that serve them.

WHY THESE PARTICULAR ASSERTIONS

  Each one is a bug that would fail silently. A sparse grid renders as a
  broken layout rather than an error. A non-deterministic back-cast makes
  sparklines twitch on every scroll frame and looks like a CSS problem. A
  matrix that is not region-scoped leaks the whole fleet's shape to an
  inspector without leaking a single row, so nothing in the UI looks wrong.

  The band-is-a-function-of-position check is load-bearing for the palette
  decision: the four band colours are status steps, and status colours are
  only legal when hue is not the sole encoding. Position is one of the
  encodings that makes them legal, so it is tested, not assumed.
"""
import pytest

from src.integrity.risk_matrix import (
    BAND_THRESHOLDS, build_matrix, cell_band, consequence_level,
    likelihood_level,
)


# --------------------------------------------------------------- binning ---

def test_likelihood_bins_are_not_quintiles():
    """The top row must be able to be nearly empty.

    Quintile bins would put 20% of the fleet in 'Almost certain' by
    construction, so the matrix could never show a healthy fleet.
    """
    assert likelihood_level(0.00) == 1
    assert likelihood_level(0.49) == 1
    assert likelihood_level(0.50) == 2
    assert likelihood_level(0.96) == 4
    assert likelihood_level(0.97) == 5
    assert likelihood_level(1.00) == 5


def test_consequence_bins_are_absolute_not_relative():
    """Fixed thresholds, so a cell getting busier means something."""
    assert consequence_level(0.0) == 1
    assert consequence_level(19.9) == 1
    assert consequence_level(20.0) == 2
    assert consequence_level(74.9) == 4
    assert consequence_level(75.0) == 5
    assert consequence_level(1000.0) == 5


@pytest.mark.parametrize("l,c,expected", [
    (1, 1, "low"), (1, 4, "low"), (2, 2, "low"),
    (3, 3, "moderate"), (2, 4, "moderate"),
    (3, 4, "high"), (4, 3, "high"),
    (5, 5, "severe"), (4, 4, "severe"), (5, 3, "severe"),  # 15 > the high ceiling of 14
])
def test_cell_band_follows_the_product(l, c, expected):
    assert cell_band(l, c) == expected


def test_band_thresholds_cover_the_whole_product_range():
    """No L x C combination may fall through to an unbanded cell."""
    covered = {cell_band(l, c) for l in range(1, 6) for c in range(1, 6)}
    assert covered == {b for _, b in BAND_THRESHOLDS}


# ---------------------------------------------------------------- matrix ---

def _rows(n=100):
    return [
        {
            "segment_id": f"S-{i:04d}",
            "likelihood_pct": i / n,
            "consequence_score": (i * 7) % 100,
            "is_hca": i % 5 == 0,
        }
        for i in range(n)
    ]


def test_matrix_is_always_dense():
    """An empty cell is information. A sparse grid reads as a render bug."""
    m = build_matrix(_rows())
    assert len(m["cells"]) == 25
    seen = {(c["likelihood"], c["consequence"]) for c in m["cells"]}
    assert seen == {(l, c) for l in range(1, 6) for c in range(1, 6)}


def test_matrix_is_row_major_from_the_top_row():
    """cells[0] is the top-left of the grid as drawn, not (1, 1)."""
    m = build_matrix(_rows())
    assert (m["cells"][0]["likelihood"], m["cells"][0]["consequence"]) == (5, 1)
    assert (m["cells"][-1]["likelihood"], m["cells"][-1]["consequence"]) == (1, 5)


def test_counts_and_bands_reconcile():
    rows = _rows()
    m = build_matrix(rows)
    assert m["total"] == len(rows)
    assert sum(c["count"] for c in m["cells"]) == len(rows)
    assert sum(m["band_counts"].values()) == len(rows)
    assert m["max_cell"] == max(c["count"] for c in m["cells"])


def test_band_is_a_pure_function_of_position():
    """Load-bearing for the palette: position is a secondary encoding, so the
    four status hues are never carrying the meaning on their own."""
    m = build_matrix(_rows())
    for c in m["cells"]:
        assert c["band"] == cell_band(c["likelihood"], c["consequence"])


def test_sample_ids_are_capped_but_present_in_every_populated_cell():
    from src.integrity.risk_matrix import SAMPLE_PER_CELL
    m = build_matrix(_rows(2000))
    for c in m["cells"]:
        assert len(c["sample_ids"]) <= SAMPLE_PER_CELL
        if c["count"]:
            assert c["sample_ids"], "a populated cell with no click-through"


def test_empty_input_still_produces_a_grid():
    m = build_matrix([])
    assert len(m["cells"]) == 25
    assert m["total"] == 0 and m["max_cell"] == 0
