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
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
