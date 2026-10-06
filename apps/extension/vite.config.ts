import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve(__dirname);

/** Extension pages + background service worker (ES modules). */
export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: process.env.AIT_OUT ?? 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        options: resolve(root, 'options.html'),
        studio: resolve(root, 'studio.html'),
        offscreen: resolve(root, 'offscreen.html'),
        background: resolve(root, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
