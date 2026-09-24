/* Corvex landing page — bootstrap.
 *
 * WHAT DRIVES WHAT
 *
 *   Native scrolling is never touched. No wheel handler, no transform on
 *   <body>, no smooth-scroll library: the browser scrolls the page exactly
 *   as it always did, which is what keeps keyboard paging, find-in-page,
 *   trackpad momentum and screen readers working. A smooth-scroll shim buys
 *   a slightly silkier wheel feel at the cost of all four, which is a bad
 *   trade on a page whose whole job is to be looked at by strangers.
 *
 *   Instead the 3D scene is DAMPED. A target follows real scroll instantly;
 *   a rendered value eases toward it a fixed fraction per frame. The camera
 *   always lags slightly and always arrives, and that lag is what reads as
 *   mass. One constant sets the feel of the entire page.
 *
 *   GSAP ScrollTrigger drives the HTML choreography — chapter pinning,
 *   copy reveals, the numbers — because it handles the bookkeeping of
 *   enter/leave/scrub correctly and does it against native scroll. The 3D
 *   and the DOM therefore share one scroll source and cannot drift.
 *
 * DEGRADATION, IN ORDER
 *
 *   no JS          .no-js CSS keeps every word readable and every section open
 *   no WebGL       canvas is removed, the flat CSS pipe shows through
 *   reduced motion no rAF loop, no parallax, no camera travel — page intact
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

import { create as createScene, type SceneHandle } from './scene';

/* Registered inside a guard and BEFORE anything else can throw. A failure
   here used to take the whole module down at top level - which no
   try/catch inside `boot` could catch, because boot never ran. */
try {
  gsap.registerPlugin(ScrollTrigger);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[corvex] ScrollTrigger failed to register:', err);
}

const doc = document;

/* Armed FIRST, before any other top-level statement can throw. The previous
   placement was at the end of the file, so a failure above it meant the
   timer was never set and the loader stayed up forever. CSS carries a
   longer backstop; this is the quick one for a healthy-but-erroring load. */
window.setTimeout(() => dismissLoader(), 2200);

const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* Fraction of the remaining distance closed each frame. Lower is heavier.
   0.075 lags about a fifth of a second behind a flick — the point where
   motion reads as mass rather than as lag. */
const LERP = 0.075;

let target = 0;
let current = 0;
let scene: SceneHandle | null = null;

/* ----------------------------------------------------------- boot ------- */

/* THE LOADER MUST NEVER BE ABLE TO TRAP THE PAGE.
 *
 *   It did. `dismissLoader()` was the last statement in boot, and nothing
 *   above it was guarded — so any throw anywhere in startup left a
 *   full-screen cover over a page that was otherwise fine, forever. The
 *   symptom was "LOADING INFRASTRUCTURE" and nothing after it.
 *
 *   Three defences, because one is not enough:
 *
 *     1. Every startup step is independently guarded. A failure in the 3D
 *        scene must not stop the counters wiring up, and vice versa —
 *        these are unrelated concerns that happened to share a function.
 *     2. The loader is dismissed in a `finally`, so it goes even if
 *        everything above it failed.
 *     3. A failsafe timer dismisses it regardless, covering the case where
 *        boot never runs at all — a parse error in the bundle, say, which
 *        no try/catch inside the bundle can catch.
 *
 *   Failures are reported to the console rather than swallowed. A silent
 *   catch would have turned this bug into a permanently blank hero with no
 *   way to find out why.
 */
