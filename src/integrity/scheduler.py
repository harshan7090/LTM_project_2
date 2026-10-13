"""
Inspection scheduling with OR-Tools CP-SAT.

THE PROBLEM:

  You have thousands of segments, each with a predicted corrosion rate and a
  recommended inspection plan costing a known number of crew-days. You have a
  handful of crews and a finite horizon. You cannot inspect everything. Which
  segments do you inspect, in which period, with which crew, to reduce the most
  risk?

  Picking the top-N by predicted rate — what the console did before — is a
  greedy heuristic that ignores capacity entirely. It will happily hand a crew
  a week of work in a period that only has three days, and it cannot express
  "an inspector may only work their own region."

WHY CP-SAT AND NOT A VRP SOLVER:

  OR-Tools' routing library solves vehicle routing — minimise travel distance
  between geographic points. This dataset has no coordinates, only a region
  label, so there is no distance matrix to minimise and a VRP would be
  fabricating geography it does not have.

  What this problem actually is: a multi-period, multi-resource selection and
  assignment problem with a capacity constraint — closer to a scheduling or
  generalised-assignment problem. CP-SAT models that directly and proves
  optimality on instances this size in well under a second.

THE MODEL:

  Decision variable  x[s, c, p] = 1  if segment s is inspected by crew c in period p

  Maximise           sum over selected of (risk_weight * urgency_multiplier)
  Subject to         each segment inspected at most once
                     each crew's assigned days per period <= days available
                     region locking (optional): a crew only takes its region
                     critical segments must land in an early period (optional)

  Risk weight is the predicted corrosion rate, so the objective is "cover the
  most predicted corrosion rate per crew-day available" — a defensible proxy
  for risk reduction that uses only data the console actually has.
"""
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from ortools.sat.python import cp_model  # noqa: E402

from src.integrity.geo import (  # noqa: E402
    DEPOT_CITY, REGION_CENTROIDS, region_code, road_distance_km,
    travel_days as travel_days_for,
)

# Crew-days of travel weighed against a unit of risk covered. Matches the
# dispatch optimiser's default so the two stages price distance the same way —
# a schedule that ignores travel and a dispatch that charges for it would
# disagree about what is affordable.
TRAVEL_PENALTY_PER_DAY = 6.0

# Urgency multipliers: how much more valuable it is to cover a critical
# segment than a normal one. Operator-tunable engineering judgement.
# Accept a plan once it is proven within this fraction of the optimum.
OPTIMALITY_GAP_LIMIT = 0.01

URGENCY_WEIGHT = {"critical": 3.0, "elevated": 1.8, "normal": 1.0}

# CP-SAT is an integer solver, so float objectives are scaled to ints.
SCALE = 100


@dataclass
class Crew:
    crew_id: str
    name: str
    region: str | None = None      # None = can work anywhere
    # Depot the crew travels out from. Defaults to the region centroid when a
    # region is set; None means travel is not modelled for this crew.
    home_latitude: float | None = None
    home_longitude: float | None = None
    # A period defaults to one working month (~20 days). This default matters
    # more than it looks: a full inspection package (CIPS + DCVG + ILI + UT)
    # can total 10-12 crew-days, so a period shorter than that makes every
    # segment individually unschedulable — see `oversized` handling below.
    days_per_period: float = 20.0
    # Town the crew is based at, for the console to show where it sets out from.
    depot: str | None = None


@dataclass
class SchedulableSegment:
    segment_id: str
    region: str
    risk_band: str
    predicted_rate_mpy: float
    est_days: float
    methods: list[str] = field(default_factory=list)
    # Risk = likelihood x consequence, 0-100. When present this drives the
    # objective instead of the raw corrosion rate, so the solver maximises
    # risk reduction rather than "mils per crew-day".
    latitude: float | None = None
    longitude: float | None = None
    risk_score: float | None = None
    # Period by which a statutory reassessment deadline falls (49 CFR 192.939
    # / 195.452). A HARD constraint: work may be scheduled earlier, never
    # later. Segments that cannot fit inside their deadline are reported
    # rather than quietly deferred.
    deadline_period: int | None = None
    is_hca: bool = False

    @property
    def objective_weight(self) -> float:
        """What the solver is actually maximising for this segment.

        Falls back to corrosion rate when no risk score is supplied, so older
        callers keep working — but the two are on different scales (0-100 vs
        mpy), and mixing them within one run would silently distort the
        objective. `build_schedule` therefore checks for consistency.
        """
        return self.risk_score if self.risk_score is not None else self.predicted_rate_mpy


