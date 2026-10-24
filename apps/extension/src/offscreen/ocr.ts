import { mangaOcrRead, readPiece, readPieces, recDictionary, type MangaOcrRun, type OcrResult, type OcrRun, type PixelData } from '@ait/core';
import { releaseWhenIdle, withLimit } from './gpuLane';
import { cached, downloadChecked, loadOrt, MANGA_OCR, MANGA_OCR_URLS, MODELS_CACHE, OCR_DET_URL, OCR_REC_KO_URL, OCR_REC_URL, ORT_WASM_URL, removeModel, type ModelFile } from './ortRuntime';

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
}
let session: Promise<Loaded> | null = null;

function load(korean: boolean): Promise<Loaded> {
  if (session) {
    const s = session;
    session = s.then((L) => (L.korean === korean ? L : (releaseLoaded(L), open(korean))));
  } else session = open(korean);
  session.catch(() => (session = null));
  return session;
}

async function open(korean: boolean): Promise<Loaded> {
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
  // On the processor: the pieces of a page all have other sizes, and on the video card every new size
  // compiles the network's shaders again (seconds per piece); these small networks are fast here, and
  // the card stays free for the detector, LaMa and the model.
  const make = (bytes: Uint8Array) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  return { ort, det: await make(new Uint8Array(await detHit.arrayBuffer())), rec: await make(recBytes), dict, korean };
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

/** Read one piece of a page (a bubble or caption): its text in reading order. */
export async function readText(px: PixelData, lang: string): Promise<OcrResult> {
  // Japanese: Manga OCR reads the whole bubble (vertical columns, furigana), when it is downloaded.
  if (lang.split('-')[0] === 'ja' && (await mangaOcrDownloaded())) return readManga(px);
  return (await readLines([px], lang, false))[0];
}

/** Every piece of a page at once: the lines of all of them read together (see readPieces). */
readText.all = async (pieces: PixelData[], lang: string): Promise<OcrResult[]> => {
  if (lang.split('-')[0] === 'ja' && (await mangaOcrDownloaded())) {
    const out: OcrResult[] = [];
    for (const px of pieces) out.push(await readManga(px));
    return out;
  }
  return readLines(pieces, lang, true);
};

function readLines(pieces: PixelData[], lang: string, batch: boolean): Promise<OcrResult[]> {
  cancelIdle?.();
  const korean = lang.split('-')[0] === 'ko';
  const limitMs = (session ? 0 : LOAD_MS) + PIECE_MS * Math.max(1, pieces.length);
  const job = chain.then(() =>
    withLimit(async () => {
      const L = await load(korean);
      const run: OcrRun = async (net, t) => {
        const s = net === 'det' ? L.det : L.rec;
        const out = await s.run({ [s.inputNames[0]]: new L.ort.Tensor('float32', t.data, t.dims) });
        const o = out[s.outputNames[0]];
        return { data: o.data as Float32Array, dims: [...o.dims] };
      };
      return batch ? readPieces(pieces, run, L.dict) : [await readPiece(pieces[0], run, L.dict)];
    }, limitMs),
  );
  chain = job.catch(() => undefined);
  void job.finally(() => {
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseOcr());
  }).catch(() => undefined);
  return job;
}

// ---- Manga OCR (Japanese) -----------------------------------------------------------------------

export async function mangaOcrDownloaded(): Promise<boolean> {
  for (const u of MANGA_OCR_URLS) if (!(await cached(u))) return false;
  return cached(ORT_WASM_URL);
}

export async function downloadMangaOcr(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadChecked([MANGA_OCR.encoder, MANGA_OCR.decoder, MANGA_OCR.vocab], progress, signal);
}

export async function deleteMangaOcr(): Promise<void> {
  await releaseManga();
  await removeModel(MANGA_OCR_URLS);
}

interface MangaLoaded {
  ort: Awaited<ReturnType<typeof loadOrt>>;
  enc: Session;
  dec: Session;
  vocab: string[];
}
let manga: Promise<MangaLoaded> | null = null;
let mangaChain: Promise<unknown> = Promise.resolve();
let mangaIdle: (() => void) | undefined;

async function openManga(): Promise<MangaLoaded> {
  const ort = await loadOrt();
  const cache = await caches.open(MODELS_CACHE);
  const [e, d, v] = await Promise.all([MANGA_OCR.encoder, MANGA_OCR.decoder, MANGA_OCR.vocab].map((f) => cache.match(f.url)));
  if (!e || !d || !v) throw new Error('Manga OCR is not downloaded');
  // int8 weights: on the processor (the video card stays with the model and the detector).
  const make = async (r: Response) => ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
  return { ort, enc: await make(e), dec: await make(d), vocab: (await v.text()).split(/\r?\n/) };
}

export async function releaseManga(): Promise<void> {
  const s = manga;
  manga = null;
  const L = await s?.catch(() => null);
  void L?.enc.release().catch(() => undefined);
  void L?.dec.release().catch(() => undefined);
}

/** One bubble at a time; on the processor, with a time limit (a decoder that never ends). */
export const MANGA_LIMIT_MS = 30_000;

function readManga(px: PixelData): Promise<OcrResult> {
  mangaIdle?.();
  const job = mangaChain.then(() =>
    withLimit(async () => {
      manga ??= openManga();
      manga.catch(() => (manga = null));
      const L = await manga;
      const run: MangaOcrRun = async (net, inputs) => {
        const s = net === 'encoder' ? L.enc : L.dec;
        const feeds: Record<string, import('onnxruntime-web').Tensor> = {};
        for (const [k, t] of Object.entries(inputs)) feeds[k] = t.data instanceof BigInt64Array ? new L.ort.Tensor('int64', t.data, t.dims) : new L.ort.Tensor('float32', t.data, t.dims);
        const out = await s.run(feeds);
        const o = out[net === 'decoder' && out.logits ? 'logits' : s.outputNames[0]];
        return { data: o.data as Float32Array, dims: [...o.dims] };
      };
      return mangaOcrRead(px, run, L.vocab);
    }, MANGA_LIMIT_MS),
  );
  mangaChain = job.catch(() => undefined);
  void job.finally(() => {
    mangaIdle?.();
    mangaIdle = releaseWhenIdle(() => void releaseManga());
  }).catch(() => undefined);
  return job;
}
