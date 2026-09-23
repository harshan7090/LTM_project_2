"""
Consequence of failure, and therefore actual risk.

WHY THIS MODULE EXISTS:

  Everything else in this project estimates LIKELIHOOD — how fast a segment is
  corroding. That is only half of risk. The industry definition, and the one
  every regulator works from, is:

      risk = likelihood of failure  x  consequence of failure

  Two segments corroding at 14 mpy are not equally urgent if one runs under
  farmland and the other crosses a drinking-water source beside a school.
  Ranking on corrosion rate alone treats them identically, which is why a
  likelihood-only tool cannot actually prioritise work.

  This is not an academic refinement. It is the organising principle of US
  pipeline regulation:

    - 49 CFR 192.903 / 195.450 define High Consequence Areas (HCAs).
    - 49 CFR 192.907 / 195.452 require operators to prioritise integrity
      assessments in them, on a shorter clock than elsewhere.
    - ASME B31.8S and API 1160 both structure integrity management around
      threat x consequence, not threat alone.

WHAT IS REAL HERE AND WHAT IS A STAND-IN:

  The Potential Impact Radius formula is the published one from 49 CFR 192.903
  and is implemented as written. The class-location concept follows 49 CFR
  192.5. The HCA decision logic follows the SHAPE of 192.903 (gas) and 195.450
  (liquid).

  The consequence WEIGHTS are engineering judgement, set in one place so an
  operator can replace them with their own risk matrix. They are not quoted
  from any standard and this module does not claim they are.

  Real HCA determination is a GIS operation against population, drinking-water
  and ecological layers. This project has no geometry — only a region label —
  so consequence attributes are carried as segment columns. Swapping in real
  HCA polygons later replaces `consequence_inputs_from_row` and nothing else.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

# --------------------------------------------------------------- tuning ----
# Operator-tunable weights. Engineering judgement, NOT standard clause values.
# They sum to 100 so the composite score reads directly as 0-100.

WEIGHT_POPULATION = 40.0      # people are the dominant consequence term
WEIGHT_DRINKING_WATER = 20.0
WEIGHT_ECOLOGICAL = 12.0
WEIGHT_NAVIGABLE_WATER = 8.0
WEIGHT_PRODUCT_HAZARD = 12.0
WEIGHT_RELEASE_VOLUME = 8.0

# Class location -> population exposure fraction (0-1). Follows the ordering
# of 49 CFR 192.5 class locations; the fractions themselves are judgement.
CLASS_LOCATION_EXPOSURE = {1: 0.10, 2: 0.40, 3: 0.80, 4: 1.00}

# Relative hazard of the product released, 0-1. Gas is rated highest because
# its failure mode is ignition and thermal radiation, which harms people
# immediately; produced water is an environmental and remediation problem
# rather than an acute one.
PRODUCT_HAZARD = {
    "Natural Gas": 1.00,
    "Crude Oil": 0.70,
    "Refined Products": 0.75,
    "Produced Water": 0.30,
}
DEFAULT_PRODUCT_HAZARD = 0.60

# Products whose HCA test is the gas rule (192.903) rather than the liquid
# rule (195.450). The two regimes ask genuinely different questions.
GAS_PRODUCTS = {"Natural Gas"}

# PIR is only meaningful for gas. 0.69 is the natural-gas constant from
# 49 CFR 192.903; the formula returns feet.
PIR_CONSTANT_NATURAL_GAS = 0.69

# Above this potential impact radius a gas segment is treated as able to reach
# an identified site even at a lower class location. Judgement.
LARGE_PIR_FT = 300.0

# Consequence banding cut-offs on the 0-100 composite. Judgement.
CONSEQUENCE_HIGH = 60.0
CONSEQUENCE_MEDIUM = 35.0


@dataclass
class ConsequenceInputs:
    """The receptor and release attributes consequence is computed from.

    Deliberately a separate object from the corrosion feature set: these are
    properties of WHERE the pipe is and WHAT it carries, not of how fast it is
    degrading. Keeping them apart is what stops consequence leaking into the
    likelihood model as a predictor.
    """
    segment_id: str
    product_type: str = ""
    diameter_inches: float = 0.0
    operating_pressure_psi: float = 0.0
    class_location: int = 1                 # 49 CFR 192.5, 1-4
    drinking_water_source: bool = False     # source-water protection area
    environmentally_sensitive: bool = False
    navigable_waterway: bool = False
    occupied_site_within_pir: bool = False  # school, hospital, care home


@dataclass
class ConsequenceAssessment:
    segment_id: str
    consequence_score: float          # 0-100
    consequence_band: str             # high | medium | low
    is_hca: bool
    hca_basis: list[str] = field(default_factory=list)
    potential_impact_radius_ft: float | None = None
    drivers: list[str] = field(default_factory=list)
    regulatory_regime: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["consequence_score"] = round(self.consequence_score, 1)
        if self.potential_impact_radius_ft is not None:
            d["potential_impact_radius_ft"] = round(self.potential_impact_radius_ft, 0)
        return d


# ----------------------------------------------------------------- PIR -----

def potential_impact_radius_ft(diameter_inches: float, pressure_psi: float,
                               product_type: str = "Natural Gas") -> float | None:
    """Potential Impact Radius, per 49 CFR 192.903.

        r = 0.69 * sqrt(p * d^2)

    with r in feet, p the MAOP in psig and d the outside diameter in inches.
    This is the published formula, implemented as written.

    Returns None for liquid products: PIR is a thermal-radiation concept for
    ignited gas releases and has no meaning for a crude oil spill, whose
    consequence footprint is governed by terrain and flow, not by a radius.
    """
    if product_type not in GAS_PRODUCTS:
        return None
    if diameter_inches <= 0 or pressure_psi <= 0:
        return 0.0
    return PIR_CONSTANT_NATURAL_GAS * math.sqrt(pressure_psi * diameter_inches ** 2)


# ----------------------------------------------------------------- HCA -----

def determine_hca(inp: ConsequenceInputs) -> tuple[bool, list[str], str]:
    """Whether the segment is in a High Consequence Area, and on what basis.

    Follows the STRUCTURE of the two regimes. The gas rule keys off class
    location and whether identified sites fall inside the potential impact
    radius; the liquid rule keys off populated areas, drinking water,
    ecological resources and navigable waterways. Mixing them would be wrong:
    a Class 1 liquid line crossing a drinking-water source IS an HCA under
    195.450, while class location alone would say otherwise.
    """
    basis: list[str] = []
    is_gas = inp.product_type in GAS_PRODUCTS
    regime = ("49 CFR 192 (gas transmission)" if is_gas
              else "49 CFR 195 (hazardous liquid)")

    if is_gas:
        if inp.class_location >= 3:
            basis.append(f"Class {inp.class_location} location")
        if inp.occupied_site_within_pir:
            basis.append("identified site within potential impact radius")
        pir = potential_impact_radius_ft(
            inp.diameter_inches, inp.operating_pressure_psi, inp.product_type)
        if pir is not None and pir >= LARGE_PIR_FT and inp.class_location >= 2:
            basis.append(f"large impact radius ({pir:.0f} ft) over populated area")
    else:
        if inp.class_location >= 3:
            basis.append("high population area")
        elif inp.class_location == 2:
            basis.append("other populated area")
        if inp.drinking_water_source:
            basis.append("drinking water source")
        if inp.environmentally_sensitive:
            basis.append("unusually sensitive ecological area")
        if inp.navigable_waterway:
            basis.append("commercially navigable waterway")

    return bool(basis), basis, regime


# --------------------------------------------------------- consequence -----

def _release_volume_factor(diameter_inches: float, pressure_psi: float) -> float:
    """Crude proxy for how much can escape, normalised to 0-1.

    Inventory scales with cross-sectional area (d^2) and, for a compressible
    product, with pressure. Normalised against a 48-inch line at 1440 psi,
    which is about the top of this dataset's range.
    """
    if diameter_inches <= 0:
        return 0.0
    reference = (48.0 ** 2) * 1440.0
    value = (diameter_inches ** 2) * max(pressure_psi, 0.0)
    return min(value / reference, 1.0)


def assess_consequence(inp: ConsequenceInputs) -> ConsequenceAssessment:
    """Composite consequence score, 0-100, with the reasoning that produced it."""
    drivers: list[str] = []

    exposure = CLASS_LOCATION_EXPOSURE.get(inp.class_location, 0.10)
    population_term = WEIGHT_POPULATION * exposure
    if inp.class_location >= 3:
        drivers.append(f"Class {inp.class_location} location — high population density")
    elif inp.class_location == 2:
        drivers.append("Class 2 location — moderate population density")

    water_term = WEIGHT_DRINKING_WATER if inp.drinking_water_source else 0.0
    if inp.drinking_water_source:
        drivers.append("Crosses a drinking water source")

    eco_term = WEIGHT_ECOLOGICAL if inp.environmentally_sensitive else 0.0
    if inp.environmentally_sensitive:
        drivers.append("Unusually sensitive ecological area")

    nav_term = WEIGHT_NAVIGABLE_WATER if inp.navigable_waterway else 0.0
    if inp.navigable_waterway:
        drivers.append("Commercially navigable waterway crossing")

    hazard = PRODUCT_HAZARD.get(inp.product_type, DEFAULT_PRODUCT_HAZARD)
    hazard_term = WEIGHT_PRODUCT_HAZARD * hazard

    volume = _release_volume_factor(inp.diameter_inches, inp.operating_pressure_psi)
    volume_term = WEIGHT_RELEASE_VOLUME * volume
    if volume > 0.5:
        drivers.append(
            f"Large release potential ({inp.diameter_inches:.0f} in at "
            f"{inp.operating_pressure_psi:.0f} psi)"
        )

    score = (population_term + water_term + eco_term + nav_term
             + hazard_term + volume_term)
    score = max(0.0, min(100.0, score))

    is_hca, basis, regime = determine_hca(inp)
    if is_hca:
        drivers.insert(0, "In a High Consequence Area")

    pir = potential_impact_radius_ft(
        inp.diameter_inches, inp.operating_pressure_psi, inp.product_type)

    if score >= CONSEQUENCE_HIGH:
        band = "high"
    elif score >= CONSEQUENCE_MEDIUM:
        band = "medium"
    else:
        band = "low"

    return ConsequenceAssessment(
        segment_id=inp.segment_id,
        consequence_score=score,
        consequence_band=band,
        is_hca=is_hca,
        hca_basis=basis,
        potential_impact_radius_ft=pir,
        drivers=drivers,
        regulatory_regime=regime,
    )


# ---------------------------------------------------------------- risk -----

# An HCA segment is not merely scored higher, it is on a different regulatory
# clock. This multiplier keeps that visible in the ranking rather than letting
# a marginally higher corrosion rate elsewhere outrank it. Judgement.
HCA_RISK_MULTIPLIER = 1.25

RISK_CRITICAL = 55.0
RISK_ELEVATED = 30.0


def risk_score(likelihood_normalized: float, consequence_score: float,
               is_hca: bool = False) -> float:
    """Combine likelihood and consequence into a 0-100 risk score.

    `likelihood_normalized` is the predicted corrosion rate mapped to 0-1
    across the fleet, NOT the raw mpy. Raw rate cannot be multiplied by a
    0-100 consequence and produce anything interpretable, and the fleet is the
    only reference frame available for "how bad is this rate".
    """
    likelihood = max(0.0, min(1.0, likelihood_normalized))
    consequence = max(0.0, min(100.0, consequence_score))
    score = likelihood * consequence
    if is_hca:
        score *= HCA_RISK_MULTIPLIER
    return max(0.0, min(100.0, score))


def risk_band(score: float) -> str:
    if score >= RISK_CRITICAL:
        return "critical"
    if score >= RISK_ELEVATED:
        return "elevated"
    return "normal"


CONSEQUENCE_COLUMNS = (
    "class_location",
    "drinking_water_source",
    "environmentally_sensitive",
    "navigable_waterway",
    "occupied_site_within_pir",
)


def consequence_inputs_from_row(row) -> ConsequenceInputs:
    """Build ConsequenceInputs from a dataset row (pandas Series or dict).

    This is the single seam where real GIS-derived HCA data would replace the
    synthetic columns. Nothing downstream needs to know which it got.
    """
    def get(key, default):
        try:
            value = row[key]
        except (KeyError, IndexError, TypeError):
            return default
        return default if value is None else value

    return ConsequenceInputs(
        segment_id=str(get("segment_id", "?")),
        product_type=str(get("product_type", "")),
        diameter_inches=float(get("diameter_inches", 0) or 0),
        operating_pressure_psi=float(get("operating_pressure_psi", 0) or 0),
        class_location=int(get("class_location", 1) or 1),
        drinking_water_source=bool(get("drinking_water_source", False)),
        environmentally_sensitive=bool(get("environmentally_sensitive", False)),
        navigable_waterway=bool(get("navigable_waterway", False)),
        occupied_site_within_pir=bool(get("occupied_site_within_pir", False)),
    )
