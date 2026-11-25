import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@uelights/shared': path.resolve(__dirname, '../packages/shared/src/index.ts') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/live': { target: 'ws://localhost:8787', ws: true },
      '/api': 'http://localhost:8787',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
