"""
Work orders and proximity-based crew assignment.

The inspection scheduler (src/integrity/scheduler.py) answers "which segments
do we look at, in which period". This answers the next question: given a set
of repairs that need doing, WHO goes, and is that the cheapest competent
person to send?

WHY TRAVEL HAS TO BE IN THE OBJECTIVE:

  Without it, every technician who holds the right certificate looks
  identical to the solver, and it will happily send someone 900 km past a
  nearer colleague because the assignment is arbitrary. Travel is also not a
  rounding error at this scale: Houston to Midland is a 3.6 crew-day round
  trip before any work starts, which is longer than most of the repairs in
  the catalogue.

  So travel is charged against the same crew-day budget as the work itself.
  A technician's capacity is consumed by getting there as well as by being
  there, which is what makes "nearest competent" fall out of the optimiser
  rather than having to be hard-coded.

THREE THINGS THIS MODEL IS HONEST ABOUT:

  1. Travel is a round trip from a home depot per job, not a route. Real
     crews chain jobs, and chaining is a vehicle routing problem needing a
     road network this project does not have. Per-job round trips OVERSTATE
     travel for clustered work — deliberately, because the opposite error
     makes distant work look free.

  2. Distances are straight-line inflated by a road factor (see geo.py).

  3. Skills are hard constraints, not preferences. A welded Type B sleeve
     needs a qualified welder; there is no partial credit for nearly having
     the certificate, so an unqualified-but-close technician is not a
     variable in the model at all.
"""
from __future__ import annotations

import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ortools.sat.python import cp_model  # noqa: E402

from src.integrity.geo import (  # noqa: E402
    REGION_CENTROIDS, road_distance_km, travel_days,
)

# --------------------------------------------------------------- tuning ----
SCALE = 100          # CP-SAT is integer; float objectives are scaled

# How much a crew-day of travel counts against a unit of risk covered. Raise
# it and the solver clusters work tightly at the cost of leaving distant risk
# uncovered; lower it and it chases risk across the map. Operator-tunable.
TRAVEL_PENALTY_PER_DAY = 6.0

# Urgency multipliers on the objective.
URGENCY_WEIGHT = {"immediate": 3.0, "scheduled": 1.8, "routine": 1.0, "monitor": 0.3}

# Statuses a work order moves through.
STATUSES = ("unassigned", "assigned", "in_progress", "complete", "blocked")

# Skills the repair catalogue can ask for (see src/integrity/repair.py).
ALL_SKILLS = (
    "general", "welding", "coating", "cathodic_protection",
    "composite_repair", "mechanical", "operations",
)


@dataclass
class Technician:
    tech_id: str
    name: str
    home_latitude: float
    home_longitude: float
    skills: tuple[str, ...] = ("general",)
    days_available: float = 20.0
    region: str | None = None       # home region, for reporting not constraint

    def can_do(self, required: list[str]) -> bool:
        return all(s in self.skills for s in required)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WorkOrder:
    order_id: str
    segment_id: str
    region: str
    latitude: float
    longitude: float
    urgency: str                    # immediate | scheduled | routine | monitor
    window_days: int
    est_days: float
    risk_score: float
    skills_required: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    is_hca: bool = False
    status: str = "unassigned"
    assigned_to: str | None = None
    travel_km: float = 0.0
    travel_days: float = 0.0

    def to_dict(self) -> dict:
        d = asdict(self)
        d["travel_km"] = round(self.travel_km, 1)
        d["travel_days"] = round(self.travel_days, 2)
        d["est_days"] = round(self.est_days, 1)
        d["risk_score"] = round(self.risk_score, 1)
        d["total_days"] = round(self.est_days + self.travel_days, 2)
        return d