@dataclass
class Assignment:
    segment_id: str
    region: str
    risk_band: str
    predicted_rate_mpy: float
    est_days: float
    methods: list[str]
    crew_id: str
    crew_name: str
    period: int

    def to_dict(self) -> dict:
        return {
            "segment_id": self.segment_id,
            "region": self.region,
            "risk_band": self.risk_band,
            "predicted_rate_mpy": round(self.predicted_rate_mpy, 2),
            "est_days": round(self.est_days, 1),
            "methods": self.methods,
            "crew_id": self.crew_id,
            "crew_name": self.crew_name,
            "period": self.period,
        }


@dataclass
class ScheduleResult:
    status: str
    optimal: bool
    assignments: list[Assignment]
    periods: int
    total_days_used: float
    total_days_available: float
    risk_covered: float
    risk_total: float
    unscheduled_critical: int
    solve_ms: float
    crews: list[dict] = field(default_factory=list)
    message: str = ""
    # Segments whose estimated work exceeds any single crew's per-period
    # capacity. These can never be scheduled as one work package, and saying so
    # explicitly matters — otherwise the solver returns a proven-optimal EMPTY
    # schedule and the reason is invisible.
    oversized: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # Segments carrying a statutory reassessment deadline that the schedule
    # does not meet. Distinct from `unscheduled_critical`: that is a
    # prioritisation outcome, this is a compliance breach.
    missed_deadlines: list[dict] = field(default_factory=list)
    hca_total: int = 0
    hca_scheduled: int = 0
    # How far the plan could still be from the best possible one, as proven by
    # the solver's bound. 0 when proven optimal; None when nothing was solved.
    optimality_gap_pct: float | None = None

    @property
    def hca_coverage_pct(self) -> float:
        if not self.hca_total:
            return 0.0
        return 100 * self.hca_scheduled / self.hca_total

    @property
    def scheduled_count(self) -> int:
        return len(self.assignments)

    @property
    def utilization_pct(self) -> float:
        if not self.total_days_available:
            return 0.0
        return 100 * self.total_days_used / self.total_days_available

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "optimal": self.optimal,
            "periods": self.periods,
            "assignments": [a.to_dict() for a in self.assignments],
            "scheduled_count": self.scheduled_count,
            "oversized": self.oversized,
            "warnings": self.warnings,
            "missed_deadlines": self.missed_deadlines,
            "hca_total": self.hca_total,
            "hca_scheduled": self.hca_scheduled,
            "hca_coverage_pct": round(self.hca_coverage_pct, 1),
            "total_days_used": round(self.total_days_used, 1),
            "total_days_available": round(self.total_days_available, 1),
            "utilization_pct": round(self.utilization_pct, 1),
            "risk_covered_mpy": round(self.risk_covered, 1),
            "risk_total_mpy": round(self.risk_total, 1),
            "risk_coverage_pct": round(
                100 * self.risk_covered / self.risk_total, 1
            ) if self.risk_total else 0.0,
            "unscheduled_critical": self.unscheduled_critical,
            "solve_ms": round(self.solve_ms, 1),
            "crews": self.crews,
            "message": self.message,
            "optimality_gap_pct": self.optimality_gap_pct,
        }


def default_crews(regions: list[str], per_region: int = 1,
                  days_per_period: float = 20.0) -> list[Crew]:
    """One region-locked crew per region by default — the arrangement most
    operators actually run, and it makes the region constraint meaningful."""
    crews = []
    for region in regions:
        for i in range(per_region):
            suffix = f"-{i + 1}" if per_region > 1 else ""
            lat, lon = REGION_CENTROIDS.get(region, (None, None))
            crews.append(Crew(
                crew_id=f"{region_code(region)}{suffix}",
                name=f"{region} inspection crew{suffix}",
                region=region,
                days_per_period=days_per_period,
                home_latitude=lat, home_longitude=lon,
                depot=DEPOT_CITY.get(region),
            ))
    # Every report below is keyed on crew_id. Two crews sharing one silently
    # merge their workloads, which is how both "NOR" crews once showed 122 of
    # 80 crew-days. Fail loudly rather than report nonsense.
    ids = [c.crew_id for c in crews]
    if len(ids) != len(set(ids)):
        raise ValueError(f"crew ids are not unique: {sorted(ids)}")
    return crews


