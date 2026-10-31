import { isBrowserTranslator } from './llm/browserTranslator';
import { AppError, toAppError } from './errors';
import { losslessWebp, releaseCanvas, type ImageBackend, type ImageMime } from './image/backend';
import { TiledImage } from './image/tiled';
import type { FetchLike } from './llm/types';
import { pipelineConfigFromSettings, pipelineHash, type PipelineConfig } from './pipeline/config';
import { renderOutput, runPipeline, styleDefaultsFor, type RenderedPage } from './pipeline/run';
import type { PageWorkers } from './pipeline/remote';
import { FALLBACK_ON, fallbackConfig } from './pipeline/fallback';
import { upscaleBytes, type UpscaleNet } from './image/upscale';
import { CpuLane } from './util/cpuLane';
import { DEFAULT_CACHE_MAX_MB, type AppSettings } from './settings';
import type { IdbStore } from './storage/idb';
import type { SecretStore } from './storage/secrets';
import { emptyContext, mergeContext, withoutPage, type TranslationContext } from './translate/context';
import type { PageResult, StageEvent, TextBlock, Usage } from './types';
import { sha256Hex, sniffImageMime } from './util/bytes';
import { tr } from './i18n';
import { preparePage, type Inpainter, type PipelineOutput, type PreparedPage } from './pipeline/standalone';
import type { TextDetector } from './pipeline/detect';
import type { TextReader } from './pipeline/standalone';
import { QA_BATCH, qaPages } from './translate/qa';
import { translateBlocks } from './translate/translator';
import { continuesNext } from './translate/continuation';
import { createProvider } from './llm/presets';
import { assertPrivacy, isLocalProvider } from './llm/privacy';
import { isOllama } from './llm/openai';
import { ollamaLoaded, ollamaUnloadAll } from './llm/discover';
import { cropRows, pageForSpan, planChunks, planStrip, shiftBlock, stitchChunk, type StripPart } from './image/strip';
import { KeyedMutex } from './util/mutex';

export interface StoredResult {
  key: string;
  /** Raised by every edit (saveEdited): a background write based on an older copy is not stored over it. */
  rev?: number;
  /** Translated as screen/UI text (see TranslateOptions.generic). */
  generic?: boolean;
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
  /** Neighbour pictures whose shared seam was translated as one band (see repairSeam). */
  seams?: string[];
  /** A strip glued after the fact from pictures translated one by one (see repairSeam): it grows at its ends. */
  seamGroup?: boolean;
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
  /** Settings for this call only, over the stored ones (the speed comparison tries other models). */
  settings?: Partial<AppSettings>;
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
  /** Its place among the pages in work (the processor goes to the lowest first); given by `translate`. */
  order?: number;
}

