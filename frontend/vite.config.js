import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
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
