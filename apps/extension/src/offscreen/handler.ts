import { AppError, base64ToBytes, tilesToImage, isLocalProvider, browserBackend, bytesToDataUrl, dataUrlToBytes, TaskQueue, toAppError, TranslateService, type StoredResult } from '@ait/core';
import { loadBundledFonts, loadUserFonts } from '@ait/studio/fonts';
import { exportCbz, exportEpub, exportPdf, exportZip, type ExportPage } from '@ait/studio/files';
import type { StageEvent } from '@ait/core';
import type { FromOffscreen, JobStatus, RenderedTiles, SpeedStats, ToOffscreen } from '../shared/messages';
import { db, loadSettings, secrets } from '../shared/store';
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

/** Moving average of the time per page, shown in the popup ("~18 с на страницу"). */
async function recordSpeed(ms: number, usage: { outputTokens: number }[]): Promise<void> {
  const prev = (await db.get<SpeedStats>('kv', 'speed')) ?? { avgMs: ms, pages: 0, at: '' };
  const n = Math.min(prev.pages, 9);
  const avgMs = Math.round((prev.avgMs * n + ms) / (n + 1));
  const tokens = usage.reduce((a, u) => a + u.outputTokens, 0);
  await db.put('kv', 'speed', { avgMs, pages: prev.pages + 1, lastMs: ms, lastTokens: tokens, at: new Date().toISOString() } satisfies SpeedStats);
}

/** What each job is doing, so the page can show progress and notice lost jobs. */
const jobs = new Map<string, { tabId: number; startedAt?: number; stage?: StageEvent }>();

/** Pictures translated together as one strip share the queue job of the first one. */
const alias = new Map<string, string>();
const main = (id: string) => alias.get(id) ?? id;

export function jobStatus(jobId: string): JobStatus {
  jobId = main(jobId);
  const info = jobs.get(jobId);
  const pos = queue.position(jobId);
  if (pos.state === 'unknown') return { state: 'unknown' };
  if (pos.state === 'pending') return { state: 'pending', ahead: pos.ahead };
  return { state: 'running', elapsedMs: info?.startedAt ? Date.now() - info.startedAt : 0, stage: info?.stage?.stage };
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
  if (!s.autoSave) return;
  const clean = (x: string) => x.replace(/[^\p{L}\p{N} ._,()\-]+/gu, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80);
  let host = 'site';
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    /* keep */
  }
  const base = src && !src.startsWith('data:') ? clean(decodeURIComponent(new URL(src, pageUrl).pathname.split('/').pop() ?? '').replace(/\.\w+$/, '')) : '';
  const name = base || r.key.slice(0, 10);
  const image = await tilesToImage(browserBackend, r.page.width, r.page.height, r.rendered);
  const c = browserBackend.createCanvas(image.width, image.height);
  image.drawRegion(c.getContext('2d'), 0, 0, image.width, image.height, image.width, image.height);
  const bytes = await browserBackend.encode(c, 'image/png');
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  emit({ source: 'offscreen', type: 'save', tabId, url, filename: `AI Translate/${clean(host) || 'site'}/${clean(title) || 'page'}/${name}.png` });
}

