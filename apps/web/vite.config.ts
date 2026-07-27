import { existsSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Frontend build and dev server.
 *
 * Two deliberate choices:
 *
 *  1. HTTPS locally. Yahoo requires an HTTPS redirect URI and will not accept
 *     plain http://localhost, so the dev server serves TLS from a self-signed
 *     certificate — run `npm run certs` to generate one. Without it the dev
 *     server still starts on HTTP, but the Yahoo flow cannot complete.
 *
 *  2. The API is proxied under /api and /auth rather than called cross-origin.
 *     Same-origin means the session cookie needs no third-party cookie
 *     allowance, and local behavior matches the deployed setup.
 *
 * No `define` block and no VITE_ variables carrying configuration: everything the
 * frontend needs comes from API responses, so no value can be inlined into
 * publicly served JavaScript.
 */

const CERT_DIR = new URL('../../certs/', import.meta.url);
const keyPath = new URL('localhost-key.pem', CERT_DIR);
const certPath = new URL('localhost-cert.pem', CERT_DIR);

const hasCerts = existsSync(keyPath) && existsSync(certPath);

const apiPort = process.env['API_PORT'] ?? '4300';
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    ...(hasCerts
      ? {
          https: {
            key: readFileSync(keyPath),
            cert: readFileSync(certPath),
          },
        }
      : {}),
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/auth': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // MUI is large and changes rarely; splitting it keeps app-code deploys
        // from invalidating a cached vendor bundle.
        manualChunks: {
          mui: ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