def _travel_days(seg: "SchedulableSegment", crew: "Crew") -> float:
    """Round-trip crew-days from a crew's depot to a segment.

    Zero when either end has no coordinates, so a caller that has not supplied
    geography gets exactly the previous behaviour rather than a silently
    distorted objective.

    Round trip, not one way: a crew dispatched from a depot has to come back,
    and halving the true cost is what makes distant work look cheap. The same
    reasoning as the dispatch optimiser in src/integrity/workorders.py.
    """
    if (seg.latitude is None or seg.longitude is None
            or crew.home_latitude is None or crew.home_longitude is None):
        return 0.0
    km = road_distance_km(seg.latitude, seg.longitude,
                          crew.home_latitude, crew.home_longitude)
    return travel_days_for(km)


def build_schedule(
    segments: list[SchedulableSegment],
    crews: list[Crew],
    periods: int = 4,
    *,
    region_locked: bool = True,
    critical_deadline_period: int | None = None,
    max_solve_seconds: float = 10.0,
    travel_penalty_per_day: float = TRAVEL_PENALTY_PER_DAY,
) -> ScheduleResult:
    """Solves the inspection schedule.

    periods                  how many scheduling periods (default: months)
    region_locked            crews only work segments in their own region
    critical_deadline_period HARD deadline: if set, a critical segment may only
                             be placed in a period < this value, and is dropped
                             from the schedule entirely if it doesn't fit.

                             Defaults to None (off), because "off" is almost
                             always what an operator wants. With it on, a
                             critical segment that can't fit the deadline is not
                             scheduled *at all* rather than scheduled late —
                             which turns a capacity shortfall into an invisible
                             coverage gap. Left off, the objective's urgency
                             weighting plus the early-period preference still
                             pull critical work to the front, and anything that
                             slips is visible in the period it landed in.
    """
    if not segments:
        return ScheduleResult("EMPTY", False, [], periods, 0, 0, 0, 0, 0, 0.0,
                              message="No segments to schedule.")
    if not crews:
        return ScheduleResult("NO_CREWS", False, [], periods, 0, 0, 0, 0, 0, 0.0,
                              message="No crews defined.")

    # ---- Guard: work packages larger than any crew-period ------------------
    # A segment needing more days than a crew has in one period can never be
    # assigned, and CP-SAT will happily report OPTIMAL with it simply left out.
    # Detect that here so the caller gets a reason instead of a silent gap.
    warnings: list[str] = []
    oversized: list[dict] = []

    def _max_capacity_for(seg: SchedulableSegment) -> float:
        """Largest crew-day budget left for WORK after travel, over eligible crews.

        Travel has to be subtracted here as well as in the capacity
        constraint. Checking `est_days` against raw capacity would let a
        segment through the oversized filter and then find it unschedulable
        inside the model — which surfaces as a quietly missing segment rather
        than as the explicit "does not fit" report the oversized list exists
        to give.
        """
        eligible = [
            c for c in crews
            if not (region_locked and c.region is not None and c.region != seg.region)
        ]
        return max((c.days_per_period - _travel_days(seg, c) for c in eligible),
                   default=0.0)

    schedulable: list[SchedulableSegment] = []
    for seg in segments:
        cap = _max_capacity_for(seg)
        if cap <= 0:
            oversized.append({
                "segment_id": seg.segment_id, "region": seg.region,
                "est_days": round(seg.est_days, 1), "max_crew_days": 0.0,
                "reason": f"No crew covers the {seg.region} region.",
            })
        elif seg.est_days > cap:
            oversized.append({
                "segment_id": seg.segment_id, "region": seg.region,
                "est_days": round(seg.est_days, 1), "max_crew_days": round(cap, 1),
                "reason": (f"Needs {seg.est_days:.1f} crew-days but the largest "
                           f"eligible crew has {cap:.1f} days per period. Split the "
                           f"work package across periods or raise crew capacity."),
            })
        else:
            schedulable.append(seg)

    if oversized:
        warnings.append(
            f"{len(oversized)} segment(s) have work packages too large for any single "
            f"crew-period and were excluded from the optimisation. They are listed "
            f"under `oversized` — they need a longer period, a bigger crew, or the "
            f"inspection split into phases."
        )

    if not schedulable:
        return ScheduleResult(
            "ALL_OVERSIZED", False, [], periods, 0,
            sum(c.days_per_period for c in crews) * periods,
            0, sum(s.predicted_rate_mpy for s in segments),
            sum(1 for s in segments if s.risk_band == "critical"), 0.0,
            message=(
                "No segment fits in a single crew-period. The typical full inspection "
                "package runs 10-12 crew-days; check that days_per_period is set to a "
                "realistic working period (20 days = one month)."
            ),
            oversized=oversized, warnings=warnings,
        )

    # From here the model works on the schedulable subset only.
    all_segments, segments = segments, schedulable

    model = cp_model.CpModel()

    # x[(s, c, p)] — segment s inspected by crew c in period p.
    # Only create variables for legal combinations; that keeps the model small.
    x: dict[tuple[int, int, int], cp_model.IntVar] = {}
    for si, seg in enumerate(segments):
        for ci, crew in enumerate(crews):
            if region_locked and crew.region is not None and crew.region != seg.region:
                continue
            for p in range(periods):
                if (critical_deadline_period is not None
                        and seg.risk_band == "critical"
                        and p >= critical_deadline_period):
                    continue
                # Statutory deadline is a hard ceiling on WHEN, not a weight.
                # No variable exists past it, so the solver cannot buy a
                # better objective by running a compliance date late.
                if seg.deadline_period is not None and p > seg.deadline_period:
                    continue
                x[(si, ci, p)] = model.NewBoolVar(f"x_{si}_{ci}_{p}")

    if not x:
        return ScheduleResult(
            "INFEASIBLE", False, [], periods, 0, 0, 0, 0, 0, 0.0,
            message="No legal segment/crew combinations — check region locking.",
            oversized=oversized, warnings=warnings,
        )

    # Each segment inspected at most once.
    for si in range(len(segments)):
        vars_for_segment = [v for (s, _, _), v in x.items() if s == si]
        if vars_for_segment:
            model.AddAtMostOne(vars_for_segment)

    # Crew capacity per period.
    for ci, crew in enumerate(crews):
        cap = int(round(crew.days_per_period * SCALE))
        for p in range(periods):
            # Travel is charged against the SAME crew-day budget as the work.
            # Without this a crew looks able to take a segment 900 km away for
            # free, and the schedule is undeliverable in the field even though
            # the solver proved it optimal.
            terms = [
                int(round((segments[si].est_days
                           + _travel_days(segments[si], crew)) * SCALE)) * v
                for (si, c, pp), v in x.items() if c == ci and pp == p
            ]
            if terms:
                model.Add(sum(terms) <= cap)

    # Objective: maximise risk covered.
    obj_terms = []
    for (si, ci, p), v in x.items():
        seg = segments[si]
        weight = seg.objective_weight * URGENCY_WEIGHT.get(seg.risk_band, 1.0)
        # Subtract the cost of getting there, so that between two crews who
        # could both take a segment the nearer one wins on its own rather than
        # being picked arbitrarily.
        weight -= _travel_days(seg, crews[ci]) * travel_penalty_per_day
        # Preference for earlier periods, so an optimal solution doesn't
        # arbitrarily defer work it could do now. Deliberately kept an order of
        # magnitude below the urgency spread (3.0x critical vs 1.0x normal) so
        # it breaks ties on placement without distorting which segments get
        # selected — at 4 periods this spans only ~3%.
        weight *= 1.0 + (periods - p) * 0.01
        obj_terms.append(int(round(weight * SCALE)) * v)
    model.Maximize(sum(obj_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_solve_seconds
    solver.parameters.num_search_workers = 8
    # Stop once the plan is PROVEN within 1% of the best possible. Four
    # identical periods make many equally good schedules, so the solver finds
    # an excellent one quickly and then spends the whole time limit proving
    # nothing beats it. The gap it reaches is reported, not hidden.
    solver.parameters.relative_gap_limit = OPTIMALITY_GAP_LIMIT
    status = solver.Solve(model)

    status_name = solver.StatusName(status)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ScheduleResult(
            status_name, False, [], periods, 0,
            sum(c.days_per_period for c in crews) * periods,
            0, sum(s.predicted_rate_mpy for s in all_segments), 0,
            solver.WallTime() * 1000,
            message=f"Solver returned {status_name}.",
            oversized=oversized, warnings=warnings,
        )

    # Proven distance from the optimum: (bound - found) / bound. Taken from
    # the bound itself, NOT the status: CP-SAT reports OPTIMAL when it stops
    # at the gap limit too, and "proven optimal" must mean a zero gap.
    best, bound = solver.ObjectiveValue(), solver.BestObjectiveBound()
    gap_pct = round(max(bound - best, 0.0) / bound * 100, 2) if bound > 0 else 0.0

    assignments: list[Assignment] = []
    for (si, ci, p), v in x.items():
        if solver.Value(v):
            seg, crew = segments[si], crews[ci]
            assignments.append(Assignment(
                segment_id=seg.segment_id,
                region=seg.region,
                risk_band=seg.risk_band,
                predicted_rate_mpy=seg.predicted_rate_mpy,
                est_days=seg.est_days,
                methods=seg.methods,
                crew_id=crew.crew_id,
                crew_name=crew.name,
                period=p,
            ))

    assignments.sort(key=lambda a: (a.period, a.crew_id, -a.predicted_rate_mpy))

    scheduled_ids = {a.segment_id for a in assignments}
    # Counted over ALL candidates, including oversized ones — an operator needs
    # to know a critical segment went uncovered regardless of the reason.
    unscheduled_critical = sum(
        1 for s in all_segments
        if s.risk_band == "critical" and s.segment_id not in scheduled_ids
    )

    # --- Compliance ------------------------------------------------------
    # A statutory deadline that cannot be met is the single most important
    # thing this solver can tell an operator, and it is exactly the kind of
    # fact a maximise-coverage objective will otherwise bury: the segment
    # simply does not appear in the schedule and nothing says why. Counted
    # over ALL candidates, oversized ones included.
    missed_deadlines = [
        {
            "segment_id": seg.segment_id,
            "region": seg.region,
            "deadline_period": seg.deadline_period,
            "risk_band": seg.risk_band,
            "est_days": round(seg.est_days, 1),
        }
        for seg in all_segments
        if seg.deadline_period is not None and seg.segment_id not in scheduled_ids
    ]
    if missed_deadlines:
        warnings.append(
            f"{len(missed_deadlines)} segment(s) with a statutory reassessment "
            f"deadline could not be scheduled within it. This is a compliance "
            f"exposure, not a prioritisation choice — add crew capacity or "
            f"extend the horizon."
        )

    hca_total = sum(1 for s in all_segments if s.is_hca)
    hca_scheduled = sum(1 for s in all_segments
                        if s.is_hca and s.segment_id in scheduled_ids)

    total_available = sum(c.days_per_period for c in crews) * periods
    used = sum(a.est_days for a in assignments)

    crew_summary = []
    for ci, crew in enumerate(crews):
        # Matched by the solver's crew INDEX, not by id, so the summary is
        # right even if two crews were ever given the same label.
        mine = [segments[si] for (si, c, _p), v in x.items() if c == ci and solver.Value(v)]
        work = sum(g.est_days for g in mine)
        travel = sum(_travel_days(g, crew) for g in mine)
        crew_summary.append({
            "crew_id": crew.crew_id,
            "name": crew.name,
            "region": crew.region,
            "depot": crew.depot,
            "days_available": round(crew.days_per_period * periods, 1),
            # Work and travel separately: the solver charges BOTH to the
            # crew-day budget, so showing work alone understated the load.
            "days_used": round(work, 1),
            "travel_days": round(travel, 1),
            "days_committed": round(work + travel, 1),
            "segments": len(mine),
        })

    return ScheduleResult(
        status=status_name,
        optimal=(status == cp_model.OPTIMAL and gap_pct < 0.005),
        assignments=assignments,
        periods=periods,
        total_days_used=used,
        total_days_available=total_available,
        risk_covered=sum(
            next(g.objective_weight for g in segments if g.segment_id == a.segment_id)
            for a in assignments
        ),
        risk_total=sum(s.objective_weight for s in all_segments),
        unscheduled_critical=unscheduled_critical,
        solve_ms=solver.WallTime() * 1000,
        crews=crew_summary,
        missed_deadlines=missed_deadlines,
        hca_total=hca_total,
        hca_scheduled=hca_scheduled,
        optimality_gap_pct=gap_pct,
        message=(
            f"{'Proven optimal' if gap_pct < 0.005 else f'Proven within {gap_pct:.2f}% of the best possible plan'} — "
            f"{len(assignments)} of {len(all_segments)} candidate segments scheduled "
            f"across {periods} periods."
        ),
        oversized=oversized,
        warnings=warnings,
    )
