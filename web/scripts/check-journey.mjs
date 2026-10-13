/* Journey geometry check.
 *
 * WHY THIS EXISTS
 *
 *   Nobody writing this page can see it render. Every previous visual bug
 *   here — a map drawn upside down, a pipe the same colour as its
 *   background, tiles 401ing behind a fallback that hid it — was caught by
 *   a numeric check and NOT by looking, because looking was not available.
 *
 *   The hazard specific to this rebuild: each chapter's scene is anchored
 *   on a Catmull-Rom curve, and that curve is arc-length reparameterised.
 *   Station five is NOT at t=0.5. An anchor can be computed perfectly and
 *   still leave the scene's actual content behind the camera or off the
 *   edge of the frame — and the only symptom is a chapter whose copy fades
 *   in over an empty background. That reads as "a bit sparse", not as a
 *   bug, which is exactly why it needs a number rather than an opinion.
 *
 *   Checking the ANCHOR would prove nothing: the anchor is by construction
 *   the point the camera is aimed at, so it is always dead centre. What is
 *   checked instead is each scene's declared FOCUS — the thing the scene
 *   wants you to look at — offset from that anchor.
 *
 * Every number is PARSED from source, so this cannot pass against a stale
 * copy of values that have since moved.
 */
import fs from 'node:fs';
import { CatmullRomCurve3, Object3D, PerspectiveCamera, Vector3 } from 'three';

const world = fs.readFileSync('web/landing-src/World.tsx', 'utf8');
const journeyTs = fs.readFileSync('web/landing-src/journey.ts', 'utf8');

const fail = [];
const note = (m) => fail.push(m);

/* ------------------------------------------------------------- parse ---- */

const stations = [...world.matchAll(/new Vector3\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)]
  .map((m) => new Vector3(Number(m[1]), Number(m[2]), Number(m[3])));

const chapters = [...journeyTs.matchAll(
  /\{\s*id:\s*'([^']+)',\s*num:\s*'([^']+)',\s*title:\s*'([^']+)',\s*from:\s*([\d.]+),\s*to:\s*([\d.]+)\s*\}/g,
)].map((m) => ({ id: m[1], num: m[2], title: m[3], from: Number(m[4]), to: Number(m[5]) }));

const lookAhead = Number(/const LOOK_AHEAD = ([\d.]+)/.exec(world)?.[1]);
const tension = Number(/'catmullrom',\s*([\d.]+)\)/.exec(world)?.[1]);
const baseFov = Number(/fov:\s*(\d+),\s*near/.exec(world)?.[1]);
const farPlane = Number(/far:\s*(\d+)/.exec(world)?.[1]);
const fogFar = Number(/new Fog\([^,]+,\s*\d+,\s*(\d+)\)/.exec(world)?.[1]);

const FILES = {
  orbit: 'Orbit', network: 'Network', twin: 'Twin', sensors: 'Sensors',
  corrosion: 'Corrosion', predict: 'Predict', shap: 'Shap', risk: 'Risk',
};

const focus = {};
for (const [id, base] of Object.entries(FILES)) {
  const src = fs.readFileSync(`web/landing-src/scenes/${base}.tsx`, 'utf8');
  const m = /export const FOCUS: \[number, number, number\] = \[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]/.exec(src);
  if (!m) { note(`${base}.tsx does not export a FOCUS point`); continue; }
  focus[id] = new Vector3(Number(m[1]), Number(m[2]), Number(m[3]));
}

if (stations.length !== 8) note(`parsed ${stations.length} stations, expected 8`);
if (chapters.length !== 8) note(`parsed ${chapters.length} chapters, expected 8`);
for (const [k, v] of Object.entries({ lookAhead, tension, baseFov, farPlane, fogFar })) {
  if (!Number.isFinite(v)) note(`could not parse ${k}`);
}
if (fail.length) {
  console.error('check-journey: could not read the source\n  ' + fail.join('\n  '));
  process.exit(1);
}

/* --------------------------------------------------------- the curve ---- */

const curve = new CatmullRomCurve3(stations, false, 'catmullrom', tension);

const smooth = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
function presence(t, c) {
  const span = c.to - c.from;
  const edge = span * 0.2;
  if (t < c.from - edge || t > c.to + edge) return 0;
  return Math.min(
    smooth((t - (c.from - edge)) / (edge * 2)),
    1 - smooth((t - (c.to - edge)) / (edge * 2)),
  );
}

