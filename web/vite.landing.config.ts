import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/* Build for the PUBLIC LANDING PAGE only.
 *
 * WHY A SECOND CONFIG
 *
 *   The landing page and the console are different products with different
 *   dependencies — the landing pulls in three.js and GSAP, which the console
 *   has no use for, and the console pulls React, TanStack and Recharts,
 *   which the landing has no use for. Building them together would make
 *   each pay for the other's weight.
 *
 *   So this emits ONE self-contained IIFE to landing/bundle.js, which
 *   index.html loads with a plain <script src>. No module graph, no import
 *   map, nothing the CSP has to be widened for: `script-src 'self'` is
 *   satisfied because the file is served from this origin like any other.
 *
 *   `emptyOutDir` is off, deliberately. The output directory is `landing/`,
 *   which also holds the hand-written index.html and app.css. Letting
 *   Vite empty it would delete the page it is building the script for.
 */
export default defineConfig({
  /* WITHOUT THIS THE PAGE IS BLANK.
   *
   * Vite's library mode deliberately does NOT substitute
   * `process.env.NODE_ENV`, because a library is expected to be bundled
   * again by whoever consumes it, and that consumer supplies the value.
   * This "library" is not consumed by anything — it is a finished script a
   * browser loads directly.
   *
   * React reads `process.env.NODE_ENV` at MODULE SCOPE to pick its dev or
   * production path. Left unsubstituted, the first thing that happens in
   * the browser is `Uncaught ReferenceError: process is not defined`, the
   * whole bundle dies before one line of application code runs, and the
   * page falls back to the plain copy with no clue as to why. Every
   * start-up guard in main.tsx is downstream of this and cannot help,
   * because none of them has been defined yet.
   *
   * The app build (vite.config.ts) does this substitution automatically.
   * Only the lib build needs it spelled out.
   *
   * Verified by web/scripts/check-bundle.mjs, which greps the built file. */
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: resolve(__dirname, '../landing'),
    emptyOutDir: false,
    sourcemap: false,
    // The landing is a visual experience; a slightly larger bundle is a
    // fair trade for it, and it is code-split away from the console.
    chunkSizeWarningLimit: 900,
    lib: {
      entry: resolve(__dirname, 'landing-src/main.tsx'),
      name: 'CorvexLanding',
      formats: ['iife'],
      fileName: () => 'bundle.js',
    },
  },
});
