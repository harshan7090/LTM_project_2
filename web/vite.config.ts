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
        // Split the heavy chart library out so the dashboard doesn't pay for
        // it before the user opens Fleet Overview.
        manualChunks: {
          charts: ['recharts'],
          table: ['@tanstack/react-table', '@tanstack/react-virtual'],
        },
      },
    },
  },
});
