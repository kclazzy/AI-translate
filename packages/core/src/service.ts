import { AppError, toAppError } from './errors';
import type { ImageBackend, ImageMime } from './image/backend';
import { TiledImage } from './image/tiled';
import type { FetchLike } from './llm/types';
import { pipelineConfigFromSettings, pipelineHash, type PipelineConfig } from './pipeline/config';
import { renderOutput, runCrossCheck, runPipeline, styleDefaultsFor, type RenderedPage } from './pipeline/run';
import type { AppSettings } from './settings';
import type { IdbStore } from './storage/idb';
import type { SecretStore } from './storage/secrets';
import { emptyContext, type TranslationContext } from './translate/context';
import type { PageResult, StageEvent, TextBlock, Usage } from './types';
import { sha256Hex, sniffImageMime } from './util/bytes';
import { tr } from './i18n';
import { CHECKER_LABELS, checkerIsCloud, machineTranslate } from './translate/crosscheck';
import { translateBlocks } from './translate/translator';
import { createProvider } from './llm/presets';
import { isLocalProvider } from './llm/privacy';
import { isOllama } from './llm/openai';
import { ollamaUnloadAll } from './llm/discover';
import { cropRows, pageForSpan, planChunks, stitchParts, type StripPart } from './image/strip';

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
  /** A picture translated as part of a glued strip: where it lies in the parent result. */
  strip?: { parent: string; index: number; y: number; h: number };
  /** A glued strip: the keys of the pictures cut back out of it. */
  parts?: string[];
  /** Text size scale the picture was drawn with (settings → fonts.scale). */
  fontScale?: number;
}

