/**
 * Dashboard: segment table and the segment detail slide-over.
 *
 * The old console rendered only the top 150 rows with no way to reach the
 * rest. This adds search, sortable columns, and incremental "load more" so all
 * 5000 segments are actually reachable, while still never putting more than a
 * page of rows in the DOM at once.
 */
import { apiGet, apiPost } from './api.js';
import { $, $$, esc, fmt, toast } from './ui.js';

const PAGE_SIZE = 100;

export const state = {
  all: [],
  filter: 'all',
  query: '',
  sortKey: 'predicted_rate_mpy',
  sortDir: 'desc',
  shown: PAGE_SIZE,
  current: null,     // currently open segment detail
  onAskAssistant: null,  // wired by app.js to jump to the assistant view
};

/** Applies filter + search + sort. Pure — returns a new array. */
export function visibleRows() {
  let rows = state.all;

  if (state.filter !== 'all') {
    rows = rows.filter((s) => s.risk_band === state.filter);
  }

  const q = state.query.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (s) => s.segment_id.toLowerCase().includes(q) || s.region.toLowerCase().includes(q),
    );
  }

  const { sortKey, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    if (typeof av === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * dir;
    return (av - bv) * dir;
  });
}

export async function loadDashboard() {
  const [segData, alertData] = await Promise.all([
    apiGet('/api/segments'),
    apiGet('/api/alerts'),
  ]);
  state.all = segData.segments;

  $('#stat-critical').textContent = alertData.critical.length;
  $('#stat-elevated').textContent = alertData.elevated.length;
  $('#stat-normal').textContent = state.all.filter((s) => s.risk_band === 'normal').length;

  renderTable();
}

export function renderTable() {
  const tbody = $('#segments-tbody');
  const empty = $('#segments-empty');
  const rows = visibleRows();
  const page = rows.slice(0, state.shown);

  if (!rows.length) {
    tbody.replaceChildren();
    empty.classList.remove('hidden');
    $('#segments-count-note').textContent = '';
    $('#load-more').classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = page.map((s) => `
    <tr data-id="${esc(s.segment_id)}" tabindex="0">
      <td class="seg-id">${esc(s.segment_id)}</td>
      <td>${esc(s.region)}</td>
      <td class="mono">${fmt.rate(s.predicted_rate_mpy)}</td>
      <td><span class="badge ${esc(s.risk_band)}">${esc(s.risk_band)}</span></td>
      <td>${fmt.years(s.last_inspection_years_ago)} ago</td>
      <td>${s.acknowledged ? '<span class="ack-tag">Acknowledged</span>' : ''}</td>
    </tr>`).join('');

  $('#segments-count-note').textContent =
    `Showing ${page.length} of ${rows.length} segment${rows.length === 1 ? '' : 's'}` +
    (rows.length !== state.all.length ? ` (filtered from ${state.all.length})` : '');

  $('#load-more').classList.toggle('hidden', page.length >= rows.length);

  // Update the sort indicators on the headers.
  $$('#segments-table th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.sortKey;
    th.setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    const arrow = $('.arrow', th);
    if (arrow) arrow.textContent = active && state.sortDir === 'asc' ? '↑' : '↓';
  });
}

// ------------------------------------------------------------- detail ----

export async function openDetail(segmentId) {
  let detail;
  try {
    detail = await apiGet(`/api/segments/${encodeURIComponent(segmentId)}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  state.current = detail;

  $('#detail-id').textContent = detail.segment_id;
  $('#detail-region').textContent = `${detail.region} region`;
  $('#detail-risk-line').innerHTML =
    `<span class="badge ${esc(detail.risk_band)}">${esc(detail.risk_band)}</span>
     &nbsp; Predicted rate:
     <span class="mono">${fmt.rate(detail.predicted_rate_mpy)} mils/year</span>`;

  const contributions = detail.explanation?.contributions ?? [];
  const maxAbs = Math.max(...contributions.map((c) => Math.abs(c.impact_mpy)), 0.01);
  $('#detail-shap').innerHTML = contributions.map((c) => {
    const pct = Math.min((Math.abs(c.impact_mpy) / maxAbs) * 50, 50);
    const cls = c.impact_mpy >= 0 ? 'pos' : 'neg';
    const sign = c.impact_mpy > 0 ? '+' : '';
    return `
      <div class="shap-row">
        <div class="shap-label">
          <span>${esc(fmt.label(c.feature))}</span>
          <span>${sign}${c.impact_mpy.toFixed(2)} mpy</span>
        </div>
        <div class="shap-bar-track">
          <div class="center-tick"></div>
          <div class="shap-bar-fill ${cls}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }).join('');

  const top = contributions[0];
  const driver = top ? fmt.label(top.feature) : 'multiple factors';
  $('#detail-recommendation').textContent =
    detail.risk_band === 'critical'
      ? `Schedule direct assessment within 30 days. Primary driver: ${driver}.`
      : detail.risk_band === 'elevated'
        ? `Add to next inspection cycle. Primary driver: ${driver}.`
        : 'No immediate action required. Continue routine monitoring schedule.';

  $('#detail-attrs').innerHTML = Object.entries(detail.attributes ?? {}).map(
    ([k, v]) => `<div><div class="k">${esc(fmt.label(k))}</div><div class="v">${esc(v)}</div></div>`,
  ).join('');

  const ackBtn = $('#ack-btn');
  const ackStatus = $('#ack-status');
  if (detail.acknowledged) {
    ackBtn.disabled = true;
    ackBtn.textContent = 'Already acknowledged';
    ackStatus.textContent = `By ${detail.acknowledged.by} at ${detail.acknowledged.at}`;
  } else {
    ackBtn.disabled = false;
    ackBtn.textContent = 'Acknowledge alert';
    ackStatus.textContent = '';
  }

  showPanel();
}

export function showPanel() {
  $('#overlay').classList.add('open');
  $('#detail-panel').classList.add('open');
  $('#detail-panel').setAttribute('aria-hidden', 'false');
}

export function closeDetail() {
  $('#overlay').classList.remove('open');
  $('#detail-panel').classList.remove('open');
  $('#detail-panel').setAttribute('aria-hidden', 'true');
}

export async function acknowledgeCurrent() {
  if (!state.current) return;
  const id = state.current.segment_id;
  try {
    await apiPost(`/api/segments/${encodeURIComponent(id)}/acknowledge`);
    toast(`${id} acknowledged`, 'success');
    await openDetail(id);
    await loadDashboard();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// -------------------------------------------------------------- wiring ----

export function wireSegments() {
  $('#segments-tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });

  // Keyboard access: Enter/Space on a focused row opens it.
  $('#segments-tbody').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) { e.preventDefault(); openDetail(tr.dataset.id); }
  });

  $$('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      state.shown = PAGE_SIZE;
      renderTable();
    });
  });

  $$('#segments-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        // Text sorts read better ascending; numbers read better descending.
        state.sortDir = key === 'segment_id' || key === 'region' ? 'asc' : 'desc';
      }
      state.shown = PAGE_SIZE;
      renderTable();
    });
  });

  $('#load-more').addEventListener('click', () => {
    state.shown += PAGE_SIZE;
    renderTable();
  });

  $('#detail-close').addEventListener('click', closeDetail);
  $('#overlay').addEventListener('click', closeDetail);
  $('#ack-btn').addEventListener('click', acknowledgeCurrent);

  $('#detail-ask-ai').addEventListener('click', () => {
    if (state.current && state.onAskAssistant) {
      state.onAskAssistant(state.current.segment_id);
      closeDetail();
    }
  });
}
