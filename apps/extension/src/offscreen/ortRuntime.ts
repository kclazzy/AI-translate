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

/** A model file pinned by its SHA-256, with a second source (this repository's releases). */
export interface ModelFile {
  url: string;
  sha256: string;
  size: number;
  /** The same file elsewhere (tried when the first source fails or sends something else). */
  mirror?: string;
}

/** Networks attached to this repository's «models-1» release (see .github/workflows/models.yml). */
export const MODELS_RELEASE = 'https://github.com/kclazzy/AI-translate/releases/download/models-1';

/** Download the runtime (unless there) and the files that are missing, checking every one; progress 0–1. */
export async function downloadChecked(files: ModelFile[], progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  const cache = await caches.open(MODELS_CACHE);
  const want: ModelFile[] = [];
  if (!(await cache.match(ORT_WASM_URL))) want.push({ url: ORT_WASM_URL, sha256: ORT_WASM_SHA256, size: ORT_WASM_SIZE });
  for (const f of files) if (!(await cache.match(f.url))) want.push(f);
  const total = want.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const f of want) {
    const sources = [f.url, ...(f.mirror ? [f.mirror] : [])];
    let ok: Blob | null = null;
    let last: unknown = null;
    for (const src of sources) {
      try {
        const blob = await fetchAll(src, (got) => progress(Math.min(0.99, (done + Math.min(got, f.size)) / total)), f.size, signal);
        if ((await sha256(await blob.arrayBuffer())) !== f.sha256) throw new Error(tr('файл скачался с ошибкой или подменён (контрольная сумма не совпала)'));
        ok = blob;
        break;
      } catch (e) {
        if (signal?.aborted) throw e;
        last = e;
      }
    }
    if (!ok) throw last ?? new Error('download');
    await cache.put(f.url, new Response(ok, { headers: { 'content-length': String(ok.size) } }));
    done += f.size;
  }
  progress(1);
}

/** Every model that runs on this runtime: it is removed with the last of them. */
export const LAMA_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
/** LaMa trained on manga and anime (AnimeMangaInpainting by dreMaz, MIT; ONNX by mayocream for Koharu). */
export const LAMA_MANGA: ModelFile = {
  url: 'https://huggingface.co/mayocream/lama-manga-onnx/resolve/b55497aadbfcb9740e1ed16f008268d71b4f3f79/lama-manga.onnx',
  sha256: '4512adab295ee5a5e02ccd1bdf8d45dccbac88309d9cff1532ffd5de876f02a4',
  size: 207_482_644,
  mirror: `${MODELS_RELEASE}/lama-manga.onnx`,
};
export const DETECTOR_URL = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx';
export const DETECTOR_FP32_URL = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector.onnx';
/** Text recognition (see ocr.ts): RapidOCR's model hub, PP-OCRv6 small and the Korean reader. */
export const OCR_HUB = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx';
export const OCR_DET_URL = `${OCR_HUB}/PP-OCRv6/det/PP-OCRv6_det_small.onnx`;
export const OCR_REC_URL = `${OCR_HUB}/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`;
export const OCR_REC_KO_URL = `${OCR_HUB}/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx`;
/** Manga OCR (Japanese; kha-white/manga-ocr-base, Apache-2.0), int8 weights made by models.yml. */
export const MANGA_OCR: Record<'encoder' | 'decoder' | 'vocab', ModelFile> = {
  encoder: { url: `${MODELS_RELEASE}/manga-ocr-encoder-int8.onnx`, sha256: '0eaf2b867292a44700ce38ef028b90639a2e36fc4c18c2bcdd1de7409488adb3', size: 87_074_595 },
  decoder: { url: `${MODELS_RELEASE}/manga-ocr-decoder-int8.onnx`, sha256: '3ff0d4c34c4a66613d98ff93e0b17f22a7b09dfbeec195c3e4d6f595af3a6b6c', size: 29_675_736 },
  vocab: { url: `${MODELS_RELEASE}/manga-ocr-vocab.txt`, sha256: '5cb5c5586d98a2f331d9f8828e4586479b0611bfba5d8c3b6dadffc84d6a36a3', size: 30_216 },
};
export const MANGA_OCR_URLS = [MANGA_OCR.encoder.url, MANGA_OCR.decoder.url, MANGA_OCR.vocab.url];
const RUNTIME_USERS = [LAMA_URL, LAMA_MANGA.url, ...MANGA_OCR_URLS, DETECTOR_URL, DETECTOR_FP32_URL, OCR_DET_URL, OCR_REC_URL, OCR_REC_KO_URL];

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
