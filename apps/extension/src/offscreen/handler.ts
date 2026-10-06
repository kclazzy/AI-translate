import { AppError, base64ToBytes, browserBackend, bytesToDataUrl, dataUrlToBytes, TaskQueue, toAppError, TranslateService, type StoredResult } from '@ait/core';
import { loadBundledFonts } from '@ait/studio/fonts';
import type { FromOffscreen, RenderedTiles, ToOffscreen } from '../shared/messages';
import { db, loadSettings, secrets } from '../shared/store';

/**
 * The pipeline runs here (offscreen document in Chrome, the background page in Firefox):
 * DOM fonts, OffscreenCanvas, IndexedDB and long-running work without the
 * 30-second service-worker idle limit.
 */
export const service = new TranslateService(db, secrets, browserBackend, loadSettings);
const queue = new TaskQueue(2);
let fontsReady: Promise<void> | null = null;
let pruned = false;

export function toRendered(r: StoredResult, cached: boolean): RenderedTiles {
  return {
    key: r.key,
    width: r.page.width,
    height: r.page.height,
    tiles: r.rendered.map((t) => ({ y: t.y, h: t.h, dataUrl: bytesToDataUrl(t.bytes, r.mime) })),
    page: { blocks: r.page.blocks, timings: r.page.timings, usage: r.page.usage, pipeline: r.page.pipeline },
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
  fontsReady ??= loadBundledFonts();
  await fontsReady;
  if (!pruned) {
    pruned = true;
    void loadSettings().then((s) => service.pruneCache(s.cacheDays));
  }
  switch (msg.type) {
    case 'run':
    case 'crop-run': {
      const settings = await loadSettings();
      queue.concurrency = Math.max(1, settings.concurrency);
      const { jobId, tabId } = msg;
      const priority = msg.priority ?? 100;
      void queue
        .add({
          key: jobId,
          priority,
          run: async (signal) => {
            const bytes = msg.type === 'run' ? base64ToBytes(msg.bytesB64) : await cropScreenshot(msg.screenshot, msg.rect, msg.dpr);
            const { result, cached } = await service.translate(bytes, msg.type === 'run' ? msg.mime : 'image/png', {
              sourceUrl: msg.pageUrl,
              title: msg.title,
              generic: msg.type === 'crop-run' ? msg.generic ?? true : msg.generic,
              force: msg.type === 'run' ? msg.force : false,
              signal,
              onStage: (event) => emit({ source: 'offscreen', type: 'stage', jobId, tabId, event }),
            });
            emit({ source: 'offscreen', type: 'done', jobId, tabId, result: toRendered(result, cached) });
          },
        })
        .catch((e) => emit({ source: 'offscreen', type: 'error', jobId, tabId, error: toAppError(e).toJSON() }));
      return { queued: true };
    }
    case 'cancel':
      return { cancelled: queue.cancel(msg.jobId) };
    case 'get-result': {
      const r = await service.getResult(msg.key);
      return r ? toRendered(r, true) : null;
    }
  }
}
