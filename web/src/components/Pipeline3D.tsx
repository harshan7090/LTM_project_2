/* A pipe segment, drawn in 3D from its own record, and orbitable.
 *
 * WHAT DRIVES WHAT
 *
 *   Every visible property comes from a field of the segment, so two
 *   segments look alike only when their records are alike:
 *
 *     outer finish        coating type (FBE, coal-tar enamel, PE tape, bare)
 *     failed patches      coating type x age (each coating has a working
 *                         life), raised by measured metal loss; tape fails
 *                         along its overlaps first
 *     rust and pits       corrosion rate and metal loss, on bare steel and
 *                         inside the failed patches
 *     white crust         cathodic protection: CP current on exposed steel
 *                         in soil deposits calcareous scale instead of rust
 *     brighter steel      stainless steel, which also rusts far less
 *     girth               diameter (4 in slender ... 48 in stout)
 *     cut end             remaining wall (grey), metal lost (brown) and the
 *                         minimum wall the code requires (red ring); the
 *                         same three are on the wall gauge in the legend
 *     bore                product carried (gas, crude, refined, water)
 *     sleeves             recorded repairs, one band each, up to four
 *     underside stain     soil type
 *     body and stripes    HDPE material (yellow stripes for gas, blue else)
 *
 *   Nothing on it is decoration: there are no girth welds, because the
 *   record does not say where they are. The risk band is deliberately NOT
 *   drawn. It used to tint the rim, which read as "a green pipe" or "a red
 *   pipe" and said nothing about the pipe itself. Risk has its own place in
 *   the panel.
 *
 * HOW
 *
 *   Hand-written WebGL: tubes and rings built in code, one GLSL program
 *   whose fragment shader generates coating, steel, rust, pits and scale
 *   from 3D value noise over the surface position (seamless, and the same
 *   size of feature on every pipe). Seeded by the segment id, so a segment
 *   always looks the same. Relief comes from bump mapping on screen-space
 *   derivatives where the GPU offers them. No 3D library: the console sends
 *   `script-src 'self'`, and three.js would add ~150 KB gzipped to draw a
 *   few tubes. Frames are drawn only while the model is on screen and only
 *   when the view changes.
 *
 *   Illustrative, not an inspection image: the record says how much wall is
 *   gone and how fast, not where each pit is.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import type { RateCategory, SegmentDetail } from '../lib/types';
import { cx, rateCategoryOf } from './ui';

/* ============================================================ the model == */

