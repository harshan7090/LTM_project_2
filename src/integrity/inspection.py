"""
Inspection method selection.

Given a segment's attributes and the model's risk assessment, decides WHICH
inspection technique is appropriate — not just that "an inspection is needed".

WHY THIS IS RULE-BASED AND NOT AN LLM CALL:

  Choosing an inspection method is a defensible engineering decision that an
  operator has to justify to a regulator. It must be deterministic, auditable,
  and identical every time for identical inputs. An LLM that picks a different
  method on Tuesday than it picked on Monday is unusable for that purpose.

  So the decision is made here, in code you can read and test. The LLM's job is
  to EXPLAIN the decision in context — which is what language models are
  genuinely good at — not to make it.

METHODOLOGY:

  The selection logic follows the structure used in real external corrosion
  direct assessment (ECDA) and integrity management practice:

    - NACE/AMPP SP0502 — External Corrosion Direct Assessment methodology,
      which pairs indirect surveys (CIPS, DCVG) over the same span.
    - NACE/AMPP SP0169 — cathodic protection criteria; the -850 mV (CSE)
      criterion is what a CIPS run is measuring against.
    - API 570 / API 1160 — inspection planning and pipeline integrity
      management, including the concept of piggability driving method choice.
    - API 579-1 / ASME FFS-1 — fitness-for-service, which is what UT thickness
      data feeds into.

  Thresholds below are engineering-judgement defaults chosen to be defensible
  and readable, NOT quoted clause values from those standards. They are set in
  one place so an operator can tune them to their own procedures.

  IMPORTANT: no specific clause numbers or numeric limits are attributed to the
  standards above beyond the widely-published -850 mV CP criterion. Where a
  threshold is ours, it says so.
"""
from dataclasses import dataclass, field, asdict

# --------------------------------------------------------------- tuning ----
# Operator-tunable thresholds. Engineering-judgement defaults, not standard
# clause values.

SOIL_CORROSIVE_OHM_CM = 2000      # below this, soil is considered corrosive
SOIL_VERY_CORROSIVE_OHM_CM = 1000
MIN_PIGGABLE_DIAMETER_IN = 6      # smaller lines rarely take a conventional tool
OVERDUE_INSPECTION_YEARS = 5
LONG_OVERDUE_YEARS = 8
OLD_PIPE_YEARS = 30
CUI_TEMP_MIN_C = 10               # CUI is worst where insulation stays damp
CUI_TEMP_MAX_C = 60
HIGH_PRESSURE_PSI = 1000
REPEAT_REPAIR_COUNT = 3

# --- Regulatory reassessment caps -------------------------------------------
# These are NOT judgement. 49 CFR 192.939 caps the reassessment interval for
# gas transmission pipelines in High Consequence Areas, and 49 CFR 195.452(j)
# does the same for hazardous liquid. A risk-based interval may be shorter
# than these; it may never be longer. That is the difference between a
# recommendation and a compliance deadline, and the scheduler treats the two
# differently.
HCA_MAX_INTERVAL_MONTHS_GAS = 84      # 7 years, 49 CFR 192.939
HCA_MAX_INTERVAL_MONTHS_LIQUID = 60   # 5 years, 49 CFR 195.452(j)(3)
GAS_PRODUCTS = {"Natural Gas"}


# Diagnostic value per method, 0-1: how much it tells you about the threat
# that selected it. Engineering judgement, in one place so an operator can
# retune it against their own experience.
#
#   1.00  direct examination - ground truth, you are looking at the metal
#   0.95  in-line inspection - full-length metal loss, quantified
#   0.90  ultrasonic - measures remaining wall at a point
#   0.85  close-interval survey - measures the CP criterion along the span
#   0.80  DCVG - locates coating defects precisely
#   0.75  ECDA - thorough four-step process, but indirect
#   0.70  CUI inspection - insulation removal, localised
#   0.50  coating survey - confirms a baseline, measures no defect
METHOD_VALUE = {
    "DIG": 1.00, "ILI-MFL": 0.95, "ILI-UT": 0.95, "UT": 0.90,
    "CIPS": 0.85, "DCVG": 0.80, "ECDA": 0.75, "CUI": 0.70, "COAT": 0.50,
}
DEFAULT_METHOD_VALUE = 0.60

# How many methods to return. Beyond three, a plan stops being a plan.
MAX_METHODS = 3


