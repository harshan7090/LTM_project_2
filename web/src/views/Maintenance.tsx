import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Truck, UserX } from 'lucide-react';

import { api } from '../lib/api';
import type {
  AssignmentResult, CapacityGap, WorkOrder, WorkOrderRequest,
} from '../lib/types';
import {
  Button, EmptyState, Module, Readout, RiskBadge, Sweep, cx, useToast,
} from '../components/ui';

const DEFAULTS: WorkOrderRequest = {
  candidate_limit: 40,
  days_available: 20,
  travel_penalty_per_day: 6,
  risk_bands: ['critical', 'elevated'],
  require_immediate: true,
};

const URGENCY_TONE: Record<string, string> = {
  immediate: 'text-critical',
  scheduled: 'text-elevated',
  routine: 'text-normal',
  monitor: 'text-muted',
};

const STATUS_TONE: Record<string, string> = {
  assigned: 'text-normal',
  unassigned: 'text-muted',
  blocked: 'text-critical',
  in_progress: 'text-accent',
  complete: 'text-dim',
};

export default function Maintenance({ onOpenSegment }: { onOpenSegment: (id: string) => void }) {
  const toast = useToast();
  const [req, setReq] = useState<WorkOrderRequest>(DEFAULTS);
  const [result, setResult] = useState<AssignmentResult | null>(null);
  const [tab, setTab] = useState<'board' | 'crew'>('board');

  const run = useMutation({
    mutationFn: () => api.assignWorkOrders(req),
    onSuccess: (r) => {
      setResult(r);
      if (r.skill_gaps.length) toast(`${r.skill_gaps.length} orders blocked — skill gap`, 'error');
      else if (r.unassigned_immediate) toast(`${r.unassigned_immediate} urgent orders unassigned`, 'error');
      else toast(`${r.assigned_count} orders dispatched in ${r.solve_ms} ms`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const set = <K extends keyof WorkOrderRequest>(k: K, v: WorkOrderRequest[K]) =>
    setReq((r) => ({ ...r, [k]: v }));

  const byTech = (result?.orders ?? []).reduce<Record<string, WorkOrder[]>>((acc, o) => {
    if (o.status !== 'assigned' || !o.assigned_to) return acc;
    (acc[o.assigned_to] = acc[o.assigned_to] ?? []).push(o);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-3">
      <Module
        title="Dispatch Parameters"
        num="01"
        sub="CP-SAT · orders split by trade"
        id="CP-SAT"
        right={
          <span className="label" style={{ fontSize: 9 }}>
            Maximise risk repaired, less travel cost
          </span>
        }
      >
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))]">
          <Field label="Candidate segments">
            <input
              type="number" min={1} max={200} value={req.candidate_limit}
              onChange={(e) => set('candidate_limit', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Crew-days each">
            <input
              type="number" min={1} max={60} value={req.days_available}
              onChange={(e) => set('days_available', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Travel penalty / day">
            {/* The cost-efficiency knob. Raise it and the optimiser clusters
                work tightly, leaving distant risk uncovered; lower it and it
                chases risk across the map. */}
            <input
              type="number" min={0} max={100} step={0.5}
              value={req.travel_penalty_per_day}
              onChange={(e) => set('travel_penalty_per_day', Number(e.target.value))}
              className={INPUT}
            />
          </Field>
          <Field label="Urgent work">
            <label className="flex items-center gap-2 pt-2 text-[12px] text-muted">
              <input
                type="checkbox" checked={req.require_immediate}
                onChange={(e) => set('require_immediate', e.target.checked)}
                className="accent-accent"
              />
              Must be covered
            </label>
          </Field>
        </div>
        <Button className="mt-3" disabled={run.isPending} onClick={() => run.mutate()}>
          <Truck size={13} /> {run.isPending ? 'Dispatching…' : 'Build & assign work orders'}
        </Button>
        {run.isPending && <div className="mt-3"><Sweep label="Optimising assignment…" /></div>}
      </Module>

      {!result && !run.isPending && (
        <Module title="Work Orders" num="02"
                sub="Assigned to the nearest qualified crew" id="WO">
          <EmptyState>
            Repair plans are generated from the highest-risk segments, split by
            trade, then assigned to the nearest qualified technician.
          </EmptyState>
        </Module>
      )}

      {result && (
        <>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            <Readout label="Dispatched" value={result.assigned_count} unit="WO" tone="accent" />
            <Readout label="Risk repaired" value={result.risk_coverage_pct} unit="%" tone="normal" />
            <Readout
              label="Travel share"
              value={result.travel_share_pct}
              unit="%"
              tone={result.travel_share_pct > 35 ? 'elevated' : undefined}
            />
            <Readout label="Distance" value={Math.round(result.total_travel_km)} unit="km" />
            <Readout
              label="Urgent uncovered"
              value={result.unassigned_immediate}
              tone={result.unassigned_immediate > 0 ? 'critical' : 'normal'}
            />
            <Readout label="Solve time" value={result.solve_ms} unit="ms" />
          </div>

          <div className="flex items-center gap-2 border border-line-soft bg-panel px-3 py-1.5">
            <span className={cx('lamp', result.optimal ? 'text-normal' : 'text-elevated')} />
            <span
              className="label"
              style={{ color: result.optimal ? 'var(--color-normal)' : 'var(--color-elevated)' }}
            >
              {result.status}
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

          {/* Where capacity actually ran out. Total crew-days are usually
              ample; a single trade in a single region is what fails, and
              "add capacity" is not actionable while "add a second coating
              crew in the Western zone" is. */}
          {result.capacity_gaps.length > 0 && (
            <Module title="Capacity Shortfall by Trade" num="03"
                    sub="Where the solver came closest to running out" id="GAP">
              <p className="mb-2.5 text-[11.5px] leading-relaxed text-muted">
                {result.relaxed_immediate
                  ? 'Urgent work could not all be covered, so that requirement was relaxed. '
                  : ''}
                Crew-days are not fungible across regions or trades — these are
                the buckets that ran out.
              </p>
              <div className="flex flex-col gap-1.5">
                {result.capacity_gaps.slice(0, 6).map((g: CapacityGap) => {
                  const pct = Math.min((g.needed_days / Math.max(g.available_days, 1)) * 100, 300);
                  return (
                    <div key={`${g.region}-${g.skill}`}>
                      <div className="mb-1 flex items-baseline justify-between text-[11.5px]">
                        <span className="flex items-baseline gap-2">
                          <span className="text-ink">{g.region}</span>
                          <span className="label text-dim" style={{ fontSize: 9 }}>
                            {g.skill.replace(/_/g, ' ')}
                          </span>
                        </span>
                        <span className="num text-muted">
                          <span className="text-critical">{g.needed_days}d</span>
                          {' needed / '}{g.available_days}d available
                          <span className="text-dim"> · {g.technicians} tech</span>
                        </span>
                      </div>
                      {/* Bar overflows its track when demand exceeds supply —
                          the overflow IS the message. */}
                      <div className="relative h-[6px] bg-raised">
                        <div className="absolute inset-y-0 left-0 bg-normal/50"
                             style={{ width: `${Math.min(100 / (pct / 100), 100)}%` }} />
                        <div className="absolute inset-y-0 left-0 border-r-2 border-critical bg-critical/30"
                             style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 border-t border-line-soft pt-2.5 text-[10.5px] leading-relaxed text-dim">
                Worst bucket: <span className="num text-ink">
                  {result.capacity_gaps[0].region} {result.capacity_gaps[0].skill.replace(/_/g, ' ')}
                </span>, short <span className="num text-critical">
                  {result.capacity_gaps[0].shortfall_days}d
                </span>. Adding one technician there covers roughly 20 crew-days.
              </p>
            </Module>
          )}

          {/* A skill gap is a staffing fact, not a scheduling outcome, so it
              gets its own panel rather than sitting among unassigned work. */}
          {result.skill_gaps.length > 0 && (
            <Module title="Blocked — No Certified Technician" id="GAP">
              <p className="mb-2 text-[11.5px] leading-relaxed text-critical">
                These orders cannot be assigned at any capacity. The roster does
                not hold the certification they require.
              </p>
              <ul className="flex flex-col gap-1 text-[11.5px]">
                {result.skill_gaps.slice(0, 8).map((g) => (
                  <li key={g.order_id} className="flex items-center gap-2 text-muted">
                    <span className="lamp lamp-critical" />
                    <span className="num text-ink">{g.segment_id}</span>
                    <span className="text-dim">{g.region}</span>
                    <div className="flex-1" />
                    <span className="num text-critical">
                      needs {g.missing_skills.join(', ')}
                    </span>
                  </li>
                ))}
                {result.skill_gaps.length > 8 && (
                  <li className="text-dim">…and {result.skill_gaps.length - 8} more</li>
                )}
              </ul>
            </Module>
          )}

          <div className="flex gap-0 border-b border-line">
            {(['board', 'crew'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cx(
                  'relative px-3 py-2 font-[family-name:var(--font-label)] text-[11px]',
                  'uppercase tracking-[0.11em] transition-colors',
                  tab === t ? 'text-accent' : 'text-muted hover:text-ink',
                )}
              >
                {tab === t && <span className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-accent" />}
                {t === 'board' ? 'Work order board' : 'Crew load'}
              </button>
            ))}
          </div>

          {tab === 'crew' && (
            <Module title="Technician Utilisation" num="04"
                    sub="Share of available crew-days consumed" id="CREW">
              <div className="flex flex-col gap-2.5">
                {result.technicians.map((t) => {
                  const workPct = t.days_available
                    ? (t.work_days / t.days_available) * 100 : 0;
                  const travelPct = t.days_available
                    ? (t.travel_days / t.days_available) * 100 : 0;
                  return (
                    <div key={t.tech_id}>
                      <div className="mb-1 flex items-baseline justify-between">
                        <span className="flex items-baseline gap-2 text-[12px]">
                          <span className="num text-[10px] text-dim">{t.tech_id}</span>
                          {t.name}
                          <span className="label text-dim" style={{ fontSize: 8.5 }}>
                            {t.skills.filter((s) => s !== 'general').join(' · ')}
                          </span>
                        </span>
                        <span className="num text-[11px] text-muted">
                          {t.orders} WO · {t.days_used}/{t.days_available}d
                          <span className="text-dim"> · {Math.round(t.travel_km)} km</span>
                        </span>
                      </div>
                      {/* Work and travel stacked in one bar — the split is the
                          point, since travel is capacity that produces nothing. */}
                      <div className="relative flex h-[6px] bg-raised">
                        <div className="h-full bg-accent" style={{ width: `${Math.min(workPct, 100)}%` }} />
                        <div
                          className="h-full bg-elevated/60"
                          style={{ width: `${Math.min(travelPct, 100 - Math.min(workPct, 100))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 flex items-center gap-2 border-t border-line-soft pt-2.5
                            text-[10.5px] text-dim">
                <span className="inline-block h-[6px] w-[14px] bg-accent" /> work
                <span className="inline-block h-[6px] w-[14px] bg-elevated/60" /> travel
                <span className="ml-1">
                  — travel is charged to the same crew-day budget, which is what
                  makes proximity matter to the optimiser.
                </span>
              </p>
            </Module>
          )}

          {tab === 'board' && Object.entries(byTech).map(([techId, orders]) => {
            const tech = result.technicians.find((t) => t.tech_id === techId);
            return (
              <Module
                key={techId}
                title={tech?.name ?? techId}
                id={techId}
                bodyClass=""
                right={
                  <span className="num text-[11px] text-muted">
                    {orders.length} WO · {tech?.days_used}d · {Math.round(tech?.travel_km ?? 0)} km
                  </span>
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        {['Order', 'Segment', 'Actions', 'Urgency', 'Risk', 'Work', 'Travel', 'Status'].map((h) => (
                          <th
                            key={h}
                            className="label whitespace-nowrap border-b border-line-soft px-2.5 py-1.5 text-left"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr
                          key={o.order_id}
                          onClick={() => onOpenSegment(o.segment_id)}
                          className={cx(
                            'cursor-pointer border-b border-line-soft last:border-0 hover:bg-raised',
                            o.urgency === 'immediate' &&
                              'shadow-[inset_2px_0_0_var(--color-critical)]',
                          )}
                        >
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[10.5px] text-dim">
                            {o.order_id}
                          </td>
                          <td className="whitespace-nowrap px-2.5 py-[7px]">
                            <span className="num text-[12px]">{o.segment_id}</span>
                            {o.is_hca && (
                              <span
                                className="label ml-1.5 border border-accent/50 px-1 text-accent"
                                style={{ fontSize: 8 }}
                              >
                                HCA
                              </span>
                            )}
                          </td>
                          <td className="px-2.5 py-[7px]">
                            <div className="flex flex-wrap gap-1">
                              {o.actions.map((a) => (
                                <span
                                  key={a}
                                  className="num border border-line-soft px-1.5 py-px text-[9.5px] text-muted"
                                >
                                  {a}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className={cx('px-2.5 py-[7px]', URGENCY_TONE[o.urgency])}>
                            <span className="label" style={{ color: 'inherit', fontSize: 9 }}>
                              {o.urgency}
                            </span>
                          </td>
                          <td className="px-2.5 py-[7px]"><RiskBadge band={
                            o.risk_score >= 55 ? 'critical' : o.risk_score >= 30 ? 'elevated' : 'normal'
                          } /></td>
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[12px]">
                            {o.est_days}d
                          </td>
                          <td className="num whitespace-nowrap px-2.5 py-[7px] text-[11px] text-muted">
                            {o.travel_days.toFixed(1)}d
                            <span className="text-dim"> · {Math.round(o.travel_km)}km</span>
                          </td>
                          <td className={cx('px-2.5 py-[7px]', STATUS_TONE[o.status])}>
                            <span className="label" style={{ color: 'inherit', fontSize: 9 }}>
                              {o.status.replace('_', ' ')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Module>
            );
          })}

          {tab === 'board' && result.unassigned_count > 0 && (
            <Module title="Unassigned — Capacity" id="QUEUE">
              <p className="mb-2 flex items-center gap-2 text-[11.5px] text-muted">
                <UserX size={13} className="text-dim" />
                {result.unassigned_count} order(s) left in the queue. Unlike the
                blocked panel above, these are coverable — there simply were not
                enough crew-days.
              </p>
            </Module>
          )}
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
