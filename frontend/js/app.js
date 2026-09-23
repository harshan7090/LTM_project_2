/**
 * App shell: auth, routing, theme, and wiring the modules together.
 *
 * Routing is hash-based so views are shareable and the browser Back button
 * works — #dashboard, #assistant, #fleet, and #segment/SEG-00042 to deep-link
 * straight into one segment's detail panel.
 */
import { apiGet, apiPost, login, session } from './api.js';
import { $, $$, toast, withTransition } from './ui.js';
import * as segments from './segments.js';
import * as fleet from './fleet.js';
import * as assistant from './assistant.js';
import * as palette from './palette.js';

const VIEWS = ['dashboard', 'assistant', 'fleet'];
const PRIVILEGED = new Set(['supervisor', 'admin']);

// ---------------------------------------------------------------- theme ----

const THEME_KEY = 'integrityai_theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  $('#theme-toggle').textContent = theme === 'light' ? 'Dark mode' : 'Light mode';
  fleet.retintChart();
}

function initTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    withTransition(() => applyTheme(next));
  });
}

// --------------------------------------------------------------- routing ----

function currentRoute() {
  const hash = location.hash.slice(1);
  if (hash.startsWith('segment/')) {
    return { view: 'dashboard', segment: decodeURIComponent(hash.slice('segment/'.length)) };
  }
  return { view: VIEWS.includes(hash) ? hash : 'dashboard', segment: null };
}

async function showView(view) {
  if (view === 'fleet' && !PRIVILEGED.has(session.me?.role)) {
    toast('Fleet Overview requires supervisor or admin access', 'error');
    view = 'dashboard';
  }

  withTransition(() => {
    VIEWS.forEach((v) => $(`#view-${v}`).classList.toggle('hidden', v !== view));
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  });

  if (view === 'fleet') await fleet.loadFleet();
  if (view === 'assistant') await assistant.refreshStatus();
}

async function handleRoute() {
  const { view, segment } = currentRoute();
  await showView(view);
  if (segment) await segments.openDetail(segment);
}

function navigate(view) {
  location.hash = view;
}

// ------------------------------------------------------------------ auth ----

async function enterApp() {
  session.me = await apiGet('/api/me');
  const me = session.me;

  $('#login-view').style.display = 'none';
  $('#app-view').style.display = 'block';

  $('#user-name').textContent = me.name;
  $('#user-role').textContent = me.role;
  $('#user-region').textContent = me.region ? `Region: ${me.region}` : 'All regions';
  $('#dashboard-scope-note').textContent = me.region
    ? `Showing segments in your assigned region: ${me.region}`
    : 'Showing all regions';

  $('#nav-fleet').classList.toggle('hidden', !PRIVILEGED.has(me.role));

  await segments.loadDashboard();
  registerCommands();
  await handleRoute();
}

function wireAuth() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.textContent = '';
    try {
      const data = await login(
        $('#login-username').value.trim(),
        $('#login-password').value,
      );
      session.set(data.token);
      await enterApp();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await apiPost('/api/logout'); } catch { /* logging out locally regardless */ }
    session.clear();
    $('#app-view').style.display = 'none';
    $('#login-view').style.display = 'flex';
  });
}

// -------------------------------------------------------------- commands ----

function registerCommands() {
  const base = [
    { label: 'Go to Dashboard', hint: 'g d', run: () => navigate('dashboard') },
    { label: 'Go to AI Assistant', hint: 'g a', run: () => navigate('assistant') },
    { label: 'Toggle light / dark theme', run: () => $('#theme-toggle').click() },
    {
      label: 'Filter: critical segments',
      run: () => { navigate('dashboard'); $('.filter-btn[data-filter="critical"]').click(); },
    },
    {
      label: 'Filter: elevated segments',
      run: () => { navigate('dashboard'); $('.filter-btn[data-filter="elevated"]').click(); },
    },
    { label: 'Sign out', run: () => $('#logout-btn').click() },
  ];

  if (PRIVILEGED.has(session.me?.role)) {
    base.splice(2, 0, { label: 'Go to Fleet Overview', hint: 'g f', run: () => navigate('fleet') });
    base.push({ label: 'Export at-risk segments (CSV)', run: () => $('#export-btn').click() });
  }

  // Segment IDs become searchable entries, so the palette doubles as a jump-to.
  const segmentCommands = segments.state.all.map((s) => ({
    label: s.segment_id,
    sub: `${s.region} — ${s.predicted_rate_mpy.toFixed(2)} mpy (${s.risk_band})`,
    dynamic: true,   // hidden until the user types
    run: () => { location.hash = `segment/${encodeURIComponent(s.segment_id)}`; },
  }));

  palette.setCommands([...base, ...segmentCommands]);
}

// ------------------------------------------------------------------ boot ----

function wireNav() {
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => navigate(item.dataset.view));
  });

  window.addEventListener('hashchange', handleRoute);

  // Escape closes the detail panel (the palette is a <dialog>, which handles
  // its own Escape natively).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') segments.closeDetail();
  });
}

(async function boot() {
  initTheme();
  wireAuth();
  wireNav();
  segments.wireSegments();
  fleet.wireFleet();
  assistant.wireAssistant();
  palette.wirePalette();

  // Jumping to the assistant from a segment's detail panel.
  segments.state.onAskAssistant = (segmentId) => {
    assistant.focusSegment(segmentId);
    navigate('assistant');
  };

  $('#open-palette').addEventListener('click', () => palette.openPalette());

  $('#search-input').addEventListener('input', (e) => {
    segments.state.query = e.target.value;
    segments.state.shown = 100;
    segments.renderTable();
  });

  if (session.token) {
    try {
      await enterApp();
      return;
    } catch {
      session.clear();
    }
  }
  $('#login-view').style.display = 'flex';
})();
