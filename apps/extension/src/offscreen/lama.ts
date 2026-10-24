import type { Inpainter, PixelData } from '@ait/core';
import { GPU_NETS, GpuTimeout, NETS_LIMIT_MS, NETS_LOAD_LIMIT_MS, onGpu, releaseWhenIdle, withLimit } from './gpuLane';
import { cached, downloadChecked, LAMA_MANGA, LAMA_URL, loadOrt, MODELS_CACHE, ORT_WASM_URL, removeModel, resizePixels, type Ort } from './ortRuntime';

/**
 * LaMa in the browser, 512×512, run with ONNX Runtime on the video card (WebGPU) or the processor
 * (WebAssembly). The model (~200 MB) is downloaded once, on request, and kept in the extension's
 * cache (with the runtime, see ortRuntime). Since 1.1.22 it is the one trained on manga and anime
 * (as in Koharu); the general one (Carve/LaMa-ONNX) downloaded before keeps working until replaced.
 */
export { LAMA_URL, MODELS_CACHE as LAMA_CACHE, ORT_VERSION, ORT_WASM_SHA256, ORT_WASM_URL } from './ortRuntime';
const SIZE = 512;

/** Which LaMa is in the cache: the one for manga, the general one (older versions), or none. */
export async function lamaKind(): Promise<'manga' | 'general' | null> {
  if (!(await cached(ORT_WASM_URL))) return null;
  if (await cached(LAMA_MANGA.url)) return 'manga';
  return (await cached(LAMA_URL)) ? 'general' : null;
}

export async function lamaDownloaded(): Promise<boolean> {
  return (await lamaKind()) !== null;
}

/** Download the runtime and the model (for manga, checked) into the cache, reporting progress (0–1) over both. */
export async function downloadLama(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadChecked([LAMA_MANGA], progress, signal);
}

/** Replace the general LaMa with the one for manga (the old file goes once the new one is in). */
export async function upgradeLama(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadLama(progress, signal);
  await releaseLama();
  await (await caches.open(MODELS_CACHE)).delete(LAMA_URL);
}

export async function deleteLama(): Promise<void> {
  await releaseLama();
  await removeModel([LAMA_URL, LAMA_MANGA.url]);
}

/** After a run on the card stopped answering: on the processor from now on (until the extension restarts). */
let gpuBroken = false;

function abandon(): void {
  gpuBroken = true;
  const s = session;
  session = null;
  void s?.then((L) => L.s.release()).catch(() => undefined);
}

/** Free the session (video memory); the next picture loads it again. */
export async function releaseLama(): Promise<void> {
  const s = session;
  session = null;
  const L = await s?.catch(() => null);
  await L?.s.release().catch(() => undefined);
}

/** One redraw at a time (a session does not run two calls at once), on the card between model requests. */
let chain: Promise<unknown> = Promise.resolve();
let cancelIdle: (() => void) | undefined;

let session: Promise<{ ort: Ort; s: import('onnxruntime-web').InferenceSession; image: string; mask: string; onGpu: boolean }> | null = null;

function load() {
  session ??= (async () => {
    const cache = await caches.open(MODELS_CACHE);
    const hit = (await cache.match(LAMA_MANGA.url)) ?? (await cache.match(LAMA_URL));
    if (!hit || !(await cached(ORT_WASM_URL))) throw new Error('LaMa is not downloaded');
    const ort = await loadOrt();
    const bytes = new Uint8Array(await hit.arrayBuffer());
    const gpu = !gpuBroken && typeof navigator !== 'undefined' && 'gpu' in navigator;
    let s: import('onnxruntime-web').InferenceSession;
    let onGpu = gpu;
    try {
      s = await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] });
    } catch {
      onGpu = false;
      s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }
    const image = s.inputNames.find((n) => /image/i.test(n)) ?? s.inputNames[0];
    const mask = s.inputNames.find((n) => /mask/i.test(n)) ?? s.inputNames[s.inputNames.length - 1];
    return { ort, s, image, mask, onGpu };
  })();
  session.catch(() => (session = null));
  return session;
}

const resize = resizePixels;

export const lamaInpainter: Inpainter = (img, mask) => {
  const limitMs = session ? NETS_LIMIT_MS : NETS_LOAD_LIMIT_MS;
  const job = chain.then(() =>
    (gpuBroken ? withLimit(() => runOnce(img, mask), NETS_LOAD_LIMIT_MS) : onGpu(GPU_NETS, () => runOnce(img, mask), { limitMs })).catch(async (e: unknown) => {
      // The card stopped answering: this picture is painted over simply, the next ones use the processor.
      if (e instanceof GpuTimeout) {
        abandon();
        throw e;
      }
      if ((e as Error)?.name === 'AbortError') throw e;
      // The run failed on the video card (its device lost, out of its memory on a tall strip): the
      // card is not used for LaMa again, and this picture is redrawn on the processor.
      const L = await session?.catch(() => null);
      if (!L?.onGpu) throw e;
      abandon();
      return withLimit(() => runOnce(img, mask), NETS_LOAD_LIMIT_MS);
    }),
  );
  chain = job.catch(() => undefined);
  void job.finally(() => {
    // Not used for a while: give the video memory back to the model.
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseLama());
  }).catch(() => undefined);
  return job;
};

async function runOnce(img: PixelData, mask: Uint8Array): Promise<PixelData> {
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
}