@dataclass
class AssignmentResult:
    status: str
    optimal: bool
    orders: list[WorkOrder]
    technicians: list[dict]
    solve_ms: float
    assigned_count: int = 0
    unassigned_count: int = 0
    unassigned_immediate: int = 0
    total_travel_km: float = 0.0
    total_work_days: float = 0.0
    total_travel_days: float = 0.0
    risk_covered: float = 0.0
    risk_total: float = 0.0
    skill_gaps: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    message: str = ""
    # Set when the urgent-work requirement had to be dropped to produce any
    # schedule at all. Distinct from "some urgent work is unassigned": this
    # says the requirement itself was unsatisfiable by this roster.
    relaxed_immediate: bool = False
    # Per (region, trade) shortfall. The actionable form of "not enough
    # capacity" - total crew-days can be ample while a single trade in a
    # single region is the thing that fails.
    capacity_gaps: list[dict] = field(default_factory=list)

    @property
    def travel_share_pct(self) -> float:
        total = self.total_work_days + self.total_travel_days
        return 100 * self.total_travel_days / total if total else 0.0

    @property
    def risk_coverage_pct(self) -> float:
        return 100 * self.risk_covered / self.risk_total if self.risk_total else 0.0

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "optimal": self.optimal,
            "orders": [o.to_dict() for o in self.orders],
            "technicians": self.technicians,
            "solve_ms": round(self.solve_ms, 1),
            "assigned_count": self.assigned_count,
            "unassigned_count": self.unassigned_count,
            "unassigned_immediate": self.unassigned_immediate,
            "total_travel_km": round(self.total_travel_km, 1),
            "total_work_days": round(self.total_work_days, 1),
            "total_travel_days": round(self.total_travel_days, 1),
            "travel_share_pct": round(self.travel_share_pct, 1),
            "risk_covered": round(self.risk_covered, 1),
            "risk_total": round(self.risk_total, 1),
            "risk_coverage_pct": round(self.risk_coverage_pct, 1),
            "skill_gaps": self.skill_gaps,
            "relaxed_immediate": self.relaxed_immediate,
            "capacity_gaps": self.capacity_gaps,
            "warnings": self.warnings,
            "message": self.message,
        }


# ------------------------------------------------------------- roster ------

# A default field roster: two technicians per region from a depot at the
# region centroid, with complementary skills so most work is coverable
# locally but specialist jobs sometimes are not — which is the situation
# worth being able to see.
DEPOT_CREWS = [
    ("A", ("general", "coating", "mechanical", "operations"), "Coatings & mechanical"),
    ("B", ("general", "welding", "cathodic_protection", "composite_repair"), "Welding & CP"),
]


def default_technicians(regions, days_available: float = 20.0) -> list[Technician]:
    techs: list[Technician] = []
    for region in sorted(set(regions)):
        lat, lon = REGION_CENTROIDS.get(region, (39.83, -98.58))
        for suffix, skills, label in DEPOT_CREWS:
            techs.append(Technician(
                tech_id=f"{_region_code(region)}-{suffix}",
                name=f"{region} {label}",
                home_latitude=lat, home_longitude=lon,
                skills=skills, days_available=days_available, region=region,
            ))
    return techs


def _region_code(region: str) -> str:
    parts = [p for p in str(region).replace("-", " ").split() if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[1][0]).upper()
    return str(region)[:2].upper()


# ----------------------------------------------------------- assignment ----

def diagnose_capacity(orders, technicians) -> list[dict]:
    """Where capacity actually runs out, per (region, trade).

    Total crew-days can look ample while the schedule is still infeasible,
    because capacity is not fungible: a Western welder cannot do a Northern
    coating job, and neither can do the other's trade. The observed case had
    150 crew-days of urgent work against 200 available and still came back
    INFEASIBLE.

    "Add capacity" is not an actionable answer to that. "You need a second
    welder in the North Eastern zone" is.
    """
    buckets: dict[tuple, dict] = {}
    for order in orders:
        skill = order.skills_required[0] if order.skills_required else "general"
        key = (order.region, skill)
        b = buckets.setdefault(key, {
            "region": order.region, "skill": skill,
            "orders": 0, "urgent": 0, "work_days": 0.0, "travel_days": 0.0,
        })
        b["orders"] += 1
        b["work_days"] += order.est_days
        if order.urgency == "immediate":
            b["urgent"] += 1
        qualified = [t for t in technicians if t.can_do(order.skills_required)]
        if qualified:
            b["travel_days"] += min(
                travel_days(road_distance_km(order.latitude, order.longitude,
                                             t.home_latitude, t.home_longitude))
                for t in qualified)

    out = []
    for (region, skill), b in buckets.items():
        capable = [t for t in technicians
                   if (skill == "general" or skill in t.skills)
                   and (t.region is None or t.region == region)]
        available = sum(t.days_available for t in capable)
        needed = b["work_days"] + b["travel_days"]
        out.append({
            **b,
            "work_days": round(b["work_days"], 1),
            "travel_days": round(b["travel_days"], 1),
            "needed_days": round(needed, 1),
            "available_days": round(available, 1),
            "technicians": len(capable),
            "shortfall_days": round(max(0.0, needed - available), 1),
            "oversubscribed": needed > available,
        })
    out.sort(key=lambda r: -r["shortfall_days"])
    return out


