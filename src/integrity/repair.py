"""
Repair and mitigation selection.

Inspection tells you what is wrong. This decides what to DO about it, which
is a different question with a different answer set: you can reinforce the
pipe, restore its coating, fix the electrochemistry, lower the pressure, or
cut the joint out and replace it.

Deterministic for the same reason as src/integrity/inspection.py — a repair
method has to be justified to a regulator, and 49 CFR 192.713 / 195.422
constrain which methods are permissible for which defect. An LLM that picks a
composite sleeve on Tuesday and a Type B on Wednesday for identical inputs is
unusable for that purpose.

WHAT DRIVES THE CHOICE:

  ERF and remaining life       -> how urgent, and whether pressure containment
                                  is needed at all
  Leak vs non-leak             -> a Type A sleeve cannot contain pressure, so
                                  anything leaking or near through-wall needs
                                  Type B or a cut-out
  Cause (CP / coating / both)  -> reinforcing the pipe without fixing the
                                  cause buys time, not a solution
  HCA                          -> shortens the permissible window
  Piggability and diameter     -> constrains what can physically be installed

THE POINT ABOUT CAUSE:

  The commonest mistake in a corrosion repair plan is treating the symptom.
  A composite sleeve over a wall-loss area on a line with a failed rectifier
  is a patch on a pipe that will keep corroding either side of it. So every
  plan here separates REINFORCEMENT (fix the defect) from MITIGATION (fix the
  cause), and emits both where both apply.

Costs and durations are order-of-magnitude planning figures for scheduling,
clearly labelled as such — not quotes.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

# --------------------------------------------------------------- tuning ----
# Operator-tunable. Engineering judgement, not standard clause values.

# Wall loss above which a non-pressure-containing (Type A) repair is no longer
# appropriate. Below 80% is the usual B31G validity limit; this is tighter.
TYPE_A_MAX_WALL_LOSS = 0.60
# Remaining life below which a permanent repair is required rather than
# monitoring with a mitigation fix.
PERMANENT_REPAIR_YEARS = 5.0
MONITOR_ONLY_YEARS = 15.0
# ERF at or above this means the safe pressure no longer covers operations.
ERF_ACTION = 1.0
ERF_WATCH = 0.90
# Replacement becomes more economic than repeated repair past this count.
REPLACEMENT_REPAIR_COUNT = 4
MIN_SLEEVE_DIAMETER_IN = 4


# How much of the threat each action actually removes, 0-1.
#
#   1.00  cut out and replace - the defect is gone
#   0.85  welded Type B sleeve - pressure-containing, permanent
#   0.75  composite sleeve - restores strength, does not contain pressure
#   0.70  recoat - removes the cause for the excavated span
#   0.65  CP upgrade - removes the cause along the whole span
#   0.45  grind out - addresses shallow loss only
#   0.30  pressure derate - buys time, fixes nothing
ACTION_VALUE = {
    "CUTOUT": 1.00, "SLV-B": 0.85, "SLV-A": 0.75, "RECOAT": 0.70,
    "CP-UP": 0.65, "GRIND": 0.45, "DERATE": 0.30, "MON": 0.05,
}
DEFAULT_ACTION_VALUE = 0.50

# Crew-day equivalent of money, for putting days and dollars on one axis.
# At roughly 25k per crew-day all-in for a dig crew, a 50k job is about two
# crew-days of budget.
USD_PER_CREW_DAY = 25_000.0

MAX_ACTIONS = 3


@dataclass
class RepairAction:
    """One recommended intervention."""
    code: str
    name: str
    category: str          # reinforcement | mitigation | operational | replacement
    priority: int          # 1 = do first
    rationale: str
    standard: str = ""
    est_days: float = 1.0
    est_cost_usd: float = 0.0
    requires_shutdown: bool = False
    skill: str = "general"   # crew capability needed — drives assignment
    summary: str = ""

    @property
    def value(self) -> float:
        return ACTION_VALUE.get(self.code, DEFAULT_ACTION_VALUE)

    @property
    def total_burden(self) -> float:
        """Days and dollars on one axis, so they can be traded off.

        A shutdown is charged three extra crew-days: taking a line out of
        service costs production and coordination that the repair's own
        duration does not capture, and ignoring it makes a cut-out look far
        cheaper than it is.
        """
        return (self.est_days
                + self.est_cost_usd / USD_PER_CREW_DAY
                + (3.0 if self.requires_shutdown else 0.0))

    @property
    def efficiency(self) -> float:
        """Threat removed per crew-day-equivalent."""
        return self.value / max(self.total_burden, 0.1)

    def __post_init__(self):
        if not self.summary:
            first = self.rationale.split(". ")[0].strip().rstrip(".")
            self.summary = (first[:96].rstrip() + "…") if len(first) > 96 else first + "."

    def to_dict(self) -> dict:
        d = asdict(self)
        d["value"] = round(self.value, 2)
        d["efficiency"] = round(self.efficiency, 3)
        d["total_burden_days"] = round(self.total_burden, 1)
        if not d.get("summary"):
            d["summary"] = self.rationale.split(". ")[0].rstrip(".") + "."
        return d


@dataclass
class RepairPlan:
    segment_id: str
    urgency: str                     # immediate | scheduled | routine | monitor
    window_days: int                 # how long until it must be done
    actions: list[RepairAction] = field(default_factory=list)
    also_considered: list[RepairAction] = field(default_factory=list)
    drivers: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    total_est_days: float = 0.0
    total_est_cost_usd: float = 0.0
    requires_shutdown: bool = False
    skills_required: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "segment_id": self.segment_id,
            "urgency": self.urgency,
            "window_days": self.window_days,
            "actions": [a.to_dict() for a in self.actions],
            "also_considered": [a.to_dict() for a in self.also_considered],
            "drivers": self.drivers,
            "notes": self.notes,
            "total_est_days": round(self.total_est_days, 1),
            "total_est_cost_usd": round(self.total_est_cost_usd, 0),
            "requires_shutdown": self.requires_shutdown,
            "skills_required": self.skills_required,
        }


# ------------------------------------------------------------ catalogue ----

def _recoat(reason: str) -> RepairAction:
    return RepairAction(
        code="RECOAT", name="Excavate, blast and recoat",
        category="mitigation", priority=2, rationale=reason,
        standard="NACE/AMPP SP0169 — coating as the primary barrier",
        est_days=3.0, est_cost_usd=45_000, skill="coating",
    )


def _cp_upgrade(reason: str) -> RepairAction:
    return RepairAction(
        code="CP-UP", name="Cathodic protection upgrade (anodes / rectifier)",
        category="mitigation", priority=1, rationale=reason,
        standard="NACE/AMPP SP0169 — restore the -850 mV (CSE) criterion",
        est_days=2.0, est_cost_usd=28_000, skill="cathodic_protection",
    )


def _composite_sleeve(reason: str) -> RepairAction:
    return RepairAction(
        code="SLV-A", name="Composite reinforcement sleeve (Type A)",
        category="reinforcement", priority=1, rationale=reason,
        standard="ASME B31.4/B31.8 permanent repair; non-pressure-containing",
        est_days=2.0, est_cost_usd=35_000, skill="composite_repair",
    )


def _steel_sleeve(reason: str) -> RepairAction:
    return RepairAction(
        code="SLV-B", name="Full-encirclement welded steel sleeve (Type B)",
        category="reinforcement", priority=1, rationale=reason,
        standard="ASME B31.4/B31.8 — pressure-containing, permitted over a leak",
        est_days=4.0, est_cost_usd=85_000, requires_shutdown=False,
        skill="welding",
    )


def _cutout(reason: str) -> RepairAction:
    return RepairAction(
        code="CUTOUT", name="Cut out and replace the affected joint",
        category="replacement", priority=1, rationale=reason,
        standard="ASME B31.4/B31.8 — the reference permanent repair",
        est_days=7.0, est_cost_usd=210_000, requires_shutdown=True,
        skill="welding",
    )


def _derate(reason: str, safe_psi: float) -> RepairAction:
    return RepairAction(
        code="DERATE", name=f"Interim pressure reduction to {safe_psi:.0f} psi",
        category="operational", priority=0, rationale=reason,
        standard="49 CFR 192.713 / 195.422 — interim protective measure",
        est_days=0.5, est_cost_usd=2_000, skill="operations",
    )


def _grind(reason: str) -> RepairAction:
    return RepairAction(
        code="GRIND", name="Grind out and blend shallow metal loss",
        category="reinforcement", priority=2, rationale=reason,
        standard="ASME B31.4/B31.8 — permitted for shallow, non-cracklike loss",
        est_days=1.5, est_cost_usd=18_000, skill="mechanical",
    )


def _monitor(reason: str) -> RepairAction:
    return RepairAction(
        code="MON", name="No repair — monitor at the scheduled interval",
        category="operational", priority=3, rationale=reason,
        est_days=0.0, est_cost_usd=0, skill="general",
    )


# -------------------------------------------------------------- selector ---

def recommend_repair(detail: dict, inspection_plan: dict | None = None) -> RepairPlan:
    """Build a repair plan for one segment.

    `detail` is ScoringService.get_segment() output, carrying `attributes`,
    `consequence` and `remaining_life`. `inspection_plan` is optional and only
    used to inherit urgency when remaining life is unavailable.
    """
    attrs = detail.get("attributes", {}) or {}
    consequence = detail.get("consequence") or {}
    remaining = detail.get("remaining_life") or {}

    segment_id = detail.get("segment_id", "?")
    is_hca = bool(consequence.get("is_hca", False))
    verdict = remaining.get("verdict", "")
    rl_years = remaining.get("remaining_life_years")
    erf = remaining.get("erf")
    safe_psi = float(remaining.get("safe_operating_pressure_psi") or 0)

    cp = bool(attrs.get("cathodic_protection", False))
    coating = str(attrs.get("coating_type", ""))
    diameter = float(attrs.get("diameter_inches", 0) or 0)
    repairs = int(attrs.get("historical_repair_count", 0) or 0)
    resistivity = float(attrs.get("soil_resistivity_ohm_cm", 99999) or 99999)

    actions: list[RepairAction] = []
    drivers: list[str] = []
    notes: list[str] = []

    # --- wall loss fraction, where it can be derived -----------------------
    wall = remaining.get("current_wall_in")
    tmin = remaining.get("min_required_wall_in")
    loss_fraction = None
    if wall and tmin is not None and wall > 0:
        # Fraction of the usable allowance already consumed, not absolute
        # metal loss — this dataset has no original construction thickness.
        loss_fraction = max(0.0, min(1.0, 1.0 - (wall - tmin) / wall))

    # --- 1. Operational: derate first if the pipe is over its safe pressure --
    # Listed at priority 0 because it is the only thing that can be done the
    # same day, and it is what buys time for everything else.
    if erf is not None and erf >= ERF_ACTION and safe_psi > 0:
        drivers.append(f"ERF {erf:.2f} — operating above the safe pressure")
        actions.append(_derate(
            f"ERF is {erf:.2f}: the present wall supports {safe_psi:.0f} psi "
            f"against an operating pressure above it. Reducing pressure is the "
            f"immediate protective measure while a permanent repair is arranged.",
            safe_psi,
        ))

    # --- 2. Reinforcement: fix the defect ----------------------------------
    needs_permanent = (
        verdict in ("repair_now", "derate")
        or (rl_years is not None and rl_years < PERMANENT_REPAIR_YEARS)
    )

    if needs_permanent:
        if repairs >= REPLACEMENT_REPAIR_COUNT:
            drivers.append(f"{repairs} previous repairs on this segment")
            actions.append(_cutout(
                f"This segment has been repaired {repairs} times. Repeated "
                f"intervention on the same joint is a replacement case: each "
                f"repair addresses one location while the underlying condition "
                f"continues either side of it."
            ))
        elif diameter < MIN_SLEEVE_DIAMETER_IN:
            drivers.append(f"{diameter:.0f} in diameter — too small to sleeve")
            actions.append(_cutout(
                f"At {diameter:.0f} in, full-encirclement sleeve hardware is not "
                f"practical. Cut-out and replacement is the workable permanent repair."
            ))
        elif loss_fraction is not None and loss_fraction > TYPE_A_MAX_WALL_LOSS:
            drivers.append(f"{loss_fraction*100:.0f}% of the wall allowance consumed")
            actions.append(_steel_sleeve(
                f"{loss_fraction*100:.0f}% of the corrosion allowance is gone. A "
                f"Type A composite sleeve does not contain pressure, so it is not "
                f"appropriate this close to through-wall. A welded Type B sleeve is "
                f"pressure-containing and permitted over a leak."
            ))
        else:
            actions.append(_composite_sleeve(
                "Wall loss is within the range a non-pressure-containing "
                "reinforcement can restore. A composite sleeve installs without "
                "welding or a shutdown, which makes it the lower-risk option "
                "where it is permissible."
            ))
    elif rl_years is not None and rl_years < MONITOR_ONLY_YEARS:
        actions.append(_grind(
            f"Remaining life is {rl_years:.0f} years — not urgent, but shallow "
            f"metal loss is cheapest to address before it needs reinforcement."
        ))

    # --- 3. Mitigation: fix the CAUSE --------------------------------------
    # Without this the plan is a patch. Reinforcing a pipe whose rectifier has
    # failed just moves the next defect a few metres along.
    if not cp:
        drivers.append("No cathodic protection")
        actions.append(_cp_upgrade(
            "Cathodic protection is recorded as absent. Reinforcing the pipe "
            "without restoring CP addresses this defect and not the process "
            "that produced it — corrosion continues either side of the repair."
        ))
    elif resistivity < 2000:
        drivers.append(f"CP present but soil is corrosive ({resistivity:.0f} ohm-cm)")
        actions.append(_cp_upgrade(
            f"Soil resistivity of {resistivity:.0f} ohm-cm raises current demand "
            f"beyond what the existing system may deliver. Additional anodes or "
            f"rectifier capacity restores the protection criterion along the span."
        ))

    if coating in ("Uncoated", "Polyethylene Tape") or coating == "Unknown":
        drivers.append(f"Coating: {coating or 'unrecorded'}")
        actions.append(_recoat(
            "The coating is the primary barrier and cathodic protection is the "
            "backup, not the reverse. Tape coatings disbond and shield CP current, "
            "so the pipe can be nominally protected and still corroding underneath."
            if coating == "Polyethylene Tape" else
            "With no effective coating the soil-side surface is exposed "
            "continuously and CP carries the entire protective load."
        ))

    # --- 4. Nothing triggered ----------------------------------------------
    if not actions:
        actions.append(_monitor(
            "No defect or cause requiring intervention. Remaining life and "
            "protection are both adequate at the current assessment interval."
        ))

    # --- urgency and window -------------------------------------------------
    if erf is not None and erf >= ERF_ACTION:
        urgency, window = "immediate", 7
    elif verdict == "repair_now":
        urgency, window = "immediate", 30
    elif verdict == "derate" or (rl_years is not None and rl_years < PERMANENT_REPAIR_YEARS):
        urgency, window = "scheduled", 90
    elif any(a.category == "mitigation" for a in actions):
        urgency, window = "routine", 180
    else:
        urgency, window = "monitor", 365

    # HCA compresses the window. A defect in a populated area does not get the
    # same grace period as the identical defect under farmland.
    if is_hca and urgency != "monitor":
        original = window
        window = max(7, int(window * 0.6))
        notes.append(
            f"Repair window shortened from {original} to {window} days: this "
            f"segment is in a High Consequence Area under "
            f"{consequence.get('regulatory_regime', 'the applicable regime')}."
        )

    if erf is not None and ERF_WATCH <= erf < ERF_ACTION:
        notes.append(
            f"ERF is {erf:.2f} — below the action threshold but with little "
            f"margin. Continued wall loss will cross it before the next "
            f"assessment interval."
        )

    if any(a.requires_shutdown for a in actions):
        notes.append(
            "At least one recommended action requires taking the segment out of "
            "service. Coordinate with operations before scheduling."
        )

    # De-duplicate by code, keep highest priority.
    unique: dict[str, RepairAction] = {}
    for a in actions:
        if a.code not in unique or a.priority < unique[a.code].priority:
            unique[a.code] = a

    # Efficiency order, with ONE exception that is pinned ahead of it.
    #
    # A pressure derate is the least effective action in the catalogue - it
    # removes 30% of the threat and fixes nothing - and it still goes first
    # when the pipe is over its safe operating pressure, because it is the
    # only thing that can happen today. That is priority 0, and it is the
    # single case where urgency legitimately beats value-per-day.
    #
    # Everything else is ranked purely on threat removed per crew-day, so
    # the order can be read straight off the numbers.
    ranked = sorted(unique.values(), key=lambda a: (0 if a.priority == 0 else 1,
                                                    -a.efficiency))
    ordered, deferred = ranked[:MAX_ACTIONS], ranked[MAX_ACTIONS:]
    if deferred:
        notes.append(
            f"{len(deferred)} further action(s) apply but rank lower on "
            f"threat removed per crew-day: "
            f"{', '.join(a.code for a in deferred)}."
        )

    return RepairPlan(
        segment_id=segment_id,
        urgency=urgency,
        window_days=window,
        actions=ordered,
        also_considered=deferred,
        drivers=drivers,
        notes=notes,
        total_est_days=sum(a.est_days for a in ordered),
        total_est_cost_usd=sum(a.est_cost_usd for a in ordered),
        requires_shutdown=any(a.requires_shutdown for a in ordered),
        skills_required=sorted({a.skill for a in ordered if a.skill != "general"}),
    )
