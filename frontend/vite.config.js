import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

// App version comes from frontend/package.json, which `node scripts/version.mjs
// sync` keeps in lockstep with the root VERSION file. GIT_SHA is optional —
// pass it at build time (e.g. `VITE_GIT_SHA=$(git rev-parse --short HEAD)
// npm run build`, or the ARG in docker/Dockerfile.frontend / CI) so the
// footer can show a build fingerprint in dev/tooltips.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, './package.json'), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(process.env.VITE_GIT_SHA || ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Forward WebSocket upgrades too — the web terminal (/api/terminal/ssh)
        // and RDP tunnel (/api/terminal/rdp) are WebSockets.
        ws: true,
      },
    },
  },
});
