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
/**
 * Manga OCR made faster (this repository's «models-3», see models.yml): the decoder that reads one
 * character at a time with a cache (cross-attention once per bubble + one step per character), and
 * the encoder in fp16 for the video card.
 */
const MODELS_3 = 'https://github.com/kclazzy/AI-translate/releases/download/models-3';
export const MANGA_FAST: Record<'cross' | 'step' | 'encoderGpu', ModelFile> = {
  cross: { url: `${MODELS_3}/manga-ocr-cross-int8.onnx`, sha256: '2723419079971e271d55952f4f2468e6d59bb741b427f130123c309974da42a3', size: 2_377_554 },
  step: { url: `${MODELS_3}/manga-ocr-step-int8.onnx`, sha256: '4af7699fac866a38b3f12cd2e7a12280cd9f1fd2c7926b68dc89d9d454af1bcd', size: 27_127_257 },
  encoderGpu: { url: `${MODELS_3}/manga-ocr-encoder-fp16.onnx`, sha256: '14e95f2e96a62cfcd9afb885279895af6229f20d9def183f9dc662c7becb6c08', size: 171_960_808 },
};
export const MANGA_OCR_URLS = [MANGA_OCR.encoder.url, MANGA_OCR.decoder.url, MANGA_OCR.vocab.url, MANGA_FAST.cross.url, MANGA_FAST.step.url, MANGA_FAST.encoderGpu.url];

/** Does this browser's video card run fp16 networks (the fast encoder)? */
let f16: Promise<boolean> | null = null;
export function gpuF16(): Promise<boolean> {
  f16 ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
      const adapter = gpu ? await gpu.requestAdapter() : null;
      return !!adapter?.features.has('shader-f16');
    } catch {
      return false;
    }
  })();
  return f16;
}
/** The upscaler for small scans: waifu2x CUNet, art, denoise 1, 2× (nagadomi/nunif, MIT), in this repository's «models-2». */
export const UPSCALER: ModelFile = {
  url: 'https://github.com/kclazzy/AI-translate/releases/download/models-2/upscale-art-2x.onnx',
  sha256: '5d3288a2847e51d8944002dc81aea76ef1a2879db33b8fb86d5953b4b1c442bf',
  size: 5_178_788,
};
const RUNTIME_USERS = [LAMA_URL, LAMA_MANGA.url, ...MANGA_OCR_URLS, UPSCALER.url, DETECTOR_URL, DETECTOR_FP32_URL, OCR_DET_URL, OCR_REC_URL, OCR_REC_KO_URL];

/** Remove a model; the runtime goes too when no other model needs it. */
export async function removeModel(modelUrls: string[]): Promise<void> {
  const cache = await caches.open(MODELS_CACHE);
  for (const u of modelUrls) await cache.delete(u);
  let other = false;
  for (const u of RUNTIME_USERS) if (!modelUrls.includes(u) && (await cache.match(u))) other = true;
  if (!other) await cache.delete(ORT_WASM_URL);
}

/**
 * Processor threads for the networks: several where the page is cross-origin isolated (the
 * extension's pages are, see manifest.ts) and in the offscreen document only, half the cores and at most 4 (the model and the page
 * need the rest); one elsewhere.
 */
