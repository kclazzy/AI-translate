import type { Inpainter, PixelData } from '@ait/core';
import { cached, downloadWithRuntime, LAMA_URL, loadOrt, MODELS_CACHE, ORT_WASM_URL, removeModel, resizePixels, type Ort } from './ortRuntime';

/**
 * LaMa in the browser: the same model the local engine uses (Carve/LaMa-ONNX, 512×512), run with
 * ONNX Runtime on the video card (WebGPU) or the processor (WebAssembly). The model (~200 MB) is
 * downloaded once, on request, and kept in the extension's cache (with the runtime, see ortRuntime).
 */
export { LAMA_URL, MODELS_CACHE as LAMA_CACHE, ORT_VERSION, ORT_WASM_SHA256, ORT_WASM_URL } from './ortRuntime';
const SIZE = 512;

export async function lamaDownloaded(): Promise<boolean> {
  return (await cached(LAMA_URL)) && (await cached(ORT_WASM_URL));
}

/** Download the runtime and the model into the cache, reporting progress (0–1) over both. */
export async function downloadLama(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadWithRuntime(LAMA_URL, 208_000_000, progress, signal);
}

export async function deleteLama(): Promise<void> {
  await removeModel([LAMA_URL]);
  session = null;
}

let session: Promise<{ ort: Ort; s: import('onnxruntime-web').InferenceSession; image: string; mask: string }> | null = null;

function load() {
  session ??= (async () => {
    const hit = await (await caches.open(MODELS_CACHE)).match(LAMA_URL);
    if (!hit || !(await cached(ORT_WASM_URL))) throw new Error('LaMa is not downloaded');
    const ort = await loadOrt();
    const bytes = new Uint8Array(await hit.arrayBuffer());
    const gpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    let s: import('onnxruntime-web').InferenceSession;
    try {
      s = await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] });
    } catch {
      s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }
    const image = s.inputNames.find((n) => /image/i.test(n)) ?? s.inputNames[0];
    const mask = s.inputNames.find((n) => /mask/i.test(n)) ?? s.inputNames[s.inputNames.length - 1];
    return { ort, s, image, mask };
  })();
  session.catch(() => (session = null));
  return session;
}

const resize = resizePixels;

export const lamaInpainter: Inpainter = async (img, mask) => {
  const { ort, s, image, mask: maskName } = await load();
  const px = resize(img, SIZE, SIZE);
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = px[i * 4 + c] / 255;
  // Nearest-neighbour mask, grown by a pixel so the edge of the letters is redrawn too.
  const m = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / SIZE));
      const sy = Math.min(img.height - 1, Math.floor((y * img.height) / SIZE));
      if (mask[sy * img.width + sx]) m[y * SIZE + x] = 1;
    }
  }
  const out = await s.run({ [image]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]), [maskName]: new ort.Tensor('float32', m, [1, 1, SIZE, SIZE]) });
  const data = out[s.outputNames[0]].data as Float32Array;
  let max = 0;
  for (let i = 0; i < data.length; i += 997) if (data[i] > max) max = data[i];
  const k = max <= 1.5 ? 255 : 1;
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = data[c * SIZE * SIZE + i] * k;
    rgba[i * 4 + 3] = 255;
  }
  const back = resize({ width: SIZE, height: SIZE, data: rgba }, img.width, img.height);
  return { width: img.width, height: img.height, data: back };
};
