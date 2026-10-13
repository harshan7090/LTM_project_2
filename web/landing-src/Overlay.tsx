/* The reading layer.
 *
 * Everything here is driven by the same journey value the camera uses, so
 * the copy cannot drift out of step with what is on screen behind it.
 *
 * ONE rAF LOOP, ALMOST NO RENDERS
 *
 *   The overlay subscribes to the journey once and re-renders only when the
 *   active chapter actually changes — a few times over the whole page. The
 *   progress rail, which does change every frame, is written straight to
 *   the DOM node through a ref. Re-rendering a panel of text sixty times a
 *   second to move a 2px bar would be a strange way to spend a frame.
 */
import { useEffect, useRef, useState } from 'react';

import { CHAPTERS, PANELS, activeChapter } from './journey';
import { journey } from './World';

/* -------------------------------------------------------- count-up ------ */

/**
 * A number that counts up when its panel arrives.
 *
 * Structured as a pair: the real value is in the DOM for assistive tech and
 * never animates, and the animated glyphs are hidden from it. A screen
 * reader hearing "one, fourteen, three hundred, five thousand" while a
 * counter spins is the failure mode this avoids.
 *
 * Tabular figures, so the box does not jitter as digits change width.
 */
function Count({ value, run }: { value: string; run: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  /* Tracks whether the count has FINISHED, not whether it has started.
   *
   * Guarding on "started" is wrong under StrictMode, which mounts effects,
   * tears them down and mounts them again: the first pass set the flag and
   * scheduled a frame, the teardown cancelled the frame, and the second
   * pass saw the flag and returned immediately. Every figure on the page
   * sat at 0 — which is what shipped, and what a screenshot caught. */
  const finished = useRef(false);

  useEffect(() => {
    if (!run || finished.current) return;
    const el = ref.current;
    if (!el) return;

    // Split into a numeric part and whatever decorates it (% sign, comma
    // grouping, decimals) so "89.8%" and "3,896" both animate correctly
    // and land on exactly the string that was passed in.
    const digits = value.replace(/[^0-9.]/g, '');
    const target = parseFloat(digits);
    if (!Number.isFinite(target)) { el.textContent = value; return; }
    const decimals = (digits.split('.')[1] ?? '').length;
    const grouped = value.includes(',');
    const suffix = value.endsWith('%') ? '%' : '';

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = value;
      finished.current = true;
      return;
    }

    // Start from zero imperatively rather than rendering '0' as the child.
    // React will not repair a textContent we mutated behind its back, so if
    // the rendered child were '0' and this effect bailed out for any reason,
    // the figure would be stuck at zero with no way back.
    el.textContent = '0';

    const DURATION = 1400;
    const start = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      const u = Math.min((now - start) / DURATION, 1);
      // Fast out, long settle. A linear count reads as a loading spinner;
      // the deceleration is what makes it read as a value arriving.
      const eased = 1 - Math.pow(1 - u, 3);
      const n = target * eased;
      const text = decimals > 0 ? n.toFixed(decimals) : Math.round(n).toString();
      el.textContent = (grouped ? Number(text).toLocaleString('en-IN') : text) + suffix;
      if (u < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        el.textContent = value;
        finished.current = true;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, value]);

  return (
    <>
      <span className="sr-only">{value}</span>
      {/* Renders the REAL value, not '0'. That way the figure is correct
          before the effect runs, correct if the effect never runs at all,
          and correct on a panel the reader returns to — the animation is
          an enhancement layered on top of a already-correct number. */}
      <span className="count" ref={ref} aria-hidden="true">{value}</span>
    </>
  );
}

/* --------------------------------------------------------- overlay ------ */

export function Overlay() {
  const [active, setActive] = useState(CHAPTERS[0].id);
  const rail = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const current = useRef(CHAPTERS[0].id);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = journey.t;
      const chapter = activeChapter(t);
      if (chapter.id !== current.current) {
        current.current = chapter.id;
        setActive(chapter.id);
      }
      if (rail.current) rail.current.style.transform = `scaleY(${t})`;
      if (readout.current) readout.current.textContent = `${Math.round(t * 100)}`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const activeIndex = CHAPTERS.findIndex((c) => c.id === active);

  return (
    <div className="overlay">
      <header className="masthead">
        <a className="brand" href="/console">
          <img className="brand__logo" src="/landing/brand/corvex-mark.webp" alt="" />
          CORVEX
        </a>
        <span className="masthead__note">Demonstration fleet · synthetic data</span>
        <a className="cta cta--ghost" href="/console">Open the console</a>
      </header>

      {/* Chapter rail. Doubles as the table of contents and the progress
          indicator, which is the only navigation a page like this needs. */}
      <nav className="rail" aria-label="Chapters">
        <div className="rail__track">
          <div className="rail__fill" ref={rail} />
        </div>
        <ol className="rail__list">
          {CHAPTERS.map((c, i) => (
            <li
              key={c.id}
              className={`rail__item${i === activeIndex ? ' is-active' : ''}${i < activeIndex ? ' is-past' : ''}`}
            >
              <span className="rail__num">{c.num}</span>
              <span className="rail__title">{c.title}</span>
            </li>
          ))}
        </ol>
      </nav>

      {PANELS.map((panel) => {
        const on = panel.chapter === active;
        return (
          <article
            key={panel.chapter}
            className={`panel panel--${panel.chapter}${on ? ' is-on' : ''}`}
            aria-hidden={!on}
          >
            {/* Screen-blended, so the logo's near-black backdrop drops out
                against the scene and only the lit emblem and wordmark show. */}
            {panel.logo && (
              <img className="panel__logo" src="/landing/brand/corvex-logo.webp"
                   alt="Corvex" width={1040} height={841} />
            )}
            {panel.eyebrow && <p className="panel__eyebrow">{panel.eyebrow}</p>}
            <h2 className="panel__headline">{panel.headline}</h2>
            {panel.body && <p className="panel__body">{panel.body}</p>}

            {panel.figures && (
              <dl className="figures">
                {panel.figures.map((f) => (
                  <div className="figure" key={f.k}>
                    <dt className="figure__v"><Count value={f.v} run={on} /></dt>
                    <dd className="figure__k">{f.k}</dd>
                  </div>
                ))}
              </dl>
            )}

            {panel.foot && <p className="panel__foot">{panel.foot}</p>}

            {panel.chapter === 'risk' && (
              <div className="panel__actions">
                <a className="cta" href="/console">Open the console</a>
                
              </div>
            )}
          </article>
        );
      })}

      <div className="hud">
        <span className="hud__pct"><span ref={readout}>0</span>%</span>
        <span className="hud__hint">Scroll</span>
      </div>
    </div>
  );
}
