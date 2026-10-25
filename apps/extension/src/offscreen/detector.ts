import { DETECTOR_SIZE, parseDetectorOutputs, type Detection, type PixelData, type RawTensor, type TextDetector } from '@ait/core';
import { GPU_NETS, GpuTimeout, NETS_LIMIT_MS, NETS_LOAD_LIMIT_MS, onGpu, releaseWhenIdle, withLimit } from './gpuLane';
import { cached, DETECTOR_FP32_URL, DETECTOR_URL, downloadWithRuntime, loadOrt, MODELS_CACHE, ORT_WASM_URL, removeModel, resizePixels, makeSession, gpuAvailable, type NetSession } from './ortRuntime';

/**
 * The neural text / bubble detector (ogkalu/comic-text-and-bubble-detector, Apache-2.0: RT-DETR-v2
 * fine-tuned on manga, webtoons, manhua and western comics; classes bubble, text_bubble,
 * text_free) in the browser, with the same ONNX Runtime as LaMa. The int8 model (~45 MB) is
 * downloaded once, on request. Input: 640×640 RGB scaled to 0–1, no normalisation. The input and
 * output names are read from the model (Hugging Face export or the original RT-DETR deploy form).
 */
export { DETECTOR_URL, DETECTOR_FP32_URL };
const MODEL_GUESS = 45_000_000;

export async function detectorDownloaded(): Promise<boolean> {
  return ((await cached(DETECTOR_URL)) || (await cached(DETECTOR_FP32_URL))) && (await cached(ORT_WASM_URL));
}

/** Download the runtime (unless LaMa brought it already) and the model, reporting progress (0–1). */
export async function downloadDetector(progress: (share: number) => void, signal?: AbortSignal, opts: { full?: boolean } = {}): Promise<void> {
  await downloadWithRuntime(opts.full ? DETECTOR_FP32_URL : DETECTOR_URL, opts.full ? 170_000_000 : MODEL_GUESS, progress, signal);
}

export async function deleteDetector(): Promise<void> {
  await releaseDetector();
  await removeModel([DETECTOR_URL, DETECTOR_FP32_URL]);
}

type Session = NetSession;
interface Loaded {
  s: Session;
  ort: Awaited<ReturnType<typeof loadOrt>>;
  image: string;
  sizes?: string;
  ep: 'webgpu' | 'wasm' | 'engine';
  url: string;
}
let session: Promise<Loaded> | null = null;

/**
 * The session, made once: the int8 model on the video card (WebGPU, with WebAssembly for the
 * operators it lacks), else on the processor; the full model when the int8 one will not load.
 */
function load(prefer?: 'wasm'): Promise<Loaded> {
  session ??= (async () => {
    const ort = await loadOrt();
    const cache = await caches.open(MODELS_CACHE);
    const gpu = prefer !== 'wasm' && !gpuBroken && gpuAvailable();
    let last: unknown = new Error('The text detector is not downloaded');
    for (const url of [DETECTOR_URL, DETECTOR_FP32_URL]) {
      const hit = await cache.match(url);
      if (!hit) continue;
      const bytes = new Uint8Array(await hit.arrayBuffer());
      for (const ep of gpu ? (['webgpu', 'wasm'] as const) : (['wasm'] as const)) {
        try {
          const s = await makeSession(ort, bytes, ep === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm']);
          const image = s.inputNames.find((n) => /pixel|image|input/i.test(n)) ?? s.inputNames[0];
          const sizes = s.inputNames.find((n) => n !== image && /size|orig/i.test(n)) ?? s.inputNames.find((n) => n !== image);
          return { s, ort, image, sizes, ep: s.remote ? ('engine' as const) : ep, url };
        } catch (e) {
          last = e;
        }
      }
    }
    throw last;
  })();
  session.catch(() => (session = null));
  return session;
}

/** One picture at a time: a session does not run two calls at once. */
let chain: Promise<unknown> = Promise.resolve();

async function runOnce(img: PixelData): Promise<Detection[]> {
  const L = await load();
  const S = DETECTOR_SIZE;
  const px = resizePixels(img, S, S);
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) input[c * S * S + i] = px[i * 4 + c] / 255;
  const feeds: Record<string, import('onnxruntime-web').Tensor> = { [L.image]: new L.ort.Tensor('float32', input, [1, 3, S, S]) };
  // The deploy form wants the size to give the boxes in: the model's own input size.
  if (L.sizes) feeds[L.sizes] = new L.ort.Tensor('int64', BigInt64Array.from([BigInt(S), BigInt(S)]), [1, 2]);
  const out = await L.s.run(feeds);
  const raw: RawTensor[] = L.s.outputNames.map((name) => ({ name, dims: out[name].dims, data: out[name].data as RawTensor['data'] }));
  const sx = img.width / S;
  const sy = img.height / S;
  return parseDetectorOutputs(raw, S).map((d) => ({ ...d, box: [d.box[0] * sx, d.box[1] * sy, d.box[2] * sx, d.box[3] * sy] }));
}

let cancelIdle: (() => void) | undefined;

export const textDetector: TextDetector = (img) => {
  cancelIdle?.();
  const queued = performance.now();
  let started = 0;
  const limitMs = session ? NETS_LIMIT_MS : NETS_LOAD_LIMIT_MS;
  // On the processor (after the card failed) it does not need the card's turn.
  const turn = <T>(fn: () => Promise<T>) => (gpuBroken ? withLimit(fn, NETS_LOAD_LIMIT_MS) : onGpu(GPU_NETS, fn, { limitMs }));
  const job = chain.then(() => turn(async () => {
    started = performance.now();
    try {
      return await runOnce(img);
    } catch (e) {
      // A model that loads on the video card but fails there (int8 operators): once more on the processor.
      const L = await session?.catch(() => null);
      if (L?.ep !== 'webgpu' && L?.ep !== 'engine') throw e;
      // …and the card is not tried again (a lost device fails every run after it).
      gpuBroken = true;
      await releaseDetector();
      await load('wasm');
      return runOnce(img);
    }
  }).catch((e: unknown) => {
    // The card stopped answering: that session is not used again, the next pictures go on the
    // processor (the pipeline goes on without the detector for this one).
    if (e instanceof GpuTimeout) abandon();
    throw e;
  }));
  chain = job.catch(() => undefined);
  void job.finally(() => {
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseDetector());
  }).catch(() => undefined);
  // Where the time goes (journal, ⓘ): waiting for the video card (Ollama on it) or computing, and where.
  return job.then(async (boxes) => {
    const ep = (await session?.catch(() => null))?.ep;
    return { boxes, waitMs: started ? started - queued : 0, runMs: started ? performance.now() - started : 0, ...(ep ? { ep } : {}) };
  });
};

/** After a run on the card stopped answering: on the processor from now on (until the extension restarts). */
let gpuBroken = false;

function abandon(): void {
  gpuBroken = true;
  const s = session;
  session = null;
  // Not awaited: the stuck session may never answer.
  void s?.then((L) => L.s.release()).catch(() => undefined);
}

/** Free the session (memory on the video card); the next picture loads it again. */
export async function releaseDetector(): Promise<void> {
  const s = session;
  session = null;
  const L = await s?.catch(() => null);
  await L?.s.release().catch(() => undefined);
}
