import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server on 5319, proxying /api and /events to the backend on 4319.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5319,
    proxy: {
      '/api': {
        target: 'http://localhost:4319',
        changeOrigin: true,
      },
      '/events': {
        target: 'http://localhost:4319',
        changeOrigin: true,
        // SSE: keep the connection open, do not buffer.
        ws: false,
      },
    },
  },
  test: {
    // The pure helper tests (util/resume/mergeOverlay) stay in the fast `node`
    // environment by default. Only the DOM/component/integration tests under
    // test/dom/** opt into jsdom (via environmentMatchGlobs), so the existing
    // suite never pays the jsdom setup cost and keeps its exact behavior.
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}'],
    environmentMatchGlobs: [['test/dom/**', 'jsdom']],
    // setupFiles run per-test-file; the setup here is jsdom-only (it pulls in
    // @testing-library/jest-dom matchers + cleanup), so guard it so the node
    // tests don't load DOM-only code.
    setupFiles: ['./test/dom/setup.js'],
  },
});