def assign_work_orders(orders: list[WorkOrder], technicians: list[Technician],
                       travel_penalty_per_day: float = TRAVEL_PENALTY_PER_DAY,
                       max_solve_seconds: float = 10.0,
                       require_immediate: bool = True) -> AssignmentResult:
    """Assign work orders to technicians, minimising travel and maximising
    risk covered under each technician's crew-day budget.

    `require_immediate` makes immediate-urgency orders a hard requirement
    where capacity allows. Without it the solver may drop an urgent job in
    favour of two cheap nearby ones, which is arithmetically correct and
    operationally wrong.
    """
    warnings: list[str] = []

    if not orders:
        return AssignmentResult("NO_ORDERS", True, [], [], 0.0,
                                message="No work orders to assign.")
    if not technicians:
        return AssignmentResult(
            "NO_TECHNICIANS", False, orders, [], 0.0,
            unassigned_count=len(orders),
            risk_total=sum(o.risk_score for o in orders),
            message="No technicians available.",
        )

    # --- skill feasibility, checked before the model is built ---------------
    # A job nobody is certified for is not an optimisation outcome, it is a
    # staffing gap, and it must not look like the solver chose to skip it.
    skill_gaps: list[dict] = []
    coverable: list[WorkOrder] = []
    for order in orders:
        if any(t.can_do(order.skills_required) for t in technicians):
            coverable.append(order)
        else:
            missing = sorted(set(order.skills_required)
                             - {s for t in technicians for s in t.skills})
            order.status = "blocked"
            skill_gaps.append({
                "order_id": order.order_id, "segment_id": order.segment_id,
                "region": order.region, "missing_skills": missing,
                "urgency": order.urgency,
            })
    if skill_gaps:
        warnings.append(
            f"{len(skill_gaps)} work order(s) require skills no technician on "
            f"the roster holds. This is a staffing gap, not a scheduling "
            f"decision — they cannot be assigned at any capacity."
        )

    if not coverable:
        return AssignmentResult(
            "ALL_BLOCKED", False, orders,
            [t.to_dict() for t in technicians], 0.0,
            unassigned_count=len(orders),
            unassigned_immediate=sum(1 for o in orders if o.urgency == "immediate"),
            risk_total=sum(o.risk_score for o in orders),
            skill_gaps=skill_gaps, warnings=warnings,
            message="No work order can be covered by the available skills.",
        )

    # --- precompute travel --------------------------------------------------
    # distance[(order_index, tech_index)] -> (km, days)
    travel: dict[tuple[int, int], tuple[float, float]] = {}
    for oi, order in enumerate(coverable):
        for ti, tech in enumerate(technicians):
            if not tech.can_do(order.skills_required):
                continue
            km = road_distance_km(order.latitude, order.longitude,
                                  tech.home_latitude, tech.home_longitude)
            travel[(oi, ti)] = (km, travel_days(km))

    model = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for (oi, ti) in travel:
        order, tech = coverable[oi], technicians[ti]
        total_days = order.est_days + travel[(oi, ti)][1]
        # A job that cannot fit one technician's whole budget, travel
        # included, is not a candidate for that technician.
        if total_days > tech.days_available:
            continue
        x[(oi, ti)] = model.NewBoolVar(f"x_{oi}_{ti}")

    if not x:
        return AssignmentResult(
            "INFEASIBLE", False, orders,
            [t.to_dict() for t in technicians], 0.0,
            unassigned_count=len(orders),
            unassigned_immediate=sum(1 for o in orders if o.urgency == "immediate"),
            risk_total=sum(o.risk_score for o in orders),
            skill_gaps=skill_gaps, warnings=warnings,
            message=("Every work order costs more crew-days than any qualified "
                     "technician has available once travel is counted."),
        )

    # Each order to at most one technician.
    for oi in range(len(coverable)):
        vars_for = [v for (o, _), v in x.items() if o == oi]
        if vars_for:
            model.AddAtMostOne(vars_for)

    # Immediate work is required where a technician can physically take it.
    if require_immediate:
        for oi, order in enumerate(coverable):
            if order.urgency != "immediate":
                continue
            vars_for = [v for (o, _), v in x.items() if o == oi]
            if vars_for:
                model.AddExactlyOne(vars_for)

    # Capacity: work days AND travel days come out of the same budget.
    for ti, tech in enumerate(technicians):
        terms = []
        for (oi, t), v in x.items():
            if t != ti:
                continue
            cost = coverable[oi].est_days + travel[(oi, ti)][1]
            terms.append(int(round(cost * SCALE)) * v)
        if terms:
            model.Add(sum(terms) <= int(round(tech.days_available * SCALE)))

    # Objective: risk covered, less the cost of getting there.
    obj = []
    for (oi, ti), v in x.items():
        order = coverable[oi]
        value = order.risk_score * URGENCY_WEIGHT.get(order.urgency, 1.0)
        penalty = travel[(oi, ti)][1] * travel_penalty_per_day
        obj.append(int(round((value - penalty) * SCALE)) * v)
    model.Maximize(sum(obj))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_solve_seconds
    solver.parameters.num_search_workers = 8
    status = solver.Solve(model)
    status_name = solver.StatusName(status)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE) and require_immediate:
        # The hard requirement made the model infeasible. Returning nothing is
        # the worst possible answer - the operator learns that it failed, not
        # what the roster could have achieved.
        #
        # An earlier version emitted a warning saying "retrying without that
        # requirement will show what the roster CAN do" and then did not
        # retry. It now does, and reports the shortfall per region and trade
        # so the gap is actionable rather than just large.
        relaxed = assign_work_orders(
            orders, technicians,
            travel_penalty_per_day=travel_penalty_per_day,
            max_solve_seconds=max_solve_seconds,
            require_immediate=False,
        )
        gaps = [b for b in diagnose_capacity(orders, technicians)
                if b["oversubscribed"]]
        relaxed.warnings.insert(0,
            f"Urgent work cannot all be covered by this roster, so that "
            f"requirement was relaxed - this is the best achievable "
            f"assignment. {relaxed.unassigned_immediate} urgent order(s) "
            f"remain unassigned.")
        if gaps:
            detail = "; ".join(
                f"{b['region']} {b['skill'].replace('_', ' ')} needs "
                f"{b['needed_days']:.0f}d against {b['available_days']:.0f}d"
                for b in gaps[:3])
            relaxed.warnings.insert(1,
                f"Total crew-days are not the constraint - they are not "
                f"fungible across regions or trades. Shortfalls: {detail}.")
        relaxed.capacity_gaps = gaps
        relaxed.relaxed_immediate = True
        return relaxed

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return AssignmentResult(
            status_name, False, orders,
            [t.to_dict() for t in technicians], solver.WallTime() * 1000,
            unassigned_count=len(orders),
            unassigned_immediate=sum(1 for o in orders if o.urgency == "immediate"),
            risk_total=sum(o.risk_score for o in orders),
            skill_gaps=skill_gaps, warnings=warnings,
            message=f"Solver returned {status_name}.",
        )

    # --- read the solution back onto the orders -----------------------------
    per_tech: dict[str, dict] = {
        t.tech_id: {"tech_id": t.tech_id, "name": t.name, "region": t.region,
                    "skills": list(t.skills),
                    "days_available": round(t.days_available, 1),
                    "work_days": 0.0, "travel_days": 0.0, "travel_km": 0.0,
                    "orders": 0}
        for t in technicians
    }

    for (oi, ti), v in x.items():
        if not solver.Value(v):
            continue
        order, tech = coverable[oi], technicians[ti]
        km, days = travel[(oi, ti)]
        order.status = "assigned"
        order.assigned_to = tech.tech_id
        order.travel_km = km
        order.travel_days = days
        row = per_tech[tech.tech_id]
        row["work_days"] += order.est_days
        row["travel_days"] += days
        row["travel_km"] += km
        row["orders"] += 1

    for row in per_tech.values():
        row["work_days"] = round(row["work_days"], 1)
        row["travel_days"] = round(row["travel_days"], 2)
        row["travel_km"] = round(row["travel_km"], 1)
        row["days_used"] = round(row["work_days"] + row["travel_days"], 2)
        row["utilization_pct"] = round(
            100 * row["days_used"] / row["days_available"], 1
        ) if row["days_available"] else 0.0

    assigned = [o for o in orders if o.status == "assigned"]
    unassigned = [o for o in orders if o.status not in ("assigned", "complete")]
    unassigned_immediate = sum(1 for o in unassigned if o.urgency == "immediate")

    if unassigned_immediate:
        warnings.append(
            f"{unassigned_immediate} immediate-urgency order(s) could not be "
            f"assigned. These are segments already at or past their safe "
            f"operating limit."
        )

    total_travel_days = sum(o.travel_days for o in assigned)
    total_work_days = sum(o.est_days for o in assigned)
    if total_work_days and total_travel_days / (total_work_days + total_travel_days) > 0.35:
        warnings.append(
            f"Travel is {100*total_travel_days/(total_work_days+total_travel_days):.0f}% "
            f"of committed crew-days. Consider a depot nearer the work, or "
            f"batching by region."
        )

    return AssignmentResult(
        status=status_name,
        optimal=(status == cp_model.OPTIMAL),
        orders=orders,
        technicians=sorted(per_tech.values(), key=lambda r: r["tech_id"]),
        solve_ms=solver.WallTime() * 1000,
        assigned_count=len(assigned),
        unassigned_count=len(unassigned),
        unassigned_immediate=unassigned_immediate,
        total_travel_km=sum(o.travel_km for o in assigned),
        total_work_days=total_work_days,
        total_travel_days=total_travel_days,
        risk_covered=sum(o.risk_score for o in assigned),
        risk_total=sum(o.risk_score for o in orders),
        skill_gaps=skill_gaps,
        warnings=warnings,
        message=(
            f"{'Proven optimal' if status == cp_model.OPTIMAL else 'Feasible'} — "
            f"{len(assigned)} of {len(orders)} work orders assigned across "
            f"{sum(1 for r in per_tech.values() if r['orders'])} technicians."
        ),
    )