export function wasmThreads(): number {
  if (typeof crossOriginIsolated === 'undefined' || !crossOriginIsolated) return 1;
  // Only in the background document that translates the pages: on a page the user looks at
  // (settings, studio) the main thread must stay free.
  if (typeof location === 'undefined' || !location.pathname.endsWith('offscreen.html')) return 1;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/** The runtime, loaded once, from the cached .wasm (no URL to fetch, nothing for the CSP to block). */
let ortPromise: Promise<Ort> | null = null;
export function loadOrt(): Promise<Ort> {
  ortPromise ??= (async () => {
    const runtime = await (await caches.open(MODELS_CACHE)).match(ORT_WASM_URL);
    if (!runtime) throw new Error('ONNX Runtime is not downloaded');
    const ort = await import('onnxruntime-web/webgpu');
    ort.env.wasm.numThreads = wasmThreads();
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
  // Read back right away: kept in ordinary memory (see browserBackend.createCanvas).
  const ctx = dst.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

// ---------------------------------------------------------------------------------------------
// The networks on the engine (AI Translate Engine on this computer, ONNX Runtime with CUDA):
// the sessions are made there, the pipeline here does not change (see engine/app/nets.py).
// ---------------------------------------------------------------------------------------------

type OrtSession = import('onnxruntime-web').InferenceSession;
type OrtTensor = import('onnxruntime-web').Tensor;

/** A session of either kind, as far as the networks here use it. */
export interface NetSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
  /** Made on the engine: where it runs there («CUDAExecutionProvider»…). */
  remote?: string;
}

interface NetsEngine {
  url: string;
  token: string;
}
let netsEngine: NetsEngine | null = null;
/** The engine stopped answering: the browser until then. */
let netsDownUntil = 0;
const NETS_DOWN_MS = 60_000;

/** Make the networks' sessions on this engine from now on (null: in the browser). Sessions already made stay where they are. */
export function setNetsEngine(e: NetsEngine | null): boolean {
  const changed = (e?.url ?? '') !== (netsEngine?.url ?? '') || (e?.token ?? '') !== (netsEngine?.token ?? '');
  netsEngine = e;
  return changed;
}

/** Are new sessions made on the engine now? */
export function netsOnEngine(): boolean {
  return !!netsEngine && Date.now() >= netsDownUntil;
}

/** A video card for the networks: the engine's, or this browser's (WebGPU). */
export function gpuAvailable(): boolean {
  return netsOnEngine() || (typeof navigator !== 'undefined' && 'gpu' in navigator);
}

const TYPES: Record<string, string> = { float32: 'float32', float16: 'float16', int64: 'int64', int32: 'int32', uint8: 'uint8', bool: 'bool' };

/** Tensors in one binary frame (u32 header length, JSON header, the data; see engine/app/nets.py). */
export function encodeFrame(tensors: [string, { type: string; dims: readonly number[]; data: unknown }][]): Blob {
  const parts: BlobPart[] = [];
  const specs = tensors.map(([name, t]) => {
    const type = TYPES[t.type];
    if (!type) throw new Error(`Tensor type ${t.type} cannot go to the engine`);
    const d = t.data as ArrayBufferView;
    const bytes = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    parts.push(bytes as BlobPart);
    return { name, type, dims: [...t.dims], length: bytes.byteLength };
  });
  const header = new TextEncoder().encode(JSON.stringify({ tensors: specs }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  return new Blob([len, header, ...parts] as BlobPart[]);
}

export function decodeFrame(buf: ArrayBuffer): { name: string; type: string; dims: number[]; data: ArrayBufferView }[] {
  const n = new DataView(buf).getUint32(0, true);
  const { tensors } = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n))) as { tensors: { name: string; type: string; dims: number[]; length: number }[] };
  let pos = 4 + n;
  return tensors.map((t) => {
    // A copy: typed arrays need their element alignment.
    const raw = buf.slice(pos, pos + t.length);
    pos += t.length;
    const data =
      t.type === 'float32' ? new Float32Array(raw)
      : t.type === 'float16' ? new Uint16Array(raw)
      : t.type === 'int64' ? new BigInt64Array(raw)
      : t.type === 'int32' ? new Int32Array(raw)
      : new Uint8Array(raw);
    return { ...t, data };
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return sha256(bytes.slice().buffer as ArrayBuffer);
}

async function engineCall(e: NetsEngine, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${e.url.replace(/\/+$/, '')}${path}`, { ...init, headers: { authorization: `Bearer ${e.token}`, ...(init.headers ?? {}) } });
  return res;
}

/** A session on the engine: the model is sent once (kept there by its SHA-256). */
async function remoteSession(ort: Ort, e: NetsEngine, bytes: Uint8Array, gpu: boolean): Promise<NetSession> {
  const sha = await sha256Hex(bytes);
  const open = () => engineCall(e, `/v1/nets/${sha}/open?gpu=${gpu ? 1 : 0}`, { method: 'POST' });
  let res = await open();
  if (res.status === 404) {
    const put = await engineCall(e, `/v1/nets/${sha}`, { method: 'PUT', body: bytes as BodyInit, headers: { 'content-type': 'application/octet-stream' } });
    if (!put.ok) throw new Error(`engine: model upload HTTP ${put.status}`);
    res = await open();
  }
  if (!res.ok) throw new Error(`engine: HTTP ${res.status}`);
  const info = (await res.json()) as { inputs: string[]; outputs: string[]; on: string };
  return {
    inputNames: info.inputs,
    outputNames: info.outputs,
    remote: info.on,
    async run(feeds) {
      const r = await engineCall(e, `/v1/nets/${sha}/run?gpu=${gpu ? 1 : 0}`, { method: 'POST', body: encodeFrame(Object.entries(feeds)), headers: { 'content-type': 'application/octet-stream' } });
      if (!r.ok) {
        // The engine restarted without this model, or stopped: new sessions in the browser for a while.
        if (r.status >= 500 || r.status === 404) netsDownUntil = Date.now() + NETS_DOWN_MS;
        throw new Error(`engine: run HTTP ${r.status}`);
      }
      const out: Record<string, OrtTensor> = {};
      for (const t of decodeFrame(await r.arrayBuffer())) out[t.name] = new ort.Tensor(t.type as 'float32', t.data as Float32Array, t.dims);
      return out;
    },
    async release() {
      await engineCall(e, `/v1/nets/${sha}/session`, { method: 'DELETE' }).catch(() => undefined);
    },
  };
}

/**
 * A network's session: on the engine when it is set and answers (CUDA there), else in this
 * browser with these execution providers (WebGPU / WebAssembly).
 */
export async function makeSession(ort: Ort, bytes: Uint8Array, executionProviders: string[]): Promise<NetSession> {
  const e = netsOnEngine() ? netsEngine : null;
  if (e) {
    try {
      return await remoteSession(ort, e, bytes, executionProviders.includes('webgpu'));
    } catch {
      // Not there (stopped, an old version): the browser, and the engine is asked again in a minute.
      netsDownUntil = Date.now() + NETS_DOWN_MS;
    }
  }
  return (await ort.InferenceSession.create(bytes, { executionProviders })) as OrtSession as NetSession;
}

/** Is the engine there with its networks, and on what? (null: not there, too old, or not paired.) */
export async function probeNetsEngine(e: NetsEngine): Promise<{ device: string } | null> {
  try {
    const res = await engineCall(e, '/v1/nets', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const info = (await res.json()) as { available?: boolean; device?: string };
    return info.available ? { device: info.device ?? 'cpu' } : null;
  } catch {
    return null;
  }
}
