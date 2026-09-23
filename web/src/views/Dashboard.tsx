/* The operations dashboard.
 *
 * LAYOUT, AND WHY IT IS THIS ORDER
 *
 *   A pipeline is a geographic object. The first question an integrity
 *   engineer asks about a fleet is "where", and the second is "how bad" - so
 *   the map leads and the risk matrix sits beside it, and the register (the
 *   answer to "which one") comes underneath.
 *
 *   The four stat tiles that used to lead are gone. "118 critical / 623
 *   elevated" is a number an operator can get by sorting a column, and it
 *   told them nothing about the SHAPE of the exposure. The matrix answers
 *   the same question and three more.
 *
 *   Every surface here is a filter on the one below it: click a map dot to
 *   select a segment, click a matrix cell to narrow the register to that
 *   likelihood x consequence combination. Nothing is decoration.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  flexRender, getCoreRowModel, getFilteredRowModel, getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, X } from 'lucide-react';

import { api } from '../lib/api';
import type { Me, RiskBand, Segment } from '../lib/types';
import { EmptyState, Module, RiskBadge, Sweep, cx, fmt } from '../components/ui';
import { BAND_COLOR, RiskMatrix, Sparkline, toBand } from '../components/fleet';
import { PipelineMap } from '../components/PipelineMap';
import SegmentDrawer from '../components/SegmentDrawer';

const BANDS: (RiskBand | 'all')[] = ['all', 'critical', 'elevated', 'normal'];

/* Row height. The old 41px row fit roughly sixteen segments on screen; at
 * 27px it fits twenty-five. On a register whose job is scanning five thousand
 * rows for outliers, that is a third more signal per screen for no loss of
 * legibility - the type size is unchanged, only the padding came down. */
const ROW_H = 27;

interface Props {
  me: Me;
  /** Hand the segment to the assistant view. The dashboard owns its own
   *  selection now, so it has no use for the app-level drawer opener - and
   *  routing through it would pop the overlay on top of the inline pane. */
  onAskAssistant: (id: string) => void;
}

