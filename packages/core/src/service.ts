import { AppError, toAppError } from './errors';
import { losslessWebp, type ImageBackend, type ImageMime } from './image/backend';
import { TiledImage } from './image/tiled';
import type { FetchLike } from './llm/types';
import { pipelineConfigFromSettings, pipelineHash, type PipelineConfig } from './pipeline/config';
import { renderOutput, runPipeline, styleDefaultsFor, type RenderedPage } from './pipeline/run';
import { DEFAULT_CACHE_MAX_MB, type AppSettings } from './settings';
import type { IdbStore } from './storage/idb';
import type { SecretStore } from './storage/secrets';
import { emptyContext, mergeContext, type TranslationContext } from './translate/context';
import type { PageResult, StageEvent, TextBlock, Usage } from './types';
import { sha256Hex, sniffImageMime } from './util/bytes';
import { tr } from './i18n';
import { preparePage, type Inpainter, type PreparedPage } from './pipeline/standalone';
import { QA_BATCH, qaPages } from './translate/qa';
import { translateBlocks } from './translate/translator';
import { createProvider } from './llm/presets';
import { assertPrivacy, isLocalProvider } from './llm/privacy';
import { isOllama } from './llm/openai';
import { ollamaUnloadAll } from './llm/discover';
import { cropRows, pageForSpan, planChunks, planStrip, shiftBlock, stitchChunk, type StripPart } from './image/strip';
import { KeyedMutex } from './util/mutex';

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
  /**
   * Made with lighter settings after the model ran out of video memory (smaller context / picture):
   * stored under its own key, so the full-quality key is tried again next time.
   */
  degraded?: boolean;
  /** Bytes the record takes (pictures + an estimate for the rest), for the cache size cap. */
  size?: number;
}

/** What the cache keeps per result besides the result itself: cheap to read for all results at once. */
interface CacheMeta {
  size: number;
  lastHitAt: string;
}

const META = 'cache:';

/** Bytes a stored result takes: its pictures plus an estimate for the text and boxes. */
export function resultSize(r: Pick<StoredResult, 'rendered' | 'cleaned' | 'original' | 'page'>): number {
  const tiles = (ts: { bytes: Uint8Array }[]) => ts.reduce((a, t) => a + t.bytes.length, 0);
  return tiles(r.rendered) + tiles(r.cleaned) + r.original.bytes.length + 2048 + r.page.blocks.length * 768;
}

