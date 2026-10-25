/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppError, toAppError, type SerializedError } from '../errors';
import { releaseCanvas, type ImageBackend, type PixelData } from '../image/backend';
import { TiledImage } from '../image/tiled';
import { setUiLang, uiLangPref, type UiLangPref } from '../i18n';
import { browserTranslateSupported, setBrowserTranslate, translateWithBrowser } from '../llm/browserTranslator';
import { activeCatalog, setCatalog } from '../llm/catalog';
import type { ModelCatalog } from '../llm/catalog';
import type { FetchLike } from '../llm/types';
import type { TextDetector } from './detect';
import { forgetRemembered } from './memo';
import { runPipeline } from './run';
import type { Inpainter, PipelineOutput, PipelineRequest, PreparedPage, StandaloneDeps, TextReader } from './standalone';

/**
 * The page pipeline in background threads (Web Workers): the pixel work of a page — decoding, the
 * text check, cleaning, the collage for the model, the views' JPEGs — runs on its own processor
 * core, so two pages in work clean at once instead of in turn, and the document that holds the
 * queue stays free. What has to stay where it is goes through messages: the model requests (the
 * video card's lane, the keys), the detector, the recognition and LaMa (their sessions on the
 * video card), the browser's translator, the series context and the stage events. Typesetting
 * stays in the caller too (its fonts). The pictures come back as pixels.
 *
 * Any trouble with the threads themselves (none can start, one is lost) and the page runs in the
 * calling document as before.
 */

/** A worker or the inside of one, as far as these messages go. */
export interface PagePort {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, fn: (e: any) => void): void;
  start?: () => void;
}

/** A worker as the pool sees it. */
export interface PageWorker extends PagePort {
  terminate(): void;
}

type Kind = 'detect' | 'ocr' | 'inpaint';

interface WireImage {
  width: number;
  height: number;
  tiles: { y: number; h: number; px: Uint8ClampedArray }[];
}

type WireError = { app: SerializedError } | { name: string; message: string };

interface RunMsg {
  t: 'run';
  id: number;
  req: Omit<PipelineRequest, 'signal' | 'onStage' | 'freshContext' | 'prepared'> & { batchReview?: boolean; prepared?: Omit<PreparedPage, 'original'> };
  fns: Partial<Record<Kind, number>> & { ocrAll?: boolean; fresh?: boolean; stage?: boolean };
  ep?: 'webgpu' | 'wasm' | 'engine';
  lang: UiLangPref;
  catalog: ModelCatalog | null;
  browser: boolean;
}

type ToWorker =
  | RunMsg
  | { t: 'abort'; id: number }
  | { t: 'ret'; cid: number; ok: true; value: unknown; ep?: 'webgpu' | 'wasm' | 'engine' }
  | { t: 'ret'; cid: number; ok: false; error: WireError }
  | { t: 'forget' };

type Call =
  | { fn: 'fetch'; run: number; url: string; init: WireInit }
  | { fn: 'fresh'; run: number }
  | { fn: 'detect'; ref: number; img: PixelData }
  | { fn: 'ocr'; ref: number; px: PixelData; lang: string }
  | { fn: 'ocrAll'; ref: number; pieces: PixelData[]; lang: string }
  | { fn: 'inpaint'; ref: number; img: PixelData; mask: Uint8Array }
  | { fn: 'browser'; texts: string[]; from: string; to: string };

type FromWorker =
  | { t: 'ready' }
  | ({ t: 'call'; cid: number } & Call)
  | { t: 'cancel'; cid: number }
  | { t: 'stage'; id: number; e: Parameters<NonNullable<PipelineRequest['onStage']>>[0] }
  | { t: 'done'; id: number; ok: true; out: WireOutput }
  | { t: 'done'; id: number; ok: false; error: WireError };

interface WireOutput extends Omit<PipelineOutput, 'original' | 'cleaned'> {
  reviewLater?: boolean | 'now';
  original: WireImage;
  /** The same picture as the original (nothing was cleaned). */
  cleaned: WireImage | 'same';
}

interface WireInit {
  method?: string;
  headers: [string, string][];
  body?: string | ArrayBuffer | Blob;
}

interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ArrayBuffer;
}

export type RemoteOutput = PipelineOutput & { reviewLater?: boolean | 'now' };