/** Everything the drawing needs, taken from one segment's record. */
export interface PipeModel {
  segmentId: string;
  rateMpy: number;
  rateCategory: RateCategory;
  diameterIn: number;
  nominalWallMm: number;
  measuredWallMm: number;
  /** Minimum wall the code requires; null where it does not apply (HDPE). */
  minWallMm: number | null;
  coating: string;
  material: string;
  cathodicProtection: boolean;
  ageYears: number;
  repairs: number;
  product: string;
  soil: string;
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' && v ? v : d);
const yes = (v: unknown) => v === true || v === 1 || v === 'True' || v === 'true';
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The drawing's inputs, read off a segment detail response. */
export function pipeModelFrom(d: Omit<SegmentDetail, 'acknowledged'>): PipeModel {
  const a = d.attributes ?? {};
  const rl = d.remaining_life;
  const nominal = num(rl?.nominal_wall_mm ?? undefined, num(a.wall_thickness_mm, 8));
  const measured = rl?.applicable ? num(rl.current_wall_mm, nominal) : nominal;
  return {
    segmentId: d.segment_id,
    rateMpy: d.predicted_rate_mpy,
    rateCategory: rateCategoryOf(d.predicted_rate_mpy, d.rate_class?.category ?? d.rate_category),
    diameterIn: num(a.diameter_inches, 12),
    nominalWallMm: nominal,
    measuredWallMm: Math.min(measured, nominal),
    minWallMm: rl?.applicable ? num(rl.min_required_wall_mm, 0) : null,
    coating: str(a.coating_type, 'Unknown'),
    material: str(a.material, 'Carbon Steel'),
    cathodicProtection: yes(a.cathodic_protection),
    ageYears: num(a.pipe_age_years, 0),
    repairs: Math.max(0, Math.round(num(a.historical_repair_count, 0))),
    product: str(a.product_type, ''),
    soil: str(a.soil_type, 'Unknown'),
  };
}

/* ---------------------------------------------------- record -> visuals - */

type RGB = [number, number, number];

/** Coating appearance. FBE is drawn teal, one of its common factory colours,
 *  rather than the bright green that would read as a status lamp. */
const COATING: Record<string, { rgb: RGB; gloss: number; tape: boolean; life: number; label: string }> = {
  'FBE': { rgb: [0.15, 0.36, 0.35], gloss: 0.45, tape: false, life: 45, label: 'FBE epoxy' },
  'Coal Tar Enamel': { rgb: [0.085, 0.078, 0.07], gloss: 0.7, tape: false, life: 35, label: 'Coal-tar enamel' },
  'Polyethylene Tape': { rgb: [0.23, 0.24, 0.25], gloss: 0.3, tape: true, life: 22, label: 'PE tape wrap' },
  'Unknown': { rgb: [0.42, 0.41, 0.38], gloss: 0.15, tape: false, life: 30, label: 'Unrecorded coating' },
};

const PRODUCT: Record<string, { rgb: RGB; label: string }> = {
  'Natural Gas': { rgb: [0.15, 0.19, 0.25], label: 'Natural gas' },
  'Crude Oil': { rgb: [0.09, 0.06, 0.035], label: 'Crude oil' },
  'Refined Products': { rgb: [0.46, 0.30, 0.08], label: 'Refined products' },
  'Produced Water': { rgb: [0.10, 0.23, 0.23], label: 'Produced water' },
};

const SOIL: Record<string, RGB> = {
  'Clay': [0.42, 0.27, 0.16],
  'Sandy': [0.56, 0.48, 0.33],
  'Loam': [0.27, 0.21, 0.14],
  'Rocky': [0.40, 0.39, 0.37],
  'Unknown': [0.32, 0.28, 0.22],
};

/* The wall colours, shared by the cut end, the gauge and the fallback. */
const WALL_LEFT = '#b4b8bc';
const METAL_LOST = '#8a4a1f';
const MIN_WALL = '#f5423d';

const HDPE_BODY: RGB = [0.09, 0.092, 0.1];
const BARE_SWATCH: RGB = [0.3, 0.29, 0.28];
const STAINLESS_SWATCH: RGB = [0.58, 0.6, 0.62];

const rgbCss = ([r, g, b]: RGB) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

/** Inverse normal CDF, logistic approximation. */
const probit = (p: number) => Math.log(p / (1 - p)) / 1.702;

/* Measured moments of the shader's fbm (3D value noise, four rotated
   octaves, normalised): close to normal(0.50, 0.115). Thresholds set from
   them make "this share of the surface" true to within a few percent. */
const FBM_MEAN = 0.5;
const FBM_SD = 0.115;

/* Upper quantiles of single-octave value noise, for pit density, where the
   distribution is far from normal: [share above, threshold]. */
const PIT_Q: [number, number][] = [[0.005, 0.92], [0.02, 0.863], [0.1, 0.745], [0.25, 0.632]];
function pitThreshold(share: number): number {
  const s = clamp(share, PIT_Q[0][0], PIT_Q[PIT_Q.length - 1][0]);
  for (let i = 1; i < PIT_Q.length; i++) {
    const [s0, t0] = PIT_Q[i - 1];
    const [s1, t1] = PIT_Q[i];
    if (s <= s1) return t0 + (t1 - t0) * (Math.log(s / s0) / Math.log(s1 / s0));
  }
  return PIT_Q[PIT_Q.length - 1][1];
}

/** Seed the noise from the segment id, so each segment has its own pattern
 *  and keeps it. Kept small: the hash loses precision far from the origin. */
function seedOf(id: string): RGB {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const u = h >>> 0;
  return [(u % 1000) / 62.5, ((u >>> 10) % 1000) / 62.5, ((u >>> 20) % 1000) / 62.5];
}

interface Look {
  isHdpe: boolean;
  coat: RGB; gloss: number; tape: number; bare: number;
  holidayThreshold: number; rustThreshold: number; pitThreshold: number; rust: number;
  cp: number; stain: RGB; stainAmt: number; age: number;
  stripe: RGB; product: RGB; steel: number;
  radius: number; rIn: number; rMeas: number; rSteel: number; rMin: number; hasMin: number;
  seed: RGB;
  sleeves: number[];
}

/* Scene constants. A short spool, so the whole length fits the panel's
   wide frame with the cut end turned toward the viewer. */
const LENGTH = 6.0;
const SLEEVE = 1.06;       // sleeve radius, as a multiple of the pipe's
const SLEEVE_W = 0.5;

function lookOf(m: PipeModel): Look {
  const isHdpe = m.material === 'HDPE';
  const stainless = m.material === 'Stainless Steel';
  const bare = !isHdpe && m.coating === 'Uncoated';
  const c = COATING[m.coating] ?? COATING.Unknown;
  const lossFrac = m.nominalWallMm > 0
    ? clamp(1 - m.measuredWallMm / m.nominalWallMm, 0, 1) : 0;

  // Share of the surface where the coating has failed: grows with age over
  // the coating's working life, and at least matches the measured loss,
  // since external corrosion only happens where the steel is exposed.
  // Capped, and lower for tape: disbonded tape mostly stays on the pipe,
  // loose, with the corrosion under it rather than in plain view.
  const ageShare = Math.pow(Math.min(m.ageYears / c.life, 1.6), 1.5) * 0.35;
  const exposed = bare ? 1
    : clamp(Math.max(ageShare, lossFrac * 1.4), 0.02, c.tape ? 0.45 : 0.6);

  // How corroded the exposed steel is. CP slows it; stainless far more;
  // HDPE does not corrode electrochemically at all.
  let severity = clamp(m.rateMpy / 12 + lossFrac * 0.6, 0, 1);
  if (m.cathodicProtection) severity *= 0.6;
  if (stainless) severity *= 0.3;
  if (isHdpe) severity = 0;
  const rustShare = clamp(0.1 + severity * 0.82, 0.05, 0.92);

  // Girth from diameter, on a log scale so 4 in and 48 in both stay legible.
  const radius = 0.58 + 0.72 * clamp(Math.log(m.diameterIn / 4) / Math.log(12), 0, 1);
  // Wall drawn at 2.6x its true share of the radius (true scale is a hair
  // line), clamped so thin and thick walls both read.
  const realShare = m.nominalWallMm / Math.max(m.diameterIn * 25.4 / 2, 1);
  const wallDraw = radius * clamp(realShare * 2.6, 0.08, 0.3);
  const coatDraw = (bare || isHdpe) ? 0 : radius * 0.04;
  const rSteel = radius - coatDraw;
  const rIn = rSteel - wallDraw;
  const measShare = m.nominalWallMm > 0 ? Math.min(m.measuredWallMm / m.nominalWallMm, 1) : 1;
  const minShare = m.minWallMm != null && m.nominalWallMm > 0
    ? Math.min(m.minWallMm / m.nominalWallMm, 1) : 0;

  // Repair sleeves, evenly spread with a fixed per-segment jitter.
  const n = isHdpe ? 0 : Math.min(m.repairs, 4);
  const seed = seedOf(m.segmentId);
  const sleeves = Array.from({ length: n }, (_, i) => {
    const base = -LENGTH / 2 + (LENGTH * (i + 1)) / (n + 1);
    return base + Math.sin(seed[0] * 7.3 * (i + 1.7)) * 0.22;
  });

  const gas = m.product === 'Natural Gas';
  return {
    isHdpe,
    coat: isHdpe ? HDPE_BODY : c.rgb,
    gloss: c.gloss,
    tape: c.tape && !bare && !isHdpe ? 1 : 0,
    bare: bare ? 1 : 0,
    holidayThreshold: FBM_MEAN + FBM_SD * probit(clamp(exposed, 0.01, 0.99)),
    rustThreshold: FBM_MEAN - FBM_SD * probit(rustShare),
    pitThreshold: pitThreshold(0.004 + severity * 0.09),
    rust: severity,
    cp: m.cathodicProtection && !isHdpe ? 1 : 0,
    stain: SOIL[m.soil] ?? SOIL.Unknown,
    stainAmt: 0.28 + Math.min(m.ageYears / 60, 1) * 0.3,
    age: Math.min(m.ageYears / 60, 1),
    stripe: gas ? [0.86, 0.66, 0.12] : [0.16, 0.38, 0.74],
    product: (PRODUCT[m.product] ?? { rgb: [0.12, 0.12, 0.13] }).rgb as RGB,
    steel: stainless ? 1 : 0,
    radius, rIn, rSteel,
    rMeas: rIn + wallDraw * measShare,
    rMin: rIn + wallDraw * minShare,
    hasMin: m.minWallMm != null && !isHdpe ? 1 : 0,
    seed,
    sleeves,
  };
}

/* ============================================================== shaders == */

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj, uView;
varying vec3 vNormal, vWorld;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FRAG_BODY = `
#define SLEEVE_HALF ${(SLEEVE_W / 2).toFixed(3)}
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vNormal, vWorld;
uniform vec3 uCam, uCoat, uStain, uStripe, uProduct, uSeed;
uniform float uMode, uGloss, uTape, uBare, uHoliday, uRust, uRustThr, uPitThr, uCP;
uniform float uStainAmt, uAge, uHdpe, uSteel, uROut, uRIn, uRMeas, uRSteel, uRMin, uHasMin;
uniform float uLen, uShadow, uSleeveX;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)) * 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// Each octave is rotated against the last, so the lattice never lines up
// into blocks.
const mat3 ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = ROT * p * 2.02; a *= 0.5; }
  return s / 0.9375;
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCam - vWorld);
  vec3 P = vWorld + uSeed;

  if (uMode > 3.5) {
    // ---- soft contact shadow on an unseen ground ---------------------------
    float dx = max(abs(vWorld.x - 0.15 * uROut) - 0.5 * uLen, 0.0);
    float d = length(vec2(dx, vWorld.z + 0.3 * uROut)) / uROut;
    gl_FragColor = vec4(0.0, 0.0, 0.0, uShadow * 0.5 * exp(-d * d * 1.3));
    return;
  }

  float grain = fbm(P * 9.0);
  vec3 col;
  float gloss = 0.0, shin = 32.0;
  float h = 0.0;                                 // relief, for the bump

  if (uMode < 0.5) {
    // ---- outer surface -----------------------------------------------------
    float th = atan(vWorld.z, vWorld.y);
    if (uHdpe > 0.5) {
      // Black PE with the colour-coded stripes HDPE line pipe carries.
      float stripe = smoothstep(0.984, 0.994, cos(th * 3.0 - 0.6));
      col = mix(uCoat * (0.85 + 0.3 * grain), uStripe, stripe);
      gloss = 0.5; shin = 26.0;
      h = (grain - 0.5) * 0.15;
    } else {
      // Steel as it comes out of the ground: dark mill scale and oxide, rust
      // blooming as the rate rises, pits inside the rust, and with CP on a
      // chalky calcareous deposit instead of rust.
      float rustM = smoothstep(uRustThr - 0.05, uRustThr + 0.05, fbm(P * 2.3 + 5.1));
      float pit = smoothstep(uPitThr, uPitThr + 0.035, vnoise(P * 28.0)) * (0.35 + 0.65 * rustM);
      vec3 scale = mix(vec3(0.17, 0.15, 0.13), vec3(0.34, 0.31, 0.27), grain);
      scale = mix(scale, mix(vec3(0.44, 0.46, 0.48), vec3(0.68, 0.70, 0.72), grain), uSteel);
      vec3 rust = mix(vec3(0.28, 0.115, 0.045), vec3(0.60, 0.30, 0.10), smoothstep(0.3, 0.75, grain));
      vec3 steel = mix(scale, rust, rustM * (0.55 + 0.45 * uRust));
      steel = mix(steel, vec3(0.05, 0.03, 0.02), pit * 0.9);
      float cpM = uCP * (0.3 + 0.7 * smoothstep(0.38, 0.72, fbm(P * 6.0 + 9.0)))
                * (1.0 - rustM * 0.75);
      steel = mix(steel, vec3(0.74, 0.73, 0.68) * (0.8 + 0.3 * grain), cpM * 0.62);
      float steelGloss = mix(0.22, 0.05, rustM) * (1.0 - cpM) + 0.4 * uSteel;
      float steelH = rustM * (grain - 0.5) * 0.7 - pit * 0.9 + cpM * 0.2;

      // The coating, intact or failed. Tape is wound helically and lets go
      // along its overlaps first.
      float wrap = abs(fract(vWorld.x / 0.34 + th * 0.159155) - 0.5);
      float seam = uTape * smoothstep(0.42, 0.5, wrap);
      float field = fbm(P * 0.9 + 7.3) - uTape * 0.08 * smoothstep(0.3, 0.5, wrap);
      float hole = uBare > 0.5 ? 1.0 : 1.0 - smoothstep(uHoliday - 0.02, uHoliday + 0.02, field);
      vec3 coat = uCoat * (0.88 + 0.24 * grain) * (1.0 - 0.35 * seam);
      // Age chalks a coating: lighter, flatter.
      float chalk = uAge * smoothstep(0.35, 0.75, fbm(P * 1.4 + 2.0));
      coat = mix(coat, coat * 0.7 + vec3(0.11), chalk * 0.7);
      col = mix(coat, steel, hole);
      gloss = mix(uGloss * (1.0 - 0.6 * chalk), steelGloss, hole);
      shin = mix(48.0, 18.0, hole);
      h = mix(0.25 + seam * 0.5 + (grain - 0.5) * 0.1, steelH, hole);
    }
    // Soil on the underside.
    float under = smoothstep(0.1, -0.85, vWorld.y / uROut);
    col = mix(col, uStain * (0.8 + 0.4 * grain),
              under * uStainAmt * (0.35 + 0.65 * fbm(P * 1.1 + 3.0)));
  } else if (uMode < 1.5) {
    // ---- the bore, coloured by what flows through it, darker deeper in -----
    float depth = smoothstep(-0.5 * uLen, 0.5 * uLen, vWorld.x);
    col = uProduct * (0.75 + 0.5 * grain) * mix(0.12, 0.62, depth * depth);
    gloss = 0.18; shin = 20.0;
  } else if (uMode < 2.5) {
    // ---- the cut end: the wall in section ----------------------------------
    float r = length(vWorld.yz);
    if (uHdpe > 0.5) {
      col = uCoat * (1.1 + 0.4 * grain);
    } else if (r < uRMeas) {
      col = mix(vec3(0.62, 0.64, 0.66), vec3(0.80, 0.82, 0.84), grain);   // wall left
      gloss = 0.35;
    } else if (r < uRSteel) {
      col = mix(vec3(0.44, 0.22, 0.09), vec3(0.62, 0.32, 0.14), grain);   // metal lost
    } else {
      col = uCoat * 1.2 + 0.03;                                             // coating
    }
    float ring = 1.0 - smoothstep(0.0, 0.012 * uROut, abs(r - uRMin));
    col = mix(col, vec3(0.96, 0.26, 0.24), ring * uHasMin);
  } else {
    // ---- a repair sleeve: coated steel, lighter than any pipe body ---------
    col = mix(vec3(0.44, 0.45, 0.47), vec3(0.60, 0.61, 0.63), grain);
    gloss = 0.45; shin = 36.0;
    // the fillet weld that closes each end of the sleeve
    float bead = 1.0 - smoothstep(0.012, 0.04, abs(abs(vWorld.x - uSleeveX) - SLEEVE_HALF));
    col = mix(col, vec3(0.12, 0.12, 0.13) * (0.8 + 0.4 * grain), bead * step(uROut * 1.01, length(vWorld.yz)));
    h = (grain - 0.5) * 0.1 + bead * 0.4;
  }

#ifdef HAS_DERIV
  // Bump from the relief (Mikkelsen, surface gradient from derivatives).
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  N = normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2) * 0.012);
#endif

  // Key over the viewer's shoulder, cool fill from below-right, a sky/ground
  // ambient, and a faint rim so dark coatings still read on a dark panel.
  vec3 L1 = normalize(vec3(-0.35, 0.80, 0.50));
  vec3 L2 = normalize(vec3(0.70, -0.20, 0.40));
  float d1 = max(dot(N, L1), 0.0), d2 = max(dot(N, L2), 0.0);
  vec3 amb = mix(vec3(0.20, 0.19, 0.18), vec3(0.42, 0.43, 0.46), 0.5 + 0.5 * N.y);
  vec3 lit = col * (amb + vec3(1.0, 0.96, 0.90) * 1.05 * d1 + vec3(0.56, 0.59, 0.66) * 0.40 * d2);
  vec3 H = normalize(L1 + V);
  lit += vec3(1.0, 0.97, 0.92) * pow(max(dot(N, H), 0.0), shin) * gloss;
  lit += vec3(0.62, 0.67, 0.75) * pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.22;
  gl_FragColor = vec4(min(lit, vec3(1.0)), 1.0);
}`;

const fragSource = (deriv: boolean) =>
  (deriv ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIV 1\n' : '') + FRAG_BODY;

/* ============================================================= geometry == */

interface Geo { position: Float32Array; normal: Float32Array; index: Uint16Array; count: number }

/** A tube along x. `inward` turns the normals to face the axis (the bore).
 *  One axial step is enough: the surface detail is all in the shader. */
function tube(radius: number, length: number, x0: number, radial: number, inward = false): Geo {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const s = inward ? -1 : 1;
  for (const x of [x0 - length / 2, x0 + length / 2]) {
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      const cy = Math.cos(th), sy = Math.sin(th);
      pos.push(x, cy * radius, sy * radius);
      nrm.push(0, cy * s, sy * s);
    }
  }
  const stride = radial + 1;
  for (let b = 0; b < radial; b++) idx.push(b, b + stride, b + 1, b + 1, b + stride, b + stride + 1);
  return { position: new Float32Array(pos), normal: new Float32Array(nrm),
           index: new Uint16Array(idx), count: idx.length };
}

/** A flat ring at x, facing +x or -x: a cut end of the wall. */
function ring(rIn: number, rOut: number, x: number, facing: 1 | -1, radial: number): Geo {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let j = 0; j <= radial; j++) {
    const th = (j / radial) * Math.PI * 2;
    const cy = Math.cos(th), sy = Math.sin(th);
    pos.push(x, cy * rIn, sy * rIn, x, cy * rOut, sy * rOut);
    nrm.push(facing, 0, 0, facing, 0, 0);
  }
  for (let j = 0; j < radial; j++) {
    const a = j * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  return { position: new Float32Array(pos), normal: new Float32Array(nrm),
           index: new Uint16Array(idx), count: idx.length };
}

/** A horizontal quad at height y, to catch the contact shadow. */
function plane(y: number, hx: number, hz: number): Geo {
  return {
    position: new Float32Array([-hx, y, -hz, hx, y, -hz, -hx, y, hz, hx, y, hz]),
    normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    index: new Uint16Array([0, 2, 1, 1, 2, 3]),
    count: 6,
  };
}

/* ============================================================= matrices == */

const perspective = (fovy: number, aspect: number, near: number, far: number) => {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0, 0, f, 0, 0,
    0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0,
  ]);
};

