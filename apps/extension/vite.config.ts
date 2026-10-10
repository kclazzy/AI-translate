import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = resolve(__dirname);

/**
 * ONNX Runtime (LaMa in the browser): its 21 MB .wasm is not part of the extension. The app
 * downloads it with the model from jsDelivr (this exact version) and checks this SHA-256.
 */
const ortDir = dirname(createRequire(resolve(root, 'package.json')).resolve('onnxruntime-web'));
const ortPkg = JSON.parse(readFileSync(resolve(ortDir, '../package.json'), 'utf8')) as { version: string };
const ortWasm = readFileSync(resolve(ortDir, 'ort-wasm-simd-threaded.jsep.wasm'));
const ortWasmSha256 = createHash('sha256').update(ortWasm).digest('hex');

/** The runtime bundle names its .wasm with `new URL(…, import.meta.url)`, which makes vite emit it: drop that. */
function noOrtWasm(): Plugin {
  return {
    name: 'ait-no-ort-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('onnxruntime-web') || !code.includes('new URL("ort-wasm')) return null;
      return { code: code.replace(/new URL\("(ort-wasm[\w.-]*\.wasm)",import\.meta\.url\)\.href/g, '"$1"'), map: null };
    },
    generateBundle(_, bundle) {
      const wasm = Object.keys(bundle).filter((f) => f.endsWith('.wasm'));
      if (wasm.length) throw new Error(`.wasm must not be in the extension: ${wasm.join(', ')}`);
    },
  };
}

/** Extension pages + background service worker (ES modules). */
export default defineConfig({
  root,
  base: './',
  plugins: [noOrtWasm(), react()],
  define: {
    __ORT_VERSION__: JSON.stringify(ortPkg.version),
    __ORT_WASM_SHA256__: JSON.stringify(ortWasmSha256),
    __ORT_WASM_SIZE__: String(ortWasm.length),
  },
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
