import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { SITE_NAME } from '@price-comparison/catalog/site-brand';
import { accessAssets } from './access-assets.js';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), accessAssets(), {
    name: 'site-brand-html',
    transformIndexHtml: html => html.replaceAll('%SITE_NAME%', SITE_NAME),
  }],
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
