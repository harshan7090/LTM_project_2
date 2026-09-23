import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, X } from 'lucide-react';

import { api } from '../lib/api';
import { Pipeline3D } from './Pipeline3D';
import type { InspectionMethod } from '../lib/types';
import { Button, RiskBadge, SectionTitle, Sweep, cx, fmt, useToast } from './ui';

const CATEGORY_TONE: Record<InspectionMethod['category'], string> = {
  indirect: 'text-accent',
  direct: 'text-elevated',
  'in-line': 'text-normal',
  pressure: 'text-critical',
};

interface Props {
  segmentId: string | null;
  onClose: () => void;
  onAskAssistant: (id: string) => void;
  /** Render as a column inside the page instead of an overlay.
   *
   *  An overlay forces a choice the operator should not have to make: read
   *  the detail OR see the register, never both. Comparing a segment against
   *  its neighbours means closing and reopening the panel for each one. As a
   *  split pane the list stays put, the selection moves, and the detail
   *  follows - which is how the comparison actually gets done.
   *
   *  The overlay form is kept for the views that open a segment from
   *  somewhere other than the register (Schedule, Dispatch), where there is
   *  no list to stay beside. */
  inline?: boolean;
}

export default function SegmentDrawer({
  segmentId, onClose, onAskAssistant, inline = false,
}: Props) {
  const [tab, setTab] = useState<'risk' | 'inspection' | 'repair'>('risk');
  const toast = useToast();
  const qc = useQueryClient();

  useEffect(() => { setTab('risk'); }, [segmentId]);

  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, inline]);

  // The suffix is a CACHE VERSION. TanStack keeps a cached object for the
  // session, so a segment opened before the payload gained `efficiency` and
  // `repair` would keep serving the old shape - and reading a field that is
  // not there is what blanked these tabs. Bump this whenever the response
  // shape changes.
  const CACHE_V = 'v2';

  const { data: detail, isLoading, isError: detailError } = useQuery({
    queryKey: ['segment', CACHE_V, segmentId],
    queryFn: () => api.segment(segmentId!),
    enabled: !!segmentId,
  });

  const {
    data: plan, isLoading: planLoading, isError: planError, error: planErr,
  } = useQuery({
    queryKey: ['inspection', CACHE_V, segmentId],
    queryFn: () => api.inspection(segmentId!),
    enabled: !!segmentId && tab === 'inspection',
  });

  const ack = useMutation({
    mutationFn: () => api.acknowledge(segmentId!),
    onSuccess: () => {
      toast(`${segmentId} acknowledged`, 'success');
      qc.invalidateQueries({ queryKey: ['segment', segmentId] });
      qc.invalidateQueries({ queryKey: ['segments'] });
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const open = !!segmentId;
  const contributions = detail?.explanation?.contributions ?? [];
  const maxAbs = Math.max(...contributions.map((c) => Math.abs(c.impact_mpy)), 0.01);

  return (
    <>
      {!inline && (
        <div
          onClick={onClose}
          className={cx(
            'fixed inset-0 z-50 bg-black/45 transition-opacity',
            open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
      )}
      <aside
        aria-hidden={!open}
        aria-label="Segment detail"
        className={cx(
          'overflow-y-auto border-line bg-panel',
          inline
            // Sticks beside the register and scrolls independently of it.
            ? 'sticky top-[52px] max-h-[calc(100vh-72px)] rounded-[2px] border pb-4'
            : [
                'fixed inset-y-0 right-0 z-51 w-[min(520px,100vw)] border-l pb-10',
                'shadow-[-8px_0_32px_rgba(0,0,0,0.45)]',
                'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
                open ? 'translate-x-0' : 'translate-x-full',
              ].join(' '),
        )}
      >
        {/* header rail, matching the app chrome */}
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line
                        bg-panel px-4 py-2.5">
          {detail && <RiskBadge band={detail.risk_band} bare />}
          <span className="num text-[14px] font-semibold">
            {detail?.segment_id ?? '—'}
          </span>
          <span className="label" style={{ fontSize: 9 }}>
            {detail?.region}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-accent">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 pt-3">
        {isLoading && <Sweep label="Loading segment…" />}
        {detailError && !isLoading && (
          <TabError what="segment" detail="The request failed. Check the session has not expired." />
        )}

        {detail && (
          <>
            <div className="mb-4 flex gap-0 border-b border-line">
              {(['risk', 'inspection', 'repair'] as const).map((t) => (
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
                  {t === 'risk' ? 'Risk & drivers'
                    : t === 'inspection' ? 'Inspection' : 'Repair'}
                </button>
              ))}
            </div>

            {tab === 'risk' && (
              <>
                {/* The segment, rendered from its own numbers.
                    Pitting density is a function of the predicted rate and
                    the rim light is its risk band, so two segments never
                    look alike unless they actually are alike. It is placed
                    above the readout because a shape is recognised faster
                    than a number is read. */}
                <div className="mb-3 overflow-hidden border border-line-soft bg-sunken">
                  <Pipeline3D
                    corrosionRate={detail.predicted_rate_mpy}
                    wallThicknessMm={
                      typeof detail.attributes?.wall_thickness_mm === 'number'
                        ? detail.attributes.wall_thickness_mm
                        : undefined
                    }
                    riskBand={detail.risk_band}
                    height={132}
                  />
                  <div className="flex items-center gap-3 border-t border-line-soft px-2.5 py-1.5">
                    <span className="label" style={{ fontSize: 8 }}>Surface</span>
                    <span className="text-[10px] text-dim">
                      Pitting scaled to predicted rate · illustrative, not an inspection image
                    </span>
                  </div>
                </div>

                {/* primary readout */}
                <div className="bracket mb-4 px-3 py-2.5">
                  <div className="label mb-1.5">Predicted corrosion rate</div>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cx(
                        'num text-[30px] font-semibold leading-none',
                        detail.risk_band === 'critical' ? 'text-critical'
                          : detail.risk_band === 'elevated' ? 'text-elevated' : 'text-normal',
                      )}
                    >
                      {fmt.rate(detail.predicted_rate_mpy)}
                    </span>
                    <span className="num text-[11px] text-dim">mils/year</span>
                    <div className="flex-1" />
                    <RiskBadge band={detail.risk_band} />
                  </div>
                </div>

                {/* Risk decomposition. The point of showing both halves is
                    that a modest corrosion rate can still top the register,
                    and an operator must be able to see why. */}
                <div className="mb-4">
                  <SectionTitle>Risk = likelihood x consequence</SectionTitle>
                  <div className="grid grid-cols-3 gap-2">
                    <Factor
                      label="Likelihood"
                      value={fmt.rate(detail.predicted_rate_mpy)}
                      unit="mpy"
                      band={detail.likelihood_band}
                    />
                    <Factor
                      label="Consequence"
                      value={detail.consequence.consequence_score.toFixed(0)}
                      unit="/100"
                      band={detail.consequence.consequence_band === 'high' ? 'critical'
                        : detail.consequence.consequence_band === 'medium' ? 'elevated' : 'normal'}
                    />
                    <Factor
                      label="Risk"
                      value={detail.risk_score.toFixed(1)}
                      unit="/100"
                      band={detail.risk_band}
                    />
                  </div>

                  {detail.consequence.is_hca && (
                    <div className="mt-2 border border-accent/40 bg-accent/[0.07] px-2.5 py-2">
                      <div className="mb-1 flex items-center gap-1.5">
                        <span className="lamp text-accent" />
                        <span className="label text-accent">High Consequence Area</span>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted">
                        {detail.consequence.hca_basis.join(' · ')}
                      </p>
                      <p className="mt-1 text-[10px] text-dim">
                        {detail.consequence.regulatory_regime}
                        {detail.consequence.potential_impact_radius_ft != null && (
                          <> · potential impact radius{' '}
                            <span className="num">
                              {detail.consequence.potential_impact_radius_ft.toFixed(0)} ft
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </div>

                {/* Remaining life turns a rate into a date, which is the
                    thing an integrity engineer actually schedules against. */}
                {detail.remaining_life.applicable ? (
                  <div className="mb-5">
                    <SectionTitle>Remaining life</SectionTitle>
                    <div className="mb-2 flex items-baseline gap-2">
                      <span
                        className={cx(
                          'num text-[26px] font-semibold leading-none',
                          VERDICT_TONE[detail.remaining_life.verdict] ?? 'text-ink',
                        )}
                      >
                        {detail.remaining_life.remaining_life_years == null
                          ? '—'
                          : detail.remaining_life.remaining_life_years.toFixed(1)}
                      </span>
                      <span className="num text-[11px] text-dim">years to t-min</span>
                      <div className="flex-1" />
                      <span className={cx('label', VERDICT_TONE[detail.remaining_life.verdict])}>
                        {(detail.remaining_life.verdict || '—').replace(/_/g, ' ')}
                      </span>
                    </div>
                    <dl className="grid gap-x-5 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
                      <SpecRow k="Grade" v={`${detail.remaining_life.grade} · ${detail.remaining_life.smys_psi.toLocaleString()} psi SMYS`} />
                      <SpecRow k="Design factor" v={detail.remaining_life.design_factor.toFixed(2)} />
                      <SpecRow k="Current wall" v={`${detail.remaining_life.current_wall_mm.toFixed(2)} mm`} />
                      <SpecRow k="Min required" v={`${detail.remaining_life.min_required_wall_mm.toFixed(2)} mm`} />
                      <SpecRow k="Safe pressure" v={`${detail.remaining_life.safe_operating_pressure_psi.toFixed(0)} psi`} />
                      <SpecRow
                        k="ERF"
                        v={detail.remaining_life.erf == null ? '—' : detail.remaining_life.erf.toFixed(2)}
                        alert={(detail.remaining_life.erf ?? 0) >= 1}
                      />
                    </dl>
                    {detail.remaining_life.drivers.map((d) => (
                      <p key={d} className="mt-1.5 flex items-baseline gap-2 text-[11px] text-muted">
                        <span className="lamp mt-[5px] text-elevated" />{d}
                      </p>
                    ))}
                  </div>
                ) : (
                  <div className="mb-5">
                    <SectionTitle>Remaining life</SectionTitle>
                    <p className="text-[11px] leading-relaxed text-dim">
                      {detail.remaining_life.reason}
                    </p>
                  </div>
                )}

                <div className="mb-5">
                  <SectionTitle>Drivers — SHAP contribution</SectionTitle>
                  {/* Diverging bars around a centre line: left reduces the rate,
                      right increases it. Reads as a tornado plot, which is how
                      sensitivity is conventionally shown in engineering. */}
                  {contributions.map((c) => {
                    const pct = Math.min((Math.abs(c.impact_mpy) / maxAbs) * 50, 50);
                    const positive = c.impact_mpy >= 0;
                    return (
                      <div key={c.feature} className="mb-2">
                        <div className="mb-[3px] flex justify-between text-[11px]">
                          <span className="text-muted">{fmt.label(c.feature)}</span>
                          <span className={cx('num', positive ? 'text-critical' : 'text-normal')}>
                            {positive ? '+' : ''}{c.impact_mpy.toFixed(2)}
                          </span>
                        </div>
                        <div className="relative h-[7px] bg-bg">
                          <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
                          <div
                            className={cx(
                              'absolute inset-y-0',
                              positive ? 'left-1/2 bg-critical' : 'right-1/2 bg-normal',
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mb-5">
                  <SectionTitle>Attributes</SectionTitle>
                  {/* Two-column key/value rows with dotted leaders — a spec
                      sheet, not a card grid. */}
                  <dl className="grid gap-x-5 gap-y-[3px] [grid-template-columns:repeat(auto-fit,minmax(210px,1fr))]">
                    {Object.entries(detail.attributes ?? {}).map(([k, v]) => (
                      <div
                        key={k}
                        className="flex items-baseline gap-1.5 border-b border-line-soft py-[3px]"
                      >
                        <dt className="text-[11px] text-muted">{fmt.label(k)}</dt>
                        <span className="flex-1 border-b border-dotted border-line" />
                        <dd className="num text-[11.5px]">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </>
            )}

            {tab === 'inspection' && (
              <>
                {planLoading && <Sweep label="Building plan…" />}
                {planError && (
                  <TabError
                    what="inspection plan"
                    detail={(planErr as Error)?.message}
                  />
                )}
                {!planLoading && !planError && !plan && (
                  <EmptyTab>No inspection plan returned for this segment.</EmptyTab>
                )}
                {plan && (
                  <>
                    <div className="mb-4 grid grid-cols-3 gap-2">
                      {[
                        {
                          l: 'Urgency', v: plan.urgency,
                          c: plan.urgency === 'immediate' ? 'text-critical'
                            : plan.urgency === 'scheduled' ? 'text-elevated' : 'text-normal',
                          mono: false,
                        },
                        { l: 'Reassess', v: `${plan.interval_months} mo`, c: 'text-ink', mono: true },
                        { l: 'Effort', v: `${plan.total_est_days} d`, c: 'text-ink', mono: true },
                      ].map((x) => (
                        <div key={x.l} className="border border-line-soft px-2.5 py-2">
                          <div className="label mb-1">{x.l}</div>
                          <div
                            className={cx(
                              'text-[13px] font-semibold uppercase',
                              x.mono ? 'num' : 'font-[family-name:var(--font-label)] tracking-[0.08em]',
                              x.c,
                            )}
                          >
                            {x.v}
                          </div>
                        </div>
                      ))}
                    </div>

                    {plan.drivers.length > 0 && (
                      <div className="mb-4">
                        <SectionTitle>Triggering factors</SectionTitle>
                        <ul className="flex flex-col gap-[3px]">
                          {plan.drivers.map((d) => (
                            <li key={d} className="flex items-baseline gap-2 text-[11.5px]">
                              <span className="lamp mt-[5px] text-elevated" />
                              <span className="text-muted">{d}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="mb-4">
                      <SectionTitle>Recommended methods</SectionTitle>
                      <ol className="flex flex-col gap-px">
                        {plan.methods.map((m, i) => (
                          <li
                            key={m.code}
                            className="border-l-2 border-line-soft bg-raised/60 py-2 pl-3 pr-2
                                       transition-colors hover:border-l-accent"
                          >
                            <div className="mb-[3px] flex items-center gap-2">
                              <span className="num text-[10px] text-dim">{i + 1}</span>
                              <span className="num text-[12px] font-semibold text-ink">
                                {m.code}
                              </span>
                              <span
                                className={cx('label', CATEGORY_TONE[m.category])}
                                style={{ fontSize: 9, color: 'inherit' }}
                              >
                                {m.category}
                              </span>
                              <div className="flex-1" />
                              {/* The ranking metric, shown so the order can
                                  be read off the numbers rather than taken
                                  on trust. */}
                              <span className="num text-[10px] text-accent"
                                    title={`${m.value} diagnostic value / ${m.est_days} crew-days`}>
                                {fmtEff(m.efficiency)}
                              </span>
                              <span className="num text-[10.5px] text-dim">{m.est_days}d</span>
                            </div>
                            <div className="mb-1 text-[12px] font-medium">{m.name}</div>
                            {/* Summary by default, full rationale on demand.
                                Four methods of prose was ~1,100 characters,
                                which nobody reads before picking one. */}
                            <details className="group">
                              <summary className="cursor-pointer list-none text-[11.5px]
                                                  leading-relaxed text-muted
                                                  marker:hidden hover:text-ink">
                                {m.summary ?? m.rationale}
                                <span className="ml-1 text-dim group-open:hidden">more</span>
                              </summary>
                              <p className="mt-1.5 text-[11.5px] leading-relaxed text-dim">
                                {m.rationale}
                              </p>
                            </details>
                            {m.standard && (
                              <p className="mt-1 text-[10px] text-dim">{m.standard}</p>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>

                    {plan.also_considered?.length > 0 && (
                      <details className="mb-4">
                        <summary className="label cursor-pointer list-none
                                            text-muted marker:hidden hover:text-ink">
                          Also considered ({plan.also_considered.length})
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1">
                          {plan.also_considered.map((m) => (
                            <li key={m.code}
                                className="flex items-baseline gap-2 text-[11px] text-dim">
                              <span className="num text-muted">{m.code}</span>
                              <span className="flex-1">{m.name}</span>
                              <span className="num">{fmtEff(m.efficiency)}</span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-dim">
                          Triggered, but lower diagnostic value per crew-day
                          than the three above.
                        </p>
                      </details>
                    )}

                    {plan.notes.length > 0 && (
                      <div className="mb-4">
                        <SectionTitle>Caveats</SectionTitle>
                        <ul className="flex flex-col gap-1.5">
                          {plan.notes.map((n, i) => (
                            <li
                              key={i}
                              className="flex gap-2 border border-elevated/30 bg-elevated/[0.07]
                                         px-2.5 py-1.5 text-[11px] leading-relaxed"
                            >
                              <span className="lamp mt-[5px] text-elevated" />
                              <span>{n}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <p className="mb-4 border-t border-line-soft pt-2.5 text-[10.5px]
                                  leading-relaxed text-dim">
                      Deterministic engineering rules, not a language model — the same
                      segment always produces the same plan.
                    </p>
                  </>
                )}
              </>
            )}

            {tab === 'repair' && !detail.repair && (
              <EmptyTab>
                This segment was loaded before repair planning was available.
                Close the panel and reopen it to refresh.
              </EmptyTab>
            )}

            {tab === 'repair' && detail.repair && (
              <>
                <div className="mb-4 grid grid-cols-3 gap-2">
                  <div className="border border-line-soft px-2.5 py-2">
                    <div className="label mb-1">Urgency</div>
                    <div className={cx(
                      'font-[family-name:var(--font-label)] text-[13px] font-semibold uppercase tracking-[0.08em]',
                      REPAIR_TONE[detail.repair.urgency],
                    )}>
                      {detail.repair.urgency}
                    </div>
                  </div>
                  <div className="border border-line-soft px-2.5 py-2">
                    <div className="label mb-1">Window</div>
                    <div className="num text-[13px] font-semibold">
                      {detail.repair.window_days} d
                    </div>
                  </div>
                  <div className="border border-line-soft px-2.5 py-2">
                    <div className="label mb-1">Est. cost</div>
                    <div className="num text-[13px] font-semibold">
                      ${(detail.repair.total_est_cost_usd / 1000).toFixed(0)}k
                    </div>
                  </div>
                </div>

                {detail.repair.drivers.length > 0 && (
                  <div className="mb-4">
                    <SectionTitle>Why</SectionTitle>
                    <ul className="flex flex-col gap-[3px]">
                      {detail.repair.drivers.map((d) => (
                        <li key={d} className="flex items-baseline gap-2 text-[11.5px]">
                          <span className="lamp mt-[5px] text-elevated" />
                          <span className="text-muted">{d}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mb-4">
                  <SectionTitle>Recommended actions</SectionTitle>
                  {/* Reinforcement fixes the defect; mitigation fixes the cause.
                      Both are shown because a sleeve on a line with failed CP
                      is a patch, not a repair. */}
                  <ol className="flex flex-col gap-px">
                    {detail.repair.actions.map((a) => (
                      <li
                        key={a.code}
                        className="border-l-2 border-line-soft bg-raised/60 py-2 pl-3 pr-2
                                   transition-colors hover:border-l-accent"
                      >
                        <div className="mb-[3px] flex items-center gap-2">
                          <span className="num text-[12px] font-semibold text-ink">{a.code}</span>
                          <span className={cx('label', CATEGORY_TONE_REPAIR[a.category])}
                                style={{ fontSize: 9, color: 'inherit' }}>
                            {a.category}
                          </span>
                          {a.requires_shutdown && (
                            <span className="label text-critical" style={{ fontSize: 8.5 }}>
                              SHUTDOWN
                            </span>
                          )}
                          <div className="flex-1" />
                          <span className="num text-[10px] text-accent"
                                title={`${a.value} threat removed / ${a.total_burden_days} crew-day equivalent`}>
                            {fmtEff(a.efficiency)}
                          </span>
                          <span className="num text-[10.5px] text-dim">
                            {a.est_days}d · ${(a.est_cost_usd / 1000).toFixed(0)}k
                          </span>
                        </div>
                        <div className="mb-1 text-[12px] font-medium">{a.name}</div>
                        <details className="group">
                          <summary className="cursor-pointer list-none text-[11.5px]
                                              leading-relaxed text-muted
                                              marker:hidden hover:text-ink">
                            {a.summary ?? a.rationale}
                            <span className="ml-1 text-dim group-open:hidden">more</span>
                          </summary>
                          <p className="mt-1.5 text-[11.5px] leading-relaxed text-dim">
                            {a.rationale}
                          </p>
                        </details>
                        {a.standard && <p className="mt-1 text-[10px] text-dim">{a.standard}</p>}
                        <p className="mt-1 text-[10px] text-dim">
                          Trade: <span className="num">{a.skill.replace(/_/g, ' ')}</span>
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>

                {detail.repair.notes.length > 0 && (
                  <div className="mb-4">
                    <SectionTitle>Caveats</SectionTitle>
                    <ul className="flex flex-col gap-1.5">
                      {detail.repair.notes.map((n, i) => (
                        <li key={i}
                            className="flex gap-2 border border-elevated/30 bg-elevated/[0.07]
                                       px-2.5 py-1.5 text-[11px] leading-relaxed">
                          <span className="lamp mt-[5px] text-elevated" />
                          <span>{n}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="mb-4 border-t border-line-soft pt-2.5 text-[10.5px]
                              leading-relaxed text-dim">
                  Repair selection is deterministic — 49 CFR 192.713 / 195.422
                  constrain which methods are permissible for which defect, so
                  the same inputs must always give the same plan.
                </p>
              </>
            )}

            <div className="flex gap-2">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => onAskAssistant(detail.segment_id)}
              >
                <Sparkles size={13} /> Ask AI
              </Button>
              <Button
                className="flex-1"
                disabled={!!detail.acknowledged || ack.isPending}
                onClick={() => ack.mutate()}
              >
                {detail.acknowledged ? 'Acknowledged' : 'Acknowledge'}
              </Button>
            </div>
            {detail.acknowledged && (
              <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-dim">
                <span className="lamp text-normal" />
                {detail.acknowledged.by} · {detail.acknowledged.at}
              </p>
            )}
          </>
        )}
        </div>
      </aside>
    </>
  );
}

const VERDICT_TONE: Record<string, string> = {
  repair_now: 'text-critical',
  derate: 'text-critical',
  plan_repair: 'text-elevated',
  monitor: 'text-normal',
};

/** One half of the risk product, shown as a gauge-style cell. */
function Factor({ label, value, unit, band }: {
  label: string; value: string; unit: string; band: string;
}) {
  const tone = band === 'critical' ? 'text-critical'
    : band === 'elevated' ? 'text-elevated' : 'text-normal';
  return (
    <div className="border border-line-soft px-2.5 py-2">
      <div className="label mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={cx('num text-[17px] font-semibold leading-none', tone)}>{value}</span>
        <span className="num text-[9.5px] text-dim">{unit}</span>
      </div>
    </div>
  );
}

/** Dotted-leader spec row, matching the Attributes sheet below it. */
function SpecRow({ k, v, alert }: { k: string; v: string; alert?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5 border-b border-line-soft py-[3px]">
      <dt className="text-[11px] text-muted">{k}</dt>
      <span className="flex-1 border-b border-dotted border-line" />
      <dd className={cx('num text-[11.5px]', alert && 'text-critical')}>{v}</dd>
    </div>
  );
}

const REPAIR_TONE: Record<string, string> = {
  immediate: 'text-critical',
  scheduled: 'text-elevated',
  routine: 'text-normal',
  monitor: 'text-muted',
};

const CATEGORY_TONE_REPAIR: Record<string, string> = {
  reinforcement: 'text-accent',
  mitigation: 'text-normal',
  operational: 'text-elevated',
  replacement: 'text-critical',
};

/** Numbers that may be absent on a cached payload. Returns a dash rather
 *  than throwing - a missing field should degrade the display, not unmount
 *  the panel. */
function fmtEff(v: number | undefined | null): string {
  return typeof v === 'number' && isFinite(v) ? `${v.toFixed(2)}/d` : '—';
}

/** A failed sub-query, stated. The previous code rendered nothing at all,
 *  which is indistinguishable from "this segment needs no inspection". */
function TabError({ what, detail }: { what: string; detail?: string }) {
  return (
    <div className="mb-4 border border-critical/40 bg-critical/[0.07] px-3 py-3">
      <div className="mb-1 flex items-center gap-2">
        <span className="lamp lamp-critical" />
        <span className="label text-critical">Could not load the {what}</span>
      </div>
      {detail && (
        <p className="text-[11.5px] leading-relaxed text-muted">{detail}</p>
      )}
      <p className="mt-1.5 text-[10.5px] text-dim">
        Close and reopen the panel to retry.
      </p>
    </div>
  );
}

function EmptyTab({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-dashed border-line px-3 py-6 text-center
                    text-[11.5px] leading-relaxed text-dim">
      {children}
    </div>
  );
}
