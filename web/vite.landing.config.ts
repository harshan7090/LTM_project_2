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
 *   which also holds hand-written index.html, app.css and pipe3d.js. Letting
 *   Vite empty it would delete the page it is building the script for.
 */
export default defineConfig({
  build: {
    outDir: resolve(__dirname, '../landing'),
    emptyOutDir: false,
    sourcemap: false,
    // The landing is a visual experience; a slightly larger bundle is a
    // fair trade for it, and it is code-split away from the console.
    chunkSizeWarningLimit: 900,
    lib: {
      entry: resolve(__dirname, 'landing-src/main.ts'),
      name: 'CorvexLanding',
      formats: ['iife'],
      fileName: () => 'bundle.js',
    },
  },
});
