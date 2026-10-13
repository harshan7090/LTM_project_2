/* Landing page consistency check.
 *
 * The recurring failure on this page has been a reference to markup that is
 * not there, or a rule for markup that was deleted. Both fail silently: the
 * page renders, nothing throws, and a panel is simply unstyled or a rule is
 * simply dead. The last rebuild left a `.lamp` block behind after the
 * element became `.pulse`, and nothing noticed until this script did.
 *
 * So this reads every class the page can produce — from index.html and from
 * the React sources, including the ones assembled inside template literals —
 * and every class app.css has a rule for, and reports both directions.
 */
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync('landing/index.html', 'utf8');
const css = fs.readFileSync('landing/app.css', 'utf8');

const SRC = 'web/landing-src';
const sources = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) sources.push(fs.readFileSync(p, 'utf8'));
  }
})(SRC);
const ts = sources.join('\n');

/* ------------------------------------------------------------- used ----- */

const used = new Set();
const add = (s) => s.split(/\s+/)
  // A trailing -- or __ is the left half of an interpolated name
  // (`panel--${id}`), not a class the stylesheet is expected to know.
  .filter((c) => c && !/(--|__)$/.test(c))
  .forEach((c) => used.add(c));

for (const m of html.matchAll(/\bclass="([^"]+)"/g)) add(m[1]);
// className="a b"
for (const m of ts.matchAll(/className="([^"]+)"/g)) add(m[1]);
// className={`a b${x ? ' c' : ''}`} — every static run inside the template,
// which is where conditional state classes like ' is-on' live.
for (const m of ts.matchAll(/className=\{`([^`]*)`\}/g)) {
  for (const chunk of m[1].split(/\$\{[^}]*\}/)) add(chunk);
}
// State classes added conditionally inside a template expression, e.g.
// ${on ? ' is-on' : ''}. Narrow on purpose: a looser version of this read
// unit strings like 'mm' and element ids like 'root' as class names.
for (const m of ts.matchAll(/'\s*((?:is|has)-[a-z0-9-]+)\s*'/g)) used.add(m[1]);
for (const m of ts.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'\)/g)) add(m[1]);

/* Set on <html>, never written as a className literal. Both have rules,
 * so both belong in the comparison. */
used.add('no-js');        // index.html, removed by main.tsx on boot
used.add('scene-failed'); // main.tsx, when the scene throws on start

/* -------------------------------------------------------------- css ----- */

/* Class selectors, read with comments stripped first. Without that, the
   header comment naming palette.ts and index.html registers phantom .ts
   and .html selectors and every run reports them as orphan rules. */
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const declared = new Set(
  [...cssRules.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);

/* --------------------------------------------------------- compare ----- */

const problems = [];

const orphans = [...declared].filter((c) => !used.has(c)).sort();
if (orphans.length) {
  problems.push(`app.css styles ${orphans.length} class(es) nothing produces:\n    ` + orphans.join(', '));
}

const missing = [...used].filter((c) => !declared.has(c)).sort();
if (missing.length) {
  problems.push(`${missing.length} class(es) are produced but have no rule:\n    ` + missing.join(', '));
}

/* The loader failsafe is the single most load-bearing rule on the page:
   without it a throw at module scope leaves a permanent splash screen,
   which has actually shipped here once. */
if (!/animation:\s*loader-failsafe/.test(css)) {
  problems.push('app.css has lost the loader-failsafe animation — a parse error in the bundle would trap the page behind the loader');
}
if (!/@keyframes loader-failsafe/.test(css)) {
  problems.push('app.css references loader-failsafe but does not define it');
}

/* The fallback copy must be reachable both ways: no script at all, and
   script that loaded but threw. */
for (const sel of ['.no-js .plain', '.scene-failed .plain']) {
  if (!css.includes(sel)) problems.push(`app.css is missing "${sel}" — a failure mode with no readable page`);
}
if (!/scene-failed/.test(ts)) {
  problems.push('nothing adds the scene-failed class, so the fallback copy can never appear');
}

/* The canvas must be positioned by an inline style, not by app.css.
 *
 * R3F writes `position: relative; width: 100%; height: 100%` inline on its
 * wrapper, and inline beats a class rule. With only the stylesheet, the
 * wrapper stays `relative` inside #root — a flow div with auto height — so
 * `height: 100%` resolves against an indefinite parent, computes to zero,
 * and the whole scene renders into a 0px box. Nothing throws; the page is
 * simply black. This shipped once and is invisible to every other check
 * here, all of which only read geometry and class names. */
const worldSrc = fs.readFileSync(`${SRC}/World.tsx`, 'utf8');
const canvasTag = /<Canvas[\s\S]*?>/.exec(worldSrc)?.[0] ?? '';
if (!/style=\{\{[^}]*position:\s*'fixed'/.test(canvasTag)) {
  problems.push("World.tsx: <Canvas> has no inline style with position 'fixed' — R3F's own inline height:100% will collapse the canvas to 0px inside #root");
}

/* The mount point the bundle needs. */
if (!/id="root"/.test(html)) problems.push('index.html has no #root for the bundle to mount into');
if (!/landing\/bundle\.js/.test(html)) problems.push('index.html does not load the bundle');

if (problems.length) {
  console.error('check-landing: ' + problems.length + ' problem(s)\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log(`check-landing: ${declared.size} CSS classes, ${used.size} produced, all accounted for.`);