function wireError(e: unknown): WireError {
  const err = e as { code?: unknown; retryable?: unknown; name?: string; message?: string };
  if (e instanceof AppError || (err && typeof err.code === 'string' && 'retryable' in err)) return { app: toAppError(e).toJSON() };
  if (e instanceof Error || (err && typeof err.name === 'string')) return { name: err.name ?? 'Error', message: err.message ?? String(e) };
  return { name: 'Error', message: String(e) };
}

function fromWire(w: WireError): Error {
  if ('app' in w) return toAppError(w.app);
  const e = new Error(w.message);
  e.name = w.name;
  return e;
}

/** A picture as pixels, tile by tile; each tile's canvas goes as soon as it is read (`release`). */
function packImage(img: TiledImage, transfer: Transferable[], release: boolean): WireImage {
  const tiles = img.tiles.map((t) => {
    const px = t.canvas.getContext('2d').getImageData(0, 0, img.width, t.h).data as Uint8ClampedArray;
    if (release) releaseCanvas(t.canvas);
    transfer.push(px.buffer);
    return { y: t.y, h: t.h, px };
  });
  return { width: img.width, height: img.height, tiles };
}

function unpackImage(backend: ImageBackend, w: WireImage): TiledImage {
  const tiles = w.tiles.map((t) => {
    const canvas = backend.createCanvas(w.width, t.h);
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(w.width, t.h);
    data.data.set(t.px);
    ctx.putImageData(data, 0, 0);
    return { y: t.y, h: t.h, canvas };
  });
  return new TiledImage(backend, w.width, w.height, tiles);
}

async function wireInit(init?: RequestInit): Promise<WireInit> {
  const headers: [string, string][] = [...new Headers(init?.headers ?? {}).entries()];
  let body: WireInit['body'];
  const b = init?.body;
  if (b == null) body = undefined;
  else if (typeof b === 'string' || b instanceof Blob || b instanceof ArrayBuffer) body = b;
  else if (ArrayBuffer.isView(b)) body = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  else {
    // A form or search parameters: as the bytes they make, with the type they make (the boundary).
    const r = new Response(b as BodyInit);
    body = await r.arrayBuffer();
    const type = r.headers.get('content-type');
    if (type && !headers.some(([k]) => k.toLowerCase() === 'content-type')) headers.push(['content-type', type]);
  }
  return { method: init?.method, headers, body };
}

const NULL_BODY = new Set([101, 204, 205, 304]);

// ---------------------------------------------------------------------------------------------
// Inside the worker.
// ---------------------------------------------------------------------------------------------

