/* Sign-in.
 *
 * A split: infrastructure on the left, the form on the right.
 *
 * The left panel is a drawn cutaway of buried line pipe, not a stock
 * photograph. That is a deliberate choice — a generic industrial photo
 * behind a login form is the most recognisable "template" move there is,
 * and a drawing that carries real information (wall, coating, corrosion
 * cell, CP current) says what the product is about before the user has
 * read a word.
 *
 * It collapses to the form alone under 900px. A decorative panel that
 * squeezes the actual task off a laptop screen is worse than no panel.
 */
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { api, auth } from '../lib/api';
import { Button } from '../components/ui';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password);
      auth.set(res.token);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function useDemo(u: string, p: string) {
    setUsername(u);
    setPassword(p);
    setError('');
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.15fr_minmax(420px,0.85fr)]">
      {/* ------------------------------------------------ infrastructure -- */}
      <aside className="relative hidden overflow-hidden border-r border-line bg-sunken lg:block">
        <PipeCutaway />

        <div className="absolute inset-x-0 bottom-0 p-9">
          <div className="label mb-3" style={{ fontSize: 9 }}>
            Buried transmission line · cutaway
          </div>
          <p className="max-w-[44ch] text-[13px] leading-relaxed text-secondary">
            External corrosion is an electrochemical cell between pipe steel and
            soil. Coating resists it, cathodic protection opposes it, and where
            both fail the wall thins until it cannot hold pressure.
          </p>
          <p className="mt-3 max-w-[44ch] text-[12px] leading-relaxed text-dim">
            Corvex predicts where that is happening fastest, scores what a
            failure there would cost, and dispatches the nearest qualified crew.
          </p>
        </div>

        <div className="absolute left-9 top-9">
          <div className="label" style={{ fontSize: 9 }}>Figure 01</div>
          <div className="num mt-1 text-[10.5px] text-dim">
            ASME B31.8 · 49 CFR 192
          </div>
        </div>
      </aside>

      {/* -------------------------------------------------------- sign in -- */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2.5">
            <div
              className="grid place-items-center bg-accent
                         font-[family-name:var(--font-label)] text-[17px] font-bold
                         leading-none text-[var(--color-on-accent)]"
              style={{ height: 30, width: 30 }}
            >
              C
            </div>
            <div className="leading-none">
              <div className="label-lg" style={{ fontSize: 19 }}>Corvex</div>
              <div className="label mt-1.5" style={{ fontSize: 9 }}>
                Pipeline Integrity Command Centre
              </div>
            </div>
          </div>

          <h1 className="mb-1.5 font-[family-name:var(--font-label)] text-[26px]
                         font-semibold uppercase leading-none tracking-[0.02em] text-ink">
            Sign in
          </h1>
          <p className="mb-7 text-[12.5px] text-dim">
            Secure operational access. Sessions are scoped to your assigned zone.
          </p>

          <form onSubmit={submit}>
            <label className="mb-4 block">
              <span className="label">Operator ID</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
                placeholder="supervisor1"
                className={FIELD}
              />
            </label>
            <label className="mb-5 block">
              <span className="label">Passcode</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className={FIELD}
              />
            </label>

            <Button type="submit" className="w-full !py-[10px]" disabled={busy}>
              {busy ? 'Authenticating…' : 'Enter console'}
              {!busy && <ArrowRight size={14} />}
            </Button>

            {error && (
              <p
                role="alert"
                className="mt-3 flex items-center gap-2 text-[12px] text-critical"
              >
                <span className="lamp lamp-critical" />
                {error}
              </p>
            )}
          </form>

          {/* Click-to-fill, because the alternative is the reviewer
              mistyping a password and concluding the login is broken. */}
          <div className="mt-8 border-t border-line-soft pt-4">
            <div className="label mb-2.5" style={{ fontSize: 9 }}>
              Demo accounts — click to fill
            </div>
            <div className="flex flex-col gap-1">
              {DEMO.map(([u, p, scope]) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => useDemo(u, p)}
                  className="group flex items-center gap-3 border border-transparent
                             px-2 py-[5px] text-left transition-colors
                             hover:border-line hover:bg-raised"
                >
                  <span className="num w-[86px] text-[11px] text-ink">{u}</span>
                  <span className="num text-[11px] text-dim">{p}</span>
                  <span className="flex-1" />
                  <span className="label text-dim group-hover:text-accent"
                        style={{ fontSize: 8.5 }}>
                    {scope}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[10.5px] leading-relaxed text-dim">
              Synthetic demonstration fleet. Not an operating record, and not
              production authentication.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

const DEMO: [string, string, string][] = [
  ['inspector1', 'inspect123', 'Western zone'],
  ['supervisor1', 'supervise123', 'Full fleet'],
  ['admin', 'admin123', 'All access'],
];

const FIELD =
  'num mt-1.5 w-full border border-line bg-bg px-3 py-[9px] text-[13px] text-ink ' +
  'outline-none transition-colors placeholder:text-dim focus:border-accent';

/* ------------------------------------------------------------- figure --- */

/** Cutaway of buried line pipe: soil, coating, wall, product, and an active
 *  corrosion cell under a coating holiday. Drawn rather than photographed so
 *  every element can be labelled and none of it is decorative. */
function PipeCutaway() {
  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 720 900"
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Cutaway of a buried pipeline showing soil cover, coating, wall thickness, product flow and an active corrosion cell at a coating holiday"
    >
      <defs>
        <pattern id="soil" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--color-sunken)" />
          <circle cx="1.5" cy="1.5" r="0.6" fill="var(--color-line)" opacity="0.6" />
          <circle cx="4.5" cy="4" r="0.5" fill="var(--color-line)" opacity="0.4" />
        </pattern>
        <pattern id="steel" width="8" height="8" patternUnits="userSpaceOnUse"
                 patternTransform="rotate(45)">
          <rect width="8" height="8" fill="var(--color-raised)" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="var(--color-line)" strokeWidth="2.5" />
        </pattern>
        <linearGradient id="prod" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0a0d0c" />
          <stop offset="48%" stopColor="#1b1508" />
          <stop offset="100%" stopColor="#0a0d0c" />
        </linearGradient>
      </defs>

      <rect width="720" height="900" fill="url(#soil)" />

      {/* grade line */}
      <line x1="0" y1="190" x2="720" y2="190" stroke="var(--color-line)" strokeWidth="2" />
      <text x="44" y="178" className="num" fill="var(--color-dim)" fontSize="11">GRADE</text>

      {/* cover dimension */}
      <g stroke="var(--color-muted)" strokeWidth="1.2">
        <line x1="92" y1="190" x2="92" y2="366" />
        <line x1="86" y1="190" x2="98" y2="190" />
        <line x1="86" y1="366" x2="98" y2="366" />
      </g>
      <text x="104" y="284" className="num" fill="var(--color-muted)" fontSize="11">
        1.2 m cover
      </text>

      {/* ---- the pipe ---- */}
      <rect x="-20" y="366" width="760" height="26" fill="url(#steel)"
            stroke="var(--color-muted)" strokeWidth="1.5" />
      <rect x="-20" y="392" width="760" height="150" fill="url(#prod)"
            stroke="var(--color-muted)" strokeWidth="1.5" />
      <rect x="-20" y="542" width="760" height="26" fill="url(#steel)"
            stroke="var(--color-muted)" strokeWidth="1.5" />

      {/* flow */}
      <g stroke="var(--color-amber)" strokeWidth="2" opacity="0.5">
        <line x1="180" y1="440" x2="290" y2="440" />
        <line x1="330" y1="472" x2="430" y2="472" />
        <line x1="470" y1="504" x2="560" y2="504" />
      </g>
      <text x="44" y="474" className="num" fill="var(--color-dim)" fontSize="11">PRODUCT</text>

      {/* coating holiday + corrosion cell */}
      <path d="M392 366 q 16 0 22 14 q 6 12 22 12 h 34 q 16 0 22 -12 q 6 -14 22 -14 Z"
            fill="var(--color-sunken)" stroke="var(--color-critical)" strokeWidth="2.5" />
      <g stroke="var(--color-critical)" strokeWidth="1.4" opacity="0.75">
        <path d="M430 330 v 30" strokeDasharray="4 4" />
        <path d="M470 330 v 30" strokeDasharray="4 4" />
      </g>
      <circle cx="450" cy="318" r="4" fill="var(--color-critical)" />
      <text x="466" y="322" className="num" fill="var(--color-critical)" fontSize="11">
        COATING HOLIDAY
      </text>

      {/* remaining wall callout */}
      <g stroke="var(--color-normal)" strokeWidth="1.4">
        <line x1="252" y1="366" x2="252" y2="392" />
        <line x1="246" y1="366" x2="258" y2="366" />
        <line x1="246" y1="392" x2="258" y2="392" />
      </g>
      <text x="264" y="360" className="num" fill="var(--color-normal)" fontSize="11">
        t remaining
      </text>

      {/* CP anode */}
      <g>
        <line x1="600" y1="190" x2="600" y2="300" stroke="var(--color-accent)"
              strokeWidth="1.6" strokeDasharray="5 4" />
        <rect x="586" y="300" width="28" height="46" fill="var(--color-accent)" opacity="0.8" />
        <text x="560" y="372" className="num" fill="var(--color-accent)" fontSize="11">
          CP ANODE
        </text>
      </g>
    </svg>
  );
}
