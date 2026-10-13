import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies /api to the FastAPI backend so the frontend can run on
// :5173 with hot reload while the real API stays on :8010. The production
// build is emitted to web/dist, which FastAPI serves directly — see
// backend/main.py, which prefers web/dist and falls back to the no-build
// vanilla console in frontend/ when the React app hasn't been built.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8010',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        /* Chunking has two jobs here, and they pull in different directions.
         *
         * SPLIT WHAT NOT EVERY USER NEEDS. recharts, the TanStack table
         * stack and react-markdown are each large and each used by one
         * corner of the console. The four non-landing views are lazily
         * imported in App.tsx, so these ride along with the view that wants
         * them rather than with sign-in.
         *
         * KEEP WHAT EVERY USER NEEDS CACHEABLE. React and the query client
         * change only when a dependency is upgraded, whereas app code
         * changes constantly. Splitting them means a redeploy invalidates
         * the app chunk and leaves the ~140 kB vendor chunk in the browser
         * cache. Bundled together, every deploy re-downloads React.
         *
         * Do NOT add a catch-all node_modules chunk here: it undoes the
         * first job by dragging every lazy dependency back into one eager
         * file. */
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client'],
          query: ['@tanstack/react-query'],
          charts: ['recharts'],
          table: ['@tanstack/react-table', '@tanstack/react-virtual'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
});
