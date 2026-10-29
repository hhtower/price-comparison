import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  envDir: false,
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: {
    proxy: {
      // The Nest API uses URI versioning; keep the browser-facing /api prefix stable.
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/u, '/v1'),
      },
      '/health': 'http://127.0.0.1:3000',
    },
  },
  test: {
    root: fileURLToPath(new URL('../../', import.meta.url)),
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./apps/web/src/setupTests.js'],
    include: ['apps/web/src/**/*.test.jsx'],
  },
});