export default function Dashboard({ me, onAskAssistant }: Props) {
  const [band, setBand] = useState<RiskBand | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [cellFilter, setCellFilter] = useState<
    { key: string; ids: Set<string>; label: string } | null
  >(null);
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'risk_score', desc: true },
  ]);
  const filterRef = useRef<HTMLInputElement>(null);

  /* Keyboard. The register is the densest surface in the console and until
   * now the only way to reach the filter or dismiss the detail pane was with
   * a mouse.
   *
   * Escape unwinds ONE level at a time - pane, then matrix cell, then the
   * text filter - rather than clearing everything at once. A single key that
   * discards three separate pieces of state is a key people stop trusting. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
        || el.isContentEditable);

      if (e.key === '/' && !typing) {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
        return;
      }
      if (e.key === 'Escape') {
        if (typing && query) { setQuery(''); return; }
        if (selected) { setSelected(null); return; }
        if (cellFilter) { setCellFilter(null); return; }
        if (band !== 'all') setBand('all');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, cellFilter, band, query]);

  const { data: segments = [], isLoading } = useQuery({
    queryKey: ['segments'],
    queryFn: api.segments,
  });

  const { data: matrix } = useQuery({
    queryKey: ['risk-matrix'],
    queryFn: api.riskMatrix,
  });

  /* The corridors the segments were placed on. Fetched rather than hardcoded
   * so the lines and the dots can never disagree — they come from the same
   * definition on the server. */
  const { data: routes = [] } = useQuery({
    queryKey: ['map-routes'],
    queryFn: api.mapRoutes,
    staleTime: Infinity,      // geography does not change during a session
  });

  const { data: mapCfg = null } = useQuery({
    queryKey: ['map-config'],
    queryFn: api.mapConfig,
    staleTime: Infinity,
  });

  const rows = useMemo(() => {
    let r = segments;
    if (band !== 'all') r = r.filter((s) => s.risk_band === band);
    if (cellFilter) r = r.filter((s) => cellFilter.ids.has(s.segment_id));
    return r;
  }, [segments, band, cellFilter]);

  // Peak rate across the whole scope, not the filtered rows, so the inline
  // bars stay comparable as filters change instead of silently rescaling.
  const peakRate = useMemo(
    () => Math.max(...segments.map((s) => s.predicted_rate_mpy), 1),
    [segments],
  );

  const pickCell = useCallback((ids: string[], label: string) => {
    setCellFilter((prev) =>
      prev?.label === label ? null : { key: label, ids: new Set(ids), label });
  }, []);

  /* ---------------------------------------------------------- the table -- */

  const columns = useMemo<ColumnDef<Segment>[]>(() => [
    {
      accessorKey: 'segment_id',
      header: 'Segment ID',
      // The HCA tick rides on the identifier rather than taking a column: it
      // is a property of the asset, not a measurement.
      cell: (i) => (
        <span className="flex items-center gap-1.5">
          <span className="num text-ink">{i.getValue<string>()}</span>
          {i.row.original.is_hca && (
            <span
              className="label border border-accent/50 px-1 text-accent"
              style={{ fontSize: 8, lineHeight: 1.3 }}
              title="High Consequence Area — statutory reassessment interval applies"
            >
              HCA
            </span>
          )}
        </span>
      ),
    },
    {
      accessorKey: 'region',
      header: 'Region',
      cell: (i) => <span className="text-muted">{i.getValue<string>()}</span>,
    },
    {
      id: 'trend',
      header: '10 yr',
      enableSorting: false,
      // The sparkline answers a question the rate column cannot: whether this
      // segment has always been like this or got here recently. It is a
      // BACK-CAST, not measurement - the column header tooltip says so, and
      // so does the detail pane.
      cell: (i) => <TrendCell segmentId={i.row.original.segment_id}
                              band={i.row.original.risk_band} />,
    },
    {
      accessorKey: 'predicted_rate_mpy',
      header: 'Rate mpy',
      cell: (i) => {
        const v = i.getValue<number>();
        const b = i.row.original.risk_band;
        return (
          <div className="flex items-center gap-2">
            <span className="num w-[42px] text-right">{fmt.rate(v)}</span>
            <span className="relative h-[3px] w-[52px] bg-raised">
              <span
                className={cx(
                  'absolute inset-y-0 left-0',
                  b === 'critical' ? 'bg-critical'
                    : b === 'elevated' ? 'bg-elevated' : 'bg-normal',
                )}
                style={{ width: `${Math.max((v / peakRate) * 100, 2)}%` }}
              />
            </span>
          </div>
        );
      },
    },
    {
      accessorKey: 'consequence_score',
      header: 'Conseq.',
      cell: (i) => {
        const v = i.getValue<number>();
        const b = i.row.original.consequence_band;
        return (
          <span className={cx('num', b === 'high' ? 'text-critical'
            : b === 'medium' ? 'text-elevated' : 'text-muted')}>
            {v.toFixed(0)}
          </span>
        );
      },
    },
    {
      accessorKey: 'risk_score',
      header: 'Risk',
      cell: (i) => {
        const v = i.getValue<number>();
        const b = i.row.original.risk_band;
        return (
          <span className={cx('num font-semibold', b === 'critical' ? 'text-critical'
            : b === 'elevated' ? 'text-elevated' : 'text-normal')}>
            {v.toFixed(1)}
          </span>
        );
      },
    },
    {
      accessorKey: 'risk_band',
      header: 'Status',
      cell: (i) => <RiskBadge band={i.getValue<RiskBand>()} />,
    },
    {
      accessorKey: 'last_inspection_years_ago',
      header: 'Last insp.',
      cell: (i) => {
        const v = i.getValue<number>();
        return <span className={cx('num', v > 5 && 'text-elevated')}>{fmt.years(v)}</span>;
      },
    },
    {
      accessorKey: 'acknowledged',
      header: 'Ack',
      cell: (i) =>
        i.getValue<boolean>()
          ? <span className="label text-normal" style={{ fontSize: 9 }}>ACK</span>
          : <span className="text-dim">—</span>,
    },
  ], [peakRate]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: query },
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _col, filter) => {
      const q = String(filter).toLowerCase();
      return (
        row.original.segment_id.toLowerCase().includes(q) ||
        row.original.region.toLowerCase().includes(q)
      );
    },
  });

  const tableRows = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 14,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom =
    virtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1]?.end ?? 0);

  /* Prefetch the back-cast for whatever is on screen, in ONE request rather
   * than one per row. The visible window is small and stable while scrolling
   * stops, so this fires rarely and each id is only ever fetched once. */
  const visibleIds = virtualRows.map((v) => tableRows[v.index]?.original.segment_id)
    .filter(Boolean) as string[];
  usePrefetchHistory(visibleIds);

  /* ------------------------------------------------------------- render -- */

  const hcaCount = segments.filter((s) => s.is_hca).length;

  /* Everything in the metric strip is derived from `segments`, which is
     already loaded for the register. No extra request, and nothing shown
     that the fleet data does not actually support. */
  const metrics = useMemo(() => {
    const n = segments.length || 1;
    const count = (b: RiskBand) => segments.filter((s) => s.risk_band === b).length;
    const meanRate = segments.reduce((a, s) => a + s.predicted_rate_mpy, 0) / n;
    return {
      critical: count('critical'),
      elevated: count('elevated'),
      normal: count('normal'),
      meanRate,
    };
  }, [segments]);

  return (
    <div className="flex flex-col gap-3">
      {/* ---- operational metrics ----------------------------------------
          Typography and rules, not cards. A row of bordered boxes with a
          number in each is the single most template-looking thing a console
          can do, and it costs vertical space the map wants. */}
      <div className="flex flex-wrap items-stretch border border-line-soft bg-panel">
        <Metric label="Fleet" value={segments.length.toLocaleString()} unit="segments" />
        <Metric
          label="In HCA" value={hcaCount.toLocaleString()}
          unit={`${((hcaCount / (segments.length || 1)) * 100).toFixed(1)}%`}
          tone="amber"
        />
        <Metric label="Critical" value={metrics.critical.toLocaleString()}
                unit="segments" tone="critical" />
        <Metric label="Elevated" value={metrics.elevated.toLocaleString()}
                unit="segments" tone="elevated" />
        <Metric label="Mean rate" value={metrics.meanRate.toFixed(2)} unit="mpy" />
        <div className="flex-1" />
        <div className="flex items-center gap-2 px-4 py-2.5">
          <span className="label" style={{ fontSize: 8.5 }}>Scope</span>
          <span className="num text-[11.5px] text-secondary">
            {me.region ?? 'All zones'}
          </span>
        </div>
      </div>

      {/* ---- where, and how bad ------------------------------------------ */}
      <div className="grid gap-3 [grid-template-columns:1fr] xl:[grid-template-columns:minmax(0,1.25fr)_minmax(400px,1fr)]">
        <Module
          title="Fleet Position"
          num="01"
          sub="Web Mercator · marker size is risk"
          id={me.region ? me.region.toUpperCase().slice(0, 3) : 'ALL'}
          bodyClass="p-2 pb-1"
          right={
            <span className="num text-[10.5px] text-dim">
              {segments.length.toLocaleString()} seg · {hcaCount.toLocaleString()} HCA ·
              {' '}{routes.length} corridors
            </span>
          }
        >
          {isLoading
            ? <div className="p-4"><Sweep label="Locating segments…" /></div>
            : <PipelineMap segments={segments} routes={routes} config={mapCfg}
                           selected={selected} onPick={setSelected} />}
        </Module>

        <Module title="Risk Matrix" num="02"
                sub="Likelihood percentile × consequence score" id="5×5"
                right={<span className="label" style={{ fontSize: 9 }}>
                  likelihood × consequence
                </span>}>
          {matrix
            ? <RiskMatrix data={matrix} onPick={pickCell}
                          activeCell={cellFilter?.key ?? null} />
            : <Sweep label="Building matrix…" />}
        </Module>
      </div>

      {/* ---- which one, and why ------------------------------------------ */}
      <div className={cx(
        'grid gap-3',
        selected
          ? '[grid-template-columns:1fr] xl:[grid-template-columns:minmax(0,1fr)_minmax(430px,480px)]'
          : '[grid-template-columns:1fr]',
      )}>
        <Module
          title="Segment Register"
          num="03"
          sub="Ranked by risk · rate in mils per year"
          id={`${tableRows.length}`}
          bodyClass=""
          right={
            <div className="flex flex-wrap items-center gap-1.5">
              {cellFilter && (
                <button
                  onClick={() => setCellFilter(null)}
                  className="label flex items-center gap-1 border border-accent px-1.5
                             py-[2px] text-accent"
                  style={{ fontSize: 9 }}
                  title="Clear the risk-matrix filter"
                >
                  {cellFilter.label}
                  <X size={9} />
                </button>
              )}
              {BANDS.map((b) => (
                <button
                  key={b}
                  onClick={() => setBand(b)}
                  className={cx(
                    'flex items-center gap-1.5 border px-2 py-[3px]',
                    'font-[family-name:var(--font-label)] text-[10px] uppercase tracking-[0.1em]',
                    'transition-colors',
                    band === b
                      ? 'border-accent text-accent'
                      : 'border-line text-muted hover:text-ink',
                  )}
                >
                  {b !== 'all' && <RiskBadge band={b as RiskBand} bare />}
                  {b === 'all' ? 'All' : b}
                </button>
              ))}
              <div className="relative ml-1 w-[170px]">
                <Search
                  size={12}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dim"
                />
                <input
                  ref={filterRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="FILTER…"
                  aria-label="Search segments by ID or region"
                  aria-keyshortcuts="/"
                  className="num w-full border border-line bg-bg py-[3px] pl-6 pr-7 text-[11px]
                             tracking-wide text-ink outline-none placeholder:text-dim
                             focus:border-accent"
                />
                {!query && (
                  <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2
                                  border border-line px-1 font-[family-name:var(--font-mono)]
                                  text-[9px] leading-[1.4] text-dim">
                    /
                  </kbd>
                )}
              </div>
            </div>
          }
        >
          <div ref={scrollRef} className="max-h-[min(58vh,620px)] overflow-auto">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-panel">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    <th className="label border-b border-line px-2 py-[6px] text-left"
                        style={{ width: 46 }}>
                      #
                    </th>
                    {hg.headers.map((h) => (
                      <th
                        key={h.id}
                        onClick={h.column.getToggleSortingHandler()}
                        title={h.column.id === 'trend'
                          ? 'Corrosion rate over the last ten years, back-cast from '
                            + 'the current prediction — reconstructed, not measured'
                          : undefined}
                        className={cx(
                          'label select-none whitespace-nowrap border-b border-line',
                          'px-2 py-[6px] text-left',
                          h.column.getCanSort() && 'cursor-pointer hover:text-accent',
                        )}
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span className="ml-1 text-accent">
                          {{ asc: '▲', desc: '▼' }[h.column.getIsSorted() as string] ?? ''}
                        </span>
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {paddingTop > 0 && <tr><td style={{ height: paddingTop }} colSpan={10} /></tr>}
                {virtualRows.map((vr) => {
                  const row = tableRows[vr.index];
                  const critical = row.original.risk_band === 'critical';
                  const isSel = selected === row.original.segment_id;
                  return (
                    <tr
                      key={row.id}
                      tabIndex={0}
                      onClick={() => setSelected(row.original.segment_id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelected(row.original.segment_id);
                        }
                      }}
                      style={{ height: ROW_H }}
                      className={cx(
                        'cursor-pointer border-b border-line-soft outline-none transition-colors',
                        isSel ? 'bg-raised' : 'hover:bg-raised focus:bg-raised',
                        // A hairline on the leading edge: the selected row in
                        // amber, a critical one in its band colour. Visible
                        // from peripheral vision while reading the pane.
                        isSel
                          ? 'shadow-[inset_2px_0_0_var(--color-accent)]'
                          : critical && 'shadow-[inset_2px_0_0_var(--color-critical)]',
                      )}
                    >
                      <td className="num px-2 py-[3px] text-[10px] text-dim">
                        {fmt.idx(vr.index + 1)}
                      </td>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}
                            className="whitespace-nowrap px-2 py-[3px] text-[11.5px]">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {paddingBottom > 0 && <tr><td style={{ height: paddingBottom }} colSpan={10} /></tr>}
              </tbody>
            </table>
            {!isLoading && tableRows.length === 0 && (
              <EmptyState>No segments match this filter.</EmptyState>
            )}
            {isLoading && <div className="p-4"><Sweep label="Loading segments…" /></div>}
          </div>

          <div className="flex items-center gap-3 border-t border-line-soft px-3 py-1.5">
            <span className="num text-[11px] text-muted">
              {tableRows.length.toLocaleString()}
              {tableRows.length !== segments.length &&
                ` / ${segments.length.toLocaleString()}`} rows
            </span>
            <div className="flex-1" />
            <span className="label" style={{ fontSize: 9 }}>
              <kbd className="num text-dim">/</kbd> filter ·
              <kbd className="num ml-1 text-dim">Esc</kbd> back ·
              virtualised
            </span>
          </div>
        </Module>

        {/* The detail as a pane, not an overlay. The register stays on screen
            and keeps its scroll position, so moving between segments is one
            click each instead of close-scroll-reopen. */}
        {selected && (
          <SegmentDrawer
            inline
            segmentId={selected}
            onClose={() => setSelected(null)}
            onAskAssistant={(id) => { setSelected(null); onAskAssistant(id); }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- sparklines --- */

/** Shared cache for the back-cast series, keyed by segment id.
 *
 *  Deliberately module-level and not React state: the register re-renders on
 *  every scroll frame, and threading a growing map through state would make
 *  each frame re-render every visible row. The version counter is what tells
 *  React something arrived. */
const historyCache = new Map<string, number[]>();
const historyPending = new Set<string>();
let historyVersion = 0;
const historyListeners = new Set<() => void>();

function notifyHistory() {
  historyVersion += 1;
  historyListeners.forEach((fn) => fn());
}

function usePrefetchHistory(ids: string[]) {
  // Serialised so the effect only fires when the visible SET changes, not on
  // every scroll frame that happens to produce an equal array.
  const key = ids.join(',');
  useEffect(() => {
    const missing = ids.filter((id) => !historyCache.has(id) && !historyPending.has(id));
    if (!missing.length) return;
    missing.forEach((id) => historyPending.add(id));

    let cancelled = false;
    api.bulkHistory(missing)
      .then((res) => {
        if (cancelled) return;
        for (const [id, series] of Object.entries(res.series)) {
          historyCache.set(id, series);
        }
        // An id the server did not return - out of region, or gone - is
        // cached as empty so it is not requested again on every scroll.
        missing.forEach((id) => { if (!historyCache.has(id)) historyCache.set(id, []); });
        notifyHistory();
      })
      .catch(() => {
        // A failed batch must not poison the cache: leaving these ids unset
        // lets the next scroll retry them.
      })
      .finally(() => { missing.forEach((id) => historyPending.delete(id)); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function TrendCell({ segmentId, band }: { segmentId: string; band: RiskBand }) {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump(historyVersion);
    historyListeners.add(fn);
    return () => { historyListeners.delete(fn); };
  }, []);

  const series = historyCache.get(segmentId);
  if (!series) {
    // A placeholder the exact size of the chart, so rows do not jump as the
    // batch lands.
    return <span className="inline-block h-[14px] w-[52px] bg-raised/60" />;
  }
  return <Sparkline series={series} width={52} height={14}
                    tone={BAND_COLOR[toBand(band)]} />;
}

/** One reading in the operational strip.
 *
 *  Vertical rules rather than boxes: the numbers are separated but the row
 *  still reads as one instrument, which is what a control panel does and a
 *  grid of cards does not. */
function Metric({
  label, value, unit, tone,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'critical' | 'elevated' | 'amber';
}) {
  const color =
    tone === 'critical' ? 'text-critical'
      : tone === 'elevated' ? 'text-elevated'
        : tone === 'amber' ? 'text-amber' : 'text-ink';
  return (
    <div className="border-r border-line-soft px-4 py-2 first:pl-4">
      <div className="label" style={{ fontSize: 8.5 }}>{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className={cx('num text-[19px] font-medium leading-none', color)}>
          {value}
        </span>
        {unit && <span className="num text-[10px] text-dim">{unit}</span>}
      </div>
    </div>
  );
}