export const MAX_INPUT_BYTES = 60 * 1024 * 1024;
/** Pages kept in the journal (a 300-page chapter fits). */
export const JOURNAL_MAX = 600;
/** Results used this recently are kept even over the cache size cap (see pruneCache). */
export const RECENT_KEEP_MS = 12 * 3_600_000;

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
  /** How the model's check of pages already shown talks to the model (a lower priority on the video card); the usual fetch otherwise. */
  reviewFetch?: FetchLike;
  /** The upscaler for small scans in this browser (set by the extension when the model is downloaded; see image/upscale.ts). */
  upscaler?: UpscaleNet;
  /** Pictures made bigger lately, by the hash of their bytes (the page prepared ahead and its translation share one). */
  private enlarged = new Map<string, Promise<Uint8Array | null>>();
  /** The neural text / bubble detector in this browser (set by the extension when the model is downloaded). */
  detector?: TextDetector;
  /** Text recognition in this browser (set by the extension when the models are downloaded). */
  reader?: TextReader;
  /** Background threads for the pages' pixel work (set by the extension; see pipeline/remote.ts). */
  pageWorkers?: PageWorkers;
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
  /**
   * Pictures prepared ahead, by key. Two slots: the queue may start preparing page N+2 before page
   * N+1 has picked up its own preparation; one slot would throw that work away.
   */
  private ahead = new Map<string, Promise<PreparedPage | undefined>>();
  /** Frees the video memory of the neural nets in this app (detector, LaMa) before a retry after «out of memory». */
  releaseGpu?: () => Promise<void>;
  /** Short pages waiting for the batched translation check, by chapter + settings. */
  private reviews = new Map<string, { items: PendingReview[]; timer?: ReturnType<typeof setTimeout> }>();
  private reviewRuns = new Set<Promise<void>>();
  /** Strip results being cut into pictures: a late review of one waits for that. */
  private deriving = new Map<string, Promise<unknown>>();
  /** Per series: done when the latest started page has its context merged (see freshContext). */
  private turns = new Map<string, Promise<void>>();
  /** The processor's stretches of pixel work, page by page in the order the pages were started. */
  private cpuLane = new CpuLane();
  private pageSeq = 0;
  /** Pages that let the next one of their series go and are still being drawn and stored. */
  private storing = new Map<string, Promise<void>>();
  /** How long a page waits for the previous one's context (tests make it short). */
  turnWaitMs?: number;
  /** The last speech line at the bottom of the series' latest page (a sentence may go on on the next one). */
  private tails = new Map<string, { key: string; blockId: string; src: string; dst: string; type: TextBlock['textType']; at: number }>();
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

  async config(seriesKey?: string, over?: Partial<AppSettings>): Promise<{ settings: AppSettings; config: PipelineConfig }> {
    const settings = { ...(await this.settingsWithKeys()), ...over };
    return { settings, config: pipelineConfigFromSettings(settings, seriesKey) };
  }

  /** Same picture + same settings that change the result (incl. fonts and screen-text mode) = same key. */
  async cacheKey(bytes: Uint8Array, config: PipelineConfig, extra: { generic?: boolean; fonts?: unknown } = {}): Promise<string> {
    const look = extra.generic || extra.fonts ? `:${(await sha256Hex(JSON.stringify([!!extra.generic, extra.fonts ?? null]))).slice(0, 8)}` : '';
    return `${(await sha256Hex(bytes)).slice(0, 40)}:${await pipelineHash(config)}${look}`;
  }

  /**
   * The stored result of this picture with the current settings, if there is one (no model, no
   * queue): a page opened again shows what was translated at once, without waiting behind the
   * pages that are really being translated. Null when it would need drawing again (text size).
   */
  async cachedResult(bytes: Uint8Array, opts: { sourceUrl?: string; seriesKey?: string; generic?: boolean } = {}): Promise<StoredResult | undefined> {
    const { settings, config } = await this.config(opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl));
    const hit = await this.db.get<StoredResult>('results', await this.cacheKey(bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) }));
    if (!hit || (hit.fontScale ?? 1) !== (settings.fonts.scale ?? 1)) return undefined;
    return hit;
  }

  /** The stored pieces of a strip, every one of them, or undefined when any is missing (see translateStrip). */
  async cachedStrip(parts: { bytes: Uint8Array }[], opts: { sourceUrl?: string; seriesKey?: string; generic?: boolean } = {}): Promise<StoredResult[] | undefined> {
    const { settings, config } = await this.config(opts.seriesKey ?? seriesKeyFromUrl(opts.sourceUrl));
    const out: StoredResult[] = [];
    for (const p of parts) {
      const ref = await this.db.get<string>('kv', `strip:${await this.cacheKey(p.bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) })}`);
      const r = ref ? await this.getResult(ref) : undefined;
      if (!r || (r.fontScale ?? 1) !== (settings.fonts.scale ?? 1)) return undefined;
      out.push(r);
    }
    return out;
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
    // Its place among the pages in work: the processor goes to the page started first.
    opts = { ...opts, order: opts.order ?? this.pageSeq++ };
    // Pages of one series in order: this one may read while the previous is still being finished,
    // but translates with the context the previous one leaves. The turn is taken at once (before any
    // await), so pages started one after another keep their order.
    let releaseTurn = () => {};
    const turnKey = seriesKey && !opts.generic ? seriesKey : undefined;
    const before = turnKey ? this.turns.get(turnKey) : undefined;
    if (turnKey) {
      const mine = new Promise<void>((r) => (releaseTurn = r));
      this.turns.set(turnKey, mine);
      const done = releaseTurn;
      releaseTurn = () => {
        done();
        if (this.turns.get(turnKey) === mine) this.turns.delete(turnKey);
      };
    }
    try {
      return await this.translateInTurn(bytes, realMime, opts, seriesKey, tStart, before, releaseTurn);
    } finally {
      releaseTurn();
    }
  }

  private async translateInTurn(bytes: Uint8Array, realMime: string, opts: TranslateOptions, seriesKey: string | undefined, tStart: number, before: Promise<void> | undefined, releaseTurn: () => void): Promise<{ result: StoredResult; cached: boolean }> {
    const { settings, config } = await this.config(seriesKey, opts.settings);
    if (opts.keepAliveMin !== undefined) {
      for (const k of ['vision', 'translator'] as const) {
        const p = config[k];
        if (p) config[k] = { ...p, keepAliveMin: Math.max(p.keepAliveMin ?? 0, opts.keepAliveMin) };
      }
    }
    const baseKey = await this.cacheKey(bytes, config, { generic: opts.generic, fonts: lookOf(settings.fonts) });
    const noSkip = opts.noSkip ?? !!opts.force;
    const aheadId = `${baseKey}|${noSkip ? 1 : 0}`;
    if (!opts.force) {
      const hit = (await this.db.get<StoredResult>('results', baseKey)) ?? (await this.otherLook(baseKey, !!opts.generic));
      if (hit) {
        // A cached page never waits for a picture prepared ahead (detector windows it does not need).
        this.ahead.delete(aheadId);
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
    const prepared = await this.takeAhead(aheadId);
    const context = opts.generic ? undefined : await this.getContext(seriesKey);
    let key = baseKey;
    // Never wait for ever: a previous page that is stuck (or slow) does not hold this one; it
    // translates with the context there is.
    // The browser's translator uses no context of the series: nothing to wait for.
    const textBy = config.ocr ? config.translator ?? config.vision : config.vision;
    const waitMs = this.turnWaitMs ?? (isBrowserTranslator(textBy) ? 0 : textBy && isLocalProvider(textBy) ? TURN_WAIT_LOCAL_MS : TURN_WAIT_MS);
    const freshContext = before && waitMs > 0 ? async () => {
      await waitFor(before, waitMs, opts.signal);
      return this.getContext(seriesKey);
    } : undefined;
    // Called once the page is stored — or failed (whoever waits for it to be stored goes on).
    let stored: () => void = () => {};
    try {
      // A small scan twice as big (the cache key stays the one of the bytes as they came).
      const pic = await this.enlarge(bytes, realMime, config, opts.signal);
      const run = (cfg: PipelineConfig, ahead = prepared) =>
        this.pipeline(
          settings,
          { bytes: pic.bytes, mime: pic.mime, config: cfg, context, signal: opts.signal, onStage: opts.onStage, generic: opts.generic, noSkip, prepared: ahead, batchReview: !opts.generic, freshContext },
          { backend: this.backend, fetchImpl: this.fetchImpl, inpaint: this.inpainter, detect: this.detector, ocr: this.reader, cpu: this.cpuFor(opts.order) },
        );
      const { value: out, lighter, fallback } = await this.runWithStandIn(config, settings, opts, run);
      // A result made with lighter settings or by the stand-in must not answer for the full-quality
      // key: the next time the usual model is asked again.
      if (lighter) key = `${baseKey}:lite`;
      if (fallback) key = `${baseKey}:fb`;
      if (seriesKey && !opts.generic) await this.joinWithPrevious(seriesKey, out.page, config, context, opts.signal).catch((e) => {
        if ((e as { code?: string }).code === 'CANCELLED') throw e;
      });
      // The series context as soon as it is known (before drawing and storing).
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
      // Context merged and the sentence tail known: the next page of the series may translate now,
      // while this one is drawn and stored (it waits for that only to join a sentence across them).
      if (seriesKey && !opts.generic) this.rememberTail(seriesKey, key, out.page);
      const storedKey = key;
      this.storing.set(storedKey, new Promise<void>((r) => (stored = () => (r(), this.storing.get(storedKey) && this.storing.delete(storedKey)))));
      releaseTurn();
      opts.onStage?.({ stage: 'rendering' });
      // Typesetting and encoding: this page's stretch on the processor.
      const { rendered, cleanedTiles, tStore } = await this.cpuFor(opts.order)(async () => {
        const rendered = await renderOutput(this.backend, out, styleDefaultsFor(config, settings.fonts));
        const tStore = performance.now();
        const cleanedTiles = await Promise.all(out.cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') })));
        return { rendered, cleanedTiles, tStore };
      });
      // The page's pictures are bytes now: their canvases (video memory in a browser, which the
      // garbage collector does not see) go at once — a chapter of 170 pages must not pile them up.
      out.cleaned.dispose();
      if (out.original !== out.cleaned) out.original?.dispose();
      const now = new Date().toISOString();
      const page = { ...rendered.page, timings: { ...rendered.page.timings, totalMs: Math.round(performance.now() - tStart) } };
      const result: StoredResult = {
        key,
        page,
        rendered: rendered.tiles,
        mime: rendered.mime,
        // The picture the texts' places belong to: the enlarged one when the scan was made bigger.
        original: { bytes: pic.bytes, mime: pic.mime },
        cleaned: cleanedTiles,
        sourceUrl: opts.sourceUrl,
        title: opts.title,
        seriesKey,
        createdAt: now,
        lastHitAt: now,
        fontScale: settings.fonts.scale,
        ...(lighter ? { degraded: true } : {}),
        ...(opts.generic ? { generic: true } : {}),
      };
      await this.putResult(key, result);
      stored();
      void this.journal({ key, page, storeMs: Math.round(performance.now() - tStore), vision: config.vision, force: opts.force }).catch(() => undefined);
      if (out.reviewLater) this.queueReview({ key, seriesKey, config, context: out.context ?? context, blocks: structuredClone(page.blocks) }, out.reviewLater === 'now');
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
    } finally {
      stored();
      releaseTurn();
    }
  }

  /**
   * Two neighbouring pictures of a strip were translated one by one, and a bubble is cut by the seam
   * between them (the site cut the strip through a line of text: «WHAT IS THE USE» half on each).
   * The band around the seam — the cut part of the upper picture and of the lower one — is translated
   * as one picture (one small request), and the pictures become one glued strip, like pictures that
   * arrived together: the band's text goes in once, is drawn once across the seam, and each picture
   * shows its part. A picture already joined at its other seam brings its whole group along.
   * Returns false when there is nothing to do (no cut, done before, a strip of another kind, other widths).
   */
  async repairSeam(upperKey: string, lowerKey: string, opts: { signal?: AbortSignal } = {}): Promise<boolean> {
    const up = await this.getResult(upperKey);
    const lo = await this.getResult(lowerKey);
    if (!up || !lo || up.generic || lo.generic || up.parts?.length || lo.parts?.length) return false;
    if (up.seams?.includes(lowerKey) || (up.strip && lo.strip && up.strip.parent === lo.strip.parent)) return false;
    const groupOf = async (r: StoredResult): Promise<StoredResult[] | null> => {
      if (!r.strip) return [r];
      const parent = await this.getResult(r.strip.parent);
      // Pictures glued because they arrived together are left as they are; seam groups grow.
      if (!parent?.seamGroup || !parent.parts) return null;
      const all = await Promise.all(parent.parts.map((k) => this.getResult(k)));
      return all.every(Boolean) ? (all as StoredResult[]) : null;
    };
    const left = await groupOf(up);
    const right = await groupOf(lo);
    if (!left || !right || left[left.length - 1].key !== upperKey || right[0].key !== lowerKey) return false;
    const members = [...left, ...right];
    const W = up.page.width;
    if (members.some((m) => m.page.width !== W)) return false;
    const H = up.page.height;
    let cutUp = up.page.blocks.filter((b) => touchesEdge(b, H, 'bottom'));
    let cutLo = lo.page.blocks.filter((b) => touchesEdge(b, lo.page.height, 'top'));
    if (!cutUp.length && !cutLo.length) {
      // The line on the seam itself was cut in half and read on neither side («THE FAIRY WAR»
      // between «ВОЙНА ФЕЙ» above and «ЗАСТАВЛЯЕТ…» below): text close to the seam, and letters
      // drawn across it (the seam is not calm).
      const near = Math.max(24, Math.round(W * 0.08));
      cutUp = up.page.blocks.filter((b) => touchesEdge(b, H - near, 'bottom'));
      cutLo = lo.page.blocks.filter((b) => touchesEdge(b, lo.page.height, 'top', near));
      if (!cutUp.length && !cutLo.length) return false;
      const plan = await planStrip(this.backend, [up.original, lo.original]);
      if (plan.calmAfter[0]) return false;
    }
    // The band: from the top of what is cut in the upper picture to the bottom of what is cut in the
    // lower one (a third of the width on a side where nothing was read).
    const topOf = (b: TextBlock) => Math.min(b.bbox[1], b.bubble?.box[1] ?? Infinity);
    const bottomOf = (b: TextBlock) => Math.max(b.bbox[1] + b.bbox[3], b.bubble ? b.bubble.box[1] + b.bubble.box[3] : 0);
    const pad = Math.round(W * 0.03);
    const side = Math.round(W * 0.35);
    const yA = Math.max(0, Math.min(H - 40, (cutUp.length ? Math.min(...cutUp.map(topOf)) : H - side) - pad));
    const hB = Math.min(lo.page.height, Math.max(40, (cutLo.length ? Math.max(...cutLo.map(bottomOf)) : side) + pad));
    const hA = H - yA;
    // Every picture made here is let go in the end, also when the band fails or is cancelled.
    const owned: { dispose(): void }[] = [];
    const keep = <T extends { dispose(): void }>(x: T): T => (owned.push(x), x);
    try {
      const originals = await Promise.all(members.map(async (m) => keep(await TiledImage.fromBytes(this.backend, m.original.bytes, m.original.mime))));
      const upImg = originals[left.length - 1];
      const loImg = originals[left.length];
      const band = keep(new TiledImage(this.backend, W, hA + hB));
      band.putRegion(upImg.getRegion(0, yA, W, hA), 0, 0);
      band.putRegion(loImg.getRegion(0, 0, W, hB), 0, hA);
      const seriesKey = up.seriesKey ?? lo.seriesKey;
      const { settings, config } = await this.config(seriesKey);
      // The pictures' own lines are in the context: the band repeats them and must not take them for echoes.
      let context = await this.getContext(seriesKey);
      for (const m of members) if (context && m.page.pageId) context = withoutPage(context, m.page.pageId.slice(0, 16));
      const single = band.toSingleCanvas();
      const bytes = await this.backend.encode(single, 'image/png');
      releaseCanvas(single);
      band.dispose();
      const out = await runPipeline({ bytes, mime: 'image/png', config, context, signal: opts.signal, noSkip: true }, { backend: this.backend, fetchImpl: this.fetchImpl, inpaint: this.inpainter, detect: this.detector, ocr: this.reader });
      keep(out.cleaned);
      if (out.original !== out.cleaned) keep(out.original);
      // Nothing read in the band: the pictures keep what they have.
      if (!out.page.blocks.length) return false;

      // One strip of all the members: their own blocks (not the copies drawn across a seam), the band's in place of what it covers.
      const offsets: number[] = [];
      let total = 0;
      for (const m of members) {
        offsets.push(total);
        total += m.page.height;
      }
      const seamY = offsets[left.length];
      const bandTop = seamY - hA;
      const bandBottom = seamY + hB;
      const ownBlocks = members.flatMap((m, i) => m.page.blocks.filter((b) => !b.continued).map((b) => shiftBlock(b, -offsets[i])));
      const kept = ownBlocks.filter((b) => b.edited || b.bbox[1] + b.bbox[3] <= bandTop || b.bbox[1] >= bandBottom);
      const n = members.length;
      const fromBand = out.page.blocks.map((b) => ({ ...shiftBlock(b, -bandTop), id: `s${n}${b.id}` }));
      const glued = keep(new TiledImage(this.backend, W, total));
      const cleaned = keep(new TiledImage(this.backend, W, total));
      for (const [i, m] of members.entries()) {
        glued.putRegion(originals[i].getRegion(0, 0, W, m.page.height), 0, offsets[i]);
        const c = await tilesToImage(this.backend, W, m.page.height, m.cleaned);
        try {
          cleaned.putRegion(c.getRegion(0, 0, W, m.page.height), 0, offsets[i]);
        } finally {
          c.dispose();
        }
      }
      cleaned.putRegion(out.cleaned.getRegion(0, 0, W, hA + hB), 0, bandTop);
      const page: PageResult = {
        ...up.page,
        pageId: `${members[0].page.pageId}~seam${n}`,
        height: total,
        blocks: [...kept, ...fromBand].sort((x, y) => x.bbox[1] - y.bbox[1]),
        usage: out.page.usage,
        debug: { ...(out.page.debug ?? { answers: [], modelBlocks: [], steps: [] }), steps: [...(out.page.debug?.steps ?? []), `seam between pictures ${left.length} and ${left.length + 1} translated as one band`] },
      };
      const rendered = await renderOutput(this.backend, { page, cleaned }, styleDefaultsFor(config, settings.fonts));
      // Everything the strip is made of goes into bytes now; the canvases are let go right after.
      const gluedCanvas = glued.toSingleCanvas();
      const gluedBytes = await this.backend.encode(gluedCanvas, 'image/png');
      releaseCanvas(gluedCanvas);
      const cleanedBytes = await Promise.all(cleaned.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, 'image/png') })));
      for (const o of owned.splice(0)) o.dispose();
      const parentKey = `${members[0].key}~seam`;
      const now = new Date().toISOString();
      const parent: StoredResult = {
        key: parentKey,
        page: rendered.page,
        rendered: rendered.tiles,
        mime: rendered.mime,
        original: { bytes: gluedBytes, mime: 'image/png' },
        cleaned: cleanedBytes,
        sourceUrl: up.sourceUrl,
        title: up.title,
        seriesKey,
        createdAt: now,
        lastHitAt: now,
        fontScale: settings.fonts.scale,
        parts: members.map((m) => m.key),
        seamGroup: true,
      };
      for (const g of [left, right]) {
        const old = g[0].strip?.parent;
        if (old && old !== parentKey) await this.dropResult(old);
      }
      await this.putResult(parentKey, parent);
      const parts = await this.deriveParts(parent, members.map((m, i) => ({ y: offsets[i], h: m.page.height })));
      // Each picture keeps its own id (the series context knows it by it) and remembers the seam.
      for (const [i, p] of parts.entries()) {
        const m = members[i];
        await this.putResult(p.key, { ...p, seamGroup: undefined, page: { ...p.page, pageId: m.page.pageId }, original: m.original, seams: [...new Set([...(m.seams ?? []), ...(i === left.length - 1 ? [lowerKey] : i === left.length ? [upperKey] : [])])] });
      }
      await this.recordUsage(out.page.usage, false);
      for (const p of parts) this.onResultChanged?.(p.key);
      return true;
    } finally {
      for (const o of owned) o.dispose();
    }
  }

  private rememberTail(seriesKey: string, key: string, page: PageResult): void {
    const speech = page.blocks.filter((b) => b.translate && b.originalText.trim() && (b.textType === 'DIALOGUE' || b.textType === 'NARRATION'));
    const last = speech[speech.length - 1];
    // Only a line near the bottom of the picture can go on at the top of the next one.
    if (!last || last.bbox[1] + last.bbox[3] < page.height * 0.6) {
      this.tails.delete(seriesKey);
      return;
    }
    this.tails.set(seriesKey, { key, blockId: last.id, src: last.originalText, dst: last.translatedText, type: last.textType, at: Date.now() });
  }

  /**
   * The previous page of the series ended mid-sentence («I CAN'T») and this one goes on at the top
   * («FIGURE IT OUT.»): both halves are translated again as one sentence, this page gets its half
   * before it is drawn, the previous page is redrawn with its half (unless edited by hand meanwhile).
   */
  private async joinWithPrevious(seriesKey: string, page: PageResult, config: PipelineConfig, context: TranslationContext | undefined, signal?: AbortSignal): Promise<void> {
    const tail = this.tails.get(seriesKey);
    if (!tail || Date.now() - tail.at > 15 * 60_000 || !continuesNext(tail.src)) return;
    const first = page.blocks.find((b) => b.translate && b.originalText.trim());
    if (!first || first.textType !== tail.type || first.bbox[1] > page.height * 0.4 || first.edited) return;
    const cfg = config.translator ?? config.vision;
    if (!cfg) return;
    assertPrivacy(config.privacy, cfg, 'text');
    const provider = createProvider(cfg, this.fetchImpl);
    const input = { sourceLang: config.sourceLang, targetLang: config.targetLang, profile: config.profile, glossary: config.glossary, context, translateSfx: config.translateSfx, ...(config.phrasebook?.enabled ? { phrasebook: config.phrasebook } : {}) };
    const res = await translateBlocks(provider, input, [{ id: 'a', type: tail.type, text: tail.src, joinsNext: true }, { id: 'b', type: first.textType, text: first.originalText }], { signal, retries: 1 });
    const a = res.translations.get('a')?.text.trim();
    const b = res.translations.get('b')?.text.trim();
    page.usage = [...page.usage, ...res.usage];
    if (!a || !b) return;
    first.translatedText = b;
    page.debug?.steps?.push(`joined with the last line of the previous page: ${first.id}`);
    // The previous page may still be drawn and stored (it let this one go before that).
    await this.storing.get(tail.key);
    const prev = await this.getResult(tail.key);
    const pb = prev?.page.blocks.find((x) => x.id === tail.blockId);
    if (!prev || !pb || pb.edited || pb.translatedText !== tail.dst || a === tail.dst) return;
    const next = await this.saveEdited(tail.key, { ...prev.page, blocks: prev.page.blocks.map((x) => (x.id === tail.blockId ? { ...x, translatedText: a } : x)) }, undefined, { ifRev: prev.rev ?? 0 }).catch(() => null);
    if (next) for (const k of [tail.key, ...(next.parts ?? [])]) this.onResultChanged?.(k);
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
      const known = this.ahead.get(id);
      if (known) return void (await known);
      // Already translated: nothing to prepare (reopening a chapter must not run the detector again).
      if (!opts.force && ((await this.db.get('kv', `${META}${key}`)) || (await this.db.get('results', key)))) return;
      const promise = this.enlarge(bytes, realMime, config)
        .then((pic) => preparePage({ bytes: pic.bytes, mime: pic.mime, config, generic: opts.generic, noSkip }, { backend: this.backend, fetchImpl: this.fetchImpl, detect: this.detector, ocr: this.reader }))
        .catch(() => undefined);
      this.ahead.set(id, promise);
      while (this.ahead.size > 2) this.ahead.delete(this.ahead.keys().next().value!);
      await promise;
    } catch {
      /* best effort */
    }
  }

  /**
   * A small scan twice as big when the settings ask for it (the bytes as they are otherwise). Done
   * once for a picture: preparing it ahead and translating it take the same result. A failed
   * upscaler only means the picture goes as it is.
   */
  private async enlarge(bytes: Uint8Array, mime: string, config: PipelineConfig, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }> {
    const net = this.upscaler;
    if (!config.upscale || !net || config.mode !== 'standalone') return { bytes, mime };
    const id = (await sha256Hex(bytes)).slice(0, 40);
    let p = this.enlarged.get(id);
    if (!p) {
      p = upscaleBytes(this.backend, bytes, mime, net, signal).catch(() => null);
      this.enlarged.set(id, p);
      while (this.enlarged.size > 3) this.enlarged.delete(this.enlarged.keys().next().value!);
    }
    const big = await p;
    if (!big) this.enlarged.delete(id);
    return big ? { bytes: big, mime: 'image/png' } : { bytes, mime };
  }

  /** The prepared picture for this key, if it is the one prepared ahead (it is handed out once). */
  private async takeAhead(id: string): Promise<PreparedPage | undefined> {
    const a = this.ahead.get(id);
    if (!a) return undefined;
    this.ahead.delete(id);
    return a;
  }

  /**
   * Translate neighbouring pictures of one strip together (see image/strip.ts). Each picture's
   * result is reported through `onPart` as soon as its chunk is done.
   */
  async translateStrip(
    parts: StripPart[],
    opts: TranslateOptions & {
      onPart: (index: number, result: StoredResult, cached: boolean) => void;
      onChunk?: (indices: number[]) => void;
      /**
       * The last `ahead` pictures are only the neighbours below, sent along to look at the seam: one
       * whose seam with the pictures asked for is cut (a bubble across it) is glued and translated
       * with them; the others are not translated now and reported through `onSkip`.
       */
      ahead?: number;
      onSkip?: (indices: number[]) => void;
    },
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
    const own = parts.length - Math.max(0, Math.min(parts.length - 1, opts.ahead ?? 0));
    const todo = parts.map((_, i) => i).filter((i) => !known[i]);
    for (const [i, r] of known.entries()) if (r) opts.onPart(i, r, true);
    if (!todo.length) return;
    // Sizes and seams first (one picture in memory at a time), then each chunk is glued on its own:
    // a whole chapter is never held in memory at once.
    const todoParts = todo.map((i) => parts[i]);
    const plan = await planStrip(this.backend, todoParts);
    const planned = planChunks(plan.spans.map((s) => s.h), plan.calmAfter);
    // A chunk of neighbours only (their seam with the pictures asked for is calm): not now.
    const chunks = planned.filter((c) => c.some((j) => todo[j] < own));
    const skipped = planned.filter((c) => !chunks.includes(c)).flat().map((j) => todo[j]);
    if (skipped.length) opts.onSkip?.(skipped);
    if (!chunks.length) return;
    // Glue one chunk into one picture (PNG bytes).
    const glue = async (chunk: number[]): Promise<Uint8Array> => {
      const glued = await stitchChunk(this.backend, todoParts, plan, chunk);
      const band = this.backend.createCanvas(glued.width, glued.height);
      try {
        const bctx = band.getContext('2d');
        for (const t of glued.tiles) bctx.drawImage(t.canvas, 0, t.y);
        return await this.backend.encode(band, 'image/png');
      } finally {
        // Only the bytes go on: a chapter of glued chunks must not pile up canvases.
        glued.dispose();
        releaseCanvas(band);
      }
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
    const encode = async (img: TiledImage, mime: ImageMime) => {
      try {
        return await Promise.all(img.tiles.map(async (t) => ({ y: t.y, h: t.h, bytes: await this.backend.encode(t.canvas, mime) })));
      } finally {
        // A crop is encoded once and not used again.
        img.dispose();
      }
    };
    const out: StoredResult[] = [];
    for (const [i, s] of spans.entries()) {
      // A strip cut again (after an edit, or one glued at a seam) keeps the keys of its pictures.
      const key = parent.parts?.[i] ?? `${parent.key}~${i}`;
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
    rendered.dispose();
    cleaned.dispose();
    await this.putResult(parent.key, { ...parent, parts: out.map((r) => r.key) });
    return out;
  }

  /**
   * A local model that ran out of video memory gets three more tries, each lighter than the last:
   * other models unloaded, then a smaller context, then a smaller context and picture.
   */
  /** A page's turn on the processor (see util/cpuLane.ts): by its order among the pages in work. */
  private cpuFor(order: number | undefined): <T>(fn: () => Promise<T>) => Promise<T> {
    return (fn) => this.cpuLane.run(order ?? Number.MAX_SAFE_INTEGER, fn);
  }

  /**
   * Run the page with the usual model (lighter retries after «out of memory», see runFitting); when
   * that model does not answer, a stand-in translates it (marked on the page), so a chapter goes on.
   * When the stand-in fails too, the usual model's error is the one shown.
   */
  private async runWithStandIn<T extends PipelineOutput>(
    config: PipelineConfig,
    settings: AppSettings,
    opts: Pick<TranslateOptions, 'signal' | 'onStage'>,
    run: (cfg: PipelineConfig, ahead?: PreparedPage) => Promise<T>,
  ): Promise<{ value: T; lighter: boolean; fallback?: { by: string; reason: string } }> {
    try {
      return await this.runFitting(config, opts, (cfg) => run(cfg));
    } catch (e) {
      const err = toAppError(e);
      const alt = !opts.signal?.aborted && FALLBACK_ON.has(err.code) ? fallbackConfig(config, settings, !!(this.detector && this.reader)) : null;
      if (!alt) throw err;
      opts.onStage?.({ stage: 'translating', message: tr('Модель не ответила — переводит запасной: {0}', alt.by) });
      let out: T;
      try {
        // Not the page prepared ahead: it was prepared for the usual way of reading.
        out = await run(alt.cfg, undefined);
      } catch (e2) {
        if (toAppError(e2).code === 'CANCELLED') throw e2;
        throw err;
      }
      const fallback = { by: alt.by, reason: err.code };
      out.page.fallback = fallback;
      return { value: out, lighter: false, fallback };
    }
  }

  /** The page pipeline: in a background thread when there are some and the settings allow it, here otherwise. */
  private pipeline(settings: AppSettings, req: Parameters<typeof runPipeline>[0], deps: Parameters<typeof runPipeline>[1]): ReturnType<typeof runPipeline> {
    return this.pageWorkers && settings.pageWorkers !== false ? this.pageWorkers.run(req, deps) : runPipeline(req, deps);
  }

  /**
   * A page of a studio project (no cache, no series turn): the same way as a page of a site —
   * recognition and the detector of this browser, LaMa, a small scan made bigger, the stand-in when
   * the model does not answer. `picture` is what the texts' places belong to (enlarged or not).
   */
  async runProjectPage(bytes: Uint8Array, mime: string, config: PipelineConfig, opts: { context?: TranslationContext; signal?: AbortSignal; onStage?: (e: StageEvent) => void } = {}): Promise<{ out: PipelineOutput; picture: { bytes: Uint8Array; mime: string } }> {
    const settings = await this.settingsWithKeys();
    const picture = await this.enlarge(bytes, mime, config, opts.signal);
    const run = (cfg: PipelineConfig) =>
      this.pipeline(settings, { bytes: picture.bytes, mime: picture.mime, config: cfg, context: opts.context, signal: opts.signal, onStage: opts.onStage }, { backend: this.backend, fetchImpl: this.fetchImpl, inpaint: this.inpainter, detect: this.detector, ocr: this.reader });
    const { value } = await this.runWithStandIn(config, settings, opts, run);
    return { out: value, picture };
  }

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
          // The detector's and LaMa's sessions hold video memory too: let them go first.
          await this.releaseGpu?.().catch(() => undefined);
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
  async saveEdited(key: string, page: PageResult, cleaned?: TiledImage, opts: { ifRev?: number } = {}): Promise<StoredResult> {
    const stored = await this.getResult(key);
    if (!stored) throw new AppError('UNKNOWN', { message: 'Result not found', retryable: false });
    if (opts.ifRev !== undefined && (stored.rev ?? 0) !== opts.ifRev) throw new EditConflict();
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
    // Drawing took a while: a background change (the review) that was based on the copy read above
    // is dropped when someone (the editor, maybe in another tab) saved meanwhile.
    let conflict = false;
    await this.updateResult(key, async (current) => {
      if (opts.ifRev !== undefined && (current?.rev ?? 0) !== opts.ifRev) {
        conflict = true;
        return null;
      }
      next.rev = (current?.rev ?? stored.rev ?? 0) + 1;
      return next;
    });
    if (conflict) throw new EditConflict();
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

  /**
   * The same picture translated with the same settings but drawn with other fonts (only the look
   * changed): copied under the new key and drawn again — the fonts never cost a model run.
   */
  private async otherLook(key: string, generic: boolean): Promise<StoredResult | undefined> {
    const at = key.indexOf(':', key.indexOf(':') + 1);
    const prefix = at < 0 ? key : key.slice(0, at);
    const keys = (await this.db.keysWithPrefix?.('results', prefix)) ?? [];
    for (const k of keys) {
      if (k === key || k.includes('~') || k.endsWith(':lite') || (at < 0 ? false : k.length > prefix.length && k[prefix.length] !== ':')) continue;
      const other = await this.db.get<StoredResult>('results', k);
      if (!other || other.strip || !!other.generic !== generic) continue;
      await this.putResult(key, { ...other, key, parts: undefined });
      return this.saveEdited(key, other.page);
    }
    return undefined;
  }

  /**
   * The page journal (kv 'journal', newest first, at most JOURNAL_MAX pages) for «Сообщить о
   * проблеме» and a long run's profile: size, blocks, the time of every stage, model requests and
   * tokens, the browser's memory and what Ollama holds in video memory. No picture or text.
   */
  private async journal(e: { key: string; page: PageResult; storeMs: number; vision: PipelineConfig['vision']; force?: boolean }): Promise<void> {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    let vram: { model: string; vramGb: number; sizeGb: number }[] | undefined;
    if (e.vision && isOllama(e.vision)) {
      const loaded = await ollamaLoaded(e.vision.baseUrl, this.fetchImpl);
      vram = loaded.map((m) => ({ model: m.name, vramGb: Math.round(m.sizeVram / 1e8) / 10, sizeGb: Math.round(m.size / 1e8) / 10 }));
    }
    const entry = {
      at: new Date().toISOString(),
      key: e.key.slice(0, 12),
      size: `${e.page.width}x${e.page.height}`,
      blocks: e.page.blocks.length,
      skipped: e.page.skippedNoText || undefined,
      // Left without a translation (the source text shown) and unsure ones, by block id: what a
      // translation run again (⟳, force) was for.
      ...untranslatedOf(e.page),
      ...(e.force ? { again: true } : {}),
      timings: { ...e.page.timings, storeMs: e.storeMs },
      ...(mem ? { heapMb: Math.round(mem.usedJSHeapSize / 1e6) } : {}),
      ...(vram ? { ollama: vram } : {}),
    };
    await this.locks.run('journal', async () => {
      const list = (await this.db.get<unknown[]>('kv', 'journal')) ?? [];
      await this.db.put('kv', 'journal', [entry, ...list].slice(0, JOURNAL_MAX));
    });
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
  async pruneCache(days: number, maxMb = Infinity, keepRecentMs = RECENT_KEEP_MS): Promise<number> {
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
    // Over the cap: oldest use first. Pages used in the last hours (the chapter being read or
    // translated) are never dropped for size: a 400-page chapter may take more than the cap for a while.
    alive.sort((a, b) => a[1].lastHitAt.localeCompare(b[1].lastHitAt));
    const cap = maxMb * 1024 * 1024;
    const recent = Date.now() - keepRecentMs;
    for (const [key, m] of alive) {
      if (used > cap && Date.parse(m.lastHitAt) < recent) {
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
            releaseCanvas(c);
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
  /** `now`: a long page shown before its check — reviewed at once (with the short pages waiting in its group). */
  private queueReview(item: PendingReview, now = false): void {
    const group = `${item.seriesKey ?? ''}|${item.config.targetLang}|${(item.config.translator ?? item.config.vision)?.id ?? ''}`;
    let g = this.reviews.get(group);
    if (!g) this.reviews.set(group, (g = { items: [] }));
    g.items.push(item);
    if (now || g.items.length >= QA_BATCH.maxPages) this.flushReviewGroup(group);
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
    const provider = createProvider(cfg, this.reviewFetch ?? this.fetchImpl);
    const pages = items.map((i) => i.blocks);
    const usage = await qaPages(pages, { provider, mode: config.qa ?? 'fix', targetLang: config.targetLang, glossary: config.glossary, context: items[items.length - 1].context });
    for (const [i, item] of items.entries()) await this.applyReview(item.key, pages[i], i === 0 ? usage : []);
    await this.recordUsage(usage, false);
  }

  /** Put the reviewer's notes and fixes into the stored result; redraw and tell the app when text changed. */
  private async applyReview(key: string, reviewed: TextBlock[], usage: Usage[]): Promise<void> {
    // An edit saved while the review was being applied wins; the review is applied again on top of it.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.applyReviewOnce(key, reviewed, usage);
      } catch (e) {
        if (!(e instanceof EditConflict)) throw e;
      }
    }
  }

  private async applyReviewOnce(key: string, reviewed: TextBlock[], usage: Usage[]): Promise<void> {
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
      const next = await this.saveEdited(key, page, undefined, { ifRev: stored.rev ?? 0 });
      for (const k of [key, ...(next.parts ?? [])]) this.onResultChanged?.(k);
    } else {
      // Only the notes: never over an edit saved meanwhile.
      let conflict = false;
      await this.updateResult(key, async (current) => {
        if ((current?.rev ?? 0) !== (stored.rev ?? 0)) {
          conflict = true;
          return null;
        }
        return { ...stored, page };
      });
      if (conflict) throw new EditConflict();
      // The notes changed too (shown in the editor): the pictures stay the same.
      if (stored.parts?.length) for (const k of stored.parts) {
        const part = await this.getResult(k);
        if (part?.strip) await this.putResult(k, { ...part, page: pageForSpan(page, { y: part.strip.y, h: part.strip.h }, part.strip.index) });
      }
    }
  }
}

function untranslatedOf(page: PageResult): { untranslated?: string[]; unsure?: string[] } {
  const left = page.blocks.filter((b) => b.translate && b.textType !== 'SFX' && (!b.translatedText.trim() || b.translatedText.trim() === b.originalText.trim())).map((b) => b.id);
  const unsure = page.blocks.filter((b) => b.translate && b.lowConfidence).map((b) => b.id);
  return { ...(left.length ? { untranslated: left } : {}), ...(unsure.length ? { unsure } : {}) };
}

/** A block cut by the picture's top or bottom edge: its bubble (or its text) reaches the edge. */
/** How long a page waits for the previous page of its series to leave its context. */
export const TURN_WAIT_LOCAL_MS = 20_000;
export const TURN_WAIT_MS = 2_000;

/** Wait for `p`, but at most `ms` (then go on), and not after `signal` aborts (then throw). */
async function waitFor(p: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw toAppError(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      p.catch(() => undefined),
      new Promise<void>((done) => (timer = setTimeout(done, ms))),
      new Promise<never>((_, stop) => signal?.addEventListener('abort', (onAbort = () => stop(toAppError(signal.reason ?? new DOMException('Aborted', 'AbortError')))), { once: true })),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

export function touchesEdge(b: TextBlock, height: number, edge: 'top' | 'bottom', within = 2): boolean {
  if (!b.translate && b.textType === 'SFX') return false;
  const boxes = [b.bbox, ...(b.bubble ? [b.bubble.box] : [])];
  return boxes.some((x) => (edge === 'top' ? x[1] <= within : x[1] + x[3] >= height - within));
}

/** A background change found that the result was edited after it was read (see saveEdited ifRev). */
class EditConflict extends Error {
  constructor() {
    super('edited meanwhile');
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
    try {
      for (const tile of image.tiles) {
        if (tile.y + tile.h <= t.y || tile.y >= t.y + t.h) continue;
        tile.canvas.getContext('2d').drawImage(img.source, 0, t.y - tile.y);
      }
    } finally {
      img.close?.();
    }
  }
  return image;
}
