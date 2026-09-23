/* Fleet visualisations: the 5x5 risk matrix, the route map, and the
 * register sparkline.
 *
 * ON THE BAND COLOURS
 *
 *   The four risk bands were first drawn green -> amber -> orange -> red,
 *   the obvious choice. Running the palette validator killed it: every
 *   four-step ramp across that arc fails the adjacent-pair separation,
 *   always on orange vs red, at deltaE 6.3-7.8 against a floor of 15. That
 *   is structural, not a bad pick - there is not enough perceptual room for
 *   four ordered hues between green and red.
 *
 *   These are the validated status steps, all clearing 3:1 on a dark
 *   surface. They are still not far enough apart for hue to carry the
 *   distinction unaided, so it never does: every cell prints its count,
 *   every band is named in the legend, and the band is a deterministic
 *   function of row x column, so position encodes it too.
 */
import { useState } from 'react';

import type { RiskMatrix as RiskMatrixData } from '../lib/types';
import { cx } from './ui';

export const BAND_COLOR: Record<string, string> = {
  low: 'var(--color-band-low)',
  moderate: 'var(--color-band-moderate)',
  high: 'var(--color-band-high)',
  severe: 'var(--color-band-severe)',
};

/** Maps the three-level register band onto the four-level matrix band. The
 *  register never reports "high" - it has three states - so the map uses
 *  three of the four steps and the matrix uses all four. */
export function toBand(b: string): string {
  return b === 'critical' ? 'severe' : b === 'elevated' ? 'moderate' : 'low';
}
const BAND_ORDER = ['low', 'moderate', 'high', 'severe'] as const;

/* ======================================================= risk matrix ==== */

export function RiskMatrix({
  data, onPick, activeCell,
}: {
  data: RiskMatrixData;
  onPick: (ids: string[], label: string) => void;
  activeCell: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        {/* Y axis. Rotated once on the container rather than per-label, so
            the words stay upright and legible. */}
        <div className="grid gap-[2px]"
             style={{ gridTemplateRows: 'repeat(5, 30px)' }}>
          {[...data.likelihood_labels].reverse().map((l) => (
            <span key={l}
                  className="label flex items-center justify-end whitespace-nowrap"
                  style={{ fontSize: 8.5 }}>
              {l}
            </span>
          ))}
        </div>

        <div className="flex-1">
          {/* 2px gaps between cells, per the mark spec - adjacent fills need
              a surface gap or they read as one shape. */}
          <div className="grid grid-cols-5 gap-[2px]"
               style={{ gridAutoRows: '30px' }}>
            {data.cells.map((c, i) => {
              const key = `${c.likelihood}-${c.consequence}`;
              const active = activeCell === key;
              const empty = c.count === 0;
              // Opacity carries population density WITHIN the band hue, so a
              // busy cell reads hotter without inventing a fifth colour.
              const weight = empty ? 0 : 0.18 + 0.62 * Math.sqrt(c.count / Math.max(data.max_cell, 1));
              return (
                <button
                  key={key}
                  onClick={() => !empty && onPick(c.sample_ids, `${data.likelihood_labels[c.likelihood - 1]} · ${data.consequence_labels[c.consequence - 1]}`)}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                  disabled={empty}
                  className={cx(
                    'relative flex h-[30px] items-center justify-center transition-all',
                    empty ? 'cursor-default' : 'cursor-pointer hover:brightness-125',
                    active && 'ring-1 ring-ink',
                  )}
                  style={{
                    background: empty ? 'transparent' : BAND_COLOR[c.band],
                    opacity: empty ? 1 : weight,
                    border: empty ? '1px dashed var(--color-line)' : 'none',
                  }}
                  title={`${data.likelihood_labels[c.likelihood - 1]} likelihood · ${data.consequence_labels[c.consequence - 1]} consequence — ${c.count} segments, ${c.band} risk`}
                >
                  {/* The count is the data. Text in an ink token, never the
                      band colour. */}
                  <span className={cx('num text-[11px]',
                                      empty ? 'text-dim' : 'font-semibold')}
                        style={{
                          // Mixed against the surface rather than fixed, so the
                          // count stays legible on both themes as the fill
                          // opacity changes underneath it.
                          color: empty ? undefined : 'var(--color-cell-ink)',
                          opacity: empty ? 1 : Math.min(1 / Math.max(weight, .34), 1),
                        }}>
                    {empty ? '·' : c.count.toLocaleString()}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-1.5 grid grid-cols-5 gap-[2px]">
            {data.consequence_labels.map((l) => (
              <span key={l} className="label text-center" style={{ fontSize: 8.5 }}>{l}</span>
            ))}
          </div>
        </div>
      </div>

      {/* Legend. Always present, and it is what makes the bands readable -
          the hues alone are not far enough apart to carry it. */}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5
                      border-t border-line-soft pt-2.5">
        {BAND_ORDER.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className="inline-block h-[9px] w-[9px]"
                  style={{ background: BAND_COLOR[b] }} />
            <span className="label" style={{ fontSize: 9 }}>{b}</span>
            <span className="num text-[10px] text-dim">
              {(data.band_counts[b] ?? 0).toLocaleString()}
            </span>
          </span>
        ))}
        <div className="flex-1" />
        <span className="text-[10px] text-dim">
          {hover !== null && data.cells[hover].count > 0
            ? `${data.cells[hover].count.toLocaleString()} segments · ${data.cells[hover].hca_count} in HCA`
            : 'Click a cell to filter the register'}
        </span>
      </div>
    </div>
  );
}

/* The route map moved to PipelineMap.tsx when it gained a real projection
 * and a basemap. It was scaling points to the bounding box of whatever was
 * filtered, which is not a projection: the country changed shape every time
 * the filter did. */

/* =========================================================== sparkline == */

export function Sparkline({
  series, width = 58, height = 16, tone = 'var(--color-muted)',
}: {
  series: number[]; width?: number; height?: number; tone?: string;
}) {
  if (!series || series.length < 2) {
    return <span className="inline-block text-dim" style={{ width }}>—</span>;
  }
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const step = width / (series.length - 1);
  const pts = series
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');
  const lastY = height - ((series[series.length - 1] - min) / span) * height;

  return (
    <svg width={width} height={height} className="block overflow-visible"
         aria-hidden="true">
      {/* No axis, no grid, no legend. A sparkline is a single series shown
          for its shape; anything else on it is noise at this size. */}
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.25"
                strokeLinejoin="round" strokeLinecap="round" opacity=".85" />
      <circle cx={width} cy={lastY} r="1.8" fill={tone} />
    </svg>
  );
}
