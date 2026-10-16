import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'strip-mock-service-worker',
      closeBundle() {
        const swPath = path.resolve(__dirname, '../dist/web/mockServiceWorker.js');
        if (fs.existsSync(swPath)) {
          fs.unlinkSync(swPath);
        }
      },
    },
  ],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-xterm': ['xterm', '@xterm/addon-fit'],
          'vendor-markdown': ['react-markdown'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/pty': {
        target: 'ws://127.0.0.1:7700',
        ws: true,
      },
      '/api': {
        target: 'http://127.0.0.1:7700',
        changeOrigin: true,
      },
    },
  },
});