/** Fonts that change the cached result: the text size scale only re-draws, so it is left out. */
function lookOf(fonts: AppSettings['fonts']): Omit<AppSettings['fonts'], 'scale'> {
  const { scale: _scale, ...rest } = fonts;
  return rest;
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
  /** Keep the local model loaded at least this long (minutes) — set while a chapter is in the queue. */
  keepAliveMin?: number;
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
    const crossCheck = s.crossCheck
      ? { ...s.crossCheck, checkers: await Promise.all(s.crossCheck.checkers.map(async (c) => ({ ...c, apiKey: await this.secrets.get(`checker:${c.id}`) }))) }
      : undefined;
    return { ...s, providers, crossCheck };
  }

  async config(seriesKey?: string): Promise<{ settings: AppSettings; config: PipelineConfig }> {
    const settings = await this.settingsWithKeys();
    return { settings, config: pipelineConfigFromSettings(settings, seriesKey) };
  }

  /** Same picture + same settings that change the result (incl. fonts and screen-text mode) = same key. */
  async cacheKey(bytes: Uint8Array, config: PipelineConfig, extra: { generic?: boolean; fonts?: unknown } = {}): Promise<string> {
    const look = extra.generic || extra.fonts ? `:${(await sha256Hex(JSON.stringify([!!extra.generic, extra.fonts ?? null]))).slice(0, 8)}` : '';
    return `${(await sha256Hex(bytes)).slice(0, 40)}:${await pipelineHash(config)}${look}`;
  }

  async getContext(seriesKey: string | undefined): Promise<TranslationContext | undefined> {
    if (!seriesKey) return undefined;
    return (await this.db.get<TranslationContext>('contexts', seriesKey)) ?? emptyContext(seriesKey, seriesKey);
  }

  async translate(bytes: Uint8Array, mime: string | undefined, opts: TranslateOptions = {}): Promise<{ result: StoredResult; cached: boolean }> {
    if (bytes.length > MAX_INPUT_BYTES) throw new AppError('IMAGE_TOO_LARGE', { retryable: false });
    const realMime = sniffImageMime(bytes);
    if (realMime === 'image/tiff') throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: tr('TIFF браузер не открывает — сохраните картинку как PNG или JPG.') });
    if (!realMime) throw new AppError('UNSUPPORTED_FORMAT', { retryable: false, detail: mime });
    const seriesKey = opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl);
    const { settings, config } = await this.config(seriesKey);
    if (opts.keepAliveMin !== undefined) {
      for (const k of ['vision', 'translator'] as const) {
        const p = config[k];
        if (p) config[k] = { ...p, keepAliveMin: Math.max(p.keepAliveMin ?? 0, opts.keepAliveMin) };
      }
    }
    const key = await this.cacheKey(bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) });
    if (!opts.force) {
      const hit = await this.db.get<StoredResult>('results', key);
      if (hit) {
        // Only the text size changed in the settings: draw the text again, no model needed.
        if ((hit.fontScale ?? 1) !== (settings.fonts.scale ?? 1) && !hit.strip) {
          const again = await this.saveEdited(key, hit.page);
          opts.onStage?.({ stage: 'done', progress: 1, message: 'cache' });
          return { result: again, cached: true };
        }
        hit.lastHitAt = new Date().toISOString();
        void this.db.put('results', key, hit);
        opts.onStage?.({ stage: 'done', progress: 1, message: 'cache' });
        return { result: hit, cached: true };
      }
    }
    const context = opts.generic ? undefined : await this.getContext(seriesKey);
    try {
      const out = await this.runFitting(config, opts, (cfg) => runPipeline({ bytes, mime: realMime, config: cfg, context, signal: opts.signal, onStage: opts.onStage, generic: opts.generic }, { backend: this.backend, fetchImpl: this.fetchImpl }));
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
        fontScale: settings.fonts.scale,
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

  /**
   * Translate neighbouring pictures of one strip together (see image/strip.ts). Each picture's
   * result is reported through `onPart` as soon as its chunk is done.
   */
  async translateStrip(
    parts: StripPart[],
    opts: TranslateOptions & { onPart: (index: number, result: StoredResult, cached: boolean) => void; onChunk?: (indices: number[]) => void },
  ): Promise<void> {
    const seriesKey = opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl);
    const { settings, config } = await this.config(seriesKey);
    // Pictures translated before (in any grouping) are taken from the cache.
    const partKeys = await Promise.all(parts.map((p) => this.cacheKey(p.bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) })));
    const known: (StoredResult | undefined)[] = await Promise.all(
      partKeys.map(async (k) => {
        if (opts.force) return undefined;
        const ref = await this.db.get<string>('kv', `strip:${k}`);
        return ref ? this.getResult(ref) : undefined;
      }),
    );
    // Text size changed since: draw the strips again (each parent once), then take the pieces.
    const redrawn = new Set<string>();
    for (const [i, r] of known.entries()) {
      if (!r?.strip || (r.fontScale ?? 1) === (settings.fonts.scale ?? 1)) continue;
      const parent = r.strip.parent;
      if (!redrawn.has(parent)) {
        const pr = await this.getResult(parent);
        if (pr) await this.saveEdited(parent, pr.page);
        redrawn.add(parent);
      }
      known[i] = await this.getResult(r.key);
    }
    const todo = parts.map((_, i) => i).filter((i) => !known[i]);
    for (const [i, r] of known.entries()) if (r) opts.onPart(i, r, true);
    if (!todo.length) return;
    const stitched = await stitchParts(this.backend, todo.map((i) => parts[i]));
    const chunks = planChunks(stitched.spans.map((s) => s.h), stitched.calmAfter);
    for (const chunk of chunks) {
      opts.onChunk?.(chunk.map((j) => todo[j]));
      const top = stitched.spans[chunk[0]].y;
      const last = stitched.spans[chunk[chunk.length - 1]];
      const band = this.backend.createCanvas(stitched.image.width, last.y + last.h - top);
      stitched.image.drawRegion(band.getContext('2d'), 0, top, stitched.image.width, last.y + last.h - top, stitched.image.width, last.y + last.h - top);
      const bytes = await this.backend.encode(band, 'image/png');
      const { result } = await this.translate(bytes, 'image/png', opts);
      const spans = chunk.map((j) => ({ y: stitched.spans[j].y - top, h: stitched.spans[j].h }));
      const derived = await this.deriveParts(result, spans, chunk.map((j) => parts[todo[j]]));
      for (const [n, j] of chunk.entries()) {
        await this.db.put('kv', `strip:${partKeys[todo[j]]}`, derived[n].key);
        opts.onPart(todo[j], derived[n], false);
      }
    }
  }

  /** Cut a glued result back into its pictures and store each one. */
  private async deriveParts(parent: StoredResult, spans: { y: number; h: number }[], originals?: StripPart[]): Promise<StoredResult[]> {
    const rendered = await tilesToImage(this.backend, parent.page.width, parent.page.height, parent.rendered);
    const cleaned = await tilesToImage(this.backend, parent.page.width, parent.page.height, parent.cleaned);
    const encode = (img: TiledImage, mime: ImageMime) => Promise.all(img.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, mime) })));
    const out: StoredResult[] = [];
    for (const [i, s] of spans.entries()) {
      const key = `${parent.key}~${i}`;
      const prev = await this.getResult(key);
      const original = originals?.[i] ? { bytes: originals[i].bytes, mime: originals[i].mime ?? 'image/png' } : prev?.original ?? parent.original;
      const r: StoredResult = {
        ...parent,
        key,
        page: pageForSpan(parent.page, s, i),
        rendered: await encode(cropRows(rendered, s.y, s.h), parent.mime),
        cleaned: await encode(cropRows(cleaned, s.y, s.h), 'image/png'),
        original,
        strip: { parent: parent.key, index: i, y: s.y, h: s.h },
        parts: undefined,
      };
      await this.db.put('results', key, r);
      out.push(r);
    }
    await this.db.put('results', parent.key, { ...parent, parts: out.map((r) => r.key) });
    return out;
  }

  /**
   * A local model that ran out of video memory gets three more tries, each lighter than the last:
   * other models unloaded, then a smaller context, then a smaller context and picture.
   */
  private async runFitting<T>(config: PipelineConfig, opts: TranslateOptions, run: (cfg: PipelineConfig) => Promise<T>): Promise<T> {
    let cfg = config;
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(cfg);
      } catch (e) {
        const err = toAppError(e);
        const vision = cfg.vision;
        if (err.code !== 'OUT_OF_MEMORY' || attempt >= 3 || !vision || !isLocalProvider(vision) || opts.signal?.aborted) throw err;
        opts.onStage?.({ stage: 'detecting', message: tr('Не хватило видеопамяти — освобождаю память и пробую ещё раз ({0} из 3)', attempt + 1) });
        if (attempt === 0) {
          if (isOllama(vision)) await ollamaUnloadAll(vision.baseUrl, this.fetchImpl).catch(() => undefined);
        } else {
          const numCtx = attempt === 1 ? 8192 : 4096;
          const lighter = <P extends PipelineConfig['vision']>(p: P): P => (p ? { ...p, numCtx: Math.min(p.numCtx ?? 16384, numCtx) } : p);
          cfg = { ...cfg, vision: lighter(cfg.vision), translator: lighter(cfg.translator), quality: attempt === 2 ? 'fast' : cfg.quality };
        }
      }
    }
  }

  /**
   * «Сверить страницу» from the editor: compare these blocks with the translators chosen in the
   * settings. Returns new blocks (with `check`) and the translators that did not answer.
   */
  async crossCheck(blocks: TextBlock[], targetLang: string, signal?: AbortSignal): Promise<{ blocks: TextBlock[]; errors: string[] }> {
    const { config } = await this.config();
    if (!config.crossCheck) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: tr('Включите сверку и выберите переводчиков в настройках.') });
    const copy: TextBlock[] = blocks.map((b) => ({ ...b, check: undefined }));
    const errors: string[] = [];
    const usage = await runCrossCheck(copy, { ...config, targetLang }, { fetchImpl: this.fetchImpl }, { signal, onError: (label, e) => errors.push(`${label}: ${toAppError(e).detail ?? toAppError(e).message}`) });
    await this.recordUsage(usage);
    return { blocks: copy, errors };
  }

  /**
   * Back translation for the editor: our translation translated back (into the original's language,
   * or English when that is unknown) to see whether the meaning survived. Uses the first machine
   * translator of «Сверка» allowed by the privacy mode, else the model that translates.
   */
  async backTranslate(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<{ texts: string[]; by: string }> {
    const { config } = await this.config();
    const target = to && to !== 'auto' && to !== 'und' ? to : 'en';
    const fetchImpl: FetchLike = this.fetchImpl ?? ((u, i) => fetch(u, i));
    for (const c of config.crossCheck?.checkers ?? []) {
      if (c.kind === 'llm' || (config.privacy === 'local' && checkerIsCloud(c))) continue;
      try {
        return { texts: await machineTranslate(c, c.apiKey, texts, from, target, fetchImpl, signal), by: CHECKER_LABELS[c.kind] };
      } catch (e) {
        if (toAppError(e).code === 'CANCELLED') throw e;
      }
    }
    const cfg = config.translator ?? config.vision;
    if (!cfg) throw new AppError('NOT_CONFIGURED', { retryable: false });
    const provider = createProvider(cfg, this.fetchImpl);
    const res = await translateBlocks(provider, { sourceLang: from, targetLang: target, profile: { ...config.profile, customPrompt: 'Translate literally, keep the meaning exactly.' }, glossary: [], translateSfx: true }, texts.map((text, i) => ({ id: `t${i}`, type: 'DIALOGUE', text })), { signal });
    await this.recordUsage(res.usage);
    return { texts: texts.map((_, i) => res.translations.get(`t${i}`)?.text ?? ''), by: cfg.model };
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
    const next: StoredResult = { ...stored, page: rendered.page, rendered: rendered.tiles, cleaned: cleanedTiles, lastHitAt: new Date().toISOString(), fontScale: settings.fonts.scale };
    await this.db.put('results', key, next);
    // A glued strip: cut the edited result back into its pictures too.
    if (stored.parts?.length) {
      const spans = [];
      for (const k of stored.parts) {
        const p = await this.getResult(k);
        if (p?.strip) spans.push({ y: p.strip.y, h: p.strip.h });
      }
      if (spans.length === stored.parts.length) await this.deriveParts({ ...next, parts: stored.parts }, spans);
    }
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

  /**
   * History entries older than `days`, and anything beyond the newest `max`, are removed.
   * (Entries are small: the pictures themselves live in the cache, pruned by pruneCache.)
   */
  async pruneHistory(days: number, max = 1000): Promise<number> {
    const cutoff = Date.now() - days * 86_400_000;
    const all = (await this.db.entries<HistoryEntry>('history')).sort((a, b) => b[1].date.localeCompare(a[1].date));
    let n = 0;
    for (const [i, [key, v]] of all.entries()) {
      if (i >= max || Date.parse(v.date) < cutoff) {
        await this.db.delete('history', key);
        n++;
      }
    }
    return n;
  }

  /** Housekeeping: old cache and old history (run on start and every few hours). */
  async prune(): Promise<{ cache: number; history: number }> {
    const s = await this.getSettings();
    return { cache: await this.pruneCache(s.cacheDays), history: await this.pruneHistory(s.historyDays ?? 30) };
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
