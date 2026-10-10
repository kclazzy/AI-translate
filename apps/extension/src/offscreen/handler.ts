import { AppError, tilesToImage, isLocalProvider, browserBackend, bytesToDataUrl, dataUrlToBytes, TaskQueue, toAppError, TranslateService, type StoredResult } from '@ait/core';
import { loadBundledFonts, loadUserFonts } from '@ait/studio/fonts';
import { exportCbz, exportEpub, exportPdf, exportZip, type ExportPage } from '@ait/studio/files';
import { buildProblemReport } from '@ait/studio/problem-report';
import type { StageEvent } from '@ait/core';
import { CANCELLED_ALL, type FromOffscreen, type JobStatus, type RenderedTiles, type SpeedStats, type ToOffscreen } from '../shared/messages';
import { deleteJobBytes, getJobBytes, pruneJobBytes } from '../shared/jobstore';
import { db, loadSettings, secrets } from '../shared/store';
import { lamaDownloaded, lamaInpainter } from './lama';
import { detectorDownloaded, releaseDetector, textDetector } from './detector';
import { setUiLang, tr } from '@ait/core/i18n';

/**
 * The pipeline runs here (offscreen document in Chrome, the background page in Firefox):
 * DOM fonts, OffscreenCanvas, IndexedDB and long-running work without the
 * 30-second service-worker idle limit.
 */
export const service = new TranslateService(db, secrets, browserBackend, loadSettings);
const queue = new TaskQueue(2);
let fontsReady: Promise<void> | null = null;
/** A picture with no answer for this long is failed and the queue moves on. */
const WATCHDOG_LOCAL_MIN = 12;
const WATCHDOG_CLOUD_MIN = 5;
/** Keep the local model loaded this long while a chapter is still in the queue. */
const CHAPTER_KEEP_ALIVE_MIN = 15;
/** Results bigger than this go to the page tile by tile (browsers refuse messages over 64 MiB). */
const MAX_TILES_IN_MESSAGE = 40 * 1024 * 1024;

/** Moving average of the time per page, shown in the popup ("~18 с на страницу"). */
async function recordSpeed(ms: number, usage: { outputTokens: number }[]): Promise<void> {
  const prev = (await db.get<SpeedStats>('kv', 'speed')) ?? { avgMs: ms, pages: 0, at: '' };
  const n = Math.min(prev.pages, 9);
  const avgMs = Math.round((prev.avgMs * n + ms) / (n + 1));
  const tokens = usage.reduce((a, u) => a + u.outputTokens, 0);
  await db.put('kv', 'speed', { avgMs, pages: prev.pages + 1, lastMs: ms, lastTokens: tokens, at: new Date().toISOString() } satisfies SpeedStats);
}

/**
 * Queue jobs are keyed by content (the picture's hash), not by request: the same picture asked for
 * twice — two tabs, a resend after a restart, a strip and a single retry — is translated once and
 * the result goes to every request waiting for it. A request is a subscriber of the job; `part` is
 * the index of its picture within a strip (0 for a single picture).
 */
interface Sub {
  tabId: number;
  doc: string;
  part: number;
}
interface Task {
  key: string;
  subs: Map<string, Sub>;
  startedAt?: number;
  stage?: StageEvent;
  /** Strip parts whose result was already sent. */
  delivered: Set<number>;
  /** Job-store ids of the bytes, deleted when the job ends. */
  blobs: string[];
  /** The bytes read ahead by `prepare` (prefetch): the run takes them instead of reading again. */
  read?: Promise<{ bytes: Uint8Array; mime: string }>;
}
const tasks = new Map<string, Task>();
/** Request (job id) → queue key of the job it waits for. */
const jobTask = new Map<string, string>();

function subscribe(task: Task, jobId: string, sub: Sub) {
  const prev = jobTask.get(jobId);
  if (prev && prev !== task.key) tasks.get(prev)?.subs.delete(jobId);
  task.subs.set(jobId, sub);
  jobTask.set(jobId, task.key);
}

function forget(task: Task) {
  task.read = undefined;
  if (tasks.get(task.key) === task) tasks.delete(task.key);
  for (const id of task.subs.keys()) if (jobTask.get(id) === task.key) jobTask.delete(id);
  for (const b of task.blobs) void deleteJobBytes(b);
}

/** Nobody waits for a part that is not ready yet: stop the job. */
function dropIfUnneeded(task: Task) {
  if ([...task.subs.values()].some((s) => !task.delivered.has(s.part))) return;
  queue.cancel(task.key);
  forget(task);
}

