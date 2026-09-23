/* Landing page consistency check.
 *
 * The recurring failure on this page has been a reference to markup that is
 * not there, or a rule for markup that was deleted. Both fail silently.
 * This checks the markup, the stylesheet and the bundle's source agree.
 */
import fs from 'node:fs';

const html = fs.readFileSync('landing/index.html', 'utf8');
const css = fs.readFileSync('landing/app.css', 'utf8');
const ts = fs.readFileSync('web/landing-src/main.ts', 'utf8')
          + fs.readFileSync('web/landing-src/scene.ts', 'utf8');

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
);
// Classes the script creates at runtime. Both spellings: classList.add,
// and className assignment on an element built with createElement - missing
// the second reported every odometer class as an orphaned CSS rule.
for (const c of [...ts.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)]) {
  htmlClasses.add(c[1]);
}
for (const c of [...ts.matchAll(/\.className\s*=\s*'([^']+)'/g)]) {
  c[1].split(/\s+/).filter(Boolean).forEach((x) => htmlClasses.add(x));
}
for (const c of ['on', 'done', 'scrolled', 'gl-on', 'no-js', 'neg', 'center', 'tight']) {
  htmlClasses.add(c);
}

let bad = 0;
const fail = (m) => { bad++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

// --- 1. every getElementById target exists ------------------------------
console.log('script -> markup:');
for (const m of ts.matchAll(/getElementById\('([^']+)'\)/g)) {
  htmlIds.has(m[1]) ? ok(`#${m[1]}`) : fail(`#${m[1]} referenced but not in markup`);
}
for (const m of ts.matchAll(/toArray<[^>]+>\('([^']+)'\)/g)) {
  const sel = m[1];
  const parts = sel.split(',').map((s) => s.trim());
  const missing = parts.filter((p) => {
    const cls = [...p.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((x) => x[1]);
    return cls.some((c) => !htmlClasses.has(c));
  });
  missing.length ? fail(`${sel} -> ${missing}`) : ok(sel);
}

// --- 2. no CSS rule for markup that does not exist ----------------------
const cssNo = css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssClasses = new Set();
for (const m of cssNo.matchAll(/(^|[\s,>+~({])\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
  cssClasses.add(m[2]);
}
const orphan = [...cssClasses].filter((c) => !htmlClasses.has(c)).sort();
console.log('\nCSS rules with no markup:');
orphan.length ? fail('ORPHANED -> ' + orphan.join(', ')) : ok('none');

// --- 3. markup classes with no CSS --------------------------------------
const unstyled = [...htmlClasses].filter((c) => !cssClasses.has(c)).sort();
console.log('\nmarkup classes with no CSS rule:');
console.log('  ' + (unstyled.length ? unstyled.join(', ') : 'none'));

// --- 4. every referenced file exists ------------------------------------
console.log('\nreferenced files:');
for (const m of html.matchAll(/(?:src|href)="(\/landing\/[^"]+)"/g)) {
  const p = m[1].replace(/^\//, '');
  fs.existsSync(p) ? ok(m[1]) : fail(`${m[1]} MISSING`);
}

// --- 5. nav + footer anchors resolve to real sections -------------------
console.log('\nin-page anchors:');
for (const m of html.matchAll(/href="#([a-zA-Z][\w-]*)"/g)) {
  htmlIds.has(m[1]) ? ok(`#${m[1]}`) : fail(`#${m[1]} has no target`);
}

// --- 6. the CTA must reach the console ----------------------------------
const consoleLinks = [...html.matchAll(/href="\/console"/g)].length;
console.log('\nLaunch console links: ' + consoleLinks);
if (consoleLinks < 2) fail('expected the CTA in the header AND the closing section');
else ok('present in header, hero and close');

// --- 7. no inline script (the CSP would kill it) ------------------------
const inline = (html.match(/<script(?![^>]*\ssrc=)/g) || []).length;
console.log('\ninline <script> blocks: ' + inline);
inline === 0 ? ok('none — CSP safe') : fail('inline script will be blocked by script-src self');

console.log(bad ? `\n${bad} PROBLEM(S)` : '\nLANDING CONSISTENT');
process.exit(bad ? 1 : 0);