/* ----------------------------------------------------------- checks ----- */

/* 16:9 is the forgiving case. 3:4 portrait is the one that actually crops,
   and it is what a phone held upright gives you. */
const ASPECTS = [{ name: '16:9', a: 16 / 9 }, { name: '3:4', a: 3 / 4 }];

console.log('chapter                  t    ahead    ndc x    ndc y   verdict');
console.log('-'.repeat(70));

for (const c of chapters) {
  const mid = (c.from + c.to) / 2;
  const anchor = curve.getPointAt(Math.min(mid + lookAhead, 1));
  // Same orientation the chapter group is given in World.tsx: local -Z
  // along the tangent. The focus point is expressed in that space, so it
  // has to be rotated before it can be added to the anchor.
  const probe = new Object3D();
  probe.position.copy(anchor);
  probe.lookAt(anchor.clone().sub(curve.getTangentAt(Math.min(mid + lookAhead, 1))));
  probe.updateMatrixWorld();
  const target = focus[c.id].clone().applyQuaternion(probe.quaternion).add(anchor);

  const pos = curve.getPointAt(Math.min(Math.max(mid, 0), 1));
  const look = curve.getPointAt(Math.min(mid + lookAhead, 1));
  const fov = baseFov + Math.sin(mid * Math.PI) * 6;

  let worst = null;
  for (const { name, a } of ASPECTS) {
    const cam = new PerspectiveCamera(fov, a, 0.5, farPlane);
    cam.position.copy(pos);
    cam.lookAt(look);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    const view = target.clone().applyMatrix4(cam.matrixWorldInverse);
    const clip = target.clone().project(cam);
    const rec = { name, x: clip.x, y: clip.y, ahead: -view.z };
    const off = Math.max(Math.abs(rec.x), Math.abs(rec.y));
    if (!worst || off > Math.max(Math.abs(worst.x), Math.abs(worst.y))) worst = rec;
  }

  const bad = [];
  if (worst.ahead <= 0) bad.push(`BEHIND CAMERA (${worst.ahead.toFixed(1)})`);
  else if (worst.ahead < 2) bad.push(`inside the near plane (${worst.ahead.toFixed(1)})`);
  else if (worst.ahead > fogFar) bad.push(`past the fog (${worst.ahead.toFixed(0)} > ${fogFar})`);
  // Slack of 0.9: a focus exactly on the frame edge means half the subject
  // is cropped at the worst aspect ratio.
  if (worst.ahead > 0 && Math.abs(worst.x) > 0.9) bad.push(`off frame in x (${worst.x.toFixed(2)} at ${worst.name})`);
  if (worst.ahead > 0 && Math.abs(worst.y) > 0.9) bad.push(`off frame in y (${worst.y.toFixed(2)} at ${worst.name})`);

  if (bad.length) note(`${c.num} ${c.title}: ${bad.join('; ')}`);
  console.log(
    `${(c.num + ' ' + c.title).padEnd(24)} ${mid.toFixed(3)} ${worst.ahead.toFixed(1).padStart(7)} `
    + `${worst.x.toFixed(3).padStart(8)} ${worst.y.toFixed(3).padStart(8)}   `
    + (bad.length ? 'FAIL — ' + bad.join('; ') : 'ok'),
  );
}

/* Chapters must overlap, or the journey cuts between them instead of
   cross-fading — the one thing the brief rules out by name. */
for (let i = 1; i < chapters.length; i++) {
  if (chapters[i].from >= chapters[i - 1].to) {
    note(`${chapters[i - 1].title} -> ${chapters[i].title}: no overlap, the journey will cut`);
  }
}

/* And there must be no moment with nothing on screen. */
for (let t = 0; t <= 1.0001; t += 0.005) {
  const total = chapters.reduce((s, c) => s + presence(t, c), 0);
  if (total < 0.2) { note(`dead zone at t=${t.toFixed(3)} — total presence ${total.toFixed(3)}`); break; }
}

console.log();
if (fail.length) {
  console.error(`check-journey: ${fail.length} problem(s)\n  ` + fail.join('\n  '));
  process.exit(1);
}
console.log('check-journey: 8/8 scenes in frame at peak, overlapping, no dead zones.');
