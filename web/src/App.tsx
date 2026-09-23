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

const NAV: { id: View; label: string; icon: typeof LayoutGrid; privileged?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutGrid },
  { id: 'assistant', label: 'AI Assistant', icon: Sparkles },
  { id: 'schedule', label: 'Schedule', icon: CalendarRange, privileged: true },
  { id: 'maintenance', label: 'Dispatch', icon: Truck, privileged: true },
  { id: 'fleet', label: 'Fleet Overview', icon: TrendingUp, privileged: true },
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

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }
  if (!me) {
    return <div className="grid min-h-screen place-items-center text-[13px] text-muted">Loading…</div>;
  }

  const visibleNav = NAV.filter((n) => !n.privileged || PRIVILEGED.has(me.role));

  return (
    <div className="min-h-screen">
      {/* ---- status rail: always-visible system state, like an HMI header --- */}
      <header className="sticky top-0 z-40 border-b border-line bg-panel/95 backdrop-blur">
        <div className="flex items-stretch">
          {/* identity block */}
          <div className="flex items-center gap-2.5 border-r border-line px-3.5 py-2">
            <div
              className="grid place-items-center bg-accent font-[family-name:var(--font-label)]
                         text-[13px] font-bold tracking-tight text-[#17130a]"
              style={{ height: 24, width: 24 }}
            >
              C
            </div>
            <div className="leading-none">
              <div className="label-lg" style={{ fontSize: 15 }}>Corvex</div>
              <div className="label mt-[3px]" style={{ fontSize: 9 }}>
                Corrosion Integrity Console
              </div>
            </div>
          </div>

          {/* nav — tabs on a rail, not buttons in a sidebar */}
          <nav className="flex overflow-x-auto">
            {visibleNav.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className={cx(
                  'relative flex items-center gap-2 whitespace-nowrap border-r border-line',
                  'px-4 font-[family-name:var(--font-label)] text-[12px] uppercase',
                  'tracking-[0.11em] transition-colors',
                  view === id
                    ? 'bg-raised text-accent'
                    : 'text-muted hover:bg-raised hover:text-ink',
                )}
              >
                {/* lit top edge marks the active channel */}
                {view === id && (
                  <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />
                )}
                <Icon size={13} />
                {label}
              </button>
            ))}
          </nav>

          <div className="flex-1" />

          {/* operator + controls */}
          <div className="flex items-center gap-3 border-l border-line px-3.5">
            <div className="text-right leading-tight max-sm:hidden">
              <div className="text-[12px] font-semibold">{me.name}</div>
              <div className="label" style={{ fontSize: 9 }}>
                {me.role} · {me.region ?? 'All regions'}
              </div>
            </div>
            <button
              onClick={toggle}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
              className="text-dim transition-colors hover:text-accent"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button
              onClick={signOut}
              title="Sign out"
              className="text-dim transition-colors hover:text-critical"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto min-w-0 max-w-[1600px] px-[clamp(0.9rem,2vw,1.6rem)] pb-12 pt-4">
        {view === 'dashboard' && <Dashboard me={me} onAskAssistant={askAssistant} />}
        {view === 'assistant' && (
          <Assistant segmentId={scopeId} onClearScope={() => setScopeId(null)} />
        )}
        {view === 'schedule' && <Schedule onOpenSegment={setDrawerId} />}
        {view === 'maintenance' && <Maintenance onOpenSegment={setDrawerId} />}
        {view === 'fleet' && <Fleet />}
      </main>

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
