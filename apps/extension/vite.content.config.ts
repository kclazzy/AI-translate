import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** Content scripts cannot be ES modules: build one self-contained IIFE. */
export default defineConfig({
  root: resolve(__dirname),
  build: {
    outDir: process.env.AIT_OUT ?? 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/content/index.ts'),
      name: 'AITContent',
      formats: ['iife'],
      fileName: () => 'content.js',
    },
    rollupOptions: { output: { extend: true } },
  },
});
