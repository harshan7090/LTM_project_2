"""
How bad is a corrosion rate, on its own?

The console shows three different things about a segment, and they answer
three different questions:

  corrosion rate category   how fast is this pipe losing wall?   (this module)
  likelihood band           how does that rate rank in the fleet? (percentile)
  risk band                 how much does it matter, given WHERE it is?
                            (likelihood x consequence, see consequence.py)

They disagree on purpose. A segment can corrode fast ("high" here) and still
be low risk because a failure there would harm almost no one; another can
corrode slowly and top the register because it runs under a town. Showing
the risk band next to the rate made a 9.29 mpy segment read as "normal",
which is exactly the confusion this module exists to remove.

THE SCALE

  NACE SP0775 (formerly RP0775), Table 2: the qualitative categorisation of
  carbon-steel corrosion rates used across oil and gas operations.

      average (general) corrosion rate
        low        < 1.0 mpy      (< 0.025 mm/y)
        moderate   1.0 - 4.9 mpy  (0.025 - 0.12 mm/y)
        high       5.0 - 10 mpy   (0.13 - 0.25 mm/y)
        severe     > 10 mpy       (> 0.25 mm/y)

  The predicted rate is a segment-level average wall-loss rate, so the
  average-rate column applies, not the separate pitting-rate column.

  Lower is better: mils per year is metal lost per year. One mil is a
  thousandth of an inch (0.0254 mm).
"""
from __future__ import annotations

BASIS = "NACE SP0775 general corrosion scale"

# (exclusive upper bound in mpy, category, label, range text)
_SCALE = (
    (1.0, "low", "Low", "< 1 mpy"),
    (5.0, "moderate", "Moderate", "1-4.9 mpy"),
    (10.0, "high", "High", "5-10 mpy"),
)
_SEVERE = ("severe", "Severe", "> 10 mpy")

CATEGORIES = ("low", "moderate", "high", "severe")


def rate_category(mpy: float) -> str:
    """Category name for a corrosion rate in mils per year."""
    return classify_rate(mpy)["category"]


def classify_rate(mpy: float) -> dict:
    """The NACE SP0775 category of a corrosion rate, with its band and basis.

    The "high" band includes its upper edge (exactly 10.0 mpy is high, not
    severe), matching the table's "5.0-10" wording.
    """
    rate = max(float(mpy or 0.0), 0.0)
    for upper, category, label, band in _SCALE:
        inclusive = category == "high"
        if rate < upper or (inclusive and rate == upper):
            return {"category": category, "label": label, "range": band, "basis": BASIS}
    category, label, band = _SEVERE
    return {"category": category, "label": label, "range": band, "basis": BASIS}
