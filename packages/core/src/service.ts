import { AppError, toAppError } from './errors';
import type { ImageBackend, ImageMime } from './image/backend';
import { TiledImage } from './image/tiled';
import type { FetchLike } from './llm/types';
import { pipelineConfigFromSettings, pipelineHash, type PipelineConfig } from './pipeline/config';
import { renderOutput, runPipeline, styleDefaultsFor, type RenderedPage } from './pipeline/run';
import type { AppSettings } from './settings';
import type { IdbStore } from './storage/idb';
import type { SecretStore } from './storage/secrets';
import { emptyContext, type TranslationContext } from './translate/context';
import type { PageResult, StageEvent, Usage } from './types';
import { sha256Hex, sniffImageMime } from './util/bytes';

export interface StoredResult {
  key: string;
  page: PageResult;
  rendered: { y: number; h: number; bytes: Uint8Array }[];
  mime: ImageMime;
  original: { bytes: Uint8Array; mime: string };
  cleaned: { y: number; h: number; bytes: Uint8Array }[];
  sourceUrl?: string;
  title?: string;
  seriesKey?: string;
  createdAt: string;
  lastHitAt: string;
}

export interface HistoryEntry {
  key: string;
  url?: string;
  title?: string;
  date: string;
  pages: number;
  targetLang: string;
  model: string;
  status: 'done' | 'error';
  error?: string;
}

export interface TranslateOptions {
  sourceUrl?: string;
  title?: string;
  seriesKey?: string;
  generic?: boolean;
  force?: boolean;
  signal?: AbortSignal;
  onStage?: (e: StageEvent) => void;
}

export const MAX_INPUT_BYTES = 60 * 1024 * 1024;

/** Series key used to share a translation context between pages of the same manga. */
export function seriesKeyFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).slice(0, 2);
    return `${u.hostname}/${parts.join('/')}`;
  } catch {
    return undefined;
  }
}

/**
 * Glue between settings, secrets, cache, history and the pipeline. Both the
 * extension (offscreen document) and the mobile app use this class.
 */
export class TranslateService {
  constructor(
    private db: IdbStore,
    private secrets: SecretStore,
    private backend: ImageBackend,
    private getSettings: () => Promise<AppSettings>,
    private fetchImpl?: FetchLike,
  ) {}

  /** Settings with API keys filled in from the encrypted store (memory only). */
  async settingsWithKeys(): Promise<AppSettings> {
    const s = await this.getSettings();
    const providers = await Promise.all(s.providers.map(async (p) => ({ ...p, apiKey: p.apiKey || (await this.secrets.get(`provider:${p.id}`)) })));
    return { ...s, providers };
  }

  async config(seriesKey?: string): Promise<{ settings: AppSettings; config: PipelineConfig }> {
    const settings = await this.settingsWithKeys();
    return { settings, config: pipelineConfigFromSettings(settings, seriesKey) };
  }

  async cacheKey(bytes: Uint8Array, config: PipelineConfig): Promise<string> {
    return `${(await sha256Hex(bytes)).slice(0, 40)}:${await pipelineHash(config)}`;
  }

  async getContext(seriesKey: string | undefined): Promise<TranslationContext | undefined> {
    if (!seriesKey) return undefined;
    return (await this.db.get<TranslationContext>('contexts', seriesKey)) ?? emptyContext(seriesKey, seriesKey);
  }

