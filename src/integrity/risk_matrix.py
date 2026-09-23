"""
The 5x5 risk matrix.

WHY THIS AND NOT FOUR STAT TILES

  Every integrity department already has one of these, usually printed and
  on a wall. It is the canonical artefact of the discipline: likelihood up
  the side, consequence along the bottom, and the cell an asset lands in
  decides what happens to it. API 1160 and ASME B31.8S both describe risk
  assessment in these terms.

  Four coloured tiles reading "118 critical / 623 elevated" come from an
  admin template and tell an engineer nothing they cannot get from sorting a
  column. A populated matrix tells them the SHAPE of the fleet's risk in one
  glance - whether the exposure is a few catastrophic-consequence segments
  or a broad band of moderate ones, which are completely different problems
  with completely different responses.

BANDING, AND WHY THE BINS ARE NOT QUINTILES

  The obvious implementation gives each likelihood level 20% of the fleet.
  That is wrong, and wrong in a way that looks fine: it guarantees the top
  row always holds a thousand segments, so the matrix can never show you a
  fleet in good condition. Real likelihood distributions are heavily skewed
  toward the low end, and the matrix has to be able to say so.

  So the likelihood bins are fixed percentile bands with a deliberately
  narrow top - level 5 is the worst 3% - and the consequence bins are fixed
  score thresholds, not distribution-relative. Both mean the matrix is
  comparable between runs: a cell getting busier actually means something.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Likelihood level from the fleet percentile rank of the predicted rate.
# Upper bound of each level, exclusive of the next.
LIKELIHOOD_BINS = (0.50, 0.75, 0.90, 0.97, 1.01)
LIKELIHOOD_LABELS = ("Rare", "Unlikely", "Possible", "Likely", "Almost certain")

# Consequence level from the 0-100 consequence score. Fixed thresholds, so
# the axis means the same thing on every run.
CONSEQUENCE_BINS = (20.0, 35.0, 55.0, 75.0, 1e9)
CONSEQUENCE_LABELS = ("Negligible", "Minor", "Moderate", "Major", "Severe")

# Cell band from the product L x C, 1..25. The thresholds are the usual
# quadrant split used in 5x5 matrices: the top-right corner is intolerable,
# the bottom-left is broadly acceptable.
BAND_THRESHOLDS = ((4, "low"), (9, "moderate"), (14, "high"), (25, "severe"))


def likelihood_level(percentile: float) -> int:
    """1-5 from a 0-1 fleet percentile rank."""
    for i, upper in enumerate(LIKELIHOOD_BINS, start=1):
        if percentile < upper:
            return i
    return 5


def consequence_level(score: float) -> int:
    """1-5 from a 0-100 consequence score."""
    for i, upper in enumerate(CONSEQUENCE_BINS, start=1):
        if score < upper:
            return i
    return 5


def cell_band(likelihood: int, consequence: int) -> str:
    product = likelihood * consequence
    for threshold, band in BAND_THRESHOLDS:
        if product <= threshold:
            return band
    return "severe"


@dataclass
class Cell:
    likelihood: int          # 1-5, row
    consequence: int         # 1-5, column
    count: int = 0
    band: str = "low"
    # A sample, not the whole set. A single cell can hold two thousand
    # segments and the matrix only needs enough to drive a click-through.
    sample_ids: list[str] = field(default_factory=list)
    hca_count: int = 0

    def to_dict(self) -> dict:
        return {
            "likelihood": self.likelihood,
            "consequence": self.consequence,
            "count": self.count,
            "band": self.band,
            "sample_ids": self.sample_ids,
            "hca_count": self.hca_count,
        }


SAMPLE_PER_CELL = 40


def build_matrix(rows) -> dict:
    """Build the 5x5 from an iterable of segment dicts.

    Each row needs `likelihood_pct`, `consequence_score`, `segment_id` and
    `is_hca`. Returns a dense 25-cell grid - empty cells included, because
    an empty cell is information: it says the fleet has nothing in that
    combination, and a sparse grid that silently omits them would read as a
    rendering bug.
    """
    grid: dict[tuple[int, int], Cell] = {
        (l, c): Cell(likelihood=l, consequence=c, band=cell_band(l, c))
        for l in range(1, 6) for c in range(1, 6)
    }

    total = 0
    for row in rows:
        l = likelihood_level(float(row.get("likelihood_pct", 0.0)))
        c = consequence_level(float(row.get("consequence_score", 0.0)))
        cell = grid[(l, c)]
        cell.count += 1
        if row.get("is_hca"):
            cell.hca_count += 1
        if len(cell.sample_ids) < SAMPLE_PER_CELL:
            cell.sample_ids.append(str(row.get("segment_id", "")))
        total += 1

    cells = [grid[(l, c)].to_dict() for l in range(5, 0, -1) for c in range(1, 6)]
    by_band: dict[str, int] = {}
    for cell in grid.values():
        by_band[cell.band] = by_band.get(cell.band, 0) + cell.count

    return {
        "cells": cells,                       # row-major, likelihood 5 -> 1
        "likelihood_labels": list(LIKELIHOOD_LABELS),
        "consequence_labels": list(CONSEQUENCE_LABELS),
        "band_counts": by_band,
        "total": total,
        "max_cell": max((c.count for c in grid.values()), default=0),
    }