export interface CacheUsage {
  /** Space the cached translations take, bytes / MB. */
  usedBytes: number;
  usedMb: number;
  /** The cap from the settings (cacheMaxMb), MB. */
  maxMb: number;
  results: number;
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
  /** Translate again, past the cache (⟳). Also asks the model when the text check finds nothing (see noSkip). */
  force?: boolean;
  /** Ask the model even when the local check finds no lettering; default: the same as `force`. */
  noSkip?: boolean;
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
  /** LaMa in this browser (set by the extension when the model is downloaded). */
  inpainter?: Inpainter;
  /**
   * A stored result changed after it was delivered (the batched translation check fixed it):
   * the app redraws the picture like after an edit (extension: 'result-changed').
   */
  onResultChanged?: (key: string) => void;
  /** Re-store finished pictures as lossless WebP in the background when the browser can (smaller cache). */
  compactTiles = true;
  /** Wait this long after a page before re-storing (the page reaches the screen first). */
  compactDelayMs = 2000;
  /** Read-modify-write of series contexts and usage totals by pages translated at the same time. */
  private locks = new KeyedMutex();
  /** The next picture, made ready while the model works on the current one (one at most). */
  private ahead: { id: string; promise: Promise<PreparedPage | undefined> } | null = null;
  /** Short pages waiting for the batched translation check, by chapter + settings. */
  private reviews = new Map<string, { items: PendingReview[]; timer?: ReturnType<typeof setTimeout> }>();
  private reviewRuns = new Set<Promise<void>>();
  /** Strip results being cut into pictures: a late review of one waits for that. */
  private deriving = new Map<string, Promise<unknown>>();
  private compactQueue: string[] = [];
  private compacting: Promise<void> | null = null;
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
    const tStart = performance.now();
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
    const baseKey = await this.cacheKey(bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) });
    const noSkip = opts.noSkip ?? !!opts.force;
    const prepared = await this.takeAhead(`${baseKey}|${noSkip ? 1 : 0}`);
    if (!opts.force) {
      const hit = await this.db.get<StoredResult>('results', baseKey);
      if (hit) {
        // Only the text size changed in the settings: draw the text again, no model needed.
        if ((hit.fontScale ?? 1) !== (settings.fonts.scale ?? 1) && !hit.strip) {
          const again = await this.saveEdited(baseKey, hit.page);
          opts.onStage?.({ stage: 'done', progress: 1, message: 'cache' });
          return { result: again, cached: true };
        }
        hit.lastHitAt = new Date().toISOString();
        // Only the small size record: the picture data is not written again.
        void this.markUsed(baseKey, hit).catch(() => undefined);
        opts.onStage?.({ stage: 'done', progress: 1, message: 'cache' });
        return { result: hit, cached: true };
      }
    }
    const context = opts.generic ? undefined : await this.getContext(seriesKey);
    let key = baseKey;
    try {
      const { value: out, lighter } = await this.runFitting(config, opts, (cfg) =>
        runPipeline(
          { bytes, mime: realMime, config: cfg, context, signal: opts.signal, onStage: opts.onStage, generic: opts.generic, noSkip, prepared, batchReview: !!config.qaBatch && !opts.generic },
          { backend: this.backend, fetchImpl: this.fetchImpl, inpaint: this.inpainter },
        ),
      );
      // A result made with lighter settings must not answer for the full-quality key.
      if (lighter) key = `${baseKey}:lite`;
      opts.onStage?.({ stage: 'rendering' });
      const rendered = await renderOutput(this.backend, out, styleDefaultsFor(config, settings.fonts));
      const cleanedTiles = await Promise.all(out.cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') })));
      const now = new Date().toISOString();
      const page = { ...rendered.page, timings: { ...rendered.page.timings, totalMs: Math.round(performance.now() - tStart) } };
      const result: StoredResult = {
        key,
        page,
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
        ...(lighter ? { degraded: true } : {}),
      };
      await this.putResult(key, result);
      if (out.reviewLater) this.queueReview({ key, seriesKey, config, context: out.context ?? context, blocks: structuredClone(page.blocks) });
      if (seriesKey && !opts.generic) {
        if (out.contextUpdate) {
          // Merge into the latest stored context: another page of the series may have finished meanwhile.
          const update = out.contextUpdate;
          await this.locks.run(`context:${seriesKey}`, async () => {
            const latest = (await this.getContext(seriesKey)) ?? emptyContext(seriesKey, seriesKey);
            await this.db.put('contexts', seriesKey, mergeContext(latest, update));
          });
        } else if (out.context) await this.db.put('contexts', seriesKey, out.context);
      }
      await this.recordUsage(rendered.page.usage);
      if (settings.saveHistory) await this.addHistory({ key, url: opts.sourceUrl, title: opts.title, date: now, pages: 1, targetLang: config.targetLang, model: (config.translator ?? config.vision)?.model ?? 'engine', status: 'done' });
      this.scheduleCompact(key);
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
   * Make a picture ready for the model (decode, look for lettering, encode for the vision model)
   * before its turn, while the model still works on the previous one. Only the latest picture is
   * kept (memory stays bounded); `translate` of the same bytes with the same settings takes it.
   * Never throws: a failed preparation only means the work is done again in `translate`.
   */
  async prefetch(bytes: Uint8Array, mime: string | undefined, opts: Pick<TranslateOptions, 'sourceUrl' | 'seriesKey' | 'generic' | 'force' | 'noSkip'> = {}): Promise<void> {
    try {
      const realMime = sniffImageMime(bytes);
      if (!realMime || realMime === 'image/tiff' || bytes.length > MAX_INPUT_BYTES) return;
      const seriesKey = opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl);
      const { settings, config } = await this.config(seriesKey);
      if (config.mode !== 'standalone') return;
      const key = await this.cacheKey(bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) });
      const noSkip = opts.noSkip ?? !!opts.force;
      const id = `${key}|${noSkip ? 1 : 0}`;
      if (this.ahead?.id === id) return void (await this.ahead.promise);
      const promise = preparePage({ bytes, mime: realMime, config, generic: opts.generic, noSkip }, { backend: this.backend, fetchImpl: this.fetchImpl }).catch(() => undefined);
      this.ahead = { id, promise };
      await promise;
    } catch {
      /* best effort */
    }
  }

  /** The prepared picture for this key, if it is the one prepared ahead (it is handed out once). */
  private async takeAhead(id: string): Promise<PreparedPage | undefined> {
    const a = this.ahead;
    if (!a || a.id !== id) return undefined;
    this.ahead = null;
    return a.promise;
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
    // Used again: keep the pieces and their glued parent out of the cache pruning.
    const touched = new Set<string>();
    for (const r of known) {
      if (!r) continue;
      for (const k of [r.key, r.strip?.parent]) if (k && !touched.has(k)) {
        touched.add(k);
        await this.touch(k);
      }
    }
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
    // Sizes and seams first (one picture in memory at a time), then each chunk is glued on its own:
    // a whole chapter is never held in memory at once.
    const todoParts = todo.map((i) => parts[i]);
    const plan = await planStrip(this.backend, todoParts);
    const chunks = planChunks(plan.spans.map((s) => s.h), plan.calmAfter);
    // Glue one chunk into one picture (PNG bytes).
    const glue = async (chunk: number[]): Promise<Uint8Array> => {
      const glued = await stitchChunk(this.backend, todoParts, plan, chunk);
      const band = this.backend.createCanvas(glued.width, glued.height);
      const bctx = band.getContext('2d');
      for (const t of glued.tiles) bctx.drawImage(t.canvas, 0, t.y);
      return this.backend.encode(band, 'image/png');
    };
    // The next chunk is glued and made ready (decoded, checked for text) while the model works on
    // this one; only one chunk ahead, so memory stays bounded.
    let next: Promise<Uint8Array> | null = chunks.length ? glue(chunks[0]) : null;
    for (const [c, chunk] of chunks.entries()) {
      opts.onChunk?.(chunk.map((j) => todo[j]));
      const top = plan.spans[chunk[0]].y;
      const bytes = await next!;
      next = null;
      const pending = this.translate(bytes, 'image/png', opts);
      if (c + 1 < chunks.length) {
        next = glue(chunks[c + 1]).then(async (b) => {
          await this.prefetch(b, 'image/png', opts);
          return b;
        });
      }
      let result: StoredResult;
      try {
        ({ result } = await pending);
      } catch (e) {
        next?.catch(() => undefined);
        throw e;
      }
      const spans = chunk.map((j) => ({ y: plan.spans[j].y - top, h: plan.spans[j].h }));
      const deriving = this.deriveParts(result, spans, chunk.map((j) => todoParts[j]));
      this.deriving.set(result.key, deriving);
      let derived: StoredResult[];
      try {
        derived = await deriving;
      } finally {
        this.deriving.delete(result.key);
      }
      for (const [n, j] of chunk.entries()) {
        // A lighter (out-of-memory) result is shown but not remembered: next time try full quality.
        if (!result.degraded) await this.db.put('kv', `strip:${partKeys[todo[j]]}`, derived[n].key);
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
        // PNG first (fast, lossless); re-stored as lossless WebP in the background.
        rendered: await encode(cropRows(rendered, s.y, s.h), 'image/png'),
        mime: 'image/png',
        cleaned: await encode(cropRows(cleaned, s.y, s.h), 'image/png'),
        original,
        strip: { parent: parent.key, index: i, y: s.y, h: s.h },
        parts: undefined,
      };
      await this.putResult(key, r);
      this.scheduleCompact(key);
      out.push(r);
    }
    await this.putResult(parent.key, { ...parent, parts: out.map((r) => r.key) });
    return out;
  }

  /**
   * A local model that ran out of video memory gets three more tries, each lighter than the last:
   * other models unloaded, then a smaller context, then a smaller context and picture.
   */
  private async runFitting<T>(config: PipelineConfig, opts: TranslateOptions, run: (cfg: PipelineConfig) => Promise<T>): Promise<{ value: T; lighter: boolean }> {
    let cfg = config;
    for (let attempt = 0; ; attempt++) {
      try {
        return { value: await run(cfg), lighter: cfg !== config };
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
   * Back translation for the editor: our translation translated back (into the original's language,
   * or English when that is unknown) to see whether the meaning survived, by the model that translates.
   */
  async backTranslate(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<{ texts: string[]; by: string }> {
    const { config } = await this.config();
    const target = to && to !== 'auto' && to !== 'und' ? to : 'en';
    const cfg = config.translator ?? config.vision;
    if (!cfg) throw new AppError('NOT_CONFIGURED', { retryable: false });
    // The texts leave the device only where the privacy mode allows.
    assertPrivacy(config.privacy, cfg, 'text');
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
    // A picture cut out of a glued strip: the edit goes into the strip, which is cut again, so a
    // later re-cut (another picture edited, text size changed) keeps it.
    if (stored.strip) {
      const synced = await this.saveIntoParent(stored, page, cleaned);
      if (synced) return synced;
    }
    const settings = await this.getSettings();
    let image = cleaned;
    if (!image) image = await tilesToImage(this.backend, stored.page.width, stored.page.height, stored.cleaned);
    const rendered = await renderOutput(this.backend, { page, cleaned: image }, styleDefaultsFor({ targetLang: page.targetLang, sfxStyle: settings.sfxStyle }, settings.fonts));
    const cleanedTiles = cleaned ? await Promise.all(cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') }))) : stored.cleaned;
    const next: StoredResult = { ...stored, page: rendered.page, rendered: rendered.tiles, cleaned: cleanedTiles, lastHitAt: new Date().toISOString(), fontScale: settings.fonts.scale };
    await this.putResult(key, next);
    this.scheduleCompact(key);
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

  /** Put the edits of one picture of a strip into its glued parent and cut the parent again. */
  private async saveIntoParent(part: StoredResult, page: PageResult, cleaned?: TiledImage): Promise<StoredResult | undefined> {
    const parent = part.strip ? await this.getResult(part.strip.parent) : undefined;
    if (!part.strip || !parent?.parts?.includes(part.key)) return undefined;
    const dy = part.strip.y;
    const toParent = (b: TextBlock): TextBlock => {
      const { continued: _continued, ...rest } = b;
      return shiftBlock(rest, -dy);
    };
    const before = new Set(part.page.blocks.map((b) => b.id));
    const after = new Map(page.blocks.map((b) => [b.id, b]));
    const blocks: TextBlock[] = [];
    for (const b of parent.page.blocks) {
      const edited = after.get(b.id);
      if (edited) {
        blocks.push(toParent(edited));
        after.delete(b.id);
      } else if (!before.has(b.id)) blocks.push(b); // another picture's block
      // else: removed in this picture
    }
    for (const b of after.values()) blocks.push(toParent(b)); // added in this picture
    let parentCleaned: TiledImage | undefined;
    if (cleaned) {
      parentCleaned = await tilesToImage(this.backend, parent.page.width, parent.page.height, parent.cleaned);
      for (const t of parentCleaned.tiles) {
        const ctx = t.canvas.getContext('2d');
        for (const s of cleaned.tiles) {
          const y = dy + s.y;
          if (y + s.h <= t.y || y >= t.y + t.h) continue;
          ctx.drawImage(s.canvas, 0, y - t.y);
        }
      }
    }
    await this.saveEdited(parent.key, { ...parent.page, blocks, targetLang: page.targetLang }, parentCleaned);
    return this.getResult(part.key);
  }

  /** Mark a cached result as used now (cache pruning drops results not used for a while). */
  private async touch(key: string): Promise<void> {
    const r = await this.getResult(key);
    if (!r) return;
    r.lastHitAt = new Date().toISOString();
    await this.markUsed(key, r);
  }

  /** Remember that a cached result was used now (cache pruning goes by the size records). */
  private async markUsed(key: string, r: StoredResult): Promise<void> {
    await this.db.put('kv', `${META}${key}`, { size: r.size ?? resultSize(r), lastHitAt: r.lastHitAt } satisfies CacheMeta);
  }

  async addHistory(e: HistoryEntry): Promise<void> {
    await this.db.put('history', `${e.date}:${e.key}`, e);
  }

  async history(limit = 200): Promise<HistoryEntry[]> {
    const all = await this.db.entries<HistoryEntry>('history');
    return all.map(([, v]) => v).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  }

  /** Add up tokens and cost; `page` = false for a request that is not a page of its own (a batched review). */
  async recordUsage(usage: Usage[], page = true): Promise<void> {
    if (!usage.length) return;
    // One update at a time: pages finishing together must not lose each other's counts.
    await this.locks.run('usage', async () => {
      const totals = (await this.db.get<UsageTotals>('usage', 'totals')) ?? { pages: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      if (page) totals.pages++;
      for (const u of usage) {
        totals.inputTokens += u.inputTokens;
        totals.outputTokens += u.outputTokens;
        totals.costUsd += u.costUsd;
      }
      await this.db.put('usage', 'totals', totals);
    });
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
    return { cache: await this.pruneCache(s.cacheDays, s.cacheMaxMb ?? DEFAULT_CACHE_MAX_MB), history: await this.pruneHistory(s.historyDays ?? 30) };
  }

  /**
   * Drop cached results not used for `days` days, then the least recently used ones until the
   * cache takes at most `maxMb`. Works from the small size records (see putResult): the pictures
   * are not read, except once for results stored before sizes were kept.
   */
  async pruneCache(days: number, maxMb = Infinity): Promise<number> {
    const cutoff = Date.now() - days * 86_400_000;
    const metas = await this.cacheIndex();
    let n = 0;
    const kept = new Set<string>();
    let used = 0;
    const alive: [string, CacheMeta][] = [];
    for (const [key, m] of metas) {
      if (Date.parse(m.lastHitAt) < cutoff) {
        await this.dropResult(key);
        n++;
      } else {
        alive.push([key, m]);
        used += m.size;
      }
    }
    // Over the cap: oldest use first.
    alive.sort((a, b) => a[1].lastHitAt.localeCompare(b[1].lastHitAt));
    const cap = maxMb * 1024 * 1024;
    for (const [key, m] of alive) {
      if (used > cap) {
        await this.dropResult(key);
        used -= m.size;
        n++;
      } else kept.add(key);
    }
    // Links from a strip picture to its cut-out result: drop those whose result is gone.
    for (const [key, ref] of await this.db.entries<string>('kv')) {
      if (key.startsWith('strip:') && !kept.has(ref)) await this.db.delete('kv', key);
    }
    return n;
  }

  /** How much space the cache takes (for «Занято: N МБ из M»). */
  async cacheUsage(): Promise<CacheUsage> {
    const s = await this.getSettings();
    const metas = await this.cacheIndex();
    let usedBytes = 0;
    for (const m of metas.values()) usedBytes += m.size;
    return { usedBytes, usedMb: Math.round((usedBytes / 1048576) * 10) / 10, maxMb: s.cacheMaxMb ?? DEFAULT_CACHE_MAX_MB, results: metas.size };
  }

  /**
   * Size and last use of every cached result, from the small records kept next to them. Results
   * stored before those records existed are measured once (one at a time); records of results
   * that are gone (cache cleared from the settings) are dropped.
   */
  private async cacheIndex(): Promise<Map<string, CacheMeta>> {
    const keys = new Set(await this.db.keys('results'));
    const metas = new Map<string, CacheMeta>();
    for (const [k, v] of await this.db.entries<unknown>('kv')) {
      if (!k.startsWith(META)) continue;
      const key = k.slice(META.length);
      if (keys.has(key)) metas.set(key, v as CacheMeta);
      else await this.db.delete('kv', k);
    }
    for (const key of keys) {
      if (metas.has(key)) continue;
      const r = await this.getResult(key);
      if (!r) continue;
      const meta = { size: r.size ?? resultSize(r), lastHitAt: r.lastHitAt ?? r.createdAt ?? new Date(0).toISOString() };
      await this.db.put('kv', `${META}${key}`, meta);
      metas.set(key, meta);
    }
    return metas;
  }

  private async dropResult(key: string): Promise<void> {
    await this.db.delete('results', key);
    await this.db.delete('kv', `${META}${key}`);
  }

  /** Store a result with its size record. All writes of results go through here (or updateResult). */
  private async putResult(key: string, r: StoredResult): Promise<void> {
    await this.locks.run(`put:${key}`, () => this.write(key, r));
  }

  private async write(key: string, r: StoredResult): Promise<void> {
    r.size = resultSize(r);
    await this.db.put('results', key, r);
    await this.db.put('kv', `${META}${key}`, { size: r.size, lastHitAt: r.lastHitAt } satisfies CacheMeta);
  }

  /**
   * Read-modify-write of a stored result under a per-key lock: `fn` gets the stored record and
   * returns the new one, or null to leave it (a background write that a user's edit overtook).
   */
  private async updateResult(key: string, fn: (current: StoredResult | undefined) => Promise<StoredResult | null>): Promise<boolean> {
    return this.locks.run(`put:${key}`, async () => {
      const r = await fn(await this.getResult(key));
      if (!r) return false;
      await this.write(key, r);
      return true;
    });
  }

  // ---- lossless WebP in the background ------------------------------------------------------

  /** Re-store a result's pictures as lossless WebP later (smaller cache; nothing on the way to the screen). */
  private scheduleCompact(key: string): void {
    if (!this.compactTiles) return;
    if (!this.compactQueue.includes(key)) this.compactQueue.push(key);
    if (this.compacting) return;
    this.compacting = (async () => {
      // Let the page reach the screen first; the encoder then runs while the model reads the next one.
      await new Promise((r) => setTimeout(r, this.compactDelayMs));
      while (this.compactQueue.length) {
        const k = this.compactQueue.shift()!;
        try {
          await this.compact(k);
        } catch {
          /* the PNG copy stays: nothing lost */
        }
      }
    })().finally(() => {
      this.compacting = null;
      if (this.compactQueue.length) this.scheduleCompact(this.compactQueue[0]);
    });
  }

  /** Wait for the background WebP re-store (tests, before a measurement). */
  async compactIdle(): Promise<void> {
    while (this.compacting) await this.compacting;
  }

  private async compact(key: string): Promise<void> {
    if (!(await losslessWebp(this.backend))) return;
    const r = await this.getResult(key);
    if (!r) return;
    const isWebp = (t: { bytes: Uint8Array }) => sniffImageMime(t.bytes) === 'image/webp';
    if (r.rendered.every(isWebp) && r.cleaned.every(isWebp)) return;
    const before = await tilesHash(r);
    const recode = (tiles: { y: number; h: number; bytes: Uint8Array }[]) =>
      Promise.all(
        tiles.map(async (t) => {
          if (isWebp(t)) return t;
          const d = await this.backend.decode(t.bytes, sniffImageMime(t.bytes) ?? 'image/png');
          try {
            const c = this.backend.createCanvas(d.width, d.height);
            c.getContext('2d').drawImage(d.source, 0, 0);
            const webp = await this.backend.encode(c, 'image/webp', 1);
            // Only when it is really smaller.
            return webp.length < t.bytes.length && sniffImageMime(webp) === 'image/webp' ? { y: t.y, h: t.h, bytes: webp } : t;
          } finally {
            d.close?.();
          }
        }),
      );
    const rendered = await recode(r.rendered);
    const cleaned = await recode(r.cleaned);
    // Mixed tiles (a WebP tile that came out larger stays PNG) keep the old `mime`: readers sniff the bytes.
    const mime: ImageMime = rendered.every(isWebp) ? 'image/webp' : r.mime;
    await this.updateResult(key, async (cur) => (cur && (await tilesHash(cur)) === before ? { ...cur, rendered, cleaned, mime } : null));
  }

  // ---- batched translation check ------------------------------------------------------------

  /** A short page waits (up to QA_BATCH.waitMs, or until 4 pages) to be reviewed with its neighbours. */
  private queueReview(item: PendingReview): void {
    const group = `${item.seriesKey ?? ''}|${item.config.targetLang}|${(item.config.translator ?? item.config.vision)?.id ?? ''}`;
    let g = this.reviews.get(group);
    if (!g) this.reviews.set(group, (g = { items: [] }));
    g.items.push(item);
    if (g.items.length >= QA_BATCH.maxPages) this.flushReviewGroup(group);
    else if (!g.timer) g.timer = setTimeout(() => this.flushReviewGroup(group), QA_BATCH.waitMs);
  }

  private flushReviewGroup(group: string): void {
    const g = this.reviews.get(group);
    if (!g) return;
    this.reviews.delete(group);
    if (g.timer) clearTimeout(g.timer);
    const run = this.reviewBatch(g.items).catch(() => undefined);
    this.reviewRuns.add(run);
    void run.finally(() => this.reviewRuns.delete(run));
  }

  /** Send every waiting review now and wait for all of them (tests; before closing). */
  async flushReviews(): Promise<void> {
    for (const group of [...this.reviews.keys()]) this.flushReviewGroup(group);
    while (this.reviewRuns.size) await Promise.all([...this.reviewRuns]);
  }

  private async reviewBatch(items: PendingReview[]): Promise<void> {
    const config = items[0].config;
    const cfg = config.translator ?? config.vision;
    if (!cfg) return;
    // runPipeline checked the privacy mode before it put the page here; checked again all the same.
    assertPrivacy(config.privacy, cfg, 'text');
    const provider = createProvider(cfg, this.fetchImpl);
    const pages = items.map((i) => i.blocks);
    const usage = await qaPages(pages, { provider, mode: config.qa ?? 'fix', targetLang: config.targetLang, glossary: config.glossary, context: items[items.length - 1].context });
    for (const [i, item] of items.entries()) await this.applyReview(item.key, pages[i], i === 0 ? usage : []);
    await this.recordUsage(usage, false);
  }

  /** Put the reviewer's notes and fixes into the stored result; redraw and tell the app when text changed. */
  private async applyReview(key: string, reviewed: TextBlock[], usage: Usage[]): Promise<void> {
    await this.deriving.get(key)?.catch(() => undefined);
    const stored = await this.getResult(key);
    if (!stored) return;
    const byId = new Map(reviewed.map((b) => [b.id, b]));
    let any = false;
    let changed = false;
    const blocks = stored.page.blocks.map((b) => {
      const r = byId.get(b.id);
      // Only blocks that still read as when they were reviewed (not edited by hand meanwhile).
      if (!r?.qa || b.edited || b.translatedText !== (r.qa.before ?? r.translatedText)) return b;
      any = true;
      if (r.translatedText !== b.translatedText) changed = true;
      return { ...b, translatedText: r.translatedText, qa: r.qa };
    });
    if (!any) return;
    const page: PageResult = { ...stored.page, blocks, usage: [...stored.page.usage, ...usage] };
    if (changed) {
      const next = await this.saveEdited(key, page);
      for (const k of [key, ...(next.parts ?? [])]) this.onResultChanged?.(k);
    } else {
      await this.putResult(key, { ...stored, page });
      // The notes changed too (shown in the editor): the pictures stay the same.
      if (stored.parts?.length) for (const k of stored.parts) {
        const part = await this.getResult(k);
        if (part?.strip) await this.putResult(k, { ...part, page: pageForSpan(page, { y: part.strip.y, h: part.strip.h }, part.strip.index) });
      }
    }
  }
}

interface PendingReview {
  key: string;
  seriesKey?: string;
  config: PipelineConfig;
  context?: TranslationContext;
  /** The page's blocks as delivered (the review works on this copy). */
  blocks: TextBlock[];
}

async function tilesHash(r: Pick<StoredResult, 'rendered' | 'cleaned'>): Promise<string> {
  const parts = [...r.rendered, ...r.cleaned];
  const total = parts.reduce((a, t) => a + t.bytes.length + 8, 0);
  const all = new Uint8Array(total);
  let o = 0;
  for (const t of parts) {
    all.set(t.bytes, o);
    o += t.bytes.length;
    new DataView(all.buffer).setUint32(o, t.y);
    new DataView(all.buffer).setUint32(o + 4, t.h);
    o += 8;
  }
  return sha256Hex(all);
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
    // PNG, or lossless WebP once re-stored (see TranslateService.compact).
    const img = await backend.decode(t.bytes, sniffImageMime(t.bytes) ?? 'image/png');
    for (const tile of image.tiles) {
      if (tile.y + tile.h <= t.y || tile.y >= t.y + t.h) continue;
      tile.canvas.getContext('2d').drawImage(img.source, 0, t.y - tile.y);
    }
    img.close?.();
  }
  return image;
}