@dataclass
class InspectionMethod:
    """One recommended technique, with the reasoning that selected it."""
    code: str
    name: str
    category: str          # "indirect" | "direct" | "in-line" | "pressure"
    priority: int          # 1 = addresses the primary threat
    rationale: str
    standard: str = ""
    est_days: float = 1.0
    summary: str = ""      # one line, for the collapsed view

    @property
    def value(self) -> float:
        return METHOD_VALUE.get(self.code, DEFAULT_METHOD_VALUE)

    @property
    def efficiency(self) -> float:
        """Diagnostic value per crew-day. The planning metric: on a fixed
        crew budget, this is what decides whether a season covers thirty
        segments or twelve."""
        return self.value / max(self.est_days, 0.1)

    def __post_init__(self):
        # One short line for the collapsed view. Derived rather than written
        # twice, so a rationale and its summary cannot drift apart.
        if not self.summary:
            first = self.rationale.split(". ")[0].strip().rstrip(".")
            self.summary = (first[:96].rstrip() + "…") if len(first) > 96 else first + "."

    def to_dict(self) -> dict:
        d = asdict(self)
        d["value"] = round(self.value, 2)
        d["efficiency"] = round(self.efficiency, 3)
        if not d.get("summary"):
            # First sentence of the rationale, so the collapsed view always
            # has something even for methods that predate this field.
            d["summary"] = self.rationale.split(". ")[0].rstrip(".") + "."
        return d


@dataclass
class InspectionPlan:
    segment_id: str
    risk_band: str
    urgency: str                        # "immediate" | "scheduled" | "routine"
    interval_months: int
    # Set only for HCA segments. This is a legal ceiling, not a
    # recommendation, and the scheduler treats it as a hard constraint.
    regulatory_deadline_months: int | None = None
    is_hca: bool = False
    methods: list[InspectionMethod] = field(default_factory=list)
    # Methods that were triggered but did not make the top three. Kept so the
    # plan is auditable - "why no ILI run?" has an answer - without putting
    # nine techniques in front of someone who has to pick one.
    also_considered: list[InspectionMethod] = field(default_factory=list)
    drivers: list[str] = field(default_factory=list)
    total_est_days: float = 0.0
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "segment_id": self.segment_id,
            "risk_band": self.risk_band,
            "urgency": self.urgency,
            "interval_months": self.interval_months,
            "regulatory_deadline_months": self.regulatory_deadline_months,
            "is_hca": self.is_hca,
            "methods": [m.to_dict() for m in self.methods],
            "also_considered": [m.to_dict() for m in self.also_considered],
            "drivers": self.drivers,
            "total_est_days": round(self.total_est_days, 1),
            "notes": self.notes,
        }


# ------------------------------------------------------------ catalogue ----

def _cips(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="CIPS",
        name="Close Interval Potential Survey",
        category="indirect",
        priority=1,
        rationale=reason,
        standard="NACE/AMPP SP0169 (−850 mV CSE criterion), SP0502",
        est_days=2.0,
    )


def _dcvg(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="DCVG",
        name="Direct Current Voltage Gradient coating survey",
        category="indirect",
        priority=2,
        rationale=reason,
        standard="NACE/AMPP SP0502 (ECDA indirect inspection)",
        est_days=2.0,
    )


def _ut(reason: str, priority: int = 3) -> InspectionMethod:
    return InspectionMethod(
        code="UT",
        name="Ultrasonic wall thickness measurement",
        category="direct",
        priority=priority,
        rationale=reason,
        standard="API 570; feeds API 579-1/ASME FFS-1 assessment",
        est_days=1.5,
    )


def _ili(reason: str, tool: str) -> InspectionMethod:
    return InspectionMethod(
        code=f"ILI-{tool}",
        name=f"In-line inspection ({tool} tool)",
        category="in-line",
        priority=1,
        rationale=reason,
        standard="API 1160 integrity assessment",
        est_days=4.0,
    )


def _ecda(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="ECDA",
        name="External Corrosion Direct Assessment (full 4-step process)",
        category="direct",
        priority=1,
        rationale=reason,
        standard="NACE/AMPP SP0502",
        est_days=5.0,
    )


def _excavation(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="DIG",
        name="Excavation and direct examination",
        category="direct",
        priority=4,
        rationale=reason,
        standard="NACE/AMPP SP0502 step 3 (direct examination)",
        est_days=3.0,
    )


