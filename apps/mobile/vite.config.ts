import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Writes the list of built files into sw.js so the app works offline after the first visit. */
function precacheManifest(): Plugin {
  return {
    name: 'ait-precache',
    apply: 'build',
    writeBundle(options, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map') && !f.includes('pdf.worker'));
      const out = resolve(options.dir!, 'sw.js');
      const sw = readFileSync(out, 'utf8').replace('self.__PRECACHE__ = [];', `self.__PRECACHE__ = ${JSON.stringify(['./', ...files])};`);
      writeFileSync(out, sw.replace('__VERSION__', String(Date.now())));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), precacheManifest()],
  build: { outDir: 'dist', emptyOutDir: true, target: ['es2022', 'safari16'], chunkSizeWarningLimit: 2500 },
  server: { host: true },
});
