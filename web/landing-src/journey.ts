/* The journey.
 *
 * WHY A SPINE AND NOT SECTIONS
 *
 *   The brief is explicit that this must not be a page with sections. So
 *   there is exactly one number in this application — `t`, the position
 *   along the journey, 0 to 1 — and everything else is a function of it.
 *   Camera, pulse, fog, every scene's opacity and every piece of copy read
 *   from the same value.
 *
 *   That constraint is what buys continuity. If a scene owned its own
 *   timeline it could disagree with the camera, and the seams between
 *   chapters would be visible as cuts. Nothing here has its own timeline.
 *
 * CHAPTERS ARE STATIONS, NOT SLIDES
 *
 *   Each chapter occupies a span of `t` and sits at a point in world space
 *   along one continuous spline. Scenes fade in as the camera approaches
 *   and out as it leaves, with the spans deliberately OVERLAPPING — at any
 *   moment you are usually seeing the tail of one and the head of the next,
 *   which is what makes it read as travel rather than as a slideshow.
 *
 * THE PULSE LEADS
 *
 *   The camera follows a glowing pulse that is always slightly ahead on the
 *   spline. Following something is what makes motion feel purposeful;
 *   a camera moving on its own reads as a drone shot.
 */

export interface Chapter {
  id: string;
  /** Section number shown in the overlay. */
  num: string;
  title: string;
  /** Where this chapter begins and ends on the journey, 0..1. */
  from: number;
  to: number;
}

/* Eight chapters over the journey. The spans are not equal: the opening
   needs room to establish scale, and the analytical chapters in the middle
   are read rather than watched, so they hold longer. */
export const CHAPTERS: Chapter[] = [
  { id: 'orbit', num: '01', title: 'Orbit', from: 0.000, to: 0.130 },
  { id: 'network', num: '02', title: 'The Network', from: 0.115, to: 0.265 },
  { id: 'twin', num: '03', title: 'Digital Twin', from: 0.250, to: 0.395 },
  { id: 'sensors', num: '04', title: 'Sensor Intelligence', from: 0.380, to: 0.510 },
  { id: 'corrosion', num: '05', title: 'Corrosion', from: 0.495, to: 0.640 },
  { id: 'predict', num: '06', title: 'Prediction Engine', from: 0.625, to: 0.760 },
  { id: 'shap', num: '07', title: 'Explainability', from: 0.745, to: 0.875 },
  { id: 'risk', num: '08', title: 'Risk Intelligence', from: 0.860, to: 1.000 },
];

/** Smoothstep — the easing used everywhere here, so nothing arrives or
 *  leaves with a hard edge. */
export const smooth = (x: number) => {
  const c = Math.min(Math.max(x, 0), 1);
  return c * c * (3 - 2 * c);
};

export const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/** Local progress within a chapter, 0 before it, 1 after it. */
export function localT(t: number, c: Chapter): number {
  return clamp01((t - c.from) / (c.to - c.from));
}

/**
 * How present a chapter is at journey position `t`, 0..1.
 *
 * Ramps up over the first fifth of its span and down over the last fifth,
 * so neighbouring chapters cross-fade through their overlap instead of
 * cutting. A scene at 0 is not rendered at all — there is no point paying
 * for geometry nobody can see.
 */
export function presence(t: number, c: Chapter): number {
  const span = c.to - c.from;
  const edge = span * 0.2;
  if (t < c.from - edge || t > c.to + edge) return 0;
  const inRamp = smooth((t - (c.from - edge)) / (edge * 2));
  const outRamp = 1 - smooth((t - (c.to - edge)) / (edge * 2));
  return Math.min(inRamp, outRamp);
}

/** The chapter the reader is actually in, for the overlay. */
export function activeChapter(t: number): Chapter {
  let best = CHAPTERS[0];
  let bestP = -1;
  for (const c of CHAPTERS) {
    const p = presence(t, c);
    if (p > bestP) { bestP = p; best = c; }
  }
  return best;
}

/* --------------------------------------------------------------- copy --- */

