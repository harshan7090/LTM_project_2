"""
Remaining life, pressure design, and fitness-for-service.

WHY THIS MODULE EXISTS:

  The model predicts a corrosion RATE. Nobody acts on a rate. An integrity
  engineer acts on a date:

      "12 mils/year"            -> not a decision
      "reaches minimum allowable wall in 14 months"  -> a decision

  This module does that conversion, plus the two things that follow from it:
  what pressure the remaining wall can still safely hold, and whether the
  segment needs repair, derating, or neither.

  Everything here is closed-form, deterministic and testable — the same
  reasoning as src/integrity/inspection.py. A regulator can be shown the
  arithmetic. An LLM is not involved at any point.

STANDARDS:

  - ASME B31.8 / B31.4 pressure design (the Barlow relation) for the minimum
    allowable wall thickness and the pressure a given wall supports.
  - API 570 remaining-life convention: (t_actual - t_min) / corrosion rate.
  - ASME B31G and Modified B31G for remaining strength of corroded pipe.

  The Barlow, B31G and Modified B31G relations below are the published forms.
  Design factors follow the B31.8 class-location table. Anything that is
  judgement rather than standard is marked as such.

UNITS — read this before changing anything:

  This dataset mixes unit systems: wall thickness in MILLIMETRES, diameter in
  INCHES, pressure in PSI, corrosion rate in MILS PER YEAR. Mixed units are
  the classic silent failure in this kind of calculation — nothing raises, the
  number is just wrong by a factor of 25.4.

  So every function here works internally in INCHES and PSI, conversion
  happens once at the boundary, and parameter names carry their unit. The
  conversion helpers are exported so callers do not reinvent them.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

MM_PER_INCH = 25.4
MILS_PER_INCH = 1000.0


def mm_to_inches(mm: float) -> float:
    return mm / MM_PER_INCH


def inches_to_mm(inches: float) -> float:
    return inches * MM_PER_INCH


def mpy_to_inches_per_year(mpy: float) -> float:
    """Mils per year -> inches per year. One mil is one thousandth of an inch."""
    return mpy / MILS_PER_INCH


# ------------------------------------------------------------- material ----

# Specified Minimum Yield Strength, psi. API 5L line pipe grades.
SMYS_PSI = {
    "Grade B": 35000,
    "X42": 42000,
    "X46": 46000,
    "X52": 52000,
    "X60": 60000,
    "X65": 65000,
    "X70": 70000,
    "X80": 80000,
}
DEFAULT_GRADE = "X52"

# Materials for which this pressure-design route does not apply. HDPE is not a
# yield-strength-governed material in the B31.8 sense and does not corrode
# electrochemically; running Barlow on it would produce a confident,
# meaningless number. Better to refuse.
NON_STEEL_MATERIALS = {"HDPE"}

# B31.8 design factor F by class location (Table 841.1.6-1). Real values.
DESIGN_FACTOR_BY_CLASS = {1: 0.72, 2: 0.60, 3: 0.50, 4: 0.40}

# B31.4 (hazardous liquid) uses a single design factor rather than a
# class-location table.
LIQUID_DESIGN_FACTOR = 0.72
GAS_PRODUCTS = {"Natural Gas"}

# Longitudinal joint factor E and temperature derating factor T. Both 1.0 for
# modern seamless/ERW pipe below 250 F, which is the whole of this dataset.
DEFAULT_JOINT_FACTOR = 1.0
DEFAULT_TEMP_FACTOR = 1.0

# Below this remaining wall fraction a segment is treated as requiring
# immediate attention regardless of the arithmetic. Judgement.
CRITICAL_WALL_FRACTION = 0.20

# Estimated Repair Factor threshold. ERF >= 1.0 means the safe pressure has
# fallen to or below the operating pressure — an industry-standard trigger.
ERF_REPAIR_THRESHOLD = 1.0


@dataclass
class RemainingLifeAssessment:
    segment_id: str
    applicable: bool                      # False for non-steel
    reason: str = ""                      # why not applicable

    grade: str = ""
    smys_psi: float = 0.0
    design_factor: float = 0.0

    current_wall_in: float = 0.0
    min_required_wall_in: float = 0.0
    corrosion_allowance_in: float = 0.0   # wall available to be lost
    corrosion_rate_mpy: float = 0.0

    remaining_life_years: float | None = None
    half_life_years: float | None = None  # to 50% of the allowance
    safe_operating_pressure_psi: float = 0.0
    operating_pressure_psi: float = 0.0
    erf: float | None = None              # operating / safe pressure

    verdict: str = ""                     # monitor | plan_repair | repair_now | derate
    drivers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        for key in ("current_wall_in", "min_required_wall_in",
                    "corrosion_allowance_in"):
            d[key] = round(d[key], 4)
        for key in ("remaining_life_years", "half_life_years", "erf"):
            if d[key] is not None:
                d[key] = round(d[key], 2)
        for key in ("safe_operating_pressure_psi", "operating_pressure_psi",
                    "smys_psi"):
            d[key] = round(d[key], 0)
        # Millimetres alongside inches, because the source data is metric and
        # an engineer comparing against the record should not have to convert.
        d["current_wall_mm"] = round(inches_to_mm(self.current_wall_in), 2)
        d["min_required_wall_mm"] = round(inches_to_mm(self.min_required_wall_in), 2)
        return d


# ------------------------------------------------------ pressure design ----

def design_factor(product_type: str, class_location: int) -> float:
    """B31.8 class-location factor for gas, B31.4 single factor for liquid."""
    if product_type in GAS_PRODUCTS:
        return DESIGN_FACTOR_BY_CLASS.get(class_location, 0.72)
    return LIQUID_DESIGN_FACTOR


def min_required_wall_in(pressure_psi: float, diameter_in: float, smys_psi: float,
                         f: float, e: float = DEFAULT_JOINT_FACTOR,
                         t: float = DEFAULT_TEMP_FACTOR) -> float:
    """Minimum wall thickness for the design pressure — Barlow, rearranged.

        t_min = (P * D) / (2 * S * F * E * T)

    This is the wall the pipe must keep to remain within its design basis. It
    is the floor that remaining life counts down to, not zero: a pipe that has
    corroded to t_min is at the end of its allowance, not at the point of
    rupture.
    """
    denom = 2.0 * smys_psi * f * e * t
    if denom <= 0 or diameter_in <= 0:
        return 0.0
    return (pressure_psi * diameter_in) / denom


def pressure_for_wall_psi(wall_in: float, diameter_in: float, smys_psi: float,
                          f: float, e: float = DEFAULT_JOINT_FACTOR,
                          t: float = DEFAULT_TEMP_FACTOR) -> float:
    """The pressure a given wall thickness supports — Barlow, forward form.

        P = (2 * S * t * F * E * T) / D
    """
    if diameter_in <= 0:
        return 0.0
    return (2.0 * smys_psi * wall_in * f * e * t) / diameter_in


# --------------------------------------------------------------- B31G ------

def folias_factor(length_in: float, diameter_in: float, wall_in: float) -> float:
    """Folias bulging factor M, Modified B31G form.

        z = L^2 / (D * t)
        M = sqrt(1 + 0.6275 z - 0.003375 z^2)   for z <= 50
        M = 0.032 z + 3.3                        for z > 50

    The two-branch definition is not optional. The quadratic under the root
    turns over and goes negative for large z, so applying it beyond z = 50
    produces a domain error rather than a conservative answer.
    """
    if diameter_in <= 0 or wall_in <= 0:
        return 1.0
    z = (length_in ** 2) / (diameter_in * wall_in)
    if z <= 50.0:
        return math.sqrt(max(1.0 + 0.6275 * z - 0.003375 * z * z, 1.0))
    return 0.032 * z + 3.3


def modified_b31g_failure_pressure_psi(depth_in: float, length_in: float,
                                       wall_in: float, diameter_in: float,
                                       smys_psi: float) -> float:
    """Failure pressure of a corroded area — Modified B31G (0.85 dL area).

        S_flow = SMYS + 10,000 psi
        S_f    = S_flow * (1 - 0.85 d/t) / (1 - 0.85 d/t / M)
        P_f    = 2 * S_f * t / D

    This is the function that per-anomaly ILI data plugs into. It is
    implemented and tested now so that adding an anomaly table is a data
    change rather than a maths change — but note that NOTHING in the current
    dataset provides `depth_in` and `length_in`. They come from an ILI tally.
    """
    if wall_in <= 0 or diameter_in <= 0:
        return 0.0
    ratio = min(max(depth_in / wall_in, 0.0), 1.0)
    if ratio >= 0.8:
        # B31G is not valid past 80% wall loss; such a defect is a repair, not
        # a calculation. Returning 0 rather than a number nobody should use.
        return 0.0
    flow_stress = smys_psi + 10000.0
    m = folias_factor(length_in, diameter_in, wall_in)
    numerator = 1.0 - 0.85 * ratio
    denominator = 1.0 - (0.85 * ratio) / m
    if denominator <= 0:
        return 0.0
    return 2.0 * flow_stress * (numerator / denominator) * wall_in / diameter_in


# ----------------------------------------------------- remaining life ------

def assess_remaining_life(segment_id: str, wall_thickness_mm: float,
                          diameter_inches: float, operating_pressure_psi: float,
                          corrosion_rate_mpy: float, material: str = "Carbon Steel",
                          product_type: str = "", class_location: int = 1,
                          grade: str | None = None) -> RemainingLifeAssessment:
    """Full remaining-life assessment for one segment, uniform metal loss.

    Uniform loss rather than a discrete defect, because a segment-level
    corrosion rate is what this dataset carries. That is the honest
    interpretation of the available data: a per-anomaly assessment needs
    per-anomaly depths, which requires an ILI tally this project does not yet
    ingest.
    """
    drivers: list[str] = []
    notes: list[str] = []

    if material in NON_STEEL_MATERIALS:
        return RemainingLifeAssessment(
            segment_id=segment_id, applicable=False,
            reason=(f"{material} is not a yield-strength-governed material under "
                    f"B31.4/B31.8 and does not corrode electrochemically. "
                    f"Pressure design and remaining-life assessment for it "
                    f"follow a different route (e.g. ASTM D2513) not "
                    f"implemented here."),
            corrosion_rate_mpy=corrosion_rate_mpy,
        )

    resolved_grade = grade or DEFAULT_GRADE
    smys = SMYS_PSI.get(resolved_grade, SMYS_PSI[DEFAULT_GRADE])
    if material == "Stainless Steel":
        notes.append(
            "SMYS taken from the carbon-steel line-pipe table; stainless grades "
            "have their own allowables and this figure is indicative only."
        )

    f = design_factor(product_type, class_location)
    wall_in = mm_to_inches(wall_thickness_mm)
    t_min = min_required_wall_in(operating_pressure_psi, diameter_inches, smys, f)
    allowance = wall_in - t_min

    safe_pressure = pressure_for_wall_psi(wall_in, diameter_inches, smys, f)
    erf = (operating_pressure_psi / safe_pressure) if safe_pressure > 0 else None

    rate_in_per_year = mpy_to_inches_per_year(corrosion_rate_mpy)

    if allowance <= 0:
        remaining = 0.0
        half_life = 0.0
        drivers.append(
            f"Wall is already at or below the minimum required "
            f"({inches_to_mm(wall_in):.1f} mm vs {inches_to_mm(t_min):.1f} mm)"
        )
    elif rate_in_per_year <= 0:
        remaining = None
        half_life = None
        notes.append(
            "Predicted corrosion rate is zero or negative, so no meaningful "
            "remaining life can be projected."
        )
    else:
        remaining = allowance / rate_in_per_year
        half_life = (allowance * 0.5) / rate_in_per_year

    wall_fraction = (allowance / wall_in) if wall_in > 0 else 0.0

    # --- verdict ---------------------------------------------------------
    if erf is not None and erf >= ERF_REPAIR_THRESHOLD:
        verdict = "repair_now"
        drivers.append(
            f"ERF {erf:.2f} — operating pressure meets or exceeds the safe "
            f"pressure the present wall supports"
        )
    elif allowance <= 0:
        verdict = "repair_now"
    elif wall_fraction < CRITICAL_WALL_FRACTION:
        verdict = "derate"
        drivers.append(
            f"Only {wall_fraction*100:.0f}% of the wall remains above the "
            f"minimum required — pressure derating should be considered"
        )
    elif remaining is not None and remaining < 2.0:
        verdict = "repair_now"
        drivers.append(f"Reaches minimum allowable wall in {remaining:.1f} years")
    elif remaining is not None and remaining < 10.0:
        verdict = "plan_repair"
        drivers.append(f"Reaches minimum allowable wall in {remaining:.1f} years")
    else:
        verdict = "monitor"

    if remaining is not None and remaining > 100:
        notes.append(
            "Projected remaining life exceeds 100 years. At these rates the "
            "governing threat is unlikely to be uniform external corrosion."
        )

    notes.append(
        f"Uniform metal loss assumed at the segment-level predicted rate. A "
        f"discrete defect assessment (B31G / RSTRENG) needs per-anomaly depth "
        f"and length from an ILI tally."
    )

    return RemainingLifeAssessment(
        segment_id=segment_id,
        applicable=True,
        grade=resolved_grade,
        smys_psi=float(smys),
        design_factor=f,
        current_wall_in=wall_in,
        min_required_wall_in=t_min,
        corrosion_allowance_in=max(allowance, 0.0),
        corrosion_rate_mpy=corrosion_rate_mpy,
        remaining_life_years=remaining,
        half_life_years=half_life,
        safe_operating_pressure_psi=safe_pressure,
        operating_pressure_psi=operating_pressure_psi,
        erf=erf,
        verdict=verdict,
        drivers=drivers,
        notes=notes,
    )


def assess_from_row(row, corrosion_rate_mpy: float,
                    class_location: int = 1) -> RemainingLifeAssessment:
    """Convenience wrapper over a dataset row (pandas Series or dict)."""
    def get(key, default):
        try:
            value = row[key]
        except (KeyError, IndexError, TypeError):
            return default
        return default if value is None else value

    return assess_remaining_life(
        segment_id=str(get("segment_id", "?")),
        wall_thickness_mm=float(get("wall_thickness_mm", 0) or 0),
        diameter_inches=float(get("diameter_inches", 0) or 0),
        operating_pressure_psi=float(get("operating_pressure_psi", 0) or 0),
        corrosion_rate_mpy=float(corrosion_rate_mpy or 0),
        material=str(get("material", "Carbon Steel")),
        product_type=str(get("product_type", "")),
        class_location=int(get("class_location", class_location) or class_location),
        grade=(str(get("pipe_grade", "")) or None),
    )