def _cui(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="CUI",
        name="Insulation removal / profile radiography for CUI",
        category="direct",
        priority=2,
        rationale=reason,
        standard="API 570 corrosion-under-insulation inspection",
        est_days=2.0,
    )


def _coating_survey(reason: str) -> InspectionMethod:
    return InspectionMethod(
        code="COAT",
        name="Coating condition survey",
        category="indirect",
        priority=3,
        rationale=reason,
        standard="NACE/AMPP SP0502",
        est_days=1.0,
    )


# ------------------------------------------------------------- selector ----

def _is_piggable(attrs: dict) -> bool:
    """Conventional ILI tools need a minimum bore. Real piggability also depends
    on bend radii, valve types and launcher/receiver facilities, which this
    dataset does not carry — so this is a diameter proxy and is labelled as
    such in the output."""
    return float(attrs.get("diameter_inches", 0)) >= MIN_PIGGABLE_DIAMETER_IN


def recommend_inspection(detail: dict) -> InspectionPlan:
    """Builds an inspection plan for one segment.

    `detail` is the dict returned by ScoringService.get_segment() — it carries
    `attributes`, `risk_band`, `predicted_rate_mpy`, the SHAP `explanation`,
    and (since consequence modelling was added) `consequence` and
    `remaining_life`.

    Both new blocks are optional. A caller that omits them gets the previous
    behaviour rather than a KeyError, which keeps this usable from tests and
    from any path that has not been updated.
    """
    attrs = detail.get("attributes", {}) or {}
    band = detail.get("risk_band", "normal")
    rate = float(detail.get("predicted_rate_mpy", 0.0))
    consequence = detail.get("consequence") or {}
    remaining = detail.get("remaining_life") or {}
    is_hca = bool(consequence.get("is_hca", False))

    age = float(attrs.get("pipe_age_years", 0))
    diameter = float(attrs.get("diameter_inches", 0))
    resistivity = float(attrs.get("soil_resistivity_ohm_cm", 99999))
    temp = float(attrs.get("operating_temperature_c", 20))
    pressure = float(attrs.get("operating_pressure_psi", 0))
    repairs = int(attrs.get("historical_repair_count", 0))
    since_inspection = float(attrs.get("last_inspection_years_ago", 0))
    cp = bool(attrs.get("cathodic_protection", False))
    coating = str(attrs.get("coating_type", ""))
    material = str(attrs.get("material", ""))
    product = str(attrs.get("product_type", ""))

    methods: list[InspectionMethod] = []
    drivers: list[str] = []
    notes: list[str] = []

    # --- Cathodic protection deficiency -----------------------------------
    # The single most actionable finding: if CP is absent, confirming it is
    # cheap and it changes the whole mitigation plan.
    if not cp:
        drivers.append("No cathodic protection")
        methods.append(_cips(
            "Cathodic protection is recorded as absent. A close-interval survey "
            "confirms whether the pipe-to-soil potential meets the −850 mV (CSE) "
            "criterion and locates the extent of any shortfall."
        ))
    elif resistivity < SOIL_CORROSIVE_OHM_CM:
        drivers.append(f"CP present but soil is corrosive ({resistivity:.0f} ohm-cm)")
        methods.append(_cips(
            f"CP is recorded as present, but soil resistivity of {resistivity:.0f} "
            f"ohm-cm raises current demand. A CIPS run verifies protection is "
            f"actually achieved along the span rather than only at the rectifier."
        ))

    # --- Coating condition -------------------------------------------------
    if coating == "Uncoated":
        drivers.append("Uncoated pipe")
        methods.append(_dcvg(
            "Pipe is recorded as uncoated, so the soil-side surface is fully "
            "exposed. DCVG locates where attack is concentrated so excavation "
            "can be targeted rather than speculative."
        ))
    elif coating == "Polyethylene Tape":
        drivers.append("Tape coating — disbondment/shielding risk")
        methods.append(_dcvg(
            "Polyethylene tape coatings are prone to disbondment, and disbonded "
            "tape can shield CP current from reaching the metal — corrosion "
            "proceeds underneath while the rectifier still reads normal. DCVG "
            "detects coating defects a potential survey alone would miss."
        ))
        notes.append(
            "CP shielding under disbonded tape means a passing CIPS reading does "
            "NOT by itself prove the pipe is protected here."
        )
    elif coating == "Coal Tar Enamel" and age > OLD_PIPE_YEARS:
        drivers.append("Ageing coal tar enamel coating")
        methods.append(_coating_survey(
            f"Coal tar enamel on {age:.0f}-year-old pipe is near or beyond typical "
            f"service life; a coating survey establishes remaining condition."
        ))

    # --- Corrosion under insulation ---------------------------------------
    # CUI is worst in the temperature band where insulation stays damp rather
    # than drying out.
    if CUI_TEMP_MIN_C <= temp <= CUI_TEMP_MAX_C and age > 15:
        drivers.append(f"Operating temperature {temp:.0f} °C is in the CUI-susceptible band")
        methods.append(_cui(
            f"At {temp:.0f} °C, insulation on this line stays damp rather than "
            f"drying, which is the condition corrosion under insulation needs. "
            f"Applies only if this segment is insulated — the dataset does not "
            f"record insulation, so confirm before scheduling."
        ))
        notes.append(
            "CUI recommendation is conditional: this dataset has no insulation "
            "field, so it is flagged on temperature and age alone."
        )

    # --- Metal loss quantification ----------------------------------------
    # Everything above locates and explains. This is what actually measures.
    needs_quantification = band in ("critical", "elevated") or rate > 5.0
    if needs_quantification:
        if _is_piggable(attrs):
            tool = "MFL" if material == "Carbon Steel" else "UT"
            methods.append(_ili(
                f"Predicted rate of {rate:.2f} mpy warrants quantified metal loss "
                f"over the full segment. At {diameter:.0f} in the line should accept "
                f"a conventional tool.",
                tool,
            ))
            notes.append(
                "Piggability is inferred from diameter only. Confirm bend radii, "
                "valve bore and launcher/receiver availability before committing."
            )
        else:
            drivers.append(f"Unpiggable at {diameter:.0f} in — direct assessment required")
            methods.append(_ecda(
                f"At {diameter:.0f} in this line is below the practical bore for a "
                f"conventional ILI tool, so external corrosion direct assessment "
                f"is the applicable route to a quantified condition."
            ))
        methods.append(_ut(
            "UT readings at the locations the indirect surveys flag give the "
            "measured wall thickness that any fitness-for-service assessment "
            "under API 579-1 requires.",
            priority=3,
        ))

    # --- Repeat repairs ----------------------------------------------------
    if repairs >= REPEAT_REPAIR_COUNT:
        drivers.append(f"{repairs} historical repairs — recurring problem")
        methods.append(_excavation(
            f"{repairs} previous repairs on this segment indicate an active, "
            f"recurring mechanism rather than isolated damage. Direct examination "
            f"establishes what is actually driving it."
        ))

    # --- Age and overdue inspection ---------------------------------------
    if age > OLD_PIPE_YEARS:
        drivers.append(f"{age:.0f}-year-old pipe")
    if since_inspection > LONG_OVERDUE_YEARS:
        drivers.append(f"Not inspected for {since_inspection:.1f} years")
    elif since_inspection > OVERDUE_INSPECTION_YEARS:
        drivers.append(f"Last inspected {since_inspection:.1f} years ago")

    if pressure > HIGH_PRESSURE_PSI:
        drivers.append(f"High operating pressure ({pressure:.0f} psi)")
        notes.append(
            f"At {pressure:.0f} psi the consequence of failure is elevated, which "
            f"raises the priority of this segment independently of its corrosion rate."
        )

    # --- Consequence ------------------------------------------------------
    # This used to say "confirm this segment's high-consequence-area status"
    # and hand the question to a human. It is now determined in
    # src/integrity/consequence.py and acted on here.
    if is_hca:
        basis = consequence.get("hca_basis") or []
        drivers.append("High Consequence Area" + (f" — {basis[0]}" if basis else ""))
        notes.append(
            "In a High Consequence Area under "
            f"{consequence.get('regulatory_regime', 'the applicable regime')}"
            + (f" ({'; '.join(basis)})" if basis else "")
            + ". A statutory maximum reassessment interval applies."
        )
        pir = consequence.get("potential_impact_radius_ft")
        if pir:
            notes.append(
                f"Potential impact radius {pir:.0f} ft (49 CFR 192.903). "
                f"Everything inside that radius is exposed to an ignited release."
            )

    # --- Remaining life ---------------------------------------------------
    verdict = remaining.get("verdict")
    rl_years = remaining.get("remaining_life_years")
    if verdict == "repair_now":
        drivers.append("Remaining life exhausted or ERF at limit")
    elif verdict == "derate":
        drivers.append("Wall approaching minimum allowable — derating candidate")
    elif verdict == "plan_repair" and rl_years is not None:
        drivers.append(f"Reaches minimum allowable wall in {rl_years:.0f} years")

    # --- Fallback: nothing triggered --------------------------------------
    if not methods:
        methods.append(_coating_survey(
            "No specific threat indicators triggered. A routine coating and CP "
            "condition check maintains the baseline record."
        ))
        drivers.append("No specific threat indicators")

    # --- Urgency and interval ---------------------------------------------
    if band == "critical":
        urgency, interval = "immediate", 6
    elif band == "elevated":
        urgency, interval = "scheduled", 12
    else:
        urgency, interval = "routine", 36

    # Remaining life can force urgency up regardless of the risk band: a
    # segment with two years of wall left is not a "routine" job even if its
    # risk score is modest.
    if verdict == "repair_now":
        urgency, interval = "immediate", min(interval, 6)
    elif verdict == "derate" and urgency == "routine":
        urgency, interval = "scheduled", min(interval, 12)
    if rl_years is not None and rl_years < 5 and interval > 12:
        interval = 12
        notes.append(
            f"Interval shortened to 12 months: projected remaining life is "
            f"{rl_years:.1f} years."
        )

    # An overdue inspection tightens the interval regardless of band.
    if since_inspection > LONG_OVERDUE_YEARS and interval > 12:
        interval = 12
        notes.append(
            f"Interval shortened to 12 months because this segment has not been "
            f"inspected in {since_inspection:.1f} years."
        )

    # --- Statutory cap ----------------------------------------------------
    # Applied LAST and only ever downward. Everything above is engineering
    # judgement that may recommend inspecting sooner; this is the legal
    # ceiling that cannot be exceeded no matter how benign the risk score.
    regulatory_deadline_months = None
    if is_hca:
        cap = (HCA_MAX_INTERVAL_MONTHS_GAS if product in GAS_PRODUCTS
               else HCA_MAX_INTERVAL_MONTHS_LIQUID)
        citation = ("49 CFR 192.939" if product in GAS_PRODUCTS
                    else "49 CFR 195.452(j)(3)")
        regulatory_deadline_months = cap
        if interval > cap:
            notes.append(
                f"Interval capped at {cap} months by {citation} — statutory "
                f"maximum reassessment interval in a High Consequence Area. "
                f"The risk-based interval would have been {interval} months."
            )
            interval = cap
        else:
            notes.append(
                f"Statutory maximum under {citation} is {cap} months; the "
                f"risk-based interval of {interval} months is shorter and governs."
            )

    # De-duplicate by code, keeping the highest-priority instance.
    unique: dict[str, InspectionMethod] = {}
    for m in methods:
        if m.code not in unique or m.priority < unique[m.code].priority:
            unique[m.code] = m

    # Ranked by efficiency, highest first. No tier ahead of it.
    #
    # An earlier version sorted by priority tier and then by efficiency
    # within the tier, which is defensible but produced a list reading
    # 0.425, 0.150, 0.400 - monotonic in neither thing an operator can see.
    # A ranking whose order cannot be read off the numbers beside it is not
    # a ranking, it is a second hidden rule.
    #
    # Nothing is lost by dropping the tier here: unlike repair, no inspection
    # method is a same-day safety measure that has to jump the queue.
    ranked = sorted(unique.values(), key=lambda m: -m.efficiency)
    ordered, deferred = ranked[:MAX_METHODS], ranked[MAX_METHODS:]
    if deferred:
        notes.append(
            f"{len(deferred)} further method(s) were triggered and set aside "
            f"as lower value per crew-day: "
            f"{', '.join(m.code for m in deferred)}. Listed under "
            f"'also considered'."
        )

    return InspectionPlan(
        segment_id=detail.get("segment_id", "?"),
        risk_band=band,
        urgency=urgency,
        interval_months=interval,
        regulatory_deadline_months=regulatory_deadline_months,
        is_hca=is_hca,
        methods=ordered,
        also_considered=deferred,
        drivers=drivers,
        total_est_days=sum(m.est_days for m in ordered),
        notes=notes,
    )
