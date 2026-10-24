import { GPU_SHAPES, isBrowserTranslator, isLocalProvider, mangaOcrRead, mangaOcrReadCached, type MangaOcrNets, readPiece, readPieces, recDictionary, type MangaOcrRun, type OcrResult, type OcrRun, type PixelData, type AppSettings } from '@ait/core';
import { releaseWhenIdle, withLimit } from './gpuLane';
import { cached, downloadChecked, gpuF16, loadOrt, MANGA_FAST, MANGA_OCR, MANGA_OCR_URLS, MODELS_CACHE, OCR_DET_URL, OCR_REC_KO_URL, OCR_REC_URL, ORT_WASM_URL, removeModel, type ModelFile } from './ortRuntime';

/**
 * Text recognition in the browser (no model that reads pictures, no Python): PaddleOCR PP-OCRv6
 * small (Apache-2.0) — one network finds the lines in a piece of the page, the other reads them.
 * Chinese, English, Japanese and Latin-script languages; Korean with its own reader (PP-OCRv5).
 * Downloaded once from RapidOCR's model hub (checked by SHA-256), or from this version's GitHub
 * release, and kept in the same cache as LaMa and the detector.
 */
const RELEASE = () => `https://github.com/kclazzy/AI-translate/releases/download/v${typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : '0'}`;

export const OCR_DET: ModelFile = { url: OCR_DET_URL, sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f', size: 9_929_594, mirror: `${RELEASE()}/PP-OCRv6_det_small.onnx` };
export const OCR_REC: ModelFile = { url: OCR_REC_URL, sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884', size: 21_234_383, mirror: `${RELEASE()}/PP-OCRv6_rec_small.onnx` };
export const OCR_REC_KO: ModelFile = { url: OCR_REC_KO_URL, sha256: 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b', size: 13_000_000 };
/** The Korean reader's alphabet, when the model does not carry it (PaddleOCR, Apache-2.0). */
const KO_DICT_URL = 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_korean_dict.txt';

export const OCR_URLS = [OCR_DET.url, OCR_REC.url, OCR_REC_KO.url];

const filesFor = (korean: boolean) => (korean ? [OCR_DET, OCR_REC_KO] : [OCR_DET, OCR_REC]);

export async function ocrDownloaded(korean = false): Promise<boolean> {
  for (const f of filesFor(korean)) if (!(await cached(f.url))) return false;
  return cached(ORT_WASM_URL);
}

/** Download the runtime (unless there) and the networks, checking every file; progress 0–1. */
export async function downloadOcr(progress: (share: number) => void, signal?: AbortSignal, korean = false): Promise<void> {
  await downloadChecked(filesFor(korean), progress, signal);
}

export async function deleteOcr(): Promise<void> {
  await releaseOcr();
  await removeModel(OCR_URLS);
}

type Session = import('onnxruntime-web').InferenceSession;
interface Loaded {
  ort: Awaited<ReturnType<typeof loadOrt>>;
  det: Session;
  rec: Session;
  dict: string[];
  korean: boolean;
  gpu: boolean;
}
let session: Promise<Loaded> | null = null;

/**
 * Where recognition runs: on the video card (WebGPU, in a few fixed sizes — each compiled once) or
 * on the processor. Chosen by the translation settings (see handler: the card when the model that
 * translates does not need it, or has room beside it); a failure on the card moves it to the
 * processor until the extension restarts.
 */
let device: 'gpu' | 'cpu' = 'cpu';
let gpuBroken = false;
export function setOcrDevice(d: 'gpu' | 'cpu'): void {
  if (d === device) return;
  device = d;
  // Made again on the other device with the next piece.
  void releaseOcr();
  void releaseManga();
}
/**
 * The card for recognition unless a model on this computer translates and the card is small (it
 * needs all the video memory then; recognition on the processor also runs beside the model).
 */
export function ocrDeviceFor(s: AppSettings): 'gpu' | 'cpu' {
  if (s.pipeline === 'engine') return 'cpu';
  const by = s.providers.find((p) => p.id === (s.readMode === 'ocr' ? s.visionProviderId : s.fallbackProviderId)) ?? null;
  const local = !!by && !isBrowserTranslator(by) && isLocalProvider(by);
  return !local || (s.gpuVramGb ?? 12) >= 10 ? 'gpu' : 'cpu';
}
export const ocrOnGpu = (): boolean => device === 'gpu' && !gpuBroken && typeof navigator !== 'undefined' && 'gpu' in navigator;

function load(korean: boolean): Promise<Loaded> {
  const gpu = ocrOnGpu();
  if (session) {
    const s = session;
    session = s.then((L) => (L.korean === korean && L.gpu === gpu ? L : (releaseLoaded(L), open(korean, gpu))));
  } else session = open(korean, gpu);
  session.catch(() => (session = null));
  return session;
}

async function open(korean: boolean, gpu: boolean): Promise<Loaded> {
  const ort = await loadOrt();
  const cache = await caches.open(MODELS_CACHE);
  const [detF, recF] = filesFor(korean);
  const detHit = await cache.match(detF.url);
  const recHit = await cache.match(recF.url);
  if (!detHit || !recHit) throw new Error('The text recognition models are not downloaded');
  const recBytes = new Uint8Array(await recHit.arrayBuffer());
  let dict = recDictionary(recBytes);
  if (!dict && korean) dict = (await (await fetch(KO_DICT_URL)).text()).split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1);
  if (!dict) throw new Error('The recogniser has no alphabet');
  // On the video card the pieces go in fixed sizes (GPU_SHAPES): every new size would compile the
  // network's shaders again. On the processor the sizes are free.
  const make = (bytes: Uint8Array) => ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] });
  return { ort, det: await make(new Uint8Array(await detHit.arrayBuffer())), rec: await make(recBytes), dict, korean, gpu };
}

