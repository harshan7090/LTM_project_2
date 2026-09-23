/* Console shell.
 *
 * WHY A COMMAND BAR AND A RAIL, NOT A TAB STRIP
 *
 *   The previous shell put five views in a horizontal tab strip across the
 *   top. That works for five and stops working at seven, and it gave the
 *   fleet's live state nowhere to live — an operator had to enter a view to
 *   find out whether anything was wrong.
 *
 *   So the chrome is split by job:
 *
 *     top bar   WHAT IS TRUE RIGHT NOW. Fleet status, scope, clock,
 *               connection. Visible from every view, never scrolls away.
 *     left rail WHERE YOU ARE. Grouped by task, not alphabetically —
 *               Command / Operations / Intelligence is the order an
 *               integrity engineer actually works in.
 *
 *   The rail lists ONLY views that exist. No Settings, no Analytics, no
 *   Inspection entry that opens an empty page: a navigation item that leads
 *   nowhere is worse than a missing one, because it reads as broken rather
 *   than as unbuilt.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarRange, LayoutGrid, LogOut, Moon, Sparkles, Sun, TrendingUp, Truck,
} from 'lucide-react';

import { api, auth } from './lib/api';
import type { Me } from './lib/types';
import Login from './views/Login';
import Dashboard from './views/Dashboard';
import Assistant from './views/Assistant';
import Schedule from './views/Schedule';
import Fleet from './views/Fleet';
import Maintenance from './views/Maintenance';
import SegmentDrawer from './components/SegmentDrawer';
import { cx, useTheme } from './components/ui';

type View = 'dashboard' | 'assistant' | 'schedule' | 'maintenance' | 'fleet';

const PRIVILEGED = new Set(['supervisor', 'admin']);

interface NavItem {
  id: View;
  label: string;
  icon: typeof LayoutGrid;
  privileged?: boolean;
}

/* Grouped by the order the work happens in: look at the fleet, act on it,
   ask about it. */
const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Command',
    items: [
      { id: 'dashboard', label: 'Fleet Position', icon: LayoutGrid },
      { id: 'fleet', label: 'Zone Overview', icon: TrendingUp, privileged: true },
    ],
  },
  {
    title: 'Operations',
    items: [
      { id: 'schedule', label: 'Schedule', icon: CalendarRange, privileged: true },
      { id: 'maintenance', label: 'Dispatch', icon: Truck, privileged: true },
    ],
  },
  {
    title: 'Intelligence',
    items: [
      { id: 'assistant', label: 'AI Assistant', icon: Sparkles },
    ],
  },
];

export default function App() {
  const [authed, setAuthed] = useState(!!auth.token);
  const [view, setView] = useState<View>('dashboard');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(null);
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();

  const { data: me, error } = useQuery<Me>({
    queryKey: ['me'],
    queryFn: api.me,
    enabled: authed,
    retry: false,
  });

  /* Fleet state for the command bar. Shares a query key with the Dashboard,
     so this costs one request, not two. */
  const { data: segments = [], isError: fleetError } = useQuery({
    queryKey: ['segments'],
    queryFn: api.segments,
    enabled: authed,
  });
  const { data: routes = [] } = useQuery({
    queryKey: ['map-routes'],
    queryFn: api.mapRoutes,
    enabled: authed,
    staleTime: Infinity,
  });

  // A stale token in localStorage shouldn't strand the user on a blank shell.
  useEffect(() => {
    if (error) {
      auth.clear();
      setAuthed(false);
    }
  }, [error]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* sign out locally regardless */ }
    auth.clear();
    qc.clear();
    setAuthed(false);
    setView('dashboard');
    setDrawerId(null);
    setScopeId(null);
  }, [qc]);

  const askAssistant = useCallback((id: string) => {
    setScopeId(id);
    setDrawerId(null);
    setView('assistant');
  }, []);

  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  if (!me) return <Boot />;

  const critical = segments.filter((s) => s.risk_band === 'critical').length;
  const visibleGroups = NAV_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((n) => !n.privileged || PRIVILEGED.has(me.role)),
    }))
    .filter((g) => g.items.length);

  return (
    <div className="flex min-h-screen flex-col">
      <CommandBar
        me={me}
        segments={segments.length}
        corridors={routes.length}
        critical={critical}
        degraded={fleetError}
        theme={theme}
        onToggleTheme={toggle}
        onSignOut={signOut}
      />

      <div className="flex min-h-0 flex-1">
        <Rail groups={visibleGroups} view={view} onPick={setView} />

        <main className="min-w-0 flex-1 px-[clamp(0.75rem,1.4vw,1.25rem)] pb-10 pt-3">
          {/* Keyed so a view change remounts and replays its entrance. The
              transition is short on purpose — an operator switching views is
              working, not being presented to. */}
          <div key={view} className="view-enter">
            {view === 'dashboard' && <Dashboard me={me} onAskAssistant={askAssistant} />}
            {view === 'assistant' && (
              <Assistant segmentId={scopeId} onClearScope={() => setScopeId(null)} />
            )}
            {view === 'schedule' && <Schedule onOpenSegment={setDrawerId} />}
            {view === 'maintenance' && <Maintenance onOpenSegment={setDrawerId} />}
            {view === 'fleet' && <Fleet />}
          </div>
        </main>
      </div>

      {/* The OVERLAY drawer, still used by Schedule and Dispatch: those views
          open a segment from a list that is not the register, where there is
          no neighbouring table worth keeping on screen. The Dashboard uses
          the same component in its inline split-pane form instead. */}
      <SegmentDrawer
        segmentId={drawerId}
        onClose={() => setDrawerId(null)}
        onAskAssistant={askAssistant}
      />
    </div>
  );
}

