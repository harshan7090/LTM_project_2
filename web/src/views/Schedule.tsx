import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Cpu } from 'lucide-react';

import { api } from '../lib/api';
import type { ScheduleRequest, ScheduleResult } from '../lib/types';
import {
  Button, EmptyState, Module, Readout, RiskBadge, Sweep, cx, useToast,
} from '../components/ui';

const DEFAULTS: ScheduleRequest = {
  periods: 4,
  days_per_period: 20,
  crews_per_region: 1,
  candidate_limit: 120,
  region_locked: true,
  risk_bands: ['critical', 'elevated'],
};

export default function Schedule({ onOpenSegment }: { onOpenSegment: (id: string) => void }) {
  const toast = useToast();
  const [req, setReq] = useState<ScheduleRequest>(DEFAULTS);
  const [result, setResult] = useState<ScheduleResult | null>(null);

  const run = useMutation({
    mutationFn: () => api.schedule(req),
    onSuccess: (r) => {
      setResult(r);
      if (r.warnings.length) toast(r.warnings[0], 'error');
      else toast(`${statusLabel(r) === 'NEAR-OPTIMAL'
        ? `Near-optimal schedule (within ${r.optimality_gap_pct}%)`
        : r.optimal ? 'Optimal schedule' : 'Feasible schedule'} in ${r.solve_ms} ms`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const set = <K extends keyof ScheduleRequest>(k: K, v: ScheduleRequest[K]) =>
    setReq((r) => ({ ...r, [k]: v }));

  return (
    <div className="flex flex-col gap-3">
      <Module
        title="Solver Parameters"
        num="01"
        sub="CP-SAT · travel charged to the same crew-day budget"
        id="CP-SAT"
        right={
          <span className="label" style={{ fontSize: 9 }}>
            Maximise risk covered s.t. crew capacity
          </span>
        }
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
          <Field label="Periods (months)">
            <input
              type="number" min={1} max={12} value={req.periods}
              onChange={(e) => set('periods', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Crew-days per period">
            <input
              type="number" min={1} max={60} value={req.days_per_period}
              onChange={(e) => set('days_per_period', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Crews per region">
            <input
              type="number" min={1} max={5} value={req.crews_per_region}
              onChange={(e) => set('crews_per_region', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Candidate pool size">
            <input
              type="number" min={1} max={500} value={req.candidate_limit}
              onChange={(e) => set('candidate_limit', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Region locking">
            <label className="flex items-center gap-2 pt-2 text-[12px] text-muted">
              <input
                type="checkbox" checked={req.region_locked}
                onChange={(e) => set('region_locked', e.target.checked)}
                className="accent-accent"
              />
              Crews stay in region
            </label>
          </Field>
        </div>
        <Button className="mt-3" disabled={run.isPending} onClick={() => run.mutate()}>
          <Cpu size={13} /> {run.isPending ? 'Solving…' : 'Run optimiser'}
        </Button>
        {run.isPending && <div className="mt-3"><Sweep label="CP-SAT searching…" /></div>}
      </Module>

      {!result && !run.isPending && (
        <Module title="Inspection Schedule" num="02"
                sub="Statutory deadline is a hard constraint" id="OUT">
          <EmptyState>
            Set crew capacity and run the optimiser to generate a schedule.
          </EmptyState>
        </Module>
      )}

      {result && (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            <Readout label="Scheduled" value={result.scheduled_count} unit="seg" tone="accent" />
            <Readout label="Crew utilisation" value={result.utilization_pct} unit="%" />
            <Readout label="Risk covered" value={result.risk_coverage_pct} unit="%" tone="normal" />
            <Readout
              label="Critical uncovered"
              value={result.unscheduled_critical}
              tone={result.unscheduled_critical > 0 ? 'critical' : 'normal'}
            />
            <Readout
              label="HCA covered"
              value={result.hca_coverage_pct}
              unit="%"
              tone={result.missed_deadlines.length > 0 ? 'critical' : 'accent'}
            />
            <Readout label="Solve time" value={result.solve_ms} unit="ms" />
          </div>

          <div className="flex items-center gap-2 border border-line-soft bg-panel px-3 py-1.5">
            <span className={cx('lamp', solvedWell(result) ? 'text-normal' : 'text-elevated')} />
            <span className="label" style={{ color: solvedWell(result) ? 'var(--color-normal)' : 'var(--color-elevated)' }}>
              {statusLabel(result)}
            </span>
            <span className="text-[11.5px] text-muted">{result.message}</span>
          </div>

          {result.warnings.map((w, i) => (
            <div
              key={i}
              className="flex gap-2.5 border border-elevated/40 bg-elevated/10 px-3 py-2.5
                         text-[11.5px] leading-relaxed"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-elevated" />
              <span>{w}</span>
            </div>
          ))}

          {result.missed_deadlines.length > 0 && (
            <Module title="Statutory Deadline Not Met" id="REG">
              <p className="mb-2 text-[11.5px] leading-relaxed text-critical">
                These segments carry a reassessment deadline under 49 CFR
                192.939 / 195.452 that this schedule does not meet. That is a
                compliance exposure, not a prioritisation choice.
              </p>
              <ul className="flex flex-col gap-1 text-[11.5px]">
                {result.missed_deadlines.slice(0, 8).map((m) => (
                  <li key={m.segment_id} className="flex items-center gap-2 text-muted">
                    <span className="lamp lamp-critical" />
                    <span className="num text-ink">{m.segment_id}</span>
                    <span className="text-dim">{m.region}</span>
                    <div className="flex-1" />
                    <span className="num text-critical">
                      due period {(m.deadline_period ?? 0) + 1}
                    </span>
                    <span className="num text-dim">{m.est_days}d</span>
                  </li>
                ))}
                {result.missed_deadlines.length > 8 && (
                  <li className="text-dim">
                    …and {result.missed_deadlines.length - 8} more
                  </li>
                )}
              </ul>
            </Module>
          )}

          {result.oversized.length > 0 && (
            <Module title="Excluded — Package Exceeds One Crew-Period" id="OVR">
              <ul className="flex flex-col gap-1 text-[11.5px]">
                {result.oversized.slice(0, 6).map((o) => (
                  <li key={o.segment_id} className="flex items-center gap-2 text-muted">
                    <span className="num text-ink">{o.segment_id}</span>
                    <span className="num text-elevated">{o.est_days}d</span>
                    <span className="text-dim">needed vs</span>
                    <span className="num">{o.max_crew_days}d</span>
                    <span className="text-dim">available</span>
                  </li>
                ))}
                {result.oversized.length > 6 && (
                  <li className="text-dim">…and {result.oversized.length - 6} more</li>
                )}
              </ul>
            </Module>
          )}

          <Module title="Crew Load" num="03"
                  sub="One inspection crew per zone, working out of its depot" id="CREW">
            <div className="flex flex-col gap-2.5">
              {result.crews.map((c) => {
                const travel = c.travel_days ?? 0;
                const committed = c.days_committed ?? c.days_used + travel;
                const workPct = c.days_available ? (c.days_used / c.days_available) * 100 : 0;
                const travelPct = c.days_available ? (travel / c.days_available) * 100 : 0;
                return (
                  <div key={c.crew_id}>
                    <div className="mb-1 flex items-baseline justify-between gap-3">
                      <span className="flex items-baseline gap-2 text-[12px]">
                        <span className="num text-[10px] text-dim">{c.crew_id}</span>
                        {c.name}
                        {c.depot && (
                          <span className="label text-dim" style={{ fontSize: 8.5 }}>
                            {c.depot} depot
                          </span>
                        )}
                      </span>
                      <span className="num whitespace-nowrap text-[11px] text-muted">
                        {c.days_used}d work + {travel}d travel = {committed.toFixed(1)}/{c.days_available}d
                        <span className="text-dim"> · {c.segments} seg</span>
                      </span>
                    </div>
                    {/* Work and travel stacked: the solver charges both to the
                        same budget, so showing work alone understated the load. */}
                    <div className="relative flex h-[6px] bg-raised">
                      <div className="h-full bg-accent" style={{ width: `${Math.min(workPct, 100)}%` }} />
                      <div className="h-full bg-elevated/60"
                           style={{ width: `${Math.min(travelPct, 100 - Math.min(workPct, 100))}%` }} />
                      <span className="absolute inset-y-0 right-0 w-px bg-line" />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-2.5 text-[10.5px] text-dim">
              <span className="inline-block h-[6px] w-[14px] bg-accent" /> inspection work
              <span className="inline-block h-[6px] w-[14px] bg-elevated/60" /> travel from the depot
              <span className="ml-1">
                — each segment below is inspected by its zone&apos;s crew in the period shown.
              </span>
            </p>
          </Module>

          {Array.from({ length: result.periods }, (_, p) => {
            const inPeriod = result.assignments.filter((a) => a.period === p);
            if (!inPeriod.length) return null;
            return (
              <Module
                key={p}
                title={`Period ${p + 1}`}
                id={`P${p + 1}`}
                bodyClass=""
                right={
                  <span className="num text-[11px] text-muted">
                    {inPeriod.length} seg ·{' '}
                    {inPeriod.reduce((s, a) => s + a.est_days, 0).toFixed(1)} crew-days
                  </span>
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {['Segment', 'Region', 'Crew', 'Rate', 'Status', 'Days', 'Methods'].map((h) => (
                          <th
                            key={h}
                            className="label whitespace-nowrap border-b border-line-soft
                                       px-2.5 py-1.5 text-left"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {inPeriod.map((a) => (
                        <tr
                          key={a.segment_id}
                          onClick={() => onOpenSegment(a.segment_id)}
                          className={cx(
                            'cursor-pointer border-b border-line-soft last:border-0 hover:bg-raised',
                            a.risk_band === 'critical' &&
                              'shadow-[inset_2px_0_0_var(--color-critical)]',
                          )}
                        >
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[12px]">
                            {a.segment_id}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-[7px] text-[12px] text-muted">
                            {a.region}
                          </td>
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[10.5px] text-dim">
                            {a.crew_id}
                          </td>
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[12px]">
                            {a.predicted_rate_mpy.toFixed(2)}
                          </td>
                          <td className="px-2.5 py-[7px]"><RiskBadge band={a.risk_band} /></td>
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[12px] text-muted">
                            {a.est_days}
                          </td>
                          <td className="px-2.5 py-[7px]">
                            <div className="flex flex-wrap gap-1">
                              {a.methods.map((m) => (
                                <span
                                  key={m}
                                  className="num border border-line-soft px-1.5 py-px
                                             text-[9.5px] text-muted"
                                >
                                  {m}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Module>
            );
          })}
        </>
      )}
    </div>
  );
}

const INPUT =
  'num mt-1 w-full border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

/** Solved well: optimal, or proven within the solver's 1% gap limit.
 *  Anything looser is shown in the caution colour. */
function solvedWell(r: { optimal: boolean; optimality_gap_pct?: number | null }): boolean {
  return r.optimal || (r.optimality_gap_pct != null && r.optimality_gap_pct <= 1);
}

/** OPTIMAL only for a zero gap; a plan proven within the limit says so. */
function statusLabel(r: { status: string; optimal: boolean; optimality_gap_pct?: number | null }): string {
  if (r.optimal) return 'OPTIMAL';
  if (r.optimality_gap_pct != null && r.optimality_gap_pct <= 1) return 'NEAR-OPTIMAL';
  return r.status;
}