function releaseLoaded(L: Loaded) {
  void L.det.release().catch(() => undefined);
  void L.rec.release().catch(() => undefined);
}

export async function releaseOcr(): Promise<void> {
  const s = session;
  session = null;
  const L = await s?.catch(() => null);
  if (L) releaseLoaded(L);
}

let chain: Promise<unknown> = Promise.resolve();
let cancelIdle: (() => void) | undefined;

/** Time for one piece (and a little more for loading the networks the first time). */
const PIECE_MS = 8_000;
const LOAD_MS = 30_000;
/** The first runs on the card compile the networks for each fixed size. */
const COMPILE_MS = 30_000;
let compiled = false;

/** Read one piece of a page (a bubble or caption): its text in reading order. */
export async function readText(px: PixelData, lang: string): Promise<OcrResult> {
  // Japanese: Manga OCR reads the whole bubble (vertical columns, furigana), when it is downloaded.
  if (lang.split('-')[0] === 'ja' && (await mangaUsable())) return readManga(px);
  return (await readLines([px], lang, false))[0];
}

/** Every piece of a page at once: the lines of all of them read together (see readPieces). */
readText.all = async (pieces: PixelData[], lang: string): Promise<OcrResult[]> => {
  if (lang.split('-')[0] === 'ja' && (await mangaUsable())) {
    const out: OcrResult[] = [];
    for (const px of pieces) out.push(await readManga(px));
    return out;
  }
  return readLines(pieces, lang, true);
};

/** Where the last pieces were read (shown with the page's times). */
let lastEp: 'webgpu' | 'wasm' = 'wasm';
readText.ep = () => lastEp;

function readLines(pieces: PixelData[], lang: string, batch: boolean): Promise<OcrResult[]> {
  cancelIdle?.();
  const korean = lang.split('-')[0] === 'ko';
  const read = async (): Promise<OcrResult[]> => {
    const L = await load(korean);
    const run: OcrRun = async (net, t) => {
      const s = net === 'det' ? L.det : L.rec;
      const out = await s.run({ [s.inputNames[0]]: new L.ort.Tensor('float32', t.data, t.dims) });
      const o = out[s.outputNames[0]];
      return { data: o.data as Float32Array, dims: [...o.dims] };
    };
    const opts = L.gpu ? { shapes: GPU_SHAPES } : {};
    const out = batch ? await readPieces(pieces, run, L.dict, opts) : [await readPiece(pieces[0], run, L.dict, opts)];
    if (L.gpu) compiled = true;
    lastEp = L.gpu ? 'webgpu' : 'wasm';
    return out;
  };
  const limit = () => (session ? 0 : LOAD_MS) + (ocrOnGpu() && !compiled ? COMPILE_MS : 0) + PIECE_MS * Math.max(1, pieces.length);
  const job = chain.then(async () => {
    const gpu = ocrOnGpu();
    try {
      return await withLimit(read, limit());
    } catch (e) {
      if (!gpu || (e as Error)?.name === 'AbortError') throw e;
      // The card failed (or stopped answering): the processor from now on, this piece again there.
      gpuBroken = true;
      await releaseOcr();
      return withLimit(read, limit());
    }
  });
  chain = job.catch(() => undefined);
  void job.finally(() => {
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseOcr());
  }).catch(() => undefined);
  return job;
}