function emitTo(task: Task, part: number | null, emit: (m: FromOffscreen) => void, make: (jobId: string, sub: Sub) => FromOffscreen) {
  for (const [jobId, sub] of task.subs) if (part === null || sub.part === part) emit(make(jobId, sub));
}

export function jobStatus(jobId: string): JobStatus {
  const key = jobTask.get(jobId);
  const task = key ? tasks.get(key) : undefined;
  if (!key || !task) return { state: 'unknown' };
  const pos = queue.position(key);
  if (pos.state === 'unknown') return { state: 'unknown' };
  if (pos.state === 'pending') return { state: 'pending', ahead: pos.ahead };
  return { state: 'running', elapsedMs: task.startedAt ? Date.now() - task.startedAt : 0, stage: task.stage?.stage };
}
let pruned = false;

/** Remember which picture address gave which result, so a page opened again shows it at once. */
async function rememberSrc(src: string | undefined, key: string): Promise<void> {
  if (!src || src.startsWith('data:')) return;
  const s = await loadSettings();
  await db.put('kv', `src:${s.targetLang}:${src}`, key);
}

/** «Сохранять каждую переведённую картинку»: Downloads/AI Translate/<site>/<chapter>/<picture>.png */
async function autoSave(r: StoredResult, pageUrl: string, title: string, src: string | undefined, tabId: number, emit: (m: FromOffscreen) => void): Promise<void> {
  const s = await loadSettings();
  if (!s.autoSave || !s.autoSaveDir) return;
  const clean = (x: string) => x.replace(/[^\p{L}\p{N} ._,()\-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);
  let host = 'site';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep */
  }
  let base = '';
  if (src && !src.startsWith('data:')) {
    let last = '';
    try {
      last = new URL(src, pageUrl).pathname.split('/').pop() ?? '';
      last = decodeURIComponent(last);
    } catch {
      /* a malformed %-escape: keep the name as it is written */
    }
    base = clean(last.replace(/\.\w+$/, ''));
  }
  const name = base || r.key.slice(0, 10);
  const image = await tilesToImage(browserBackend, r.page.width, r.page.height, r.rendered);
  const c = browserBackend.createCanvas(image.width, image.height);
  image.drawRegion(c.getContext('2d'), 0, 0, image.width, image.height, image.width, image.height);
  const bytes = await browserBackend.encode(c, 'image/png');
  const folders = [clean(host) || 'site', clean(title) || 'page'];
  // The folder the user chose: <folder>/<site>/<chapter>/<picture>.png
  if (s.autoSaveDir && s.autoSaveDir !== 'downloads') {
    const dir = await db.get<FileSystemDirectoryHandle>('kv', 'autosave-dir');
    const h = dir as FileSystemDirectoryHandle & { queryPermission?: (o: { mode: string }) => Promise<string> };
    if (h && (await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') {
      let d: FileSystemDirectoryHandle = h;
      for (const f of folders) d = await d.getDirectoryHandle(f, { create: true });
      const w = await (await d.getFileHandle(`${name}.png`, { create: true })).createWritable();
      await w.write(bytes as BlobPart);
      await w.close();
      await db.delete('kv', 'autosave-blocked');
      return;
    }
    // The browser forgot the permission (restart): ask again in the settings, nothing is lost —
    // meanwhile the picture goes to Downloads/AI Translate.
    await db.put('kv', 'autosave-blocked', new Date().toISOString());
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  emit({ source: 'offscreen', type: 'save', tabId, url, filename: `AI Translate/${folders.join('/')}/${name}.png` });
}

/** LaMa in the browser, when chosen in the settings and downloaded. */
async function browserLama(mode: string | undefined) {
  return mode === 'browser' && (await lamaDownloaded()) ? lamaInpainter : undefined;
}

function tileOf(r: StoredResult, i: number) {
  const t = r.rendered[i];
  return { y: t.y, h: t.h, dataUrl: bytesToDataUrl(t.bytes, r.mime) };
}

export function toRendered(r: StoredResult, cached: boolean): RenderedTiles {
  // base64 is 4/3 of the bytes; past the limit the page fetches the tiles one by one.
  const size = r.rendered.reduce((a, t) => a + Math.ceil(t.bytes.length / 3) * 4, 0);
  const omit = size > MAX_TILES_IN_MESSAGE;
  return {
    key: r.key,
    width: r.page.width,
    height: r.page.height,
    tiles: omit ? [] : r.rendered.map((_, i) => tileOf(r, i)),
    tilesOmitted: omit ? r.rendered.length : undefined,
    page: { blocks: r.page.blocks, timings: r.page.timings, usage: r.page.usage, pipeline: r.page.pipeline, stripLang: r.page.stripLang, artText: r.page.artText, artRedrawn: r.page.artRedrawn, skippedNoText: r.page.skippedNoText, selfCheck: r.page.selfCheck },
    cached,
  };
}

async function cropScreenshot(screenshot: string, rect: { x: number; y: number; width: number; height: number }, dpr: number): Promise<Uint8Array> {
  const { bytes } = dataUrlToBytes(screenshot);
  const img = await browserBackend.decode(bytes, 'image/png');
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(img.width - sx, Math.round(rect.width * dpr));
  const sh = Math.min(img.height - sy, Math.round(rect.height * dpr));
  if (sw < 8 || sh < 8) throw new AppError('IMAGE_FETCH_FAILED', { retryable: false, detail: 'Selected area is empty' });
  const c = browserBackend.createCanvas(sw, sh);
  c.getContext('2d').drawImage(img.source, sx, sy, sw, sh, 0, 0, sw, sh);
  img.close?.();
  return browserBackend.encode(c, 'image/png');
}

/**
 * Fonts for drawing the translation. A broken bundled font is tried again on the next picture; a
 * broken font of the user's is skipped (logged) and never blocks translation.
 */
function ensureFonts(): Promise<void> {
  fontsReady ??= (async () => {
    let bundledOk = true;
    try {
      await loadBundledFonts();
    } catch (e) {
      bundledOk = false;
      console.warn('[AIT] bundled fonts failed', e);
    }
    try {
      await loadUserFonts(db);
    } catch (e) {
      console.warn('[AIT] user fonts failed', e);
    }
    if (!bundledOk) fontsReady = null;
  })();
  return fontsReady;
}

async function readBytes(blobId: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const got = await getJobBytes(blobId);
  if (!got) throw new AppError('IMAGE_FETCH_FAILED', { retryable: true, detail: tr('Картинка потерялась в очереди. Нажмите «Повторить».') });
  return got;
}

function watchdogError(limitMin: number) {
  return new AppError('TIMEOUT', { retryable: true, detail: tr('Модель не ответила за {0} мин. Картинка пропущена, перевод главы продолжается. Проверьте модель в настройках: возможно, она не помещается в видеопамять.', limitMin) });
}

/** The queue setting for the current settings: local servers answer one request at a time. */
async function prepare() {
  const settings = await loadSettings();
  service.inpainter = await browserLama(settings.lamaMode);
  service.detector = settings.detectorMode === 'browser' && (await detectorDownloaded()) ? textDetector : undefined;
  // This document can live for days: follow a language changed since it opened.
  setUiLang(settings.interfaceLang, false);
  const vision = settings.providers.find((p) => p.id === settings.visionProviderId);
  const local = settings.pipeline !== 'engine' && (!vision || isLocalProvider(vision));
  // Running two pages at once on a local server makes both twice as slow and can push a single
  // page past the timeout.
  queue.concurrency = local ? 1 : Math.max(1, settings.concurrency);
  return local;
}

/**
 * Messages answered at once, whatever runs: they only read what is stored or known (never queued
 * behind the translations, and not waiting for the fonts). A translation in progress lets them in
 * between its steps (the pipeline yields, see yieldIfBusy).
 */
const QUICK = new Set<ToOffscreen['type']>(['status', 'lookup-cached', 'get-result', 'get-tile', 'cancel', 'cancel-tab', 'free-memory']);

export async function handleOffscreen(msg: ToOffscreen, emit: (m: FromOffscreen) => void): Promise<unknown> {
  // The batched translation check fixed a picture after it was shown: the pages showing it redraw
  // it (Chrome: a message to the background; Firefox: a direct call, the handler runs there).
  service.onResultChanged = (key) => emit({ source: 'offscreen', type: 'result-changed', key });
  if (!QUICK.has(msg.type)) await ensureFonts();
  if (!pruned) {
    pruned = true;
    void service.prune();
    // Bytes of jobs lost when this worker was closed mid-queue.
    void pruneJobBytes(10 * 60_000).catch(() => undefined);
    // The offscreen document can live for days: tidy up again every 6 hours.
    setInterval(() => {
      void service.prune();
      void pruneJobBytes(6 * 3_600_000).catch(() => undefined);
    }, 6 * 3_600_000);
  }
  switch (msg.type) {
    case 'run':
    case 'crop-run': {
      const local = await prepare();
      const { jobId, tabId } = msg;
      const sub: Sub = { tabId, doc: msg.doc ?? '', part: 0 };
      const priority = msg.priority ?? 100;
      const force = msg.type === 'run' ? !!msg.force : false;
      const generic = msg.type === 'crop-run' ? msg.generic ?? true : !!msg.generic;
      // A screen capture is never the same job as another one; a picture is known by its bytes.
      let key = msg.type === 'run' ? `run:${msg.hash}:${force ? 'f' : ''}:${generic ? 'g' : ''}` : `crop:${jobId}`;
      const existing = tasks.get(key);
      if (existing && !existing.delivered.size && queue.has(key)) {
        subscribe(existing, jobId, sub);
        if (msg.type === 'run' && !existing.blobs.includes(msg.blobId)) void deleteJobBytes(msg.blobId);
        // A higher priority (the picture came on screen) moves the shared job up; add() with a
        // known key only raises the priority of the waiting job.
        void queue.add({ key, priority, run: async () => undefined }).catch(() => undefined);
        return { queued: true, status: jobStatus(jobId) };
      }
      // The same job is just finishing: start a separate one (its result comes from the cache).
      if (existing) key = `${key}#${jobId}`;
      const task: Task = { key, subs: new Map(), delivered: new Set(), blobs: msg.type === 'run' ? [msg.blobId] : [] };
      tasks.set(key, task);
      subscribe(task, jobId, sub);
      /** The picture's bytes: the ones read ahead when there are any, else from the job store. */
      const bytesOf = async (blobId: string) => {
        const ahead = task.read;
        task.read = undefined;
        return ((ahead && (await ahead.catch(() => undefined))) || (await readBytes(blobId))).bytes;
      };
      void queue
        .add({
          key,
          priority,
          // While the model works on the picture before, decode this one and look for lettering.
          prepare:
            msg.type === 'run'
              ? async () => {
                  const read = readBytes(msg.blobId);
                  task.read = read;
                  const { bytes } = await read;
                  if (task.read !== read) return; // already taken by the run
                  await service.prefetch(bytes, msg.mime, { sourceUrl: msg.pageUrl, generic, force });
                }
              : undefined,
          run: async (signal) => {
            task.startedAt = Date.now();
            const bytes = msg.type === 'run' ? await bytesOf(msg.blobId) : await cropScreenshot(msg.screenshot, msg.rect, msg.dpr);
            // Watchdog: a picture that gets no answer for too long fails with a clear reason and
            // the queue moves on (one stuck request must not stop the whole chapter).
            const watch = new AbortController();
            const onAbort = () => watch.abort(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            const limitMin = local ? WATCHDOG_LOCAL_MIN : WATCHDOG_CLOUD_MIN;
            const timer = setTimeout(() => watch.abort(new DOMException('watchdog', 'TimeoutError')), limitMin * 60_000);
            const t0 = Date.now();
            try {
              const { result, cached } = await service.translate(bytes, msg.type === 'run' ? msg.mime : 'image/png', {
                sourceUrl: msg.pageUrl,
                title: msg.title,
                generic,
                force,
                signal: watch.signal,
                // While more pages wait, keep the local model in video memory between them.
                keepAliveMin: local && queue.getStats().pending > 0 ? CHAPTER_KEEP_ALIVE_MIN : undefined,
                onStage: (event) => {
                  task.stage = event;
                  emitTo(task, null, emit, (id, s) => ({ source: 'offscreen', type: 'stage', jobId: id, tabId: s.tabId, event }));
                },
              });
              if (!cached) void recordSpeed(Date.now() - t0, result.page.usage);
              task.delivered.add(0);
              const rendered = toRendered(result, cached);
              emitTo(task, null, emit, (id, s) => ({ source: 'offscreen', type: 'done', jobId: id, tabId: s.tabId, result: rendered }));
              if (msg.type === 'run') void rememberSrc(msg.imageSrc, result.key);
              if (!cached) void autoSave(result, msg.pageUrl, msg.title, msg.type === 'run' ? msg.imageSrc : undefined, tabId, emit).catch(() => undefined);
            } catch (e) {
              if (watch.signal.aborted && watch.signal.reason instanceof DOMException && watch.signal.reason.message === 'watchdog') throw watchdogError(limitMin);
              throw e;
            } finally {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
            }
          },
        })
        .catch((e) => {
          const error = toAppError(e).toJSON();
          emitTo(task, null, emit, (id, s) => ({ source: 'offscreen', type: 'error', jobId: id, tabId: s.tabId, error }));
        })
        .finally(() => forget(task));
      return { queued: true, status: jobStatus(jobId) };
    }
    case 'run-strip': {
      const local = await prepare();
      const { tabId, jobIds } = msg;
      const doc = msg.doc ?? '';
      let key = `strip:${msg.parts.map((p) => p.hash).join(',')}:${msg.force ? 'f' : ''}`;
      const existing = tasks.get(key);
      if (existing && !existing.delivered.size && queue.has(key)) {
        jobIds.forEach((id, part) => subscribe(existing, id, { tabId, doc, part }));
        for (const p of msg.parts) if (!existing.blobs.includes(p.blobId)) void deleteJobBytes(p.blobId);
        return { queued: true, status: jobStatus(jobIds[0]) };
      }
      if (existing) key = `${key}#${jobIds[0]}`;
      const task: Task = { key, subs: new Map(), delivered: new Set(), blobs: msg.parts.map((p) => p.blobId) };
      tasks.set(key, task);
      jobIds.forEach((id, part) => subscribe(task, id, { tabId, doc, part }));
      void queue
        .add({
          key,
          priority: msg.priority ?? 100,
          run: async (signal) => {
            task.startedAt = Date.now();
            const parts = [];
            for (const p of msg.parts) parts.push({ bytes: (await readBytes(p.blobId)).bytes, mime: p.mime });
            const watch = new AbortController();
            const onAbort = () => watch.abort(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            // A strip is several pictures: allow time for each chunk of it.
            const limitMin = (local ? WATCHDOG_LOCAL_MIN : WATCHDOG_CLOUD_MIN) * Math.max(1, Math.ceil(jobIds.length / 3));
            const timer = setTimeout(() => watch.abort(new DOMException('watchdog', 'TimeoutError')), limitMin * 60_000);
            let t0 = Date.now();
            let current: number[] = jobIds.map((_, i) => i);
            try {
              await service.translateStrip(parts, {
                sourceUrl: msg.pageUrl,
                title: msg.title,
                force: msg.force,
                signal: watch.signal,
                keepAliveMin: local ? CHAPTER_KEEP_ALIVE_MIN : undefined,
                onChunk: (idx) => {
                  current = idx;
                  t0 = Date.now();
                },
                onStage: (event) => {
                  task.stage = event;
                  for (const part of current) {
                    if (task.delivered.has(part)) continue;
                    emitTo(task, part, emit, (id, s) => ({ source: 'offscreen', type: 'stage', jobId: id, tabId: s.tabId, event }));
                  }
                },
                onPart: (i, result, cached) => {
                  task.delivered.add(i);
                  if (!cached && result.strip?.index === 0) void recordSpeed(Date.now() - t0, result.page.usage);
                  const rendered = toRendered(result, cached);
                  emitTo(task, i, emit, (id, s) => ({ source: 'offscreen', type: 'done', jobId: id, tabId: s.tabId, result: rendered }));
                  void rememberSrc(msg.parts[i].src, result.key);
                  if (!cached) void autoSave(result, msg.pageUrl, msg.title, msg.parts[i].src, tabId, emit).catch(() => undefined);
                },
              });
            } catch (e) {
              if (watch.signal.aborted && watch.signal.reason instanceof DOMException && watch.signal.reason.message === 'watchdog') throw watchdogError(limitMin);
              throw e;
            } finally {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
            }
          },
        })
        .catch((e) => {
          const error = toAppError(e).toJSON();
          for (const [id, s] of task.subs) if (!task.delivered.has(s.part)) emit({ source: 'offscreen', type: 'error', jobId: id, tabId: s.tabId, error });
        })
        .finally(() => forget(task));
      return { queued: true, status: jobStatus(jobIds[0]) };
    }
    case 'cancel': {
      // One request stops waiting; the job itself stops only when nobody else waits for it
      // (✕ on one picture of a strip leaves its neighbours alone).
      const key = jobTask.get(msg.jobId);
      const task = key ? tasks.get(key) : undefined;
      jobTask.delete(msg.jobId);
      if (!task) return { cancelled: false };
      task.subs.delete(msg.jobId);
      dropIfUnneeded(task);
      return { cancelled: true };
    }
    case 'cancel-tab': {
      let n = 0;
      const error = new AppError('CANCELLED', { detail: CANCELLED_ALL }).toJSON();
      for (const task of [...tasks.values()]) {
        for (const [id, s] of [...task.subs]) {
          if (msg.tabId !== undefined && s.tabId !== msg.tabId) continue;
          if (msg.doc && s.doc && s.doc !== msg.doc) continue;
          task.subs.delete(id);
          jobTask.delete(id);
          if (!task.delivered.has(s.part)) emit({ source: 'offscreen', type: 'error', jobId: id, tabId: s.tabId, error });
          n++;
        }
        dropIfUnneeded(task);
      }
      return { cancelled: n };
    }
    case 'free-memory':
      // «Освободить и повторить»: the detector's session (video memory) is made again when needed.
      await releaseDetector();
      return { ok: true };
    case 'status':
      return Object.fromEntries(msg.jobIds.map((id) => [id, jobStatus(id)]));
    case 'lookup-cached': {
      // Pictures of this page translated before (to the current language): only their keys — the
      // page fetches the results one by one, so no single message gets too big.
      const s = await loadSettings();
      const out: Record<string, string> = {};
      for (const src of msg.srcs.slice(0, 300)) {
        const key = await db.get<string>('kv', `src:${s.targetLang}:${src}`);
        if (key) out[src] = key;
      }
      return out;
    }
    case 'get-result': {
      const r = await service.getResult(msg.key);
      return r ? toRendered(r, true) : null;
    }
    case 'get-tile': {
      const r = await service.getResult(msg.key);
      return r && r.rendered[msg.index] ? tileOf(r, msg.index) : null;
    }
    case 'build-problem-report': {
      // «Сообщить о проблеме»: the stored result as a zip for the developer (settings without keys).
      const r = await service.getResult(msg.key);
      if (!r) throw new AppError('UNKNOWN', { retryable: false, message: tr('Перевод этой картинки не найден') });
      const { name, bytes } = await buildProblemReport({
        page: r.page,
        original: r.original,
        rendered: r.rendered,
        cleaned: r.cleaned,
        settings: await loadSettings(),
        // Offscreen documents have no chrome.runtime.getManifest: the worker sends it.
        version: msg.version,
        platform: `extension${r.degraded ? ' (lighter settings)' : ''}${r.strip ? ' (part of a strip)' : ''}`,
        backend: browserBackend,
        sourceUrl: msg.pageUrl,
        includeUrl: !!msg.pageUrl,
        comment: msg.comment,
      });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
      return { url, name, size: bytes.length };
    }
    case 'build-file': {
      // Assemble the translated pages of a chapter into one file and hand back a blob URL.
      const pages: ExportPage[] = [];
      for (const [i, key] of msg.keys.entries()) {
        const r = await service.getResult(key);
        if (r) pages.push({ name: `${String(i + 1).padStart(3, '0')}.png`, width: r.page.width, height: r.page.height, tiles: r.rendered, avoid: r.page.blocks.map((b) => b.bubble?.box ?? b.bbox) });
      }
      if (!pages.length) throw new AppError('UNKNOWN', { retryable: false, message: tr('Нет переведённых страниц') });
      // Letters (any alphabet), digits and simple punctuation only: Chrome rejects some characters.
      const safe = (msg.title || tr('Глава')).replace(/[^\p{L}\p{N} ._,()\-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 100) || tr('Глава');
      const backend = browserBackend;
      const exportSettings = await loadSettings();
      setUiLang(exportSettings.interfaceLang, false);
      const len = exportSettings.exportPageLength;
      let bytes: Uint8Array;
      let mime: string;
      if (msg.format === 'pdf') [bytes, mime] = [await exportPdf(backend, pages, undefined, len), 'application/pdf'];
      else if (msg.format === 'cbz') [bytes, mime] = [await exportCbz(backend, pages, safe, undefined, len), 'application/vnd.comicbook+zip'];
      else if (msg.format === 'epub') [bytes, mime] = [await exportEpub(backend, pages, safe, msg.lang, undefined, len), 'application/epub+zip'];
      else [bytes, mime] = [await exportZip(backend, pages, 'image/png'), 'application/zip'];
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
      return { url, name: `${safe}.${msg.format}`, pages: pages.length, size: bytes.length };
    }
  }
}
