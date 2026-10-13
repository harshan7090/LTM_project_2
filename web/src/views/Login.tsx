/* Sign-in.
 *
 * A split: the field on the left, the form on the right.
 *
 * WHY A PHOTOGRAPH NOW
 *
 *   This panel used to be a drawn cutaway of buried pipe. It was accurate
 *   and it read as a diagram, which is to say, flat: the first screen a
 *   reviewer sees looked like a textbook figure. A field photograph says
 *   "this is about real assets and the people who inspect them" before a
 *   word is read. What keeps it from being a template is the treatment:
 *   graded into the console's graphite and oil green, and framed with the
 *   same corner brackets and status lamps the console uses.
 *
 * WHY IT DOES NOT GO SOFT
 *
 *   The source is 1024 x 682. Full-bleed on a 1366-wide laptop it is drawn
 *   at about its native size. On a tall monitor a full-height cover would
 *   stretch it 1.6x, so the photo box stops at 46rem and fades into solid
 *   graphite, and the copy sits on that. Nothing here scales it beyond
 *   roughly 1.1x in CSS pixels.
 *
 * It collapses to the form alone under 1024px. A decorative panel that
 * squeezes the actual task off a laptop screen is worse than no panel.
 */
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { api, auth } from '../lib/api';
import { Button } from '../components/ui';
import fieldPhoto from '../assets/login-field.webp';
import corvexMark from '../assets/corvex-mark.webp';

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
    /* `login-page` re-points the colour tokens to black and red for this
       screen only (see index.css), so the console keeps its own palette. */
    <div className="login-page grid min-h-screen lg:grid-cols-[1.15fr_minmax(420px,0.85fr)]">
      {/* ------------------------------------------------------- field -- */}
      <FieldHero />

      {/* -------------------------------------------------------- sign in -- */}
      <main className="login-form-side flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2.5">
            <img src={corvexMark} alt="" width={44} height={44}
                 className="brand-logo h-11 w-11 rounded-[6px]" />
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

            <Button type="submit" className="login-gloss login-cta w-full !py-[10px]" disabled={busy}>
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

/* --------------------------------------------------------------- hero --- */

/** Field photograph, graded into the product palette, with the headline.
 *  Always dark: the photo does not follow the theme toggle, because a
 *  light-graded industrial photo washes out to grey. */
function FieldHero() {
  return (
    <aside className="login-hero relative hidden overflow-hidden lg:block">
      {/* Photo box. Capped at 46rem tall so a tall monitor fades it into
          graphite instead of stretching it past its native resolution. */}
      <div className="absolute inset-x-0 top-0 h-full max-h-[46rem]">
        <img
          src={fieldPhoto}
          alt=""
          width={1024}
          height={682}
          decoding="async"
          fetchPriority="high"
          className="login-hero-photo h-full w-full object-cover"
        />
        <div className="login-hero-grade absolute inset-0" />
      </div>

      {/* Corner brackets: the console's panel signature, at full scale. */}
      <span className="hero-tick left-6 top-6 border-l border-t" aria-hidden />
      <span className="hero-tick right-6 top-6 border-r border-t" aria-hidden />
      <span className="hero-tick bottom-6 left-6 border-b border-l" aria-hidden />
      <span className="hero-tick bottom-6 right-6 border-b border-r" aria-hidden />

      {/* ------------------------------------------------------ status strip */}
      <div className="absolute inset-x-10 top-10 flex items-start justify-between gap-4">
        <div className="hero-chip flex items-center gap-2.5">
          <span className="lamp login-lamp" />
          <span className="label hero-label">Fleet online</span>
          <span className="num text-[10.5px] text-[rgba(241,243,237,0.72)]">IN · 5 zones</span>
        </div>
        <div className="hero-chip text-right">
          <div className="label hero-label">Field verification</div>
          <div className="num mt-0.5 text-[10px] text-[rgba(241,243,237,0.62)]">
            ASME B31.8 · 49 CFR 192 / 195
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- copy ---- */}
      <div className="absolute inset-x-0 bottom-0 px-10 pb-10">
        <div className="label hero-label mb-3 flex items-center gap-2">
          <span className="inline-block h-px w-6 bg-[var(--login-red)]" />
          AI-powered pipeline integrity
        </div>

        <h2 className="hero-title">
          Predict. Protect. <span className="login-gloss-text">Prevent.</span>
        </h2>

        <p className="mt-3 max-w-[50ch] text-[13px] leading-relaxed text-[rgba(241,243,237,0.80)]">
          Corvex predicts where buried pipe is corroding fastest, scores what a
          failure there would cost, and dispatches the nearest qualified crew.
          The AI explains every decision; it never makes one.
        </p>
      </div>
    </aside>
  );
}