/** General look-at with an explicit up vector. */
function lookAt(eye: number[], at: number[], up: number[]) {
  let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
  const zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  const xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1,
  ]);
}

/* ============================================================ component == */

/* Orbit limits. Elevation is clamped short of the poles: at exactly
   vertical the up vector and the view direction are parallel and the
   look-at basis collapses. */
const EL_LIMIT = 1.25;
const DIST_MIN = 4.2;
const DIST_MAX = 13.0;
const FOV = (36 * Math.PI) / 180;
/* Three-quarter view with the cut end turned toward the viewer, framed so
   a 48 in pipe still fits a narrow panel (checked by projecting both end
   circles at aspect 2.0 to 2.6). */
const TARGET = [0.3, -0.12, 0];
const HOME_AZ = 0.85;
const HOME_EL = 0.4;
const DRIFT = 0.28;
/** Closer for slender pipes, so a 4 in line is not lost in the frame, but
 *  not so much closer that 4 in and 48 in end up looking the same size. */
const homeFor = (radius: number) => ({
  az: HOME_AZ, el: HOME_EL, dist: 7.3 + 1.3 * clamp((radius - 0.58) / 0.72, 0, 1),
});

export function Pipeline3D({ model, height = 196 }: { model: PipeModel; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);

  // The camera lives in a ref, not state: it changes every pointer move and
  // every idle frame, and re-rendering the tree at that rate would be
  // wasteful for something only the canvas reads.
  const home = useRef(homeFor(lookOf(model).radius));
  const orbit = useRef({ ...home.current });
  const drag = useRef<{ x: number; y: number; az: number; el: number } | null>(null);
  const interacted = useRef(false);

  const reset = useCallback(() => {
    orbit.current = { ...home.current };
    interacted.current = false;
    setTouched(false);
  }, []);

  /* ------------------------------------------------------------- input -- */
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, az: orbit.current.az, el: orbit.current.el };
    interacted.current = true;
    setTouched(true);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    orbit.current.az = d.az + (e.clientX - d.x) * 0.0105;
    orbit.current.el = clamp(d.el + (e.clientY - d.y) * 0.0085, -EL_LIMIT, EL_LIMIT);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    setDragging(false);
  }, []);

  /* Keyboard orbit. A control that only works with a pointer is not a
     control for everyone. */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 0.32 : 0.12;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': orbit.current.az -= step; break;
      case 'ArrowRight': orbit.current.az += step; break;
      case 'ArrowUp': orbit.current.el = Math.min(EL_LIMIT, orbit.current.el + step); break;
      case 'ArrowDown': orbit.current.el = Math.max(-EL_LIMIT, orbit.current.el - step); break;
      case '+': case '=': orbit.current.dist = Math.max(DIST_MIN, orbit.current.dist - 0.6); break;
      case '-': orbit.current.dist = Math.min(DIST_MAX, orbit.current.dist + 0.6); break;
      case 'Home': reset(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      if (e.key !== 'Home') { interacted.current = true; setTouched(true); }
    }
  }, [reset]);

  /* Wheel, attached natively so it can be non-passive. */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      orbit.current.dist = clamp(orbit.current.dist + e.deltaY * 0.0052, DIST_MIN, DIST_MAX);
      interacted.current = true;
      setTouched(true);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [failed]);

  // A stable key so the GL setup re-runs only when the record changes.
  const modelKey = JSON.stringify(model);

  /* ------------------------------------------------------------- render -- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const look = lookOf(model);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // A different segment starts from its own home view.
    home.current = homeFor(look.radius);
    orbit.current = { ...home.current };
    interacted.current = false;
    setTouched(false);

    let ctx: WebGLRenderingContext | null = null;
    try {
      ctx = canvas.getContext('webgl', { alpha: true, antialias: true }) as WebGLRenderingContext | null;
    } catch { ctx = null; }
    if (!ctx) { setFailed(true); return; }
    const gl = ctx;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
      gl.deleteShader(sh);
      return null;
    };
    // Relief needs screen-space derivatives; without them the same shader
    // draws flat, which loses texture but nothing the record says.
    const deriv = !!gl.getExtension('OES_standard_derivatives');
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = (deriv && compile(gl.FRAGMENT_SHADER, fragSource(true)))
      || compile(gl.FRAGMENT_SHADER, fragSource(false));
    if (!vs || !fs) { setFailed(true); return; }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { setFailed(true); return; }
    gl.useProgram(prog);

    const aPos = gl.getAttribLocation(prog, 'aPos');
    const aNrm = gl.getAttribLocation(prog, 'aNormal');

    /* Geometry: the shadow catcher, outer surface, bore, both cut ends and
       the sleeves. Each part is drawn with its own mode so the shader knows
       what it is. */
    const R = look.radius;
    const ground = -R * SLEEVE - 0.02;
    type Part = { geo: Geo; mode: number; x: number; buffers: WebGLBuffer[] };
    const parts: Part[] = [];
    const add = (geo: Geo, mode: number, x = 0) => {
      const mk = (target: number, data: ArrayBufferView) => {
        const b = gl.createBuffer()!; gl.bindBuffer(target, b);
        gl.bufferData(target, data, gl.STATIC_DRAW); return b;
      };
      parts.push({ geo, mode, x, buffers: [
        mk(gl.ARRAY_BUFFER, geo.position), mk(gl.ARRAY_BUFFER, geo.normal),
        mk(gl.ELEMENT_ARRAY_BUFFER, geo.index),
      ] });
    };
    add(plane(ground, LENGTH / 2 + 2.2 * R, 3.2 * R), 4);    // first: see render()
    add(tube(R, LENGTH, 0, 128), 0);
    add(tube(look.rIn, LENGTH, 0, 96, true), 1);
    add(ring(look.rIn, R, LENGTH / 2, 1, 128), 2);
    add(ring(look.rIn, R, -LENGTH / 2, -1, 128), 2);
    for (const x of look.sleeves) {
      add(tube(R * SLEEVE, SLEEVE_W, x, 128), 3, x);
      add(ring(R, R * SLEEVE, x + SLEEVE_W / 2, 1, 128), 3, x);
      add(ring(R, R * SLEEVE, x - SLEEVE_W / 2, -1, 128), 3, x);
    }

    const U = (n: string) => gl.getUniformLocation(prog, n);
    const u = { proj: U('uProj'), view: U('uView'), cam: U('uCam'), mode: U('uMode'),
                shadow: U('uShadow'), sleeveX: U('uSleeveX') };
    // Per-segment constants, set once.
    gl.uniform3fv(U('uCoat'), look.coat);
    gl.uniform3fv(U('uStain'), look.stain);
    gl.uniform3fv(U('uStripe'), look.stripe);
    gl.uniform3fv(U('uProduct'), look.product);
    gl.uniform3fv(U('uSeed'), look.seed);
    gl.uniform1f(U('uGloss'), look.gloss);
    gl.uniform1f(U('uTape'), look.tape);
    gl.uniform1f(U('uBare'), look.bare);
    gl.uniform1f(U('uHoliday'), look.holidayThreshold);
    gl.uniform1f(U('uRust'), look.rust);
    gl.uniform1f(U('uRustThr'), look.rustThreshold);
    gl.uniform1f(U('uPitThr'), look.pitThreshold);
    gl.uniform1f(U('uCP'), look.cp);
    gl.uniform1f(U('uStainAmt'), look.stainAmt);
    gl.uniform1f(U('uAge'), look.age);
    gl.uniform1f(U('uHdpe'), look.isHdpe ? 1 : 0);
    gl.uniform1f(U('uSteel'), look.steel);
    gl.uniform1f(U('uROut'), R);
    gl.uniform1f(U('uRIn'), look.rIn);
    gl.uniform1f(U('uRMeas'), look.rMeas);
    gl.uniform1f(U('uRSteel'), look.rSteel);
    gl.uniform1f(U('uRMin'), look.rMin);
    gl.uniform1f(U('uHasMin'), look.hasMin);
    gl.uniform1f(U('uLen'), LENGTH);

    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);     // the shader flips normals for back faces
    gl.clearColor(0, 0, 0, 0);
    // Shadow alpha must land in the canvas as-is: premultiplied output.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const render = (w: number, h: number) => {
      gl.viewport(0, 0, w, h);
      const { az, el, dist } = orbit.current;
      const ce = Math.cos(el);
      const eye = [
        TARGET[0] + dist * ce * Math.sin(az),
        TARGET[1] + dist * Math.sin(el),
        TARGET[2] + dist * ce * Math.cos(az),
      ];
      gl.uniformMatrix4fv(u.proj, false, perspective(FOV, w / h, 0.1, 100));
      gl.uniformMatrix4fv(u.view, false, lookAt(eye, TARGET, [0, 1, 0]));
      gl.uniform3f(u.cam, eye[0], eye[1], eye[2]);
      // The ground is only implied; seen from below it would make no sense.
      gl.uniform1f(u.shadow, clamp((eye[1] - ground - 0.4) / 1.2, 0, 1));
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      for (const p of parts) {
        // The shadow goes down first, blended and without depth, so the pipe
        // always draws over it.
        const shadow = p.mode === 4;
        if (shadow) { gl.enable(gl.BLEND); gl.depthMask(false); }
        const [bPos, bNrm, bIdx] = p.buffers;
        gl.bindBuffer(gl.ARRAY_BUFFER, bPos);
        gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bNrm);
        gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
        gl.uniform1f(u.mode, p.mode);
        if (p.mode === 3) gl.uniform1f(u.sleeveX, p.x);
        gl.drawElements(gl.TRIANGLES, p.geo.count, gl.UNSIGNED_SHORT, 0);
        if (shadow) { gl.disable(gl.BLEND); gl.depthMask(true); }
      }
    };

    /* Draw only while on screen, and only when the view has changed: the
       panel scrolls, and a hidden model should cost nothing. */
    let raf = 0;
    let visible = true;
    let last = '';
    const t0 = performance.now();
    const frame = (now: number) => {
      if (!visible || !canvas.isConnected) { raf = 0; return; }
      raf = requestAnimationFrame(frame);
      // Idle drift until the first interaction: it advertises that the
      // model is live without fighting the user once they take hold of it.
      if (!interacted.current && !reduced && !drag.current) {
        orbit.current.az = HOME_AZ + Math.sin((now - t0) / 5200) * DRIFT;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; last = ''; }
      const { az, el, dist } = orbit.current;
      const key = `${az.toFixed(4)} ${el.toFixed(4)} ${dist.toFixed(3)} ${w} ${h}`;
      if (key === last) return;
      last = key;
      render(w, h);
    };
    raf = requestAnimationFrame(frame);

    const io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible && !raf) { last = ''; raf = requestAnimationFrame(frame); }
      })
      : null;
    io?.observe(canvas);

    const onLost = (e: Event) => { e.preventDefault(); setFailed(true); };
    canvas.addEventListener('webglcontextlost', onLost);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      io?.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      for (const p of parts) p.buffers.forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
    };
    // modelKey stands in for `model`: the same record must not rebuild GL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  if (failed) return <PipeSection model={model} height={height} />;

  return (
    <div
      className="relative"
      style={{
        background: 'radial-gradient(ellipse 62% 78% at 54% 46%, '
          + 'color-mix(in srgb, var(--color-ink) 7%, transparent), transparent 72%)',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={cx('block w-full touch-none outline-none',
                      'focus-visible:ring-1 focus-visible:ring-accent',
                      dragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        role="img"
        aria-label={describe(model)}
      />
      <div className={cx(
        'pointer-events-none absolute bottom-1.5 left-2 transition-opacity duration-500',
        touched ? 'opacity-0' : 'opacity-100',
      )}>
        <span className="label" style={{ fontSize: 8 }}>Drag to rotate · scroll to zoom</span>
      </div>
      {touched && (
        <button
          type="button"
          onClick={reset}
          title="Reset view"
          aria-label="Reset the 3D view"
          className="absolute right-1.5 top-1.5 grid h-[22px] w-[22px] place-items-center
                     border border-line-soft bg-panel/85 text-muted transition-colors
                     hover:text-accent"
        >
          <RotateCcw size={11} />
        </button>
      )}
    </div>
  );
}

/** What the outer surface is, in words. */
function surfaceLabel(m: PipeModel): string {
  if (m.material === 'HDPE') return 'HDPE plastic';
  if (m.coating === 'Uncoated') return m.material === 'Stainless Steel' ? 'Bare stainless' : 'Bare steel';
  return (COATING[m.coating] ?? COATING.Unknown).label;
}

/** The model in words, for screen readers. */
function describe(m: PipeModel): string {
  const loss = m.nominalWallMm > 0 ? Math.max(0, (1 - m.measuredWallMm / m.nominalWallMm) * 100) : 0;
  return `3D model of segment ${m.segmentId}: ${m.diameterIn} inch pipe, ${surfaceLabel(m).toLowerCase()}, `
    + `${m.cathodicProtection ? 'with' : 'without'} cathodic protection, `
    + `corroding at ${m.rateMpy.toFixed(2)} mils per year (${m.rateCategory} rate), `
    + `wall ${m.nominalWallMm.toFixed(1)} to ${m.measuredWallMm.toFixed(1)} mm `
    + `(${loss.toFixed(0)}% lost), ${m.repairs} recorded repairs, carrying `
    + `${(PRODUCT[m.product] ?? { label: m.product || 'unknown product' }).label.toLowerCase()}. `
    + 'Drag or use the arrow keys to rotate, plus and minus to zoom.';
}

/* ---------------------------------------------------------------- legend - */

/** What the drawing was built from, so nothing on it is unexplained. */
export function PipeLegend({ model: m }: { model: PipeModel }) {
  const isHdpe = m.material === 'HDPE';
  const stainless = m.material === 'Stainless Steel';
  const look = lookOf(m);
  const surfaceSwatch = isHdpe ? HDPE_BODY
    : m.coating === 'Uncoated' ? (stainless ? STAINLESS_SWATCH : BARE_SWATCH) : look.coat;
  const chips: { k: string; v: string; swatch?: string }[] = [
    { k: 'Surface', v: surfaceLabel(m), swatch: rgbCss(surfaceSwatch) },
    { k: 'CP', v: isHdpe ? 'n/a' : m.cathodicProtection ? 'On' : 'Off' },
    { k: 'Size', v: `${m.diameterIn}″` },
    { k: 'Repairs', v: isHdpe ? '—' : m.repairs ? `${m.repairs} sleeve${m.repairs === 1 ? '' : 's'}` : 'none' },
    { k: 'Product', v: (PRODUCT[m.product] ?? { label: m.product || '—' }).label,
      swatch: rgbCss(look.product) },
    { k: 'Soil', v: m.soil, swatch: rgbCss(look.stain) },
    { k: 'Age', v: `${Math.round(m.ageYears)} yr` },
  ];
  return (
    <div className="border-t border-line-soft px-2.5 py-1.5">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {chips.map((ch) => (
          <span key={ch.k} className="flex items-center gap-1 text-[10px]">
            <span className="label" style={{ fontSize: 8 }}>{ch.k}</span>
            {ch.swatch && (
              <span className="inline-block h-[8px] w-[8px] border border-line"
                    style={{ background: ch.swatch }} />
            )}
            <span className="num text-secondary">{ch.v}</span>
          </span>
        ))}
      </div>
      <WallGauge model={m} />
      <p className="mt-1 text-[9.5px] leading-snug text-dim">
        {!isHdpe && <>The cut end of the model uses the gauge&apos;s colours. </>}
        Illustrative, built from the record, not an inspection image.
      </p>
    </div>
  );
}

/** The wall at a glance: the bar is the wall as built; grey is what is
 *  left, brown is what corrosion has taken, and the red tick is the least
 *  the code allows. Legible at any camera angle, unlike the 3D cut end. */
function WallGauge({ model: m }: { model: PipeModel }) {
  if (!(m.nominalWallMm > 0)) return null;
  const isHdpe = m.material === 'HDPE';
  const left = clamp(m.measuredWallMm / m.nominalWallMm, 0, 1);
  const loss = (1 - left) * 100;
  const min = m.minWallMm != null && !isHdpe ? clamp(m.minWallMm / m.nominalWallMm, 0, 1) : null;
  const words = `Wall ${m.nominalWallMm.toFixed(1)} mm as built, ${m.measuredWallMm.toFixed(1)} mm left`
    + (min != null ? `, code minimum ${m.minWallMm!.toFixed(1)} mm` : '');
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="label" style={{ fontSize: 8 }}>Wall</span>
      <span className="relative inline-block h-[7px] w-[120px] shrink-0 outline outline-1 outline-line"
            role="img" aria-label={words} title={words}>
        <span className="absolute inset-y-0 left-0" style={{ width: `${left * 100}%`, background: WALL_LEFT }} />
        <span className="absolute inset-y-0 right-0" style={{ width: `${100 - left * 100}%`, background: METAL_LOST }} />
        {min != null && (
          <span className="absolute -bottom-[3px] -top-[3px] w-[2px]"
                style={{ left: `calc(${min * 100}% - 1px)`, background: MIN_WALL }} />
        )}
      </span>
      <span className="num text-[10px] text-secondary">
        {isHdpe
          ? `${m.nominalWallMm.toFixed(1)} mm`
          : `${m.nominalWallMm.toFixed(1)} → ${m.measuredWallMm.toFixed(1)} mm${loss >= 0.5 ? ` (−${loss.toFixed(0)}%)` : ''}`}
      </span>
      {min != null && (
        <span className="flex items-center gap-1 text-[10px] text-dim">
          <span className="inline-block h-[8px] w-[2px]" style={{ background: MIN_WALL }} />
          <span className="num">min {m.minWallMm!.toFixed(1)}</span>
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- fallback */

/** Flat cross-section drawing, used when WebGL is unavailable. Carries the
 *  same numbers, so nothing is lost but the depth. */
function PipeSection({ model: m, height }: { model: PipeModel; height: number }) {
  const look = lookOf(m);
  const k = 46 / look.radius;
  return (
    <svg className="block w-full" style={{ height }} viewBox="0 0 320 128" role="img"
         aria-label={describe(m)}>
      <circle cx="64" cy="64" r={look.radius * k} fill={rgbCss(look.coat)} />
      <circle cx="64" cy="64" r={look.rSteel * k} fill={METAL_LOST} />
      <circle cx="64" cy="64" r={look.rMeas * k} fill={WALL_LEFT} />
      <circle cx="64" cy="64" r={look.rIn * k} fill={rgbCss(look.product)} />
      {look.hasMin > 0 && (
        <circle cx="64" cy="64" r={look.rMin * k} fill="none" stroke={MIN_WALL} strokeWidth="1.2" />
      )}
      <text x="132" y="58" className="num" style={{ fill: 'var(--color-muted)' }} fontSize="11">
        {m.nominalWallMm.toFixed(1)} → {m.measuredWallMm.toFixed(1)} mm wall
      </text>
      <text x="132" y="76" className="num" style={{ fill: 'var(--color-dim)' }} fontSize="10">
        {m.rateMpy.toFixed(2)} mpy · cross-section (WebGL unavailable)
      </text>
    </svg>
  );
}
