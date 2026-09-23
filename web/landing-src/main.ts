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

gsap.registerPlugin(ScrollTrigger);

const doc = document;
const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/* Fraction of the remaining distance closed each frame. Lower is heavier.
   0.075 lags about a fifth of a second behind a flick — the point where
   motion reads as mass rather than as lag. */
const LERP = 0.075;

let target = 0;
let current = 0;
let scene: SceneHandle | null = null;

/* ----------------------------------------------------------- boot ------- */

function boot() {
  doc.documentElement.classList.remove('no-js');

  const canvas = doc.getElementById('pipe-gl') as HTMLCanvasElement | null;
  if (canvas) {
    scene = createScene(canvas, reduced);
    if (scene) {
      doc.documentElement.classList.add('gl-on');
    } else {
      // An empty <canvas> left in place is a hole in the hero. Remove it and
      // let the flat fallback underneath do its job.
      canvas.remove();
    }
  }

  wireScroll();
  wireChapters();
  wireCounters();
  wireMatrix();
  wireNav();
  dismissLoader();
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

function wireCounters() {
  const els = gsap.utils.toArray<HTMLElement>('[data-count]');
  els.forEach((el) => {
    const to = parseFloat(el.dataset.count ?? '0');
    const dp = parseInt(el.dataset.decimals ?? '0', 10);
    const render = (v: number) => {
      el.textContent = dp ? v.toFixed(dp) : Math.round(v).toLocaleString();
    };

    if (reduced) { render(to); return; }

    const state = { v: 0 };
    render(0);
    ScrollTrigger.create({
      trigger: el,
      start: 'top 82%',
      once: true,
      onEnter: () => {
        gsap.to(state, {
          v: to,
          duration: 1.5,
          // Quick, then settling — an instrument coming to rest.
          ease: 'expo.out',
          onUpdate: () => render(state.v),
        });
      },
    });
  });
}

/* ---------------------------------------------------------- matrix ------ */

/* The 5x5, populated from the real scored fleet.
 *
 * These counts are the actual output of the 5,000-segment demonstration
 * dataset, not illustrative numbers - the same grid the console draws. The
 * band is a pure function of row x column, which matters because the four
 * band hues are STATUS colours: they are not far enough apart for hue to
 * carry an ordered scale by itself, so position and a printed count carry
 * it too.
 */
const MATRIX_COUNTS: number[][] = [
  // Almost certain -> Rare, each row Negligible -> Severe.
  [63, 38, 44, 6, 0],
  [158, 95, 84, 13, 0],
  [332, 208, 167, 40, 3],
  [526, 383, 285, 50, 5],
  [1105, 731, 563, 98, 3],
];

const BAND_COLOR = ['#7ea64a', '#d99a32', '#d8794a', '#e4735c'];

function bandFor(likelihood: number, consequence: number): string {
  const p = likelihood * consequence;
  return p <= 4 ? BAND_COLOR[0] : p <= 9 ? BAND_COLOR[1]
    : p <= 14 ? BAND_COLOR[2] : BAND_COLOR[3];
}

function wireMatrix() {
  const grid = doc.getElementById('matrix-grid');
  if (!grid) return;

  const max = Math.max(...MATRIX_COUNTS.flat());
  const rowLabels = ['Almost certain', 'Likely', 'Possible', 'Unlikely', 'Rare'];
  const colLabels = ['Negligible', 'Minor', 'Moderate', 'Major', 'Severe'];

  const cells: HTMLElement[] = [];
  MATRIX_COUNTS.forEach((row, r) => {
    const likelihood = 5 - r;
    row.forEach((n, c) => {
      const cell = doc.createElement('i');
      const empty = n === 0;
      // Opacity carries density WITHIN the band hue, so a busy cell reads
      // hotter without inventing a fifth colour.
      const weight = empty ? 0 : 0.2 + 0.62 * Math.sqrt(n / max);
      if (empty) {
        cell.style.border = '1px dashed var(--line)';
      } else {
        cell.style.background = bandFor(likelihood, c + 1);
        cell.style.opacity = String(weight.toFixed(3));
      }
      cell.title = `${rowLabels[r]} likelihood · ${colLabels[c]} consequence — `
        + `${n.toLocaleString()} segments`;
      const b = doc.createElement('b');
      b.textContent = empty ? '' : n.toLocaleString();
      // The count must stay legible as the fill opacity drops beneath it.
      b.style.opacity = String(Math.min(1 / Math.max(weight, 0.34), 1).toFixed(2));
      cell.appendChild(b);
      grid.appendChild(cell);
      cells.push(cell);
    });
  });

  if (reduced) return;

  // Cells rise in reading order as the section arrives, so the grid builds
  // itself rather than appearing complete.
  gsap.from(cells, {
    opacity: 0,
    scale: 0.82,
    duration: 0.5,
    ease: 'power2.out',
    stagger: { each: 0.012, from: 'start' },
    scrollTrigger: { trigger: grid, start: 'top 80%', once: true },
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
function dismissLoader() {
  const el = doc.getElementById('loader');
  if (!el) return;
  const go = () => {
    el.classList.add('done');
    window.setTimeout(() => el.remove(), 700);
    ScrollTrigger.refresh();
  };
  // One frame after boot, so the scene has painted behind it.
  requestAnimationFrame(() => requestAnimationFrame(go));
}

if (doc.readyState === 'loading') {
  doc.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