/** Answer the pool's pages in this worker (its entry point calls this once). */
export function servePages(port: PagePort, backend: ImageBackend): void {
  let nextCid = 1;
  const calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const runs = new Map<number, AbortController>();
  /** Stable stand-ins for the caller's detector / reader / LaMa (the memo keys on them). */
  const proxies = new Map<Kind, { ref: number; fn: any }>();
  let ep: 'webgpu' | 'wasm' | 'engine' | undefined;
  let browser: boolean | null = null;

  const call = <T>(c: Call, signal?: AbortSignal, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(new AppError('CANCELLED'));
      const cid = nextCid++;
      calls.set(cid, { resolve, reject });
      signal?.addEventListener('abort', () => {
        if (!calls.has(cid)) return;
        calls.delete(cid);
        port.postMessage({ t: 'cancel', cid } satisfies FromWorker);
        reject(new AppError('CANCELLED'));
      }, { once: true });
      port.postMessage({ t: 'call', cid, ...c } satisfies FromWorker, transfer);
    });

  const proxy = (kind: Kind, ref: number, all: boolean): any => {
    const had = proxies.get(kind);
    if (had?.ref === ref && (kind !== 'ocr' || !!had.fn.all === all)) return had.fn;
    let fn: any;
    if (kind === 'detect') fn = ((img, signal) => call({ fn: 'detect', ref, img }, signal)) satisfies TextDetector;
    else if (kind === 'inpaint') fn = ((img, mask, signal) => call({ fn: 'inpaint', ref, img, mask }, signal)) satisfies Inpainter;
    else {
      const reader = ((px: PixelData, lang: string) => call({ fn: 'ocr', ref, px, lang })) as TextReader;
      if (all) reader.all = (pieces, lang) => call({ fn: 'ocrAll', ref, pieces, lang });
      reader.ep = () => ep as 'webgpu' | 'wasm' | 'engine';
      fn = reader;
    }
    proxies.set(kind, { ref, fn });
    return fn;
  };

  const run = async (m: RunMsg): Promise<void> => {
    const ctrl = new AbortController();
    runs.set(m.id, ctrl);
    try {
      setUiLang(m.lang, false);
      setCatalog(m.catalog);
      if (browser !== m.browser) {
        browser = m.browser;
        setBrowserTranslate(m.browser ? (texts, from, to, signal) => call<string[]>({ fn: 'browser', texts, from, to }, signal) : null, m.browser);
      }
      ep = m.ep ?? ep;
      const fetchImpl: FetchLike = async (url, init) => {
        const res = await call<WireResponse>({ fn: 'fetch', run: m.id, url, init: await wireInit(init) }, init?.signal ?? undefined);
        return new Response(NULL_BODY.has(res.status) ? null : res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
      };
      const deps: StandaloneDeps = {
        backend,
        fetchImpl,
        ...(m.fns.detect ? { detect: proxy('detect', m.fns.detect, false) } : {}),
        ...(m.fns.ocr ? { ocr: proxy('ocr', m.fns.ocr, !!m.fns.ocrAll) } : {}),
        ...(m.fns.inpaint ? { inpaint: proxy('inpaint', m.fns.inpaint, false) } : {}),
      };
      let prepared: PreparedPage | undefined;
      if (m.req.prepared) {
        // The picture itself is decoded again here (quick): the rest of what was done ahead comes along.
        const original = await TiledImage.fromBytes(backend, m.req.bytes, m.req.mime);
        prepared = { ...m.req.prepared, original };
      }
      const out = await runPipeline(
        {
          ...m.req,
          prepared,
          signal: ctrl.signal,
          ...(m.fns.stage ? { onStage: (e) => port.postMessage({ t: 'stage', id: m.id, e } satisfies FromWorker) } : {}),
          ...(m.fns.fresh ? { freshContext: () => call({ fn: 'fresh', run: m.id }, ctrl.signal) } : {}),
        },
        deps,
      );
      const transfer: Transferable[] = [];
      const same = out.cleaned === out.original;
      const cleaned = same ? ('same' as const) : packImage(out.cleaned, transfer, true);
      const original = packImage(out.original, transfer, true);
      const { original: _o, cleaned: _c, ...rest } = out;
      rest.page = { ...rest.page, timings: { ...rest.page.timings, inWorker: true } };
      const msg = { t: 'done', id: m.id, ok: true, out: { ...rest, original, cleaned } } satisfies FromWorker;
      try {
        port.postMessage(msg, transfer);
      } catch {
        // Pixels that cannot be handed over (a canvas library's own memory): copied instead.
        port.postMessage(msg);
      }
    } catch (e) {
      port.postMessage({ t: 'done', id: m.id, ok: false, error: wireError(e) } satisfies FromWorker);
    } finally {
      runs.delete(m.id);
    }
  };

  port.addEventListener('message', (ev: MessageEvent<ToWorker>) => {
    const m = ev.data;
    if (m.t === 'run') void run(m);
    else if (m.t === 'abort') runs.get(m.id)?.abort();
    else if (m.t === 'forget') forgetRemembered();
    else if (m.t === 'ret') {
      const c = calls.get(m.cid);
      if (!c) return;
      calls.delete(m.cid);
      if (m.ok) {
        if (m.ep) ep = m.ep;
        c.resolve(m.value);
      } else c.reject(fromWire(m.error));
    }
  });
  port.start?.();
  port.postMessage({ t: 'ready' } satisfies FromWorker);
}

// ---------------------------------------------------------------------------------------------
// The calling side.
// ---------------------------------------------------------------------------------------------

/** Trouble with the threads themselves (not with the page): the page runs here instead. */
class WorkerLost extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'WorkerLost';
  }
}

interface Slot {
  w: PageWorker;
  ready: Promise<void>;
  runs: Map<number, { req: PipelineRequest; deps: StandaloneDeps; resolve: (o: RemoteOutput) => void; reject: (e: Error) => void }>;
  calls: Map<number, AbortController>;
  idle?: ReturnType<typeof setTimeout>;
  dead?: boolean;
}

/** How long a new worker may take to start before the pool gives up on threads. */
const READY_MS = 15_000;
/** A worker with nothing to do for this long is closed (its memory goes back). */
const IDLE_MS = 60_000;

/**
 * A few workers for pages (see servePages). `run` gives a page to the least busy one (a new one
 * while there are fewer than `size`); without workers — none could start — pages run here.
 */
