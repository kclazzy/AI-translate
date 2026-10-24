import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * RAR / 7z / TAR chapters (CBR, CB7, CBT) are unpacked by libarchive.js (libarchive in WebAssembly,
 * MIT): its worker and its 1 MB .wasm are copied as they are to `libarchive/` next to the pages and
 * loaded only when such a file is opened. The library's own `new URL("./worker-bundle.js", …)` is
 * replaced by that fixed place, so the bundler does not try to rebuild the ready worker.
 */
export function libarchiveAssets(): Plugin {
  const dir = resolve(dirname(createRequire(resolve(__dirname, 'package.json')).resolve('libarchive.js')));
  return {
    name: 'ait-libarchive',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('libarchive.js') || !code.includes('new URL("./worker-bundle.js",import.meta.url)')) return null;
      return { code: code.replace('new URL("./worker-bundle.js",import.meta.url)', 'new URL("libarchive/worker-bundle.js",document.baseURI)'), map: null };
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'libarchive/worker-bundle.js', source: readFileSync(resolve(dir, 'worker-bundle.js')) });
      this.emitFile({ type: 'asset', fileName: 'libarchive/libarchive.wasm', source: readFileSync(resolve(dir, 'libarchive.wasm')) });
    },
  };
}
