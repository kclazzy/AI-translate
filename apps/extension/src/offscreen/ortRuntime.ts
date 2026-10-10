import { tr } from '@ait/core/i18n';

/**
 * ONNX Runtime for the neural networks that run in the browser (LaMa, the text detector). Its
 * engine (.wasm, ~21 MB) is not shipped with the extension: it is downloaded once, when the first
 * of those models is, from jsDelivr, pinned to the exact onnxruntime-web version the extension is
 * built with, and checked against the SHA-256 of that file (both taken from node_modules at build
 * time). The models and the runtime are kept in the Cache Storage 'ait-models'.
 */
export const MODELS_CACHE = 'ait-models';
export const ORT_VERSION = __ORT_VERSION__;
export const ORT_WASM_SHA256 = __ORT_WASM_SHA256__;
export const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`;
export const ORT_WASM_SIZE = __ORT_WASM_SIZE__;

export type Ort = typeof import('onnxruntime-web/webgpu');

export async function cached(url: string): Promise<boolean> {
  try {
    return !!(await (await caches.open(MODELS_CACHE)).match(url));
  } catch {
    return false;
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch a file whole, reporting the bytes received. */
export async function fetchAll(url: string, onBytes: (got: number, total: number) => void, guess: number, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || guess;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes(got, total);
  }
  return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
}

/**
 * Download a model together with the runtime (unless the runtime is already there), reporting
 * progress (0–1) over both. The model's hash is not known ahead (it is not ours), the runtime's is.
 */
export async function downloadWithRuntime(modelUrl: string, modelGuess: number, progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  const cache = await caches.open(MODELS_CACHE);
  let wasmTotal = ORT_WASM_SIZE;
  let wasmGot = 0;
  let modelTotal = modelGuess;
  let modelGot = 0;
  const haveWasm = !!(await cache.match(ORT_WASM_URL));
  if (haveWasm) wasmTotal = 0;
  const report = () => progress(Math.min(0.99, (wasmGot + modelGot) / Math.max(1, wasmTotal + modelTotal)));
  if (!haveWasm) {
    const wasm = await fetchAll(ORT_WASM_URL, (got, total) => ((wasmGot = got), (wasmTotal = total), report()), ORT_WASM_SIZE, signal);
    if ((await sha256(await wasm.arrayBuffer())) !== ORT_WASM_SHA256) throw new Error(tr('файл движка ONNX Runtime скачался с ошибкой или подменён (контрольная сумма не совпала). Попробуйте ещё раз позже.'));
    await cache.put(ORT_WASM_URL, new Response(wasm, { headers: { 'content-length': String(wasm.size) } }));
    wasmGot = wasmTotal;
  }
  report();
  if (!(await cache.match(modelUrl))) {
    const blob = await fetchAll(modelUrl, (got, total) => ((modelGot = got), (modelTotal = total), report()), modelGuess, signal);
    await cache.put(modelUrl, new Response(blob, { headers: { 'content-length': String(blob.size) } }));
  }
  progress(1);
}

/** Every model that runs on this runtime: it is removed with the last of them. */
export const LAMA_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
export const DETECTOR_URL = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx';
export const DETECTOR_FP32_URL = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx';
const RUNTIME_USERS = [LAMA_URL, DETECTOR_URL, DETECTOR_FP32_URL];

/** Remove a model; the runtime goes too when no other model needs it. */
export async function removeModel(modelUrls: string[]): Promise<void> {
  const cache = await caches.open(MODELS_CACHE);
  for (const u of modelUrls) await cache.delete(u);
  let other = false;
  for (const u of RUNTIME_USERS) if (!modelUrls.includes(u) && (await cache.match(u))) other = true;
  if (!other) await cache.delete(ORT_WASM_URL);
}

/** The runtime, loaded once, from the cached .wasm (no URL to fetch, nothing for the CSP to block). */
let ortPromise: Promise<Ort> | null = null;
export function loadOrt(): Promise<Ort> {
  ortPromise ??= (async () => {
    const runtime = await (await caches.open(MODELS_CACHE)).match(ORT_WASM_URL);
    if (!runtime) throw new Error('ONNX Runtime is not downloaded');
    const ort = await import('onnxruntime-web/webgpu');
    // No threads: the page is not cross-origin isolated.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = await runtime.arrayBuffer();
    return ort;
  })();
  ortPromise.catch(() => (ortPromise = null));
  return ortPromise;
}

/** Resize RGBA pixels with a canvas (smooth), returning RGBA. */
export function resizePixels(img: { width: number; height: number; data: Uint8ClampedArray }, w: number, h: number): Uint8ClampedArray {
  if (img.width === w && img.height === h) return img.data;
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