  async translate(bytes: Uint8Array, mime: string | undefined, opts: TranslateOptions = {}): Promise<{ result: StoredResult; cached: boolean }> {
    if (bytes.length > MAX_INPUT_BYTES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false });
    const realMime = sniffImageMime(bytes);
    if (!realMime) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: mime });
    const seriesKey = opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl);
    const { settings, config } = await this.config(seriesKey);
    const key = await this.cacheKey(bytes, config);
    if (!opts.force) {
      const hit = await this.db.get<StoredResult>('results', key);
      if (hit) {
        hit.lastHitAt = new Date().toISOString();
        void this.db.put('results', key, hit);
        opts.onStage?.({ stage: 'done', progress: 1, message: 'cache' });
        return { result: hit, cached: true };
      }
    }
    const context = opts.generic ? undefined : await this.getContext(seriesKey);
    try {
      const out = await runPipeline({ bytes, mime: realMime, config, context, signal: opts.signal, onStage: opts.onStage, generic: opts.generic }, { backend: this.backend, fetchImpl: this.fetchImpl });
      opts.onStage?.({ stage: 'rendering' });
      const rendered = await renderOutput(this.backend, out, styleDefaultsFor(config, settings.fonts));
      const cleanedTiles = await Promise.all(out.cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') })));
      const now = new Date().toISOString();
      const result: StoredResult = {
        key,
        page: rendered.page,
        rendered: rendered.tiles,
        mime: rendered.mime,
        original: { bytes, mime: realMime },
        cleaned: cleanedTiles,
        sourceUrl: opts.sourceUrl,
        title: opts.title,
        seriesKey,
        createdAt: now,
        lastHitAt: now,
      };
      await this.db.put('results', key, result);
      if (out.context && seriesKey) await this.db.put('contexts', seriesKey, out.context);
      await this.recordUsage(rendered.page.usage);
      if (settings.saveHistory) await this.addHistory({ key, url: opts.sourceUrl, title: opts.title, date: now, pages: 1, targetLang: config.targetLang, model: (config.translator ?? config.vision)?.model ?? 'engine', status: 'done' });
      return { result, cached: false };
    } catch (e) {
      const err = toAppError(e);
      if (settings.saveHistory && err.code !== 'CANCELLED') {
        await this.addHistory({ key, url: opts.sourceUrl, title: opts.title, date: new Date().toISOString(), pages: 1, targetLang: config.targetLang, model: (config.translator ?? config.vision)?.model ?? 'engine', status: 'error', error: err.code });
      }
      throw err;
    }
  }

  async getResult(key: string): Promise<StoredResult | undefined> {
    return this.db.get<StoredResult>('results', key);
  }

  /** Persist editor changes: new blocks and/or a new cleaned layer, then re-render. */
  async saveEdited(key: string, page: PageResult, cleaned?: TiledImage): Promise<StoredResult> {
    const stored = await this.getResult(key);
    if (!stored) throw new AppError('UNKNOWN', { message: 'Result not found', retryable: false });
    const settings = await this.getSettings();
    let image = cleaned;
    if (!image) image = await tilesToImage(this.backend, stored.page.width, stored.page.height, stored.cleaned);
    const rendered = await renderOutput(this.backend, { page, cleaned: image }, styleDefaultsFor({ targetLang: page.targetLang, sfxStyle: settings.sfxStyle }, settings.fonts));
    const cleanedTiles = cleaned ? await Promise.all(cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') }))) : stored.cleaned;
    const next: StoredResult = { ...stored, page: rendered.page, rendered: rendered.tiles, cleaned: cleanedTiles, lastHitAt: new Date().toISOString() };
    await this.db.put('results', key, next);
    return next;
  }

  async addHistory(e: HistoryEntry): Promise<void> {
    await this.db.put('history', `${e.date}:${e.key}`, e);
  }

  async history(limit = 200): Promise<HistoryEntry[]> {
    const all = await this.db.entries<HistoryEntry>('history');
    return all.map(([, v]) => v).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  async recordUsage(usage: Usage[]): Promise<void> {
    if (!usage.length) return;
    const totals = (await this.db.get<UsageTotals>('usage', 'totals')) ?? { pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    totals.pages++;
    for (const u of usage) {
      totals.inputTokens += u.inputTokens;
      totals.outputTokens += u.outputTokens;
      totals.costUsd += u.costUsd;
    }
    await this.db.put('usage', 'totals', totals);
  }

  async usage(): Promise<UsageTotals> {
    return (await this.db.get<UsageTotals>('usage', 'totals')) ?? { pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  /** Drop cached results not used for `days` days. */
  async pruneCache(days: number): Promise<number> {
    const cutoff = Date.now() - days * 86_400_000;
    let n = 0;
    for (const [key, v] of await this.db.entries<StoredResult>('results')) {
      if (Date.parse(v.lastHitAt) < cutoff) {
        await this.db.delete('results', key);
        n++;
      }
    }
    return n;
  }
}

export interface UsageTotals {
  pages: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export async function tilesToImage(backend: ImageBackend, width: number, height: number, tiles: { y: number; h: number; bytes: Uint8Array }[]): Promise<TiledImage> {
  const image = new TiledImage(backend, width, height);
  for (const t of tiles) {
    const img = await backend.decode(t.bytes, 'image/png');
    for (const tile of image.tiles) {
      if (tile.y + tile.h <= t.y || tile.y >= t.y + t.h) continue;
      tile.canvas.getContext('2d').drawImage(img.source, 0, t.y - tile.y);
    }
    img.close?.();
  }
  return image;
}
