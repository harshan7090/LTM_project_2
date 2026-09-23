import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { RiskBand } from '../lib/types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- status ---

const BAND_TEXT: Record<RiskBand, string> = {
  critical: 'text-critical',
  elevated: 'text-elevated',
  normal: 'text-normal',
};

/**
 * An HMI indicator lamp plus its label. Replaces the pill-shaped badge — on a
 * control panel, status is a light, and a lit lamp is legible at a glance in a
 * way a coloured rectangle full of text is not.
 */
export function RiskBadge({ band, bare = false }: { band: RiskBand; bare?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5', BAND_TEXT[band])}>
      <span className={cx('lamp', band === 'critical' && 'lamp-critical')} />
      {!bare && (
        <span className="label" style={{ color: 'inherit', fontSize: 10 }}>
          {band}
        </span>
      )}
    </span>
  );
}

// --------------------------------------------------------------- buttons ---

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'subtle';
  size?: 'sm' | 'md';
};

export function Button({
  variant = 'primary', size = 'md', className, ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[2px]',
        'font-[family-name:var(--font-label)] uppercase tracking-[0.11em]',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'px-3 py-[5px] text-[11px]' : 'px-4 py-[7px] text-[12px]',
        variant === 'primary' &&
          'bg-accent text-[var(--color-on-accent)] font-bold hover:brightness-110',
        variant === 'ghost' &&
          'border border-line text-ink font-semibold hover:border-accent hover:text-accent',
        variant === 'subtle' && 'text-muted font-semibold hover:text-accent',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------- panels ---

/** Plain bordered region. */
export function Panel({
  className, children, bracket = false,
}: { className?: string; children: ReactNode; bracket?: boolean }) {
  return (
    <div
      className={cx(
        'rounded-[2px] border border-line-soft bg-panel',
        bracket && 'bracket',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A panel with a titled header rail — the standard container in this UI.
 * `id` renders as a small monospace tag on the right, the way instrument
 * panels carry a channel or tag number.
 */
export function Module({
  title, id, num, sub, right, className, bodyClass, children, bracket = true,
}: {
  title: string;
  id?: string;
  /** Section number, e.g. "03". Drawing-sheet convention: it gives every
   *  panel an address you can refer to out loud. */
  num?: string;
  /** Small technical line under the title — units, scope, provenance. */
  sub?: string;
  right?: ReactNode;
  className?: string;
  bodyClass?: string;
  children: ReactNode;
  bracket?: boolean;
}) {
  return (
    <section
      className={cx(
        'rounded-[2px] border border-line-soft bg-panel',
        bracket && 'bracket',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-[7px]">
        {num && (
          <span className="num text-[9.5px] text-accent" aria-hidden="true">{num}</span>
        )}
        <div className="min-w-0">
          <h2 className="label" style={{ color: 'var(--color-muted)' }}>{title}</h2>
          {sub && (
            <div className="num mt-[2px] text-[9px] leading-none text-dim">{sub}</div>
          )}
        </div>
        {id && <span className="num text-[10px] text-dim">[{id}]</span>}
        <div className="flex-1" />
        {right}
      </header>
      <div className={bodyClass ?? 'p-3'}>{children}</div>
    </section>
  );
}

/**
 * A readout, not a "stat card". Value dominates, label is a small tracked
 * caption above it, and an optional unit sits alongside in dim mono — the
 * layout a physical gauge uses.
 */
export function Readout({
  label, value, unit, tone, sub,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: RiskBand | 'accent' | 'neutral';
  sub?: string;
}) {
  const toneClass =
    tone === 'critical' ? 'text-critical'
      : tone === 'elevated' ? 'text-elevated'
        : tone === 'normal' ? 'text-normal'
          : tone === 'accent' ? 'text-accent'
            : 'text-ink';
  return (
    <div className="bracket rounded-[2px] px-3 py-2.5">
      <div className="label mb-1.5">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className={cx('num text-[26px] font-semibold leading-none', toneClass)}>
          {value}
        </span>
        {unit && <span className="num text-[11px] text-dim">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-[10.5px] text-dim">{sub}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="label mb-2">{children}</h3>;
}

// -------------------------------------------------------------- feedback ---

/** Instrument-style progress: a thin amber line sweeping across the panel. */
export function Sweep({ label }: { label?: string }) {
  return (
    <div className="w-full">
      <div className="relative h-[2px] w-full overflow-hidden bg-raised">
        <div className="animate-sweep absolute inset-y-0 w-1/4 bg-accent" />
      </div>
      {label && <div className="mt-2 text-[11px] text-muted">{label}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span className="inline-flex gap-[3px]">
        <span className="animate-blink h-[3px] w-[3px] bg-accent" />
        <span className="animate-blink h-[3px] w-[3px] bg-accent [animation-delay:0.15s]" />
        <span className="animate-blink h-[3px] w-[3px] bg-accent [animation-delay:0.3s]" />
      </span>
      {label && <span>{label}</span>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="label mb-1.5">No data</div>
      <div className="text-[12px] text-muted">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- toasts ---

type Toast = { id: number; message: string; kind: 'info' | 'error' | 'success' };
type ToastFn = (message: string, kind?: Toast['kind']) => void;

const ToastContext = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastContext);

const TOAST_TONE: Record<Toast['kind'], string> = {
  error: 'text-critical',
  success: 'text-normal',
  info: 'text-accent',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback<ToastFn>((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4800);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-90 flex flex-col gap-1.5">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="animate-fade-up flex max-w-sm items-start gap-2 border border-line
                       bg-panel px-3 py-2 text-[12px] shadow-[0_6px_24px_rgba(0,0,0,0.5)]"
          >
            <span className={cx('lamp mt-1', TOAST_TONE[t.kind])} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ----------------------------------------------------------------- theme ---

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('integrityai_theme') as 'dark' | 'light') || 'dark',
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.classList.toggle('light', theme === 'light');
    localStorage.setItem('integrityai_theme', theme);
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

// ------------------------------------------------------------ formatting ---

export const fmt = {
  rate: (v: number) => v.toFixed(2),
  years: (v: number) => `${v.toFixed(1)} yr`,
  label: (s: string) => s.replaceAll('_', ' '),
  /** Zero-padded row index, so the row-number column stays a fixed width. */
  idx: (n: number) => String(n).padStart(4, '0'),
};

/* ====================================================== technical detail == */

/**
 * A small labelled reading — coordinates, units, provenance.
 *
 * These are the details that make an instrument look like an instrument: a
 * panel that states its own scope and units reads as engineered, while the
 * same panel with a bare number reads as a template.
 */
export function Telemetry({
  items, className,
}: {
  items: { k: string; v: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {items.map(({ k, v }) => (
        <span key={k} className="flex items-baseline gap-1.5">
          <span className="label" style={{ fontSize: 8 }}>{k}</span>
          <span className="num text-[10.5px] text-muted">{v}</span>
        </span>
      ))}
    </div>
  );
}

/** Inline proportional bar. Thin, because it sits inside a table row. */
export function Meter({
  value, max, tone = 'var(--color-accent)', width = 54,
}: {
  value: number;
  max: number;
  tone?: string;
  width?: number;
}) {
  const pct = Math.max(Math.min((value / (max || 1)) * 100, 100), 2);
  return (
    <span
      className="relative inline-block h-[3px] bg-raised align-middle"
      style={{ width }}
      role="presentation"
    >
      <span
        className="absolute inset-y-0 left-0 block"
        style={{ width: `${pct}%`, background: tone }}
      />
    </span>
  );
}

/**
 * A failure, stated in the language of the system.
 *
 * "Something went wrong" tells an operator nothing they can act on. Naming
 * what could not be reached, and when it last worked, tells them whether to
 * retry, wait, or call someone.
 */
export function ErrorState({
  what, detail, lastOk, onRetry,
}: {
  what: string;
  detail?: string;
  lastOk?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="border border-critical/40 bg-critical/[0.06] px-4 py-4">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="lamp lamp-critical" />
        <span className="label text-critical">{what}</span>
      </div>
      {detail && (
        <p className="max-w-[52ch] text-[11.5px] leading-relaxed text-muted">{detail}</p>
      )}
      {lastOk && (
        <div className="mt-2.5">
          <span className="label" style={{ fontSize: 8 }}>Last successful sync</span>
          <div className="num text-[11px] text-secondary">{lastOk}</div>
        </div>
      )}
      {onRetry && (
        <Button variant="ghost" size="sm" className="mt-3" onClick={onRetry}>
          Retry connection
        </Button>
      )}
    </div>
  );
}

/**
 * Loading placeholder shaped like the thing it replaces.
 *
 * A spinner says "wait"; a skeleton says "wait, and here is what is coming",
 * which stops the layout jumping when the data lands.
 */
export function Skeleton({
  rows = 3, className,
}: { rows?: number; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skeleton h-[11px] bg-raised"
          // Staggered widths so it reads as text, not as a progress bar.
          style={{ width: `${88 - (i % 3) * 17}%`, animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  );
}
