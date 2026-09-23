/**
 * Fleet Overview: risk distribution histogram, per-region breakdown, CSV export.
 * Supervisor/admin only — the backend enforces that with a real 403.
 */
import { apiBlob, apiGet } from './api.js';
import { $, esc, toast } from './ui.js';

let chart = null;

/** Reads the current theme's colours so the chart matches light/dark. */
function chartColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    accent: css.getPropertyValue('--accent').trim(),
    muted: css.getPropertyValue('--text-muted').trim(),
    border: css.getPropertyValue('--border').trim(),
  };
}

export async function loadFleet() {
  let stats;
  try {
    stats = await apiGet('/api/stats');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  $('#fleet-total').textContent = stats.total_segments;
  $('#fleet-critical').textContent = stats.risk_band_counts.critical;
  $('#fleet-elevated').textContent = stats.risk_band_counts.elevated;
  $('#fleet-normal').textContent = stats.risk_band_counts.normal;

  $('#region-breakdown').innerHTML = Object.entries(stats.avg_predicted_rate_by_region)
    .map(([region, rate]) => `
      <div class="region-row">
        <span>${esc(region)}</span>
        <span class="rate">${Number(rate).toFixed(2)} mpy</span>
      </div>`)
    .join('');

  renderHistogram(stats.histogram);
}

export function renderHistogram(histogram) {
  const ctx = $('#histogram-chart');
  if (!ctx || typeof Chart === 'undefined') return;
  const c = chartColors();

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: histogram.bin_edges.slice(0, -1).map((e) => String(e)),
      datasets: [{
        data: histogram.counts,
        backgroundColor: c.accent,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `${items[0].label} mpy and above`,
            label: (item) => `${item.raw} segments`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Predicted rate (mils/year)', color: c.muted, font: { size: 10 } },
          ticks: { color: c.muted, font: { size: 10 } },
          grid: { display: false },
        },
        y: {
          title: { display: true, text: 'Segments', color: c.muted, font: { size: 10 } },
          ticks: { color: c.muted, font: { size: 10 } },
          grid: { color: c.border },
        },
      },
    },
  });
}

/** Re-tints the chart after a theme change without refetching. */
export function retintChart() {
  if (!chart) return;
  const c = chartColors();
  chart.data.datasets[0].backgroundColor = c.accent;
  const { scales } = chart.options;
  for (const axis of ['x', 'y']) {
    scales[axis].ticks.color = c.muted;
    scales[axis].title.color = c.muted;
  }
  scales.y.grid.color = c.border;
  chart.update('none');
}

export function wireFleet() {
  $('#export-btn').addEventListener('click', async () => {
    try {
      const blob = await apiBlob('/api/export.csv');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'at_risk_segments.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast('Export downloaded', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