function step(name: string, fn: () => void) {
  try {
    fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[corvex] ${name} failed:`, err);
  }
}

function boot() {
  doc.documentElement.classList.remove('no-js');

  try {
    step('scene', () => {
      const canvas = doc.getElementById('pipe-gl') as HTMLCanvasElement | null;
      if (!canvas) return;
      try {
        scene = createScene(canvas, reduced);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[corvex] 3D scene failed to build:', err);
        scene = null;
      }
      if (scene) {
        doc.documentElement.classList.add('gl-on');
      } else {
        // An empty <canvas> is a hole in the hero. Remove it and let the
        // flat fallback underneath do its job.
        canvas.remove();
      }
    });

    step('scroll', wireScroll);
    step('chapters', wireChapters);
    step('counters', wireCounters);
    step('matrix', wireMatrix);
    step('nav', wireNav);
  } finally {
    dismissLoader();
  }
}

/* --------------------------------------------------------- scroll ------- */

function readScroll() {
  const y = window.scrollY || doc.documentElement.scrollTop || 0;
  const h = Math.max(1, doc.body.scrollHeight - window.innerHeight);
  target = Math.min(Math.max(y / h, 0), 1);

  const header = doc.getElementById('header');
  if (header) header.classList.toggle('scrolled', y > 24);
}

function frame() {
  const gap = target - current;
  // Snap when the gap is imperceptible, so the loop is not forever writing
  // values that never settle.
  current += Math.abs(gap) < 0.0002 ? gap : gap * LERP;
  scene?.setProgress(current);
  requestAnimationFrame(frame);
}

function wireScroll() {
  window.addEventListener('scroll', readScroll, { passive: true });
  window.addEventListener('resize', () => { readScroll(); scene?.resize(); }, { passive: true });
  readScroll();
  current = target;               // no opening lurch on a restored scroll
  scene?.setProgress(current);

  if (reduced) {
    // No loop; the scene repaints on scroll only.
    window.addEventListener('scroll', () => scene?.setProgress(target), { passive: true });
  } else {
    requestAnimationFrame(frame);
  }
}

/* -------------------------------------------------------- chapters ------ */

/* Each chapter fades and lifts its copy as it crosses the middle of the
   viewport, and dims again as it leaves. Tied to scroll position rather
   than to a one-shot trigger, so scrubbing back up looks identical to
   scrolling down — a page that only animates forwards feels broken the
   moment anyone scrolls up. */
function wireChapters() {
  const chapters = gsap.utils.toArray<HTMLElement>('.chapter');

  chapters.forEach((el) => {
    const copy = el.querySelector('.chapter-copy');
    if (!copy) return;

    if (reduced) {
      gsap.set(copy, { opacity: 1, y: 0 });
      return;
    }

    gsap.fromTo(
      copy,
      { opacity: 0, y: 40 },
      {
        opacity: 1,
        y: 0,
        ease: 'none',
        scrollTrigger: {
          trigger: el,
          start: 'top 78%',
          end: 'top 38%',
          scrub: 0.6,
        },
      },
    );

    gsap.to(copy, {
      opacity: 0,
      y: -30,
      ease: 'none',
      scrollTrigger: {
        trigger: el,
        start: 'bottom 62%',
        end: 'bottom 22%',
        scrub: 0.6,
      },
    });
  });

  // The hero copy lifts away first, so the scene it was sitting on is
  // uncovered rather than scrolled off behind text.
  const hero = doc.getElementById('hero-copy');
  if (hero && !reduced) {
    gsap.to(hero, {
      opacity: 0,
      y: -70,
      ease: 'none',
      scrollTrigger: {
        trigger: '#hero',
        start: 'top top',
        end: '70% top',
        scrub: 0.5,
      },
    });
  }
}

/* -------------------------------------------------------- counters ------ */

/* Counters.
 *
 * MODELLED ON THE REFERENCE, AFTER READING IT RATHER THAN GUESSING
 *
 *   The site this was asked to match renders each figure as ONE span with
 *   tabular numerals and replaces its text as it counts:
 *
 *     <span class="sr-only">183+ frictions diagnosed across our practice</span>
 *     <p aria-hidden="true" class="flex items-baseline gap-2 font-mono">
 *       <span class="tabular-nums">183</span><span>·</span><span>frictions diagnosed</span>
 *     </p>
 *
 *   No digit columns, no odometer. An earlier version here rolled each
 *   digit behind a window, which is a more elaborate effect than the
 *   reference uses and reads as mechanical rather than quick — almost
 *   certainly why it did not feel right.
 *
 *   What actually carries it is the easing and the type: a fast start, a
 *   long tail, monospaced tabular figures so the number does not jitter in
 *   width as it climbs, and the label sitting quietly beside it.
 *
 * ACCESSIBILITY, ALSO FROM THE REFERENCE
 *
 *   A counter mid-flight reads aloud as nonsense — a screen reader would
 *   announce every intermediate value. So the visible figure is
 *   aria-hidden and a screen-reader-only span carries the final sentence.
 *   That pattern is lifted straight from the reference, and it is the part
 *   most people copying this effect leave out.
 */
function wireCounters() {
  const els = gsap.utils.toArray<HTMLElement>('[data-count]');

  els.forEach((el) => {
    const to = parseFloat(el.dataset.count ?? '0');
    const dp = parseInt(el.dataset.decimals ?? '0', 10);
    const suffix = el.dataset.suffix ?? '';
    const format = (v: number) =>
      (dp ? v.toFixed(dp) : Math.round(v).toLocaleString()) + suffix;
    const finalText = format(to);

    /* The live figure is hidden from assistive tech and a static sentence
       put beside it, so nobody hears the count. */
    el.setAttribute('aria-hidden', 'true');
    const label = el.dataset.label;
    if (label && !el.dataset.srDone) {
      const sr = doc.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = `${finalText} ${label}`;
      el.parentElement?.insertBefore(sr, el);
      el.dataset.srDone = '1';
    }

    if (reduced) { el.textContent = finalText; return; }

    el.textContent = format(0);
    const state = { v: 0 };

    ScrollTrigger.create({
      trigger: el,
      start: 'top 86%',
      once: true,
      onEnter: () => {
        gsap.to(state, {
          v: to,
          duration: 2.0,
          /* Fast out of the gate, then a long settle. This easing is what
             the effect actually is - the number is legible almost at once
             and then eases into place, rather than crawling linearly to it. */
          ease: 'expo.out',
          onUpdate: () => { el.textContent = format(state.v); },
          onComplete: () => { el.textContent = finalText; },
        });
      },
    });
  });
}

/* ------------------------------------------------------------ nav ------- */

function wireNav() {
  // '.dots a' used to be here, for a dot nav that no longer exists in the
  // markup. A selector that matches nothing fails silently, which is how it
  // survived a redesign.
  const links = gsap.utils.toArray<HTMLAnchorElement>('.nav-link');
  const sections = gsap.utils.toArray<HTMLElement>('main > section[id]');

  sections.forEach((sec) => {
    ScrollTrigger.create({
      trigger: sec,
      start: 'top 52%',
      end: 'bottom 52%',
      onToggle: (self) => {
        if (!self.isActive) return;
        links.forEach((a) => {
          a.classList.toggle('on', a.getAttribute('href') === `#${sec.id}`);
        });
      },
    });
  });
}

/* ---------------------------------------------------------- loader ------ */

/* The loader exists to cover the first frame of a heavy scene, not to
   perform. It leaves as soon as the scene is up — there is no minimum
   display time, because a progress bar that outlasts the thing it measures
   is theatre. */
/* Safe to call repeatedly: boot's `finally` and the failsafe timer will
   both reach it, and on a healthy load they race. */
let loaderGone = false;

function dismissLoader() {
  if (loaderGone) return;
  loaderGone = true;
  const el = doc.getElementById('loader');
  if (!el) return;
  const go = () => {
    el.classList.add('done');
    window.setTimeout(() => el.remove(), 700);
    // Guarded on its own: a ScrollTrigger failure must not be the reason
    // the cover stays up.
    try { ScrollTrigger.refresh(); } catch { /* layout will settle anyway */ }
  };
  // One frame after boot, so the scene has painted behind it.
  requestAnimationFrame(() => requestAnimationFrame(go));
}

if (doc.readyState === 'loading') {
  doc.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