/* ========================================================= command bar == */

function CommandBar({
  me, segments, corridors, critical, degraded, theme, onToggleTheme, onSignOut,
}: {
  me: Me;
  segments: number;
  corridors: number;
  critical: number;
  degraded: boolean;
  theme: string;
  onToggleTheme: () => void;
  onSignOut: () => void;
}) {
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const status = degraded
    ? { tone: 'critical', text: 'Link degraded' }
    : critical > 0
      ? { tone: 'elevated', text: `${critical} critical` }
      : { tone: 'normal', text: 'Operational' };

  return (
    <header className="sticky top-0 z-40 flex h-[38px] flex-shrink-0 items-stretch
                       border-b border-line bg-panel/95 backdrop-blur">
      <div className="flex w-[186px] flex-shrink-0 items-center gap-2 border-r border-line px-3">
        <div className="grid h-[19px] w-[19px] place-items-center bg-accent
                        font-[family-name:var(--font-label)] text-[13px] font-bold
                        leading-none text-[#0d1110]">
          C
        </div>
        <span className="font-[family-name:var(--font-label)] text-[15px] font-semibold
                         uppercase leading-none tracking-[0.13em] text-ink">
          Corvex
        </span>
      </div>

      {/* Fleet state. The reason the bar exists: an operator should never
          have to open a view to learn something is wrong. */}
      <div className="flex items-center gap-2 border-r border-line px-3.5">
        <span className={cx('lamp', `lamp-${status.tone}`)} />
        <span className="label" style={{ fontSize: 9.5 }}>Fleet</span>
        <span
          className="num text-[11px] font-medium"
          style={{ color: `var(--color-${status.tone})` }}
        >
          {status.text}
        </span>
      </div>

      <div className="flex items-center gap-4 px-3.5 max-lg:hidden">
        <Stat label="Zones" value={me.region ? '1' : '5'} />
        <Stat label="Corridors" value={corridors ? String(corridors) : '—'} />
        <Stat label="Segments" value={segments ? segments.toLocaleString() : '—'} />
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3 border-l border-line px-3.5">
        <span className="num text-[11px] tabular-nums text-dim max-md:hidden">
          {clock.toLocaleTimeString('en-GB')}
        </span>
        <div className="text-right leading-tight max-sm:hidden">
          <div className="text-[11.5px] font-semibold text-ink">{me.name}</div>
          <div className="label" style={{ fontSize: 8.5 }}>
            {me.role} · {me.region ?? 'All zones'}
          </div>
        </div>
        <button
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="text-dim transition-colors hover:text-accent"
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
        </button>
        <button
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="text-dim transition-colors hover:text-critical"
        >
          <LogOut size={13} />
        </button>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label" style={{ fontSize: 8.5 }}>{label}</span>
      <span className="num text-[11.5px] text-secondary">{value}</span>
    </span>
  );
}

/* ================================================================ rail == */

function Rail({
  groups, view, onPick,
}: {
  groups: { title: string; items: NavItem[] }[];
  view: View;
  onPick: (v: View) => void;
}) {
  return (
    <nav
      aria-label="Console sections"
      className="sticky top-[38px] hidden h-[calc(100vh-38px)] w-[186px] flex-shrink-0
                 flex-col gap-5 overflow-y-auto border-r border-line bg-panel
                 py-4 md:flex"
    >
      {groups.map((g) => (
        <div key={g.title}>
          <div className="label px-3 pb-2" style={{ fontSize: 8.5 }}>{g.title}</div>
          {g.items.map(({ id, label, icon: Icon }) => {
            const on = view === id;
            return (
              <button
                key={id}
                onClick={() => onPick(id)}
                aria-current={on ? 'page' : undefined}
                className={cx(
                  'relative flex w-full items-center gap-2.5 px-3 py-[7px] text-left',
                  'text-[12.5px] transition-colors',
                  on ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink',
                )}
              >
                {/* Lit leading edge marks the active channel, the way a
                    hardware panel lights the selected input. */}
                {on && <span className="absolute inset-y-0 left-0 w-[2px] bg-accent" />}
                <Icon size={14} className={on ? 'text-accent' : 'text-dim'} />
                {label}
              </button>
            );
          })}
        </div>
      ))}

      <div className="flex-1" />
      <div className="px-3">
        <div className="label" style={{ fontSize: 8 }}>Data</div>
        <p className="mt-1 text-[10px] leading-snug text-dim">
          Synthetic demonstration fleet. Not an operating record.
        </p>
      </div>
    </nav>
  );
}

/* ================================================================ boot == */

/* Shown only while the session resolves. Deliberately not a progress
   theatre: it is usually on screen for under a second, and a fake loading
   bar that outlasts the thing it is measuring is worse than no bar. */
function Boot() {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-3">
        <div className="grid h-8 w-8 place-items-center bg-accent
                        font-[family-name:var(--font-label)] text-[20px] font-bold
                        leading-none text-[#0d1110]">
          C
        </div>
        <div className="label-lg" style={{ fontSize: 15 }}>Corvex</div>
        <div className="h-[2px] w-[132px] overflow-hidden bg-raised">
          <div className="boot-sweep h-full w-1/3 bg-accent" />
        </div>
        <div className="label" style={{ fontSize: 9 }}>Initialising fleet</div>
      </div>
    </div>
  );
}