export class PageWorkers {
  private slots: Slot[] = [];
  private nextId = 1;
  private refs = new Map<Kind, { fn: unknown; ref: number }>();
  private nextRef = 1;
  /** The threads did not work in this browser: every page runs here from now on. */
  broken = false;

  constructor(private readonly make: () => PageWorker, public size: number, private readonly backend: ImageBackend, private readonly idleMs = IDLE_MS) {}

  /** Pages in work in the workers now. */
  get busy(): number {
    return this.slots.reduce((n, s) => n + s.runs.size, 0);
  }

  async run(req: PipelineRequest & { batchReview?: boolean }, deps: StandaloneDeps): Promise<RemoteOutput> {
    if (!this.broken && req.config.mode !== 'engine') {
      try {
        return await this.runRemote(req, deps);
      } catch (e) {
        if (!(e instanceof WorkerLost)) throw e;
        if (req.signal?.aborted) throw new AppError('CANCELLED');
      }
    }
    return runPipeline(req, deps);
  }

  /** Forget the detector's and the recognition's results kept in the workers too. */
  forget(): void {
    for (const s of this.slots) s.w.postMessage({ t: 'forget' } satisfies ToWorker);
  }

  /** Close every worker (pages in work run here instead). */
  close(): void {
    for (const s of [...this.slots]) this.lose(s, 'closed', false);
  }

  private ref(kind: Kind, fn: unknown): number | undefined {
    if (!fn) return undefined;
    const had = this.refs.get(kind);
    if (had?.fn === fn) return had.ref;
    const ref = this.nextRef++;
    this.refs.set(kind, { fn, ref });
    return ref;
  }

  private fnOf(kind: Kind, ref: number): any {
    const had = this.refs.get(kind);
    if (had?.ref !== ref) throw new AppError('CANCELLED', { detail: `${kind} was replaced` });
    return had.fn;
  }

  private pick(): Slot {
    const live = this.slots.filter((s) => !s.dead);
    const free = live.find((s) => !s.runs.size);
    if (free) return free;
    if (live.length < this.size) return this.spawn();
    return live.reduce((a, b) => (b.runs.size < a.runs.size ? b : a));
  }