// ---- Manga OCR (Japanese) -----------------------------------------------------------------------

/**
 * Manga OCR's files: the int8 encoder and the alphabet, the decoder that reads with a cache
 * (cross + step, models-3) and — where the video card runs fp16 — the encoder for the card.
 * Copies from before 1.1.32 (the decoder without a cache) keep reading until the new files are in.
 */
async function mangaFiles(): Promise<ModelFile[]> {
  return [MANGA_OCR.encoder, MANGA_OCR.vocab, MANGA_FAST.cross, MANGA_FAST.step, ...((await gpuF16()) ? [MANGA_FAST.encoderGpu] : [])];
}

/** Everything for the fastest reading here is downloaded (what the setup looks at). */
export async function mangaOcrDownloaded(): Promise<boolean> {
  for (const f of await mangaFiles()) if (!(await cached(f.url))) return false;
  return cached(ORT_WASM_URL);
}

/** Manga OCR can read (the files of this version or of an earlier one). */
async function mangaUsable(): Promise<boolean> {
  if (!(await cached(MANGA_OCR.encoder.url)) || !(await cached(MANGA_OCR.vocab.url)) || !(await cached(ORT_WASM_URL))) return false;
  return ((await cached(MANGA_FAST.cross.url)) && (await cached(MANGA_FAST.step.url))) || cached(MANGA_OCR.decoder.url);
}

/** Megabytes still to download for Manga OCR. */
export async function mangaOcrMb(): Promise<number> {
  let n = 0;
  for (const f of await mangaFiles()) if (!(await cached(f.url))) n += f.size;
  return Math.round(n / 1_000_000);
}

export async function downloadMangaOcr(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadChecked(await mangaFiles(), progress, signal);
  // The decoder without a cache is not needed any more.
  if ((await cached(MANGA_FAST.step.url)) && (await cached(MANGA_FAST.cross.url))) {
    await releaseManga();
    await (await caches.open(MODELS_CACHE)).delete(MANGA_OCR.decoder.url);
  }
}

export async function deleteMangaOcr(): Promise<void> {
  await releaseManga();
  await removeModel(MANGA_OCR_URLS);
}

interface MangaLoaded {
  ort: Awaited<ReturnType<typeof loadOrt>>;
  enc: Session;
  /** The encoder runs on the video card. */
  encGpu: boolean;
  /** The decoder with a cache (models-3), or the one without (older copies). */
  cross?: Session;
  step?: Session;
  dec?: Session;
  vocab: string[];
}
let manga: Promise<MangaLoaded> | null = null;
let mangaChain: Promise<unknown> = Promise.resolve();
let mangaIdle: (() => void) | undefined;
let mangaGpuBroken = false;

async function openManga(): Promise<MangaLoaded> {
  const ort = await loadOrt();
  const cache = await caches.open(MODELS_CACHE);
  const get = (f: ModelFile) => cache.match(f.url);
  const [v, cross, step] = await Promise.all([get(MANGA_OCR.vocab), get(MANGA_FAST.cross), get(MANGA_FAST.step)]);
  if (!v) throw new Error('Manga OCR is not downloaded');
  const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());
  const cpu = async (r: Response) => ort.InferenceSession.create(await bytes(r), { executionProviders: ['wasm'] });
  // The encoder (most of the time of a bubble) on the video card when it runs fp16 networks;
  // the decoder's small steps on the processor.
  let enc: Session | null = null;
  let encGpu = false;
  const gpuEnc = ocrOnGpu() && !mangaGpuBroken && (await gpuF16()) ? await get(MANGA_FAST.encoderGpu) : undefined;
  if (gpuEnc) {
    try {
      enc = await ort.InferenceSession.create(await bytes(gpuEnc), { executionProviders: ['webgpu'] });
      encGpu = true;
    } catch {
      mangaGpuBroken = true;
    }
  }
  if (!enc) {
    const e = await get(MANGA_OCR.encoder);
    if (!e) throw new Error('Manga OCR is not downloaded');
    enc = await cpu(e);
  }
  const vocab = (await v.text()).split(/\r?\n/);
  if (cross && step) return { ort, enc, encGpu, cross: await cpu(cross), step: await cpu(step), vocab };
  const d = await get(MANGA_OCR.decoder);
  if (!d) throw new Error('Manga OCR is not downloaded');
  return { ort, enc, encGpu, dec: await cpu(d), vocab };
}

