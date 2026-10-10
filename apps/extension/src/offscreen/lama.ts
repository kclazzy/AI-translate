import type { Inpainter, PixelData } from '@ait/core';
import { tr } from '@ait/core/i18n';

/**
 * LaMa in the browser: the same model the local engine uses (Carve/LaMa-ONNX, 512×512), run with
 * ONNX Runtime on the video card (WebGPU) or the processor (WebAssembly). The model (~200 MB) is
 * downloaded once, on request, and kept in the extension's cache.
 */
export const LAMA_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
export const LAMA_CACHE = 'ait-models';
const SIZE = 512;

/**
 * The ONNX Runtime engine (.wasm, ~21 MB) is not shipped with the extension: it is downloaded with
 * the model from jsDelivr, pinned to the exact onnxruntime-web version the extension is built with,
 * and checked against the SHA-256 of that file (both taken from node_modules at build time).
 */
export const ORT_VERSION = __ORT_VERSION__;
export const ORT_WASM_SHA256 = __ORT_WASM_SHA256__;
export const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`;
const ORT_WASM_SIZE = __ORT_WASM_SIZE__;

export async function lamaDownloaded(): Promise<boolean> {
  try {
    const cache = await caches.open(LAMA_CACHE);
    return !!(await cache.match(LAMA_URL)) && !!(await cache.match(ORT_WASM_URL));
  } catch {
    return false;
  }
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch a file whole, reporting the bytes received. */
async function fetchAll(url: string, onBytes: (got: number, total: number) => void, guess: number, signal?: AbortSignal): Promise<Blob> {
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

/** Download the runtime and the model into the cache, reporting progress (0–1) over both. */
export async function downloadLama(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  const cache = await caches.open(LAMA_CACHE);
  const MODEL_GUESS = 208_000_000;
  let wasmTotal = ORT_WASM_SIZE;
  let wasmGot = 0;
  let modelTotal = MODEL_GUESS;
  let modelGot = 0;
  const report = () => progress(Math.min(0.99, (wasmGot + modelGot) / (wasmTotal + modelTotal)));
  if (!(await cache.match(ORT_WASM_URL))) {
    const wasm = await fetchAll(ORT_WASM_URL, (got, total) => ((wasmGot = got), (wasmTotal = total), report()), ORT_WASM_SIZE, signal);
    if ((await sha256(await wasm.arrayBuffer())) !== ORT_WASM_SHA256) throw new Error(tr('файл движка ONNX Runtime скачался с ошибкой или подменён (контрольная сумма не совпала). Попробуйте ещё раз позже.'));
    await cache.put(ORT_WASM_URL, new Response(wasm, { headers: { 'content-length': String(wasm.size) } }));
  }
  wasmGot = wasmTotal;
  report();
  if (!(await cache.match(LAMA_URL))) {
    const blob = await fetchAll(LAMA_URL, (got, total) => ((modelGot = got), (modelTotal = total), report()), MODEL_GUESS, signal);
    await cache.put(LAMA_URL, new Response(blob, { headers: { 'content-length': String(blob.size) } }));
  }
  progress(1);
}

export async function deleteLama(): Promise<void> {
  const cache = await caches.open(LAMA_CACHE);
  await cache.delete(LAMA_URL);
  await cache.delete(ORT_WASM_URL);
  session = null;
}

type Ort = typeof import('onnxruntime-web/webgpu');
let session: Promise<{ ort: Ort; s: import('onnxruntime-web').InferenceSession; image: string; mask: string }> | null = null;

function load() {
  session ??= (async () => {
    const cache = await caches.open(LAMA_CACHE);
    const hit = await cache.match(LAMA_URL);
    const runtime = await cache.match(ORT_WASM_URL);
    if (!hit || !runtime) throw new Error('LaMa is not downloaded');
    const ort = await import('onnxruntime-web/webgpu');
    // The runtime (.wasm) comes from the cache as bytes: no URL to fetch, nothing for the CSP to block.
    // No threads: the page is not cross-origin isolated.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = await runtime.arrayBuffer();
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

/** Resize RGBA pixels with a canvas (smooth), returning RGBA. */
function resize(img: PixelData, w: number, h: number): Uint8ClampedArray {
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const dst = new OffscreenCanvas(w, h);
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

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