export function toRendered(r: StoredResult, cached: boolean): RenderedTiles {
  return {
    key: r.key,
    width: r.page.width,
    height: r.page.height,
    tiles: r.rendered.map((t) => ({ y: t.y, h: t.h, dataUrl: bytesToDataUrl(t.bytes, r.mime) })),
    page: { blocks: r.page.blocks, timings: r.page.timings, usage: r.page.usage, pipeline: r.page.pipeline, stripLang: r.page.stripLang },
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

export async function handleOffscreen(msg: ToOffscreen, emit: (m: FromOffscreen) => void): Promise<unknown> {
  fontsReady ??= loadBundledFonts().then(() => loadUserFonts(db)).then(() => undefined);
  await fontsReady;
  if (!pruned) {
    pruned = true;
    void service.prune();
    // The offscreen document can live for days: tidy up again every 6 hours.
    setInterval(() => void service.prune(), 6 * 3_600_000);
  }
  switch (msg.type) {
    case 'run':
    case 'crop-run': {
      const settings = await loadSettings();
      // This document can live for days: follow a language changed since it opened.
      setUiLang(settings.interfaceLang, false);
      // Local servers (Ollama, LM Studio) answer one request at a time: running two pages at once
      // makes both twice as slow and can push a single page past the timeout.
      const vision = settings.providers.find((p) => p.id === settings.visionProviderId);
      const local = settings.pipeline !== 'engine' && (!vision || isLocalProvider(vision));
      queue.concurrency = local ? 1 : Math.max(1, settings.concurrency);
      const { jobId, tabId } = msg;
      const priority = msg.priority ?? 100;
      jobs.set(jobId, { tabId });
      void queue
        .add({
          key: jobId,
          priority,
          run: async (signal) => {
            const info = jobs.get(jobId);
            if (info) info.startedAt = Date.now();
            const bytes = msg.type === 'run' ? base64ToBytes(msg.bytesB64) : await cropScreenshot(msg.screenshot, msg.rect, msg.dpr);
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
                generic: msg.type === 'crop-run' ? msg.generic ?? true : msg.generic,
                force: msg.type === 'run' ? msg.force : false,
                signal: watch.signal,
                // While more pages wait, keep the local model in video memory between them.
                keepAliveMin: local && queue.getStats().pending > 0 ? CHAPTER_KEEP_ALIVE_MIN : undefined,
                onStage: (event) => {
                  const i = jobs.get(jobId);
                  if (i) i.stage = event;
                  emit({ source: 'offscreen', type: 'stage', jobId, tabId, event });
                },
              });
              if (!cached) void recordSpeed(Date.now() - t0, result.page.usage);
              emit({ source: 'offscreen', type: 'done', jobId, tabId, result: toRendered(result, cached) });
              if (msg.type === 'run') void rememberSrc(msg.imageSrc, result.key);
              if (!cached) void autoSave(result, msg.pageUrl, msg.title, msg.type === 'run' ? msg.imageSrc : undefined, tabId, emit).catch(() => undefined);
            } catch (e) {
              if (watch.signal.aborted && watch.signal.reason instanceof DOMException && watch.signal.reason.message === 'watchdog') {
                throw new AppError('TIMEOUT', { retryable: true, detail: tr('Модель не ответила за {0} мин. Картинка пропущена, перевод главы продолжается. Проверьте модель в настройках: возможно, она не помещается в видеопамять.', limitMin) });
              }
              throw e;
            } finally {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
            }
          },
        })
        .catch((e) => emit({ source: 'offscreen', type: 'error', jobId, tabId, error: toAppError(e).toJSON() }))
        .finally(() => jobs.delete(jobId));
      return { queued: true, status: jobStatus(jobId) };
    }
    case 'run-strip': {
      const settings = await loadSettings();
      setUiLang(settings.interfaceLang, false);
      const vision = settings.providers.find((p) => p.id === settings.visionProviderId);
      const local = settings.pipeline !== 'engine' && (!vision || isLocalProvider(vision));
      queue.concurrency = local ? 1 : Math.max(1, settings.concurrency);
      const { tabId, jobIds } = msg;
      const jobId = jobIds[0];
      for (const id of jobIds.slice(1)) alias.set(id, jobId);
      jobs.set(jobId, { tabId });
      const done = new Set<string>();
      void queue
        .add({
          key: jobId,
          priority: msg.priority ?? 100,
          run: async (signal) => {
            const info = jobs.get(jobId);
            if (info) info.startedAt = Date.now();
            const watch = new AbortController();
            const onAbort = () => watch.abort(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            // A strip is several pictures: allow time for each chunk of it.
            const limitMin = (local ? WATCHDOG_LOCAL_MIN : WATCHDOG_CLOUD_MIN) * Math.max(1, Math.ceil(jobIds.length / 3));
            const timer = setTimeout(() => watch.abort(new DOMException('watchdog', 'TimeoutError')), limitMin * 60_000);
            let t0 = Date.now();
            let current: string[] = jobIds;
            try {
              await service.translateStrip(
                msg.parts.map((p) => ({ bytes: base64ToBytes(p.bytesB64), mime: p.mime })),
                {
                  sourceUrl: msg.pageUrl,
                  title: msg.title,
                  force: msg.force,
                  signal: watch.signal,
                  keepAliveMin: local ? CHAPTER_KEEP_ALIVE_MIN : undefined,
                  onChunk: (idx) => {
                    current = idx.map((i) => jobIds[i]);
                    t0 = Date.now();
                  },
                  onStage: (event) => {
                    const i = jobs.get(jobId);
                    if (i) i.stage = event;
                    for (const id of current) if (!done.has(id)) emit({ source: 'offscreen', type: 'stage', jobId: id, tabId, event });
                  },
                  onPart: (i, result, cached) => {
                    done.add(jobIds[i]);
                    if (!cached && result.strip?.index === 0) void recordSpeed(Date.now() - t0, result.page.usage);
                    emit({ source: 'offscreen', type: 'done', jobId: jobIds[i], tabId, result: toRendered(result, cached) });
                    void rememberSrc(msg.parts[i].src, result.key);
                    if (!cached) void autoSave(result, msg.pageUrl, msg.title, msg.parts[i].src, tabId, emit).catch(() => undefined);
                  },
                },
              );
            } catch (e) {
              if (watch.signal.aborted && watch.signal.reason instanceof DOMException && watch.signal.reason.message === 'watchdog') {
                throw new AppError('TIMEOUT', { retryable: true, detail: tr('Модель не ответила за {0} мин. Картинка пропущена, перевод главы продолжается. Проверьте модель в настройках: возможно, она не помещается в видеопамять.', limitMin) });
              }
              throw e;
            } finally {
              clearTimeout(timer);
              signal.removeEventListener('abort', onAbort);
            }
          },
        })
        .catch((e) => {
          const error = toAppError(e).toJSON();
          for (const id of jobIds) if (!done.has(id)) emit({ source: 'offscreen', type: 'error', jobId: id, tabId, error });
        })
        .finally(() => {
          jobs.delete(jobId);
          for (const id of jobIds) alias.delete(id);
        });
      return { queued: true, status: jobStatus(jobId) };
    }
    case 'cancel':
      return { cancelled: queue.cancel(main(msg.jobId)) };
    case 'cancel-tab': {
      let n = 0;
      for (const [id, j] of jobs) if (msg.tabId === undefined || j.tabId === msg.tabId) n += queue.cancel(id) ? 1 : 0;
      return { cancelled: n };
    }
    case 'status':
      return Object.fromEntries(msg.jobIds.map((id) => [id, jobStatus(id)]));
    case 'lookup-cached': {
      // Pictures of this page translated before (to the current language): their results.
      const s = await loadSettings();
      const out: Record<string, RenderedTiles> = {};
      for (const src of msg.srcs.slice(0, 300)) {
        const key = await db.get<string>('kv', `src:${s.targetLang}:${src}`);
        const r = key ? await service.getResult(key) : undefined;
        if (r) out[src] = toRendered(r, true);
      }
      return out;
    }
    case 'get-result': {
      const r = await service.getResult(msg.key);
      return r ? toRendered(r, true) : null;
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