export async function releaseManga(): Promise<void> {
  const s = manga;
  manga = null;
  const L = await s?.catch(() => null);
  for (const x of [L?.enc, L?.cross, L?.step, L?.dec]) void x?.release().catch(() => undefined);
}

/** One bubble at a time, with a time limit (a decoder that never ends). */
export const MANGA_LIMIT_MS = 30_000;

const tensorOf = (o: import('onnxruntime-web').Tensor) => ({ data: o.data as Float32Array, dims: [...o.dims] });

async function readMangaOnce(px: PixelData): Promise<OcrResult> {
  manga ??= openManga();
  manga.catch(() => (manga = null));
  const L = await manga;
  const T = L.ort.Tensor;
  const f32 = (t: { data: Float32Array; dims: number[] }) => new T('float32', t.data, t.dims);
  lastEp = L.encGpu ? 'webgpu' : 'wasm';
  if (L.cross && L.step) {
    const { cross, step, enc } = L;
    const nets: MangaOcrNets = {
      encode: async (input) => tensorOf((await enc.run({ [enc.inputNames[0]]: f32(input) }))[enc.outputNames[0]]),
      cross: async (hidden) => {
        const o = await cross.run({ encoder_hidden_states: f32(hidden) });
        return ['ck0', 'cv0', 'ck1', 'cv1'].map((k) => tensorOf(o[k]));
      },
      step: async ({ id, pos, mask, past, cross: ck }) => {
        const feeds: Record<string, import('onnxruntime-web').Tensor> = {
          input_ids: new T('int64', BigInt64Array.from([BigInt(id)]), [1, 1]),
          position_ids: new T('int64', BigInt64Array.from([BigInt(pos)]), [1, 1]),
          attention_mask: new T('int64', mask, [1, mask.length]),
        };
        ['k0', 'v0', 'k1', 'v1'].forEach((k, i) => (feeds[k] = f32(past[i])));
        ['ck0', 'cv0', 'ck1', 'cv1'].forEach((k, i) => (feeds[k] = f32(ck[i])));
        const o = await step.run(feeds);
        return { logits: tensorOf(o.logits), present: ['present_k0', 'present_v0', 'present_k1', 'present_v1'].map((k) => tensorOf(o[k])) };
      },
    };
    return mangaOcrReadCached(px, nets, L.vocab);
  }
  const run: MangaOcrRun = async (net, inputs) => {
    const s = net === 'encoder' ? L.enc : L.dec!;
    const feeds: Record<string, import('onnxruntime-web').Tensor> = {};
    for (const [k, t] of Object.entries(inputs)) feeds[k] = t.data instanceof BigInt64Array ? new T('int64', t.data, t.dims) : new T('float32', t.data, t.dims);
    const out = await s.run(feeds);
    const o = out[net === 'decoder' && out.logits ? 'logits' : s.outputNames[0]];
    return { data: o.data as Float32Array, dims: [...o.dims] };
  };
  return mangaOcrRead(px, run, L.vocab);
}

function readManga(px: PixelData): Promise<OcrResult> {
  mangaIdle?.();
  const job = mangaChain.then(async () => {
    const loaded = await manga?.catch(() => null);
    try {
      return await withLimit(() => readMangaOnce(px), MANGA_LIMIT_MS + (loaded ? 0 : COMPILE_MS));
    } catch (e) {
      const L = await manga?.catch(() => null);
      if (!L?.encGpu || (e as Error)?.name === 'AbortError') throw e;
      // The card failed: the encoder on the processor from now on, this bubble again there.
      mangaGpuBroken = true;
      await releaseManga();
      return withLimit(() => readMangaOnce(px), MANGA_LIMIT_MS);
    }
  });
  mangaChain = job.catch(() => undefined);
  void job.finally(() => {
    mangaIdle?.();
    mangaIdle = releaseWhenIdle(() => void releaseManga());
  }).catch(() => undefined);
  return job;
}
