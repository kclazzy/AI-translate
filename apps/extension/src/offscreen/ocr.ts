import { readPiece, recDictionary, type OcrResult, type OcrRun, type PixelData } from '@ait/core';
import { GPU_NETS, GpuTimeout, NETS_LIMIT_MS, NETS_LOAD_LIMIT_MS, onGpu, releaseWhenIdle } from './gpuLane';
import { cached, fetchAll, loadOrt, MODELS_CACHE, OCR_DET_URL, OCR_REC_KO_URL, OCR_REC_URL, ORT_WASM_SHA256, ORT_WASM_SIZE, ORT_WASM_URL, removeModel } from './ortRuntime';

/**
 * Text recognition in the browser (no model that reads pictures, no Python): PaddleOCR PP-OCRv6
 * small (Apache-2.0) — one network finds the lines in a piece of the page, the other reads them.
 * Chinese, English, Japanese and Latin-script languages; Korean with its own reader (PP-OCRv5).
 * Downloaded once from RapidOCR's model hub (checked by SHA-256), or from this version's GitHub
 * release, and kept in the same cache as LaMa and the detector.
 */
interface ModelFile {
  url: string;
  sha256: string;
  size: number;
  /** The same file attached to the extension's own GitHub release (a second source). */
  mirror?: string;
}

const RELEASE = () => `https://github.com/kclazzy/AI-translate/releases/download/v${chrome.runtime.getManifest().version}`;

export const OCR_DET: ModelFile = { url: OCR_DET_URL, sha256: '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f', size: 9_929_594, mirror: 'PP-OCRv6_det_small.onnx' };
export const OCR_REC: ModelFile = { url: OCR_REC_URL, sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884', size: 21_234_383, mirror: 'PP-OCRv6_rec_small.onnx' };
export const OCR_REC_KO: ModelFile = { url: OCR_REC_KO_URL, sha256: 'cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b', size: 13_000_000 };
/** The Korean reader's alphabet, when the model does not carry it (PaddleOCR, Apache-2.0). */
const KO_DICT_URL = 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/dict/ppocrv5_korean_dict.txt';

export const OCR_URLS = [OCR_DET.url, OCR_REC.url, OCR_REC_KO.url];

const filesFor = (korean: boolean) => (korean ? [OCR_DET, OCR_REC_KO] : [OCR_DET, OCR_REC]);

async function sha256(buf: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function ocrDownloaded(korean = false): Promise<boolean> {
  for (const f of filesFor(korean)) if (!(await cached(f.url))) return false;
  return cached(ORT_WASM_URL);
}

/** Download the runtime (unless there) and the networks, checking every file; progress 0–1. */
export async function downloadOcr(progress: (share: number) => void, signal?: AbortSignal, korean = false): Promise<void> {
  const cache = await caches.open(MODELS_CACHE);
  const want: { url: string; sha256: string; size: number; mirror?: string }[] = [];
  if (!(await cache.match(ORT_WASM_URL))) want.push({ url: ORT_WASM_URL, sha256: ORT_WASM_SHA256, size: ORT_WASM_SIZE });
  for (const f of filesFor(korean)) if (!(await cache.match(f.url))) want.push(f);
  const total = want.reduce((n, f) => n + f.size, 0) || 1;
  let done = 0;
  for (const f of want) {
    const sources = [f.url, ...(f.mirror ? [`${RELEASE()}/${f.mirror}`] : [])];
    let ok: Blob | null = null;
    let last: unknown = null;
    for (const src of sources) {
      try {
        const blob = await fetchAll(src, (got) => progress(Math.min(0.99, (done + Math.min(got, f.size)) / total)), f.size, signal);
        if ((await sha256(await blob.arrayBuffer())) !== f.sha256) throw new Error('checksum');
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
let gpuBroken = false;

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
  const gpu = !gpuBroken && typeof navigator !== 'undefined' && 'gpu' in navigator;
  const make = async (bytes: Uint8Array) => {
    try {
      return await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] });
    } catch {
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }
  };
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

/** Read one piece of a page (a bubble or caption): its text in reading order. */
export function readText(px: PixelData, lang: string): Promise<OcrResult> {
  cancelIdle?.();
  const korean = lang.split('-')[0] === 'ko';
  const limitMs = session ? NETS_LIMIT_MS : NETS_LOAD_LIMIT_MS;
  const job = chain.then(() =>
    onGpu(
      GPU_NETS,
      async () => {
        const L = await load(korean);
        const run: OcrRun = async (net, t) => {
          const s = net === 'det' ? L.det : L.rec;
          const out = await s.run({ [s.inputNames[0]]: new L.ort.Tensor('float32', t.data, t.dims) });
          const o = out[s.outputNames[0]];
          return { data: o.data as Float32Array, dims: [...o.dims] };
        };
        return readPiece(px, run, L.dict);
      },
      { limitMs },
    ).catch((e: unknown) => {
      if (e instanceof GpuTimeout) {
        gpuBroken = true;
        void releaseOcr();
      }
      throw e;
    }),
  );
  chain = job.catch(() => undefined);
  void job.finally(() => {
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseOcr());
  }).catch(() => undefined);
  return job;
}
