import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Download } from 'lucide-react';

import { api } from '../lib/api';
import { Button, Module, Readout, Sweep, useToast } from '../components/ui';

export default function Fleet() {
  const toast = useToast();
  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
  });

  async function exportCsv() {
    try {
      const blob = await api.exportCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'at_risk_segments.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast('Export downloaded', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  if (isLoading) return <Sweep label="Loading fleet statistics…" />;
  if (error) return <p className="text-[13px] text-critical">{(error as Error).message}</p>;
  if (!stats) return null;

  const histogram = stats.histogram.counts.map((count, i) => ({
    bin: stats.histogram.bin_edges[i],
    count,
  }));

  // Recover the band cut-offs from the cumulative distribution so the bars can
  // be coloured with the same semantics the backend uses (critical = top 10%
  // of predicted rate, elevated = next 20%). Derived rather than hardcoded, so
  // the chart stays correct if those percentiles change in ml.py.
  const totalCount = stats.histogram.counts.reduce((a, b) => a + b, 0) || 1;
  const cutAt = (fraction: number) => {
    let seen = 0;
    for (let i = 0; i < histogram.length; i++) {
      seen += histogram[i].count;
      if (seen / totalCount >= fraction) return histogram[i].bin;
    }
    return histogram[histogram.length - 1]?.bin ?? 0;
  };
  const elevatedCut = cutAt(0.7);
  const criticalCut = cutAt(0.9);

  const regions = Object.entries(stats.avg_predicted_rate_by_region)
    .sort((a, b) => b[1] - a[1]);
  const maxRegion = Math.max(...regions.map(([, v]) => v), 0.01);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(155px,1fr))]">
        <Readout label="Total segments" value={stats.total_segments.toLocaleString()} unit="seg" />
        <Readout label="Critical" value={stats.risk_band_counts.critical} tone="critical" />
        <Readout label="Elevated" value={stats.risk_band_counts.elevated} tone="elevated" />
        <Readout label="Normal" value={stats.risk_band_counts.normal} tone="normal" />
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(330px,1fr))]">
        <Module title="Predicted Corrosion Rate Distribution" id="HIST">
          <div style={{ height: 235 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={histogram} margin={{ top: 4, right: 8, bottom: 18, left: -14 }}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis
                  dataKey="bin"
                  tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                  stroke="var(--color-line)"
                  label={{
                    value: 'Predicted rate (mils/year)',
                    position: 'insideBottom', offset: -10,
                    fill: 'var(--color-muted)', fontSize: 10,
                  }}
                />
                <YAxis
                  tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
                  stroke="var(--color-line)"
                />
                <Tooltip
                  cursor={{ fill: 'var(--color-raised)' }}
                  contentStyle={{
                    background: 'var(--color-panel)',
                    border: '1px solid var(--color-line)',
                    borderRadius: 2,
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                  }}
                  labelFormatter={(v) => `${v} mpy and above`}
                  formatter={(v: number) => [`${v} segments`, '']}
                />
                {/* Bars carry the band colour rather than one flat accent, so
                    the histogram encodes the same risk semantics as the table. */}
                <Bar dataKey="count" radius={[0, 0, 0, 0]}>
                  {histogram.map((h, i) => (
                    <Cell
                      key={i}
                      fill={
                        h.bin >= criticalCut ? 'var(--color-critical)'
                          : h.bin >= elevatedCut ? 'var(--color-elevated)'
                            : 'var(--color-normal)'
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Module>

        <Module title="Average Predicted Rate by Region" id="REG">
          <div className="flex flex-col gap-2.5">
            {regions.map(([region, rate]) => (
              <div key={region}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[12px]">{region}</span>
                  <span className="num text-[12px] text-muted">
                    {rate.toFixed(2)} <span className="text-dim">mpy</span>
                  </span>
                </div>
                <div className="h-[5px] bg-raised">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${(rate / maxRegion) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Module>
      </div>

      <div>
        <Button variant="ghost" size="sm" onClick={exportCsv}>
          <Download size={12} /> Export at-risk segments
        </Button>
      </div>
    </div>
  );
}