def work_orders_from_repair(segment: dict, repair_plan: dict) -> list[WorkOrder]:
    """Split a repair plan into dispatchable work orders, one per trade.

    WHY THIS SPLITS RATHER THAN RETURNING ONE ORDER:

      A plan that needs both recoating and a CP upgrade was initially emitted
      as a single order requiring both skills, and the assignment model then
      demanded one technician holding every certificate on it. On the real
      roster that is nobody, so 27 of 39 orders came back "blocked by skill
      gap" — a staffing conclusion produced entirely by a modelling mistake.

      Field work is not dispatched that way. A coatings crew and a CP crew are
      different trucks with different equipment. So actions are grouped by the
      trade that performs them, and each group becomes its own order that can
      go to a different technician on a different day.

    Actions sharing a skill stay bundled, because sending the same crew to the
    same location twice is the error in the other direction.
    """
    segment_id = segment.get("segment_id", "?")
    actions = repair_plan.get("actions", [])
    if not actions:
        return []

    by_skill: dict[str, list[dict]] = {}
    for action in actions:
        by_skill.setdefault(action.get("skill", "general"), []).append(action)

    # Risk is attributed to each order in full rather than divided. Splitting
    # it would make a two-trade segment look individually less important than
    # a one-trade segment of equal risk, which inverts the priority.
    risk = float(segment.get("risk_score", 0.0))

    orders: list[WorkOrder] = []
    for skill, group in sorted(by_skill.items()):
        orders.append(WorkOrder(
            order_id=f"WO-{segment_id}-{skill.upper()[:4]}",
            segment_id=segment_id,
            region=segment.get("region", ""),
            latitude=float(segment.get("latitude") or 0.0),
            longitude=float(segment.get("longitude") or 0.0),
            urgency=repair_plan.get("urgency", "routine"),
            window_days=int(repair_plan.get("window_days", 365)),
            est_days=float(sum(a.get("est_days", 0.0) for a in group)),
            risk_score=risk,
            skills_required=[skill] if skill != "general" else [],
            actions=[a.get("code", "") for a in group],
            is_hca=bool(segment.get("is_hca", False)),
        ))
    return orders


def work_order_from_repair(segment: dict, repair_plan: dict,
                           order_id: str | None = None) -> WorkOrder:
    """Single-order form, kept for callers that want one row per segment.

    Requires one technician to hold every skill on the plan, so prefer
    `work_orders_from_repair` for anything that will actually be dispatched.
    """
    segment_id = segment.get("segment_id", "?")
    return WorkOrder(
        order_id=order_id or f"WO-{segment_id}",
        segment_id=segment_id,
        region=segment.get("region", ""),
        latitude=float(segment.get("latitude") or 0.0),
        longitude=float(segment.get("longitude") or 0.0),
        urgency=repair_plan.get("urgency", "routine"),
        window_days=int(repair_plan.get("window_days", 365)),
        est_days=float(repair_plan.get("total_est_days", 1.0)),
        risk_score=float(segment.get("risk_score", 0.0)),
        skills_required=list(repair_plan.get("skills_required", [])),
        actions=[a.get("code", "") for a in repair_plan.get("actions", [])],
        is_hca=bool(segment.get("is_hca", False)),
    )