  private spawn(): Slot {
    let w: PageWorker;
    try {
      w = this.make();
    } catch (e) {
      this.broken = true;
      throw new WorkerLost(`cannot start: ${(e as Error)?.message ?? e}`);
    }
    let started = false;
    const slot: Slot = { w, runs: new Map(), calls: new Map(), ready: Promise.resolve() };
    slot.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new WorkerLost('did not start')), READY_MS);
      w.addEventListener('message', (ev: MessageEvent<FromWorker>) => {
        if (ev.data?.t === 'ready') {
          started = true;
          clearTimeout(timer);
          resolve();
        } else this.onMessage(slot, ev.data);
      });
      const fail = (why: string) => {
        clearTimeout(timer);
        // One that never started: threads do not work here at all.
        if (!started) this.broken = true;
        reject(new WorkerLost(why));
        this.lose(slot, why, !started);
      };
      w.addEventListener('error', (e: ErrorEvent) => fail(`error: ${e?.message ?? 'unknown'}`));
      w.addEventListener('messageerror', () => fail('message could not be read'));
    });
    slot.ready.catch(() => undefined);
    w.start?.();
    this.slots.push(slot);
    return slot;
  }

  private lose(s: Slot, why: string, broken: boolean): void {
    if (s.dead) return;
    s.dead = true;
    if (broken) this.broken = true;
    clearTimeout(s.idle);
    for (const c of s.calls.values()) c.abort();
    for (const r of s.runs.values()) r.reject(new WorkerLost(why));
    s.runs.clear();
    this.slots = this.slots.filter((x) => x !== s);
    try {
      s.w.terminate();
    } catch {
      /* gone already */
    }
  }

  private async runRemote(req: PipelineRequest & { batchReview?: boolean }, deps: StandaloneDeps): Promise<RemoteOutput> {
    const slot = this.pick();
    clearTimeout(slot.idle);
    const id = this.nextId++;
    const done = new Promise<RemoteOutput>((resolve, reject) => slot.runs.set(id, { req, deps, resolve, reject }));
    const settle = () => {
      if (slot.runs.size || slot.dead) return;
      clearTimeout(slot.idle);
      slot.idle = setTimeout(() => !slot.runs.size && this.lose(slot, 'idle', false), this.idleMs);
    };
    done.then(settle, settle);
    try {
      await slot.ready;
    } catch (e) {
      slot.runs.delete(id);
      throw e;
    }
    const { signal, onStage, freshContext, prepared, ...plain } = req;
    let ahead: RunMsg['req']['prepared'];
    if (prepared) {
      const { original, ...rest } = prepared;
      ahead = rest;
      // The worker decodes the picture itself.
      original.dispose();
    }
    const reader = deps.ocr;
    const msg: RunMsg = {
      t: 'run',
      id,
      req: { ...plain, ...(ahead ? { prepared: ahead } : {}) },
      fns: {
        detect: this.ref('detect', deps.detect),
        ocr: this.ref('ocr', reader),
        ocrAll: !!reader?.all,
        inpaint: this.ref('inpaint', deps.inpaint),
        fresh: !!freshContext,
        stage: !!onStage,
      },
      ep: reader?.ep?.(),
      lang: uiLangPref(),
      catalog: activeCatalog(),
      browser: browserTranslateSupported(),
    };
    const abort = () => slot.w.postMessage({ t: 'abort', id } satisfies ToWorker);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      slot.w.postMessage(msg);
    } catch (e) {
      // Something in the request cannot be sent (a bug, not the page): pages run here from now on.
      this.broken = true;
      slot.runs.delete(id);
      throw new WorkerLost(`cannot send: ${(e as Error)?.message ?? e}`);
    }
    try {
      return await done;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private onMessage(slot: Slot, m: FromWorker): void {
    if (!m) return;
    if (m.t === 'stage') slot.runs.get(m.id)?.req.onStage?.(m.e);
    else if (m.t === 'done') {
      const r = slot.runs.get(m.id);
      if (!r) return;
      slot.runs.delete(m.id);
      if (!m.ok) return r.reject(fromWire(m.error));
      try {
        const { original: o, cleaned: c, ...rest } = m.out;
        const original = unpackImage(this.backend, o);
        const cleaned = c === 'same' ? original : unpackImage(this.backend, c);
        r.resolve({ ...rest, original, cleaned });
      } catch (e) {
        r.reject(toAppError(e));
      }
    } else if (m.t === 'cancel') {
      slot.calls.get(m.cid)?.abort();
      slot.calls.delete(m.cid);
    } else if (m.t === 'call') void this.answer(slot, m);
  }

  private async answer(slot: Slot, m: { cid: number } & Call): Promise<void> {
    const ctrl = new AbortController();
    slot.calls.set(m.cid, ctrl);
    const signal = ctrl.signal;
    try {
      let value: unknown;
      const transfer: Transferable[] = [];
      let ep: 'webgpu' | 'wasm' | 'engine' | undefined;
      if (m.fn === 'fetch' || m.fn === 'fresh') {
        const r = slot.runs.get(m.run);
        if (!r) throw new AppError('CANCELLED');
        if (m.fn === 'fresh') value = await r.req.freshContext?.();
        else {
          const f: FetchLike = r.deps.fetchImpl ?? ((u, i) => fetch(u, i));
          const res = await f(m.url, { method: m.init.method, headers: m.init.headers, body: m.init.body, signal });
          const body = await res.arrayBuffer();
          transfer.push(body);
          value = { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body } satisfies WireResponse;
        }
      } else if (m.fn === 'detect') value = await (this.fnOf('detect', m.ref) as TextDetector)(m.img, signal);
      else if (m.fn === 'inpaint') {
        const px = await (this.fnOf('inpaint', m.ref) as Inpainter)(m.img, m.mask, signal);
        value = px;
      } else if (m.fn === 'ocr' || m.fn === 'ocrAll') {
        const reader = this.fnOf('ocr', m.ref) as TextReader;
        value = m.fn === 'ocr' ? await reader(m.px, m.lang) : await reader.all!(m.pieces, m.lang);
        ep = reader.ep?.();
      } else if (m.fn === 'browser') value = await translateWithBrowser(m.texts, m.from, m.to, signal);
      if (slot.calls.delete(m.cid) && !slot.dead) slot.w.postMessage({ t: 'ret', cid: m.cid, ok: true, value, ...(ep ? { ep } : {}) } satisfies ToWorker, transfer);
    } catch (e) {
      if (slot.calls.delete(m.cid) && !slot.dead) slot.w.postMessage({ t: 'ret', cid: m.cid, ok: false, error: wireError(e) } satisfies ToWorker);
    }
  }
}