export interface Panel {
  chapter: string;
  eyebrow?: string;
  headline: string;
  body?: string;
  /** Figures shown with the panel. Every one is measured; see
   *  CORVEX_OVERVIEW.md. */
  figures?: { v: string; k: string }[];
  /** Shown as a quiet caveat under the panel. */
  foot?: string;
  /** Lead the panel with the full Corvex logo. Used once, on the opening. */
  logo?: boolean;
}

export const PANELS: Panel[] = [
  {
    chapter: 'orbit',
    logo: true,
    eyebrow: 'Demonstration fleet · synthetic data',
    headline: 'Predict. Protect. Prevent.',
    body: 'AI-powered pipeline integrity and corrosion intelligence for the '
      + 'infrastructure that moves energy.',
    figures: [
      { v: '5,000', k: 'Segments' },
      { v: '6,414', k: 'km of corridor' },
      { v: '15', k: 'Real routes' },
      { v: '409', k: 'Passing tests' },
    ],
  },
  {
    chapter: 'network',
    eyebrow: '02 — The network',
    headline: 'Fifteen real corridors.',
    body: 'HVJ. Jamnagar–Loni. Paradip–Haldia. Kochi–Mangalore. '
      + 'Numaligarh–Siliguri. Segments sit on the line, in milepost order — '
      + 'not scattered across a map.',
  },
  {
    chapter: 'twin',
    eyebrow: '03 — Digital twin',
    headline: 'Every segment, modelled.',
    body: 'Coating, steel wall, sensor layer, flow channel, corrosion zones. '
      + 'Forty-one attributes per segment feed the assessment.',
  },
  {
    chapter: 'sensors',
    eyebrow: '04 — Instrumentation',
    headline: 'What the line reports.',
    body: 'Pressure, temperature, ultrasonic wall thickness, magnetic flux '
      + 'leakage, corrosion probes, cathodic protection potential.',
  },
  {
    chapter: 'corrosion',
    eyebrow: '05 — Corrosion',
    headline: "It doesn't hold still.",
    body: 'External corrosion is an electrochemical cell between pipe steel '
      + 'and soil. Coating resists it, cathodic protection opposes it, and '
      + 'where both fail the wall thins until it cannot hold pressure.',
    figures: [
      { v: '1.03', k: 'Mean rate, mpy' },
      { v: '15.44', k: 'Peak, mpy' },
    ],
  },
  {
    chapter: 'predict',
    eyebrow: '06 — Prediction',
    headline: 'Deterministic, and measured.',
    body: 'Gradient-boosted trees over forty-one attributes. Not a black box '
      + 'with a confident voice — a model with a published error and a '
      + 'calibrated interval around every number it produces.',
    figures: [
      { v: '0.682', k: 'Test R²' },
      { v: '0.483', k: 'MAE, mpy' },
      { v: '89.8%', k: 'Interval coverage' },
    ],
    foot: 'Measured on a held-out split of the synthetic fleet. Not a claim '
      + 'of real-world operator validation.',
  },
  {
    chapter: 'shap',
    eyebrow: '07 — Explainability',
    headline: 'Every prediction explained.',
    body: 'Exact SHAP attribution decomposes each prediction into the '
      + 'features that produced it. No number on the screen is '
      + 'unattributable.',
    foot: 'The features shown are the model’s real inputs; the bar lengths '
      + 'illustrate the shape of a typical attribution rather than one '
      + 'segment’s values. The console computes and prints the actual '
      + 'numbers per segment.',
  },
  {
    chapter: 'risk',
    eyebrow: '08 — Risk',
    headline: 'AI explains. AI never decides.',
    body: 'Likelihood × consequence on the 5×5 the discipline already uses, '
      + 'under 49 CFR 192.903 and 195.450. Every auditable decision is '
      + 'deterministic, tested code — the language model reads those outputs '
      + 'and explains them, and never produces a number that reaches a '
      + 'decision.',
    figures: [
      { v: '3,896', k: 'Low' },
      { v: '871', k: 'Moderate' },
      { v: '167', k: 'High' },
      { v: '66', k: 'Severe' },
    ],
  },
];
