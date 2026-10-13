/* Screenshot the landing journey, chapter by chapter.
 *
 * WHY THIS EXISTS
 *
 *   This page is eight scenes deep and none of it is in the DOM — it is
 *   pixels on a canvas. Every other check in this directory reads source
 *   or geometry, which is why they all passed green while the page was
 *   showing a plain text fallback and, before that, while every figure on
 *   it sat at zero. Neither failure was visible to anything but an eye.
 *
 *   So: drive a real browser, scroll to each chapter, save a PNG. It is the
 *   only check here that can catch "it renders, but it is wrong".
 *
 * NO DEPENDENCIES
 *
 *   Node 24 has a built-in WebSocket, so the Chrome DevTools Protocol is
 *   reachable without adding a package to a project that does not otherwise
 *   need a browser automation stack.
 *
 * Usage:  node web/scripts/shoot-journey.mjs [url] [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8010/';
const OUT = process.argv[3] || path.join(process.env.TEMP || '/tmp', 'corvex-journey');
const PORT = 9222;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('No Chrome or Edge found. This check needs one of them.');
  process.exit(1);
}

/* Read the chapters from the source, so this cannot drift from the page. */
const journeySrc = fs.readFileSync('web/landing-src/journey.ts', 'utf8');
const chapters = [...journeySrc.matchAll(
  /\{\s*id:\s*'([^']+)',\s*num:\s*'([^']+)',\s*title:\s*'([^']+)',\s*from:\s*([\d.]+),\s*to:\s*([\d.]+)\s*\}/g,
)].map((m) => ({ id: m[1], num: m[2], title: m[3], from: Number(m[4]), to: Number(m[5]) }));

if (!chapters.length) {
  console.error('Could not parse any chapters out of journey.ts');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- CDP ---- */

let nextId = 1;
const pending = new Map();
let socket;

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30000);
  });
}

const evaluate = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    .then((r) => r.result?.value);

/* --------------------------------------------------------------- run ---- */

const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox',
  // Software rendering: CI machines and this one have no GPU in headless.
  // Slower, but it is the same WebGL, which is what is being checked.
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--window-size=1600,1000',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(OUT, '.profile')}`,
  'about:blank',
], { stdio: 'ignore' });

let failed = 0;

try {
  // Wait for the debugging endpoint rather than sleeping a guessed amount.
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome never opened its debugging port');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', rej, { once: true });
  });

  const consoleErrors = [];
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      return;
    }
    // A page that throws is the failure this whole script exists to catch,
    // so it is collected rather than merely printed.
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);   // scene start-up, on software rendering

  const health = await evaluate(`(() => {
    const c = document.querySelector('canvas');
    return {
      htmlClass: document.documentElement.className,
      canvas: c ? c.width + 'x' + c.height : null,
      scrollHeight: document.documentElement.scrollHeight,
      viewport: innerHeight,
    };
  })()`);

  console.log(`html class : "${health.htmlClass}"`);
  console.log(`canvas     : ${health.canvas}`);
  console.log(`scrollable : ${health.scrollHeight}px over a ${health.viewport}px viewport`);
  console.log();

  if (health.htmlClass.includes('no-js')) {
    console.error('FAIL: the bundle never ran — html still has the no-js class.');
    failed++;
  }
  if (health.htmlClass.includes('scene-failed')) {
    console.error('FAIL: the scene threw and fell back to the plain page.');
    failed++;
  }
  if (!health.canvas) {
    console.error('FAIL: no canvas in the document.');
    failed++;
  } else if (/^0x|x0$/.test(health.canvas)) {
    console.error(`FAIL: the canvas has a zero dimension (${health.canvas}).`);
    failed++;
  }
  if (health.scrollHeight <= health.viewport + 10) {
    console.error('FAIL: the page does not scroll, so the journey cannot advance.');
    failed++;
  }

  for (const c of chapters) {
    const mid = (c.from + c.to) / 2;
    // Lenis animates toward a programmatic scroll rather than jumping, so
    // the wait after setting it is not optional.
    await evaluate(
      `window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * ${mid})`,
    );
    await sleep(2200);

    const seen = await evaluate(`(() => {
      const on = document.querySelector('.panel.is-on');
      const pct = document.querySelector('.hud__pct span');
      return { panel: on ? on.className : null, pct: pct ? pct.textContent : null };
    })()`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${c.num}-${c.id}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    const expected = `panel--${c.id}`;
    const ok = seen.panel && seen.panel.includes(expected);
    if (!ok) failed++;
    console.log(
      `${c.num} ${c.title.padEnd(20)} t=${mid.toFixed(3)} hud=${String(seen.pct).padStart(3)}%  `
      + `${ok ? 'panel ok' : `PANEL MISMATCH — showing ${seen.panel}`}`,
    );
  }

  console.log();
  if (consoleErrors.length) {
    failed++;
    console.error(`${consoleErrors.length} console error(s):`);
    [...new Set(consoleErrors)].slice(0, 10).forEach((e) => console.error('  ' + e));
  } else {
    console.log('No console errors.');
  }
  console.log(`Screenshots in ${OUT}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  chrome.kill();
}

process.exit(failed ? 1 : 0);
