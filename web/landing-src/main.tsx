/* Entry point.
 *
 * Three jobs, in this order: mount React, turn scroll into the journey
 * value, and get the loader out of the way.
 *
 * THE LOADER IS GUARDED FOUR WAYS
 *
 *   A previous version of this page shipped with a loader that could not
 *   lift, because the throw that would have prevented it happened at module
 *   top level — before any of the code that dismisses it ran. The lesson
 *   was that a dismissal which depends on the app working is not a
 *   dismissal. So:
 *
 *     1. app.css dismisses the loader on a 4s animation, with no script
 *        involved at all. That one survives this file failing to parse.
 *     2. The arming below runs before anything that can throw.
 *     3. Mounting is wrapped, and a failure reveals the noscript copy
 *        rather than leaving a black screen.
 *     4. `finally` dismisses regardless of which branch was taken.
 */
import { Component, StrictMode } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Lenis from 'lenis';

import { Overlay } from './Overlay';
import { CHAPTERS } from './journey';
import { World, journey, warmupDone } from './World';

/* ---------------------------------------------------------- loader ------ */

let dismissed = false;
let mounted = false;

function dismissLoader(): void {
  if (dismissed) return;
  dismissed = true;
  const el = document.getElementById('loader');
  if (!el) return;
  el.classList.add('is-gone');
  // Removed rather than left at opacity 0: a full-screen element with
  // pointer events is easy to leave behind, and it eats every click.
  window.setTimeout(() => el.remove(), 700);
}

/** Last-resort timer, armed before anything that can throw. */
// 8 s, not 3.5: the loader now also covers the shader pre-roll (see
// PreRoll in World.tsx), which takes a few seconds on an integrated GPU.
window.setTimeout(dismissLoader, 8000);

/* ------------------------------------------------------------ webgl ----- */

/**
 * Whether this browser can actually run the scene.
 *
 * Checked BEFORE mounting, because a Canvas that cannot get a context
 * throws inside React's render — which the try/catch around createRoot
 * cannot see, since render is not synchronous with the call. Without this
 * probe, a machine with WebGL disabled gets a black page and no clue.
 */
function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return Boolean(
      c.getContext('webgl2') ||
      c.getContext('webgl') ||
      c.getContext('experimental-webgl'),
    );
  } catch {
    // Some hardened configurations throw rather than returning null.
    return false;
  }
}

/** Shows the plain copy instead of the scene, and gets the loader off. */
function fallBackToPlain(why: string, err?: unknown): void {
  document.documentElement.classList.add('scene-failed');
  console.error('[corvex] ' + why, err ?? '');
  dismissLoader();
}

/**
 * Catches a scene that starts and then throws — a shader that will not
 * compile, a context lost on a driver reset. The pre-flight probe cannot
 * see those, and without a boundary React unmounts the whole tree and
 * leaves nothing at all on screen.
 */
class SceneBoundary extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };

  static getDerivedStateFromError() {
    return { dead: true };
  }

  componentDidCatch(err: Error, info: ErrorInfo) {
    fallBackToPlain('scene threw after mounting', err.message + ' ' + info.componentStack);
  }

  render() {
    return this.state.dead ? null : this.props.children;
  }
}

/* ----------------------------------------------------------- scroll ----- */

function startScroll(): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const lenis = new Lenis({
    // A reader who has asked for less motion still gets the whole journey —
    // they just get it without the glide, which is the part that makes
    // people ill rather than the part that carries the content.
    lerp: reduced ? 1 : 0.085,
    wheelMultiplier: 0.9,
    touchMultiplier: 1.4,
  });

  let raf = 0;
  const tick = (time: number) => {
    lenis.raf(time);
    // One number, straight from the scrollbar. Nothing else writes it.
    journey.t = Math.min(Math.max(lenis.progress || 0, 0), 1);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    lenis.destroy();
  };
}

/* ------------------------------------------------------------- boot ----- */

function App() {
  return (
    <>
      <World />
      <Overlay />
      {/* The scroll height. Everything visible is fixed to the viewport, so
          without this there is nothing to scroll and the journey has no
          input. One screen per chapter plus one to land on. */}
      <div
        className="scroll-length"
        aria-hidden="true"
        style={{ height: `${(CHAPTERS.length + 1) * 100}vh` }}
      />
    </>
  );
}

function boot(): void {
  try {
    document.documentElement.classList.remove('no-js');
  } catch { /* nothing here is worth failing the page for */ }

  try {
    if (!hasWebGL()) {
      // Not an error: this browser simply cannot draw the page. The plain
      // copy carries the whole argument, so it is a complete answer rather
      // than a degraded one, and starting Lenis over it would be pointless.
      fallBackToPlain('no WebGL context available, showing the plain page');
      return;
    }

    const host = document.getElementById('root');
    if (!host) throw new Error('missing #root');
    createRoot(host).render(
      <StrictMode>
        <SceneBoundary>
          <App />
        </SceneBoundary>
      </StrictMode>,
    );
    mounted = true;
    // Lift the loader once every chapter has been drawn once (PreRoll), so
    // no chapter compiles its shaders mid-scroll. One more frame after that
    // so the reader's first view is the real starting position.
    warmupDone.then(() => requestAnimationFrame(dismissLoader));
  } catch (err) {
    // The scene is what failed, not the page. Fall back to the plain copy
    // rather than showing a reader a black rectangle.
    fallBackToPlain('scene failed to start', err);
  } finally {
    // Only if the scene is actually up. Lenis over the plain fallback
    // would hijack a page that reads perfectly well with native scroll.
    if (mounted) { try { startScroll(); } catch { /* scroll is an enhancement */ } }
    // Mounted: the pre-roll lifts the loader, with the 8 s timer as backstop.
    // Not mounted: nothing will, so lift it now.
    if (!mounted) window.setTimeout(dismissLoader, 1200);
  }
}

boot();
