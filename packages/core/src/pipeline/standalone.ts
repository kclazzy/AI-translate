import { familyFor } from '../llm/catalog';
import { AppError } from '../errors';
import { releaseCanvas, type ImageBackend, type PixelData } from '../image/backend';
import { cleanBlock, plainFillColor, findLeftoverText, findLetterClusters, findTextRegions, luminance, parseHex, type LetterCluster, type Lettering, type LeftoverProbe } from '../image/clean';
import { boxArea, boxToPolygon, clampBox, expandBox, overlapRatio, TiledImage } from '../image/tiled';
import { detectScript } from '../languages';
import { assertPrivacy, isLocalProvider, isLocalUrl } from '../llm/privacy';
import { createProvider } from '../llm/presets';
import type { FetchLike, LlmProvider } from '../llm/types';
import { memoryKey, mergeContext, rememberedTranslation, withoutPage, type ContextUpdate, type TranslationContext } from '../translate/context';
import { applyForbiddenFixes, findGlossaryHits, findViolations } from '../translate/glossary';
import { isDegenerate, parseVisionAnswer, tameRuns, type Look, type VisionAnswer } from '../translate/parse';
import { FONT_STACKS } from '../render/style';
import { tr } from '../i18n';
import { buildSystemPrompt, contextData, visionCollageInstruction, visionFullInstruction, visionOcrInstruction, visionPhrasebook, type PromptInput } from '../translate/prompt';
import { completeFitted, CONTEXT_LEVELS, estimateTokens, growRoom, imageTokens, OCR_LEVEL, windowOf } from '../translate/budget';
import { translateBlocks, usageFrom } from '../translate/translator';
import type { Box, BubbleInfo, PageDebug, PageResult, StageEvent, TextBlock, TextStyle, Usage } from '../types';
import { bytesToBase64, sha256Hex } from '../util/bytes';
import { mapLimit } from '../util/queue';
import { withRetry } from '../util/retry';
import { yieldIfBusy } from '../util/yield';
import { MAX_SIDE, pipelineHash, type PipelineConfig } from './config';
import { checkForTextAsync, type TextCheck } from '../image/textcheck';
import { EngineClient } from './engine';
import { addStep, createDebug, recording } from './debug';
import { dedupeReads, dropRepeatedParts, echoesContext, nearBoxes, normText, sameText } from './dupes';
import { backgroundUnder, colourFor } from './selfcheck';
import { bubbleAround, detectedTextNear, detectorFindsText, detectPage, ellipseBubble, isTextKind, missedDetections, snapBlocksToDetections, type Detection, type DetectorStats, type TextDetector } from './detect';

export interface PipelineRequest {
  bytes: Uint8Array;
  mime?: string;
  config: PipelineConfig;
  context?: TranslationContext;
  signal?: AbortSignal;
  onStage?: (e: StageEvent) => void;
  /** Screen-area / UI text: no bubble analysis, text drawn on plates. */
  generic?: boolean;
  /**
   * Ask the model even when the local check finds no lettering (⟳ «перевести всё равно»: the
   * service sets it for `force`). See config.skipEmptyPages.
   */
  noSkip?: boolean;
  /** The picture decoded / checked / encoded ahead of time (see preparePage); must match bytes and config. */
  prepared?: PreparedPage;
  /**
   * Two pages of a series in work at once (the next one reads while the previous one is erased and
   * typeset): the series context as it is once the previous page is done, asked for just before the
   * translation step, so the names and lines of the previous page are in it.
   */
  freshContext?: () => Promise<TranslationContext | undefined>;
}

/** A picture made ready for the model while the previous one was still in it (prefetch). */
export interface PreparedPage {
  original: TiledImage;
  decodeMs: number;
  /** The text check (absent when it does not apply: generic, noSkip, setting off). */
  textCheck?: TextCheck;
  /** The neural detector's boxes (when it is on and here), page px. */
  detections?: Detection[];
  detectorMs?: number;
  detectorStats?: DetectorStats;
  /** The views as sent to the vision model, for `viewsFor` (model + quality). */
  views?: EncodedView[];
  viewsFor?: string;
  /** Recognition in this browser done ahead too: the pieces read and their text (for `readFor`, the language). */
  reads?: { pieces: Box[]; results: ReadResult[]; ms: number };
  readFor?: string;
}

interface EncodedView {
  view: View;
  jpeg: Uint8Array;
  dw: number;
  dh: number;
}

/** Should the picture be checked for lettering before the model is asked? */
function checksText(req: Pick<PipelineRequest, 'config' | 'generic' | 'noSkip'>): boolean {
  return req.config.mode === 'standalone' && req.config.skipEmptyPages !== false && !req.noSkip && !req.generic;
}

const viewsKey = (config: PipelineConfig) => `${config.vision?.model ?? ''}|${config.quality}`;

/**
 * Everything before the first model call that needs only this computer: decode the picture, look
 * for lettering, encode the views for the vision model. Run for the next page while the model
 * works on the current one (TranslateService.prefetch).
 */
export async function preparePage(req: Pick<PipelineRequest, 'bytes' | 'mime' | 'config' | 'generic' | 'noSkip'>, deps: StandaloneDeps): Promise<PreparedPage> {
  const t0 = performance.now();
  const original = await TiledImage.fromBytes(deps.backend, req.bytes, req.mime);
  const prep: PreparedPage = { original, decodeMs: Math.round(performance.now() - t0) };
  if (usesDetector(req, deps)) {
    // The neural detector: its boxes help place the text, and it replaces the heuristic text check.
    const t1 = performance.now();
    try {
      const stats: DetectorStats = { windows: 0, runMs: 0, waitMs: 0 };
      prep.detections = await detectPage(original, deps.detect!, deps.backend, undefined, stats);
      prep.detectorMs = Math.round(performance.now() - t1);
      prep.detectorStats = stats;
      if (checksText(req)) prep.textCheck = { lines: prep.detections.length, letters: 0, noText: !detectorFindsText(prep.detections), ms: prep.detectorMs };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      // The detector failed (model broken, out of memory): the page goes on without it.
    }
  }
  if (checksText(req) && !prep.textCheck) prep.textCheck = await checkForTextAsync(original);
  // Recognition in this browser: the next page's text is read while this one is translated.
  if (req.config.ocr && !req.generic && deps.ocr && prep.detections && !prep.textCheck?.noText) {
    const t2 = performance.now();
    try {
      const pieces = ocrPieces(prep.detections, original.width, original.height);
      prep.reads = { pieces, results: await readPieces(deps.ocr, original, pieces, req.config.sourceLang), ms: 0 };
      prep.reads.ms = Math.round(performance.now() - t2);
      prep.readFor = req.config.sourceLang;
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      // Read again with the page itself.
    }
  }
  if (req.config.mode === 'standalone' && req.config.vision?.vision && !prep.textCheck?.noText) {
    prep.views = [];
    for (const view of planViews(original.width, original.height)) prep.views.push(await encodeView(original, view, req.config, req.config.vision.model, deps));
    prep.viewsFor = viewsKey(req.config);
  }
  return prep;
}

export interface PipelineOutput {
  page: PageResult;
  original: TiledImage;
  cleaned: TiledImage;
  context?: TranslationContext;
  /** What this page adds to the series context (merged into the latest stored context by the caller). */
  contextUpdate?: ContextUpdate;
  /** Run the self-check when the page is typeset (renderOutput; see selfcheck.ts). */
  selfCheck?: boolean;
}

/** Is the neural detector to be used for this page? */
function usesDetector(req: Pick<PipelineRequest, 'config' | 'generic'>, deps: StandaloneDeps): boolean {
  return req.config.mode === 'standalone' && !!req.config.detector && !!deps.detect && !req.generic;
}

/** Text recognition in this browser (PaddleOCR, see ocr/paddle.ts): the text of one piece of a page. */
type ReadResult = { text: string; lines: { box: Box; text: string; score: number; vertical: boolean }[] };
/** Reads one piece of a page; `all` (when there) reads every piece of a page in one go (faster). */
export type TextReader = ((px: PixelData, lang: string) => Promise<ReadResult>) & { all?: (pieces: PixelData[], lang: string) => Promise<ReadResult[]> };

/**
 * The pieces of a page read by the recognition: the detector's text boxes put together, each with a
 * margin (a letter cut by a tight box is read wrong: «HELLO» as «ELLO»).
 */
function ocrPieces(dets: Detection[], width: number, height: number): Box[] {
  const found = dets.filter((d) => isTextKind(d.kind));
  return pieceBoxes(found.map((d) => d.box), width, height).map((b) => clampBox(expandBox(b, Math.max(10, Math.round(Math.min(b[2], b[3]) * 0.25))), width, height));
}

/** Read the pieces: all at once when the reader can, else one by one. */
async function readPieces(reader: TextReader, original: TiledImage, pieces: Box[], lang: string, onEach?: (done: number) => void): Promise<ReadResult[]> {
  if (reader.all) return reader.all(pieces.map((b) => original.getRegion(b[0], b[1], b[2], b[3])), lang);
  const out: ReadResult[] = [];
  for (const [i, b] of pieces.entries()) {
    out.push(await reader(original.getRegion(b[0], b[1], b[2], b[3]), lang));
    onEach?.(i + 1);
  }
  return out;
}

export interface StandaloneDeps {
  backend: ImageBackend;
  fetchImpl?: FetchLike;
  /** Recognition without a vision model (settings → AI mode «Распознавание»). */
  ocr?: TextReader;
  /** LaMa running in this browser (extension), used when the settings say so. */
  inpaint?: Inpainter;
  /** The neural text / bubble detector running in this browser, used when the settings say so. */
  detect?: TextDetector;
}

export interface View {
  y: number;
  h: number;
}

/** Split very tall images into overlapping views the vision model can read. */
export function planViews(width: number, height: number): View[] {
  if (height <= width * 2.6) return [{ y: 0, h: height }];
  const viewH = Math.round(width * 2);
  const overlap = Math.round(width * 0.35);
  const views: View[] = [];
  for (let y = 0; y < height; y += viewH - overlap) {
    const h = Math.min(viewH, height - y);
    views.push({ y, h });
    if (y + h >= height) break;
  }
  return views;
}

function promptInput(config: PipelineConfig, context?: TranslationContext): PromptInput {
  return { sourceLang: config.sourceLang, targetLang: config.targetLang, profile: config.profile, glossary: config.glossary, context, translateSfx: config.translateSfx, ...(config.phrasebook?.enabled ? { phrasebook: config.phrasebook } : {}) };
}

interface Located {
  box: Box;
  text: string;
  translation?: string;
  type: TextBlock['textType'];
  vertical: boolean;
  view: View;
  speaker?: string;
  gender?: 'male' | 'female' | 'unknown';
  look?: Look;
  /** Read from an answer that was cut off or had to be mended. */
  low?: boolean;
  /** The reading step gave the translation instead of the original (see readTranslated). */
  pre?: boolean;
}

/** The largest picture sent in one request, bytes (under the strictest provider limit, 5 MB, as base64 +33%). */
export const VIEW_MAX_BYTES = 3_600_000;

/** One view of the picture as the vision model gets it: scaled to the quality's size, JPEG. */
async function encodeView(image: TiledImage, view: View, config: PipelineConfig, model: string, deps: StandaloneDeps): Promise<EncodedView> {
  const family = familyFor(model);
  const maxSide = Math.min(MAX_SIDE[config.quality], family?.maxSide ?? Infinity);
  const scale = Math.min(1, maxSide / Math.max(image.width, view.h));
  const dw = Math.max(1, Math.round(image.width * scale));
  const dh = Math.max(1, Math.round(view.h * scale));
  const canvas = deps.backend.createCanvas(dw, dh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  image.drawRegion(ctx, 0, view.y, image.width, view.h, dw, dh);
  let jpeg = await deps.backend.encode(canvas, 'image/jpeg', 0.92);
  // Providers refuse big pictures (Anthropic: 5 MB): a lower quality only when needed, and only
  // when it really comes out smaller.
  for (const q of [0.85, 0.8, 0.75]) {
    if (jpeg.length <= VIEW_MAX_BYTES) break;
    const smaller = await deps.backend.encode(canvas, 'image/jpeg', q);
    if (smaller.length < jpeg.length) jpeg = smaller;
  }
  releaseCanvas(canvas);
  return { view, jpeg, dw, dh };
}

/** The collage of the page's text pieces, drawn (see pipeline/collage.ts). */
interface CollageView {
  jpeg: Uint8Array;
  dw: number;
  dh: number;
  pieces: CollagePiece[];
}

async function readView(provider: LlmProvider, image: TiledImage, view: View, config: PipelineConfig, context: TranslationContext | undefined, withTranslation: boolean, deps: StandaloneDeps, signal?: AbortSignal, encoded?: EncodedView, debug?: PageDebug, collage?: CollageView): Promise<{ answer: VisionAnswer; usage: Usage }> {
  const family = familyFor(provider.config.model);
  const { jpeg, dw, dh } = collage ?? encoded ?? (await encodeView(image, view, config, provider.config.model, deps));
  const input = promptInput(config, context);
  const system = buildSystemPrompt(input);
  // Reading only: a model that translated anyway is asked again more firmly (see below).
  let strict = false;
  const instructionNow = () =>
    collage
      ? visionCollageInstruction(dw, dh, collage.pieces.length, config.sourceLang, withTranslation, strict)
      : withTranslation ? visionFullInstruction(dw, dh) : visionOcrInstruction(dw, dh, config.sourceLang, strict);
  let instruction = instructionNow();
  // Reading only (two-step): the names help spelling; the story and earlier lines would only be echoed.
  const levelOf = (i: number) => (withTranslation ? CONTEXT_LEVELS[i] : i === 0 ? OCR_LEVEL : CONTEXT_LEVELS[CONTEXT_LEVELS.length - 1]);
  // Single call: the page's text is not known yet, so the hints come from the previous pages' lines.
  const dataAt = (i: number) => [contextData(input, levelOf(i)), withTranslation && levelOf(i).phrasebook ? visionPhrasebook(input) : ''].filter(Boolean).join('\n\n');
  const fixed = estimateTokens(system) + estimateTokens(instruction) + imageTokens(dw, dh);
  const inputAt = (i: number) => fixed + estimateTokens(dataAt(i));
  const win = windowOf(provider.config);
  const base64 = bytesToBase64(jpeg);
  let room = 6000;
  let level = 0;
  return withRetry(
    async (attempt) => {
      const last = attempt >= 2;
      const sent = await completeFitted(win, room, inputAt, (i, maxTokens) => {
        const data = dataAt(i);
        return provider.complete({
          system,
          messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/jpeg', base64 }, { type: 'text', text: data ? `${data}\n\n${instruction}` : instruction }] }],
          json: true,
          signal,
          maxTokens,
          // Reading is transcription: as steady as possible (a temperature set by the user wins).
          temperature: provider.config.temperature ?? 0.1,
        });
      }, { from: level, onTrim: (i, why) => addStep(debug, `context trimmed to level ${i}: ${why}`) });
      level = sent.level;
      const res = sent.res;
      // A cut-off answer is asked again first (with more room); only the last try keeps what can be mended.
      if (res.truncated && !last) {
        const more = growRoom(win, sent.maxTokens, sent.inputTokens, 12000);
        // No more room in the window: give up the least important context for it.
        if (more <= sent.maxTokens && level < CONTEXT_LEVELS.length - 1) level++;
        room = win ? more : 12000;
        throw new AppError('TRANSLATION_INVALID_OUTPUT', { retryable: true, detail: 'Answer cut off at the output limit' });
      }
      // The collage's answer names pieces by number: they get their places on the page.
      const answer = parseVisionAnswer(collage ? withPieceBoxes(res.text, collage.pieces, image.width, image.height) : res.text, withTranslation, last);
      if (res.truncated) answer.repaired = true;
      // The reading step answered with the translation (Russian where the page is English): the
      // original is needed for the translation step and the filters. Asked once more, firmly; when
      // the model insists, what it gave is used as the translation (marked unsure).
      if (!withTranslation && readTranslated(answer.blocks, config)) {
        if (!last && !strict) {
          strict = true;
          instruction = instructionNow();
          addStep(debug, 'reading step answered with a translation → asked again for the original text');
          throw new AppError('TRANSLATION_INVALID_OUTPUT', { retryable: true, detail: 'Translated instead of transcribing' });
        }
        addStep(debug, 'reading step gave a translation again → used as the translation');
        for (const b of answer.blocks) if (scriptFits(detectScript(b.text), config.targetLang)) {
          b.translation = b.text;
          b.pretranslated = true;
        }
      }
      // Some families answer in pixels of the picture they got: bring them to 0–1000.
      if (family?.coords === 'pixels' && !collage) for (const b of answer.blocks) b.box = [(b.box[0] / dw) * 1000, (b.box[1] / dh) * 1000, (b.box[2] / dw) * 1000, (b.box[3] / dh) * 1000];
      return { answer, usage: usageFrom(provider, res) };
    },
    // A local model that timed out will time out again: report it instead of waiting 3× longer.
    { retries: 2, signal, shouldRetry: (e) => e.retryable && !(e.code === 'TIMEOUT' && isLocalProvider(config.vision!)) },
  );
}

/**
 * Most of what the reading step returned is written in the target language's script and not in the
 * source's (Cyrillic for an English page): the model translated instead of transcribing.
 */
export function readTranslated(blocks: { text: string }[], config: Pick<PipelineConfig, 'sourceLang' | 'targetLang'>): boolean {
  if (config.sourceLang === 'auto' || config.sourceLang.split('-')[0] === config.targetLang.split('-')[0]) return false;
  const lettered = blocks.filter((b) => /\p{L}{2,}/u.test(b.text));
  if (!lettered.length) return false;
  const translated = lettered.filter((b) => {
    const sc = detectScript(b.text);
    return scriptFits(sc, config.targetLang) && !scriptFits(sc, config.sourceLang);
  });
  return translated.length * 2 >= lettered.length;
}

/** A LaMa-like inpainter: picture region (RGBA) and its mask (1 = redraw) → the redrawn region. */
export type Inpainter = (img: PixelData, mask: Uint8Array, signal?: AbortSignal) => Promise<PixelData>;

/** The local engine's /v1/inpaint as an inpainter. */
export function engineInpainter(engine: { url: string; token: string }, deps: StandaloneDeps): Inpainter {
  const client = new EngineClient(engine.url, engine.token, deps.fetchImpl);
  return async (img, mask, signal) => {
    const { width: w, height: h } = img;
    const c = deps.backend.createCanvas(w, h);
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(w, h);
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    const mc = deps.backend.createCanvas(w, h);
    const mctx = mc.getContext('2d');
    const md = mctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = mask[i] ? 255 : 0;
      md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = v;
      md.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(md, 0, 0);
    let out: Uint8Array;
    try {
      out = await client.inpaint(await deps.backend.encode(c, 'image/png'), await deps.backend.encode(mc, 'image/png'), signal);
    } finally {
      releaseCanvas(c);
      releaseCanvas(mc);
    }
    const dec = await deps.backend.decode(out, 'image/png');
    const oc = deps.backend.createCanvas(w, h);
    try {
      oc.getContext('2d').drawImage(dec.source, 0, 0, w, h);
      return oc.getContext('2d').getImageData(0, 0, w, h);
    } finally {
      dec.close?.();
      releaseCanvas(oc);
    }
  };
}

/**
 * Text over artwork is smudged away with a simple fill first; LaMa (in the local engine or in the
 * browser) then redraws those areas properly (hair, backgrounds). Any failure keeps the simple fill.
 */
function errorText(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 160);
}

/** The colour that fills a mask as well as LaMa would (a white or black bubble), else null (see plainFillColor). */
export function flatRing(img: PixelData, mask: Uint8Array): [number, number, number] | null {
  return plainFillColor(img, mask);
}

export const LAMA_MAX_AREAS = 12;
export const LAMA_PAGE_BUDGET_MS = 20_000;

export async function redrawArt(original: TiledImage, cleaned: TiledImage, masks: { box: Box; mask: Uint8Array }[], inpaint: Inpainter, signal?: AbortSignal, failed?: (e: unknown) => void): Promise<number> {
  let done = 0;
  // LaMa per page: at most this many areas and this much time; the rest keeps the simple fill
  // (a long chapter must not stall on one page full of plates).
  const started = Date.now();
  for (const m of masks.slice(0, LAMA_MAX_AREAS)) {
    if (Date.now() - started > LAMA_PAGE_BUDGET_MS) break;
    try {
      // Context around the mask helps LaMa: a margin of half the box on every side.
      const pad = Math.round(Math.max(24, Math.max(m.box[2], m.box[3]) * 0.5));
      const area = clampBox([m.box[0] - pad, m.box[1] - pad, m.box[2] + pad * 2, m.box[3] + pad * 2], original.width, original.height);
      const [ax, ay, aw, ah] = area;
      const img = original.getRegion(ax, ay, aw, ah);
      const inMask = new Uint8Array(aw * ah);
      for (let y = 0; y < m.box[3]; y++) {
        for (let x = 0; x < m.box[2]; x++) {
          if (!m.mask[y * m.box[2] + x]) continue;
          const px = m.box[0] - ax + x;
          const py = m.box[1] - ay + y;
          if (px >= 0 && py >= 0 && px < aw && py < ah) inMask[py * aw + px] = 1;
        }
      }
      // A plain background around the letters (a grey or black panel, a narration box): one colour
      // fills it exactly, without LaMa.
      const flat = flatRing(img, inMask);
      if (flat) {
        const cur = cleaned.getRegion(ax, ay, aw, ah);
        for (let i = 0; i < inMask.length; i++) if (inMask[i]) for (let k = 0; k < 3; k++) cur.data[i * 4 + k] = flat[k];
        cleaned.putRegion(cur, ax, ay);
        done++;
        continue;
      }
      const res = await inpaint(img, inMask, signal);
      if (res.width !== aw || res.height !== ah) continue;
      // Only the masked pixels change; everything else stays exactly as cleaned.
      const cur = cleaned.getRegion(ax, ay, aw, ah);
      for (let i = 0; i < inMask.length; i++) if (inMask[i]) for (let k = 0; k < 3; k++) cur.data[i * 4 + k] = res.data[i * 4 + k];
      cleaned.putRegion(cur, ax, ay);
      done++;
    } catch (e) {
      if ((e as { code?: string }).code === 'CANCELLED' || (e as Error)?.name === 'AbortError') throw e;
      failed?.(e);
      break; // the inpainter is not there: keep the simple fill
    }
  }
  return done;
}

/** Does text written in this script belong to the language (kanji-only Japanese looks Chinese)? */
/**
 * The user's filters for one text: «Только баблы» keeps speech and captions (and, when the detector
 * says the text stands outside any bubble, captions only); «только язык оригинала» keeps texts in
 * that script. One rule for the page's blocks, the re-reads and the translator's re-typing.
 */
export function wanted(config: Pick<PipelineConfig, 'bubblesOnly' | 'onlySourceLang' | 'sourceLang'>, type: TextBlock['textType'], text: string, detKind?: Detection['kind']): boolean {
  if (config.bubblesOnly && (type === 'SFX' || type === 'SIGN' || type === 'OTHER')) return false;
  if (config.bubblesOnly && detKind === 'text_free' && type !== 'NARRATION') return false;
  if (config.onlySourceLang && !scriptFits(detectScript(text), config.sourceLang)) return false;
  return true;
}

export function scriptFits(script: ReturnType<typeof detectScript>, lang: string): boolean {
  if (script === 'other') return true;
  const base = lang.split('-')[0];
  if (base === 'ja') return script === 'ja' || script === 'zh';
  if (base === 'zh') return script === 'zh' || script === 'ja';
  if (base === 'ko') return script === 'ko';
  if (['ru', 'uk', 'be', 'bg', 'sr', 'kk'].includes(base)) return script === 'cyrillic';
  return script === 'latin';
}

/** Letters with case (Latin, Cyrillic, Greek) and all of them capitals: comic lettering. */
export { isAllCaps } from '../translate/caseNorm';
import { joinLetterBlocks, keepAsDrawn } from './asDrawn';
import { growOverPlain, mergeSplitLines } from './splitLines';
import { COLLAGE_MAX, drawCollage, pieceBoxes, pieceScale, planCollage, withPieceBoxes, type CollagePiece } from './collage';
import { fixSfx } from '../translate/sfx';
import { isAllCaps } from '../translate/caseNorm';

/**
 * The lettering the model saw (LOOK_HELP) as a style: a shout in bold capitals, a thought or whisper
 * slanted, a system window or sign in the narrow caption face, a small aside in the handwritten one.
 * The pixels measured later add the colour and outline of the original letters.
 */
export function lookStyle(look: Look, type: TextBlock['textType']): Partial<TextStyle> {
  if (type === 'SFX') return {};
  switch (look) {
    case 'b':
      return { bold: true, uppercase: true };
    case 'i':
      return { italic: true };
    case 'u':
      return { fontFamily: FONT_STACKS.narration };
    case 'h':
      return { fontFamily: FONT_STACKS.hand };
  }
}

/** Make the translation look like the original: capitals, weight and colour of the letters. */
export function matchLettering(b: TextBlock, l: Lettering | undefined): Partial<TextStyle> {
  const style: Partial<TextStyle> = {};
  if (isAllCaps(b.originalText)) style.uppercase = true;
  if (l && l.letterHeight > 0) {
    // Bold lettering: thick strokes for its height. The measured stroke includes about one pixel
    // of anti-aliased edge, which matters for small letters (calibrated: regular ≈ 0.11, bold ≈ 0.145).
    if ((l.stroke - 1) / l.letterHeight >= 0.128) style.bold = true;
    if (b.textType !== 'SFX' && b.bubble) {
      const fill = parseHex(b.bubble.fill);
      const text = parseHex(l.color);
      const contrast = Math.abs(luminance(...fill) - luminance(...text));
      // Keep coloured or white lettering (narration boxes, shouting) when it stands out.
      if (contrast > 90 && l.colorShare >= 0.6) {
        style.color = l.color;
        style.strokeColor = null;
        style.strokeWidth = 0;
      }
    }
    // Outlined letters (white with a black edge over the art, coloured shouting): keep both colours.
    // Never on a plain light bubble: a "fill" in the bubble's own colour is the bubble seen through
    // a mask that took in part of it, and drawing it gives light letters on dark plates.
    const onOwnColour = (() => {
      if (!b.bubble || !l.fill) return false;
      const f = parseHex(l.fill);
      const bf = parseHex(b.bubble.fill);
      return Math.hypot(f[0] - bf[0], f[1] - bf[1], f[2] - bf[2]) < 60;
    })();
    if (l.fill && l.outline && !onOwnColour) {
      // The fill is the colour in the middle of the strokes, the outline the one around them:
      // white letters with a black edge stay white with a black edge (not the other way round).
      style.color = l.fill;
      style.strokeColor = l.outline;
      // In proportion to the letters (≈ 11 % of the font size): a thicker one merges the strokes
      // of a line into one dark plate (sound effects too: their default outline is twice that).
      style.strokeWidth = 2;
    }
    // Slanted lettering (thoughts, whispers, foreign speech) stays slanted.
    if (l.italic) style.italic = true;
    // Captions written flush left (or right) stay that way.
    if (l.align && l.align !== 'center') style.alignment = l.align;
  }
  return style;
}

/**
 * A model often splits one bubble into several blocks. Each would get the whole bubble and the
 * translations would be drawn on top of each other: join them into one block in reading order.
 */
export function mergeSharedBubbles(blocks: TextBlock[], closed: Map<string, boolean>): TextBlock[] {
  const out: TextBlock[] = [];
  const groups: TextBlock[][] = [];
  for (const b of blocks) {
    // Only speech joins speech: a sound effect next to a bubble keeps its own block (and type).
    // A sign on the wall behind a bubble is not part of the speech either (it would be split into a lobe of the bubble).
    const speech = (t: TextBlock['textType']) => t === 'DIALOGUE' || t === 'NARRATION';
    const g = b.bubble && closed.get(b.id) && speech(b.textType) ? groups.find((gr) => gr[0].bubble && speech(gr[0].textType) && closed.get(gr[0].id) && overlapRatio(gr[0].bubble.box, b.bubble!.box) > 0.6) : undefined;
    if (g) g.push(b);
    else groups.push([b]);
  }
  for (const g of groups) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    g.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    // Two bubbles drawn joined into one shape (one lobe per speech) flood as one bubble. Texts far
    // apart are separate speeches: each keeps its own lobe instead of one text in the top part.
    const clusters: TextBlock[][] = [[g[0]]];
    for (const b of g.slice(1)) {
      const prev = clusters[clusters.length - 1];
      const p = prev[prev.length - 1];
      const gap = b.bbox[1] - (p.bbox[1] + p.bbox[3]);
      const h = Math.max(p.bbox[3], b.bbox[3]);
      const width = g[0].bubble!.box[2];
      const shift = Math.abs(b.bbox[0] + b.bbox[2] / 2 - (p.bbox[0] + p.bbox[2] / 2));
      const separate = gap > h * 0.75 || (gap > 0 && shift > width * 0.2);
      if (separate) clusters.push([b]);
      else prev.push(b);
    }
    const merged = clusters.map(mergeGroup);
    if (merged.length > 1) splitBubble(merged);
    out.push(...merged);
  }
  return out;
}

function mergeGroup(all: TextBlock[]): TextBlock {
  // The same words read twice (two views, a re-read of the bubble) are said once.
  const g = dropRepeatedParts(all);
  const first = g[0];
  // The box covers every part read (also the dropped copies: they stand on the same lettering).
  let bbox = all[0].bbox;
  for (const o of all.slice(1)) {
    const x = Math.min(bbox[0], o.bbox[0]);
    const y = Math.min(bbox[1], o.bbox[1]);
    bbox = [x, y, Math.max(bbox[0] + bbox[2], o.bbox[0] + o.bbox[2]) - x, Math.max(bbox[1] + bbox[3], o.bbox[1] + o.bbox[3]) - y];
  }
  return {
    ...first,
    bbox,
    polygon: boxToPolygon(bbox),
    originalText: g.map((x) => x.originalText).join('\n'),
    translatedText: g.map((x) => x.translatedText.trim()).filter(Boolean).join(' '),
    fontSizeEstimate: Math.min(...g.map((x) => x.fontSizeEstimate || Infinity)) || first.fontSizeEstimate,
  };
}

/** Sentences (keeps the end marks): «Я... не знал. Прости!» → ["Я... не знал.", "Прости!"]. */
export function sentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?…。！？])\s+/).map((x) => x.trim()).filter(Boolean);
  // «Я... не знал»: an ellipsis followed by a lowercase word does not end the sentence.
  const out: string[] = [];
  for (const p of parts) {
    const first = p[0] ?? '';
    if (out.length && /(\.\.\.|…)$/.test(out[out.length - 1]) && first !== first.toUpperCase()) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/** Split `items` into `weights.length` contiguous non-empty runs, sizes following the weights. */
function shareOut<T>(items: T[], weights: number[], size: (t: T) => number): T[][] {
  const k = weights.length;
  const total = items.reduce((a, t) => a + size(t), 0) || 1;
  const wsum = weights.reduce((a, w) => a + w, 0) || 1;
  const out: T[][] = [];
  let i = 0;
  let acc = 0;
  let target = 0;
  for (let g = 0; g < k; g++) {
    target += (weights[g] / wsum) * total;
    const run: T[] = [];
    // Leave at least one item for every later group.
    while (i < items.length - (k - g - 1) && (run.length === 0 || (g === k - 1) || acc + size(items[i]) / 2 <= target)) {
      acc += size(items[i]);
      run.push(items[i++]);
    }
    out.push(run);
  }
  return out;
}

export function splitByGroups(b: TextBlock, groups: Box[], lettering: Lettering | undefined, width: number, height: number): TextBlock[] {
  const weights = groups.map((g) => g[2] * g[3]);
  let tr = sentences(b.translatedText);
  if (tr.length < groups.length) tr = b.translatedText.split(/\s+/).filter(Boolean);
  if (tr.length < groups.length) return [b];
  const join = (xs: string[]) => xs.join(' ');
  const trParts = shareOut(tr, weights, (x) => x.length).map(join);
  let orig = sentences(b.originalText);
  if (orig.length < groups.length) orig = b.originalText.split(/\s+/).filter(Boolean);
  const origParts = orig.length >= groups.length ? shareOut(orig, weights, (x) => x.length).map(join) : groups.map(() => b.originalText);
  return groups.map((g, i) => {
    const area = clampBox(expandBox(g, Math.round(g[3] * 0.12)), width, height);
    const text = clampBox([g[0] - Math.round(g[2] * 0.12), g[1] - Math.round(g[3] * 0.12), Math.round(g[2] * 1.24), Math.round(g[3] * 1.24)], width, height);
    return {
      ...b,
      id: i === 0 ? b.id : `${b.id}s${i + 1}`,
      originalText: origParts[i],
      translatedText: trParts[i],
      bbox: g,
      polygon: boxToPolygon(g),
      textBox: text,
      fontSizeEstimate: fontFromLettering(g, origParts[i], lettering),
      bubble: b.bubble ? { ...b.bubble, box: area, safeArea: text, shape: 'rect', rows: undefined } : null,
    };
  });
}

/** One bubble shape shared by several speeches (top to bottom): cut it between the texts. */
function splitBubble(parts: TextBlock[]): void {
  const shared = parts[0].bubble!;
  const top = shared.box[1];
  const bottom = shared.box[1] + shared.box[3];
  for (const [i, b] of parts.entries()) {
    const y0 = i === 0 ? top : Math.round((parts[i - 1].bbox[1] + parts[i - 1].bbox[3] + b.bbox[1]) / 2);
    const y1 = i === parts.length - 1 ? bottom : Math.round((b.bbox[1] + b.bbox[3] + parts[i + 1].bbox[1]) / 2);
    const box: Box = [shared.box[0], y0, shared.box[2], Math.max(1, y1 - y0)];
    const bubble: BubbleInfo = { ...shared, box, safeArea: intersectBox(shared.safeArea, box) ?? box, shape: 'rect' };
    if (shared.rows) {
      // Only the outline rows of this part, so the text follows its own lobe.
      const r = shared.rows;
      const a = Math.max(0, Math.floor((y0 - r.y) / r.step));
      const z = Math.min(r.l.length, Math.ceil((y1 - r.y) / r.step));
      bubble.rows = z > a ? { ...r, y: r.y + a * r.step, l: r.l.slice(a, z), r: r.r.slice(a, z) } : undefined;
      if (!bubble.rows) delete bubble.rows;
    }
    b.bubble = bubble;
  }
}

function intersectBox(a: Box, b: Box): Box | null {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return r > x && btm > y ? [x, y, r - x, btm - y] : null;
}

function intersects(a: Box, b: Box): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/** Text areas of different blocks must not overlap: split the overlap between them. */
export function separateAreas(blocks: TextBlock[]): void {
  const areas = blocks.map((b) => b.bubble?.safeArea);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = areas[i];
      const c = areas[j];
      if (!a || !c || !intersects(a, c) || a === c) continue;
      // Cut along the axis where the blocks are further apart (one above the other → horizontal cut).
      const dy = c[1] + c[3] / 2 - (a[1] + a[3] / 2);
      const dx = c[0] + c[2] / 2 - (a[0] + a[2] / 2);
      const [first, second] = (Math.abs(dy) >= Math.abs(dx) ? dy : dx) >= 0 ? [a, c] : [c, a];
      if (Math.abs(dy) >= Math.abs(dx)) {
        const cut = Math.round((Math.max(first[1], second[1]) + Math.min(first[1] + first[3], second[1] + second[3])) / 2);
        const fBottom = first[1] + first[3];
        first[3] = Math.max(8, cut - first[1] - 1);
        const sBottom = second[1] + second[3];
        second[1] = Math.min(cut + 1, sBottom - 8);
        second[3] = sBottom - second[1];
        void fBottom;
      } else {
        const cut = Math.round((Math.max(first[0], second[0]) + Math.min(first[0] + first[2], second[0] + second[2])) / 2);
        first[2] = Math.max(8, cut - first[0] - 1);
        const sRight = second[0] + second[2];
        second[0] = Math.min(cut + 1, sRight - 8);
        second[2] = sRight - second[0];
      }
    }
  }
}

/**
 * Font size of the original lettering: from the measured letter height when there is one
 * (capitals are about 0.72 of the font size, CJK glyphs about 0.9), never larger than the
 * estimate from the box area.
 */
export function fontFromLettering(box: Box, text: string, l: Lettering | undefined): number {
  const byArea = estimateFontSize(box, text);
  // Outlined lettering (fill + outline, low colour share) breaks into pieces: its height is not reliable.
  if (!l || l.letterHeight < 6 || l.colorShare < 0.6) return byArea;
  const script = detectScript(text);
  const ratio = script === 'latin' || script === 'cyrillic' ? (isAllCaps(text) ? 0.72 : 0.6) : 0.9;
  // The measured height can only lower the area estimate a little: dots and commas («...AND THEN...»,
  // «HAHA!») count as short letters and pull the median down, and the translation came out a third
  // of the original's size.
  return Math.max(8, Math.min(byArea, Math.max(Math.round(l.letterHeight / ratio), Math.round(byArea * 0.8))));
}

/** Rough font size from box area and character count. */
export function estimateFontSize(box: Box, text: string): number {
  const n = Math.max(1, [...text.replace(/\s+/g, '')].length);
  return Math.max(8, Math.round(Math.sqrt((box[2] * box[3]) / n) * 0.85));
}

/**
 * Full on-device pipeline: a vision LLM finds and reads the text (optionally translating it in
 * the same call), a separate text model may translate, then the image is cleaned locally.
 * Runs in the extension, the mobile app and the web app; no backend required.
 */
export async function runStandalonePipeline(req: PipelineRequest, deps: StandaloneDeps): Promise<PipelineOutput> {
  const t0 = performance.now();
  // This picture translated before (⟳, the chapter again): its own lines in the series context are not
  // «earlier pages» — they would be taken for echoes and removed, and the old translation forced back.
  const pageKey = (await sha256Hex(req.bytes)).slice(0, 16);
  if (req.context) req = { ...req, context: withoutPage(req.context, pageKey) };
  const { config, signal } = req;
  const stage = (s: StageEvent['stage'], progress?: number) => req.onStage?.({ stage: s, progress });
  if (!config.vision) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: 'No vision provider' });
  // Recognition in this browser: the picture never goes to a model, a text model translates.
  const ocrMode = !!config.ocr && !req.generic;
  if (ocrMode && !deps.ocr) throw new AppError('SETUP_NEEDED', { retryable: false, detail: tr('Скачайте модели распознавания текста (Настройки → Режим работы ИИ → Распознавание).') });
  if (!ocrMode && !config.vision.vision) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: `${config.vision.label} does not accept images; pick a vision model or use the engine` });
  if (!ocrMode) assertPrivacy(config.privacy, config.vision, 'image');
  // A separate translation request: another model, or the same one in two steps (more accurate).
  const translatorCfg = ocrMode
    ? (config.translator ?? config.vision)
    : config.translator && config.translator.id !== config.vision.id ? config.translator : config.twoStep ? config.vision : null;
  const separate = !!translatorCfg;
  if (translatorCfg) assertPrivacy(config.privacy, translatorCfg, 'text');

  stage('decoding');
  const prepared = req.prepared;
  const prep = prepared ?? (await preparePage(req, deps));
  const original = prep.original;
  const tDecoded = performance.now();
  const debug = createDebug();
  const vision = recording(createProvider(config.vision, deps.fetchImpl), 'read', debug);
  const usage: Usage[] = [];
  let blocks: TextBlock[] = [];
  let cleaned: TiledImage | null = null;
  let tTranslated = 0;
  let tCleaned = 0;
  let inpaintMs = 0;
  const artMasks: { box: Box; mask: Uint8Array }[] = [];
  let artRedrawn = false;
  let lama: PageResult['lama'];
  // No lettering anywhere (local check): the model is not asked at all.
  const skipped = !!prep.textCheck?.noText;
  let tDetected = tDecoded;
  let entities: unknown[] = [];
  const summaries: string[] = [];
  // The neural detector's boxes (prepared ahead, or found now), when it is on.
  let dets = prep.detections;
  let detectorMs = prep.detectorMs ?? 0;
  if (skipped) {
    addStep(debug, 'page skipped: no text (local check)');
    return finish();
  }

  stage('detecting');
  if (!dets && usesDetector(req, deps)) {
    const t1 = performance.now();
    try {
      dets = await detectPage(original, deps.detect!, deps.backend, signal);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
    }
    detectorMs = Math.round(performance.now() - t1);
  }
  if (dets) addStep(debug, `detector: ${dets.filter((d) => d.kind !== 'bubble').length} text box(es), ${dets.filter((d) => d.kind === 'bubble').length} bubble(s)`);
  // One request reads and translates: it needs the previous page's context already.
  async function takeFreshContext(): Promise<void> {
    const get = req.freshContext;
    if (!get) return;
    req = { ...req, freshContext: undefined };
    const fresh = await get();
    req = { ...req, context: fresh ? withoutPage(fresh, pageKey) : req.context };
  }
  if (!separate) await takeFreshContext();
  const located: Located[] = [];
  // Only the text, as a collage of the pieces the detector found (settings → read crops): a much
  // smaller picture for the model than the whole page.
  let collageUsed = false;
  let answers: { view: View; answer: VisionAnswer; usage: Usage }[] = [];
  if (ocrMode) {
    // The detector found the text; each piece of it is read here, line by line.
    if (!dets) throw new AppError('SETUP_NEEDED', { retryable: false, detail: tr('Для распознавания нужен «Точный поиск текста»: скачайте его в настройках.') });
    const found = dets.filter((d) => isTextKind(d.kind));
    const blocks: VisionAnswer['blocks'] = [];
    const t0 = performance.now();
    // Read ahead while the previous page was translated (the same detections, the same language)?
    const ahead = prep.reads && prep.readFor === config.sourceLang && prep.detections === dets ? prep.reads : undefined;
    const pieces = ahead?.pieces ?? ocrPieces(dets, original.width, original.height);
    const reads = ahead?.results ?? (await readPieces(deps.ocr!, original, pieces, config.sourceLang, (n) => stage('ocr', n / pieces.length)));
    if (ahead) addStep(debug, `text read ahead (while the page before was translated): ${ahead.ms} ms`);
    stage('ocr', 1);
    for (const [i, b] of pieces.entries()) {
      const r = reads[i];
      if (!r?.text) continue;
      const inside = found.filter((d) => overlapRatio(d.box, b) > 0.5);
      const free = inside.length > 0 && inside.every((d) => d.kind === 'text_free');
      blocks.push({
        box: [(b[0] / original.width) * 1000, (b[1] / original.height) * 1000, ((b[0] + b[2]) / original.width) * 1000, ((b[1] + b[3]) / original.height) * 1000],
        text: r.text,
        type: free ? 'NARRATION' : 'DIALOGUE',
        vertical: r.lines.length > 0 && r.lines.filter((l) => l.vertical).length > r.lines.length / 2,
      });
    }
    addStep(debug, `text recognition in the browser: ${pieces.length} piece(s), ${blocks.length} with text, ${Math.round(performance.now() - t0)} ms`);
    answers = [{ view: { y: 0, h: original.height }, answer: { blocks, entities: [], summary: '' }, usage: { provider: 'ocr', model: 'PP-OCR', inputTokens: 0, outputTokens: 0, costUsd: 0 } }];
    collageUsed = true;
  }
  const textDets = !ocrMode && config.collage && dets && !req.generic ? dets.filter((d) => isTextKind(d.kind)) : [];
  if (textDets.length) {
    const boxes = pieceBoxes(textDets.map((d) => d.box), original.width, original.height);
    const area = boxes.reduce((a, b) => a + b[2] * b[3], 0);
    // Text over most of the page (a title page, a wall of captions): the page as it is reads as well.
    if (boxes.length <= 40 && area <= original.width * original.height * 0.6) {
      const plan = planCollage(boxes, COLLAGE_MAX, textDets.map((d) => d.box), boxes.map((b) => (b[3] > 160 ? pieceScale(original.getRegion(b[0], b[1], b[2], b[3])) : 1)));
      const drawn = await drawCollage(deps.backend, original, plan);
      addStep(debug, `collage: ${plan.pieces.length} piece(s), ${drawn.width}×${drawn.height} (${Math.round((area / (original.width * original.height)) * 100)}% of the page)`);
      const view = { y: 0, h: original.height };
      const r = await readView(vision, original, view, config, req.context, !separate, deps, signal, undefined, debug, { jpeg: drawn.jpeg, dw: drawn.width, dh: drawn.height, pieces: plan.pieces });
      stage('ocr', 1);
      if (r.answer.blocks.length) {
        answers = [{ view, ...r }];
        collageUsed = true;
      } else {
        usage.push(r.usage);
        addStep(debug, 'collage: nothing read → the whole page');
      }
    }
  }
  if (!collageUsed) {
    const views = planViews(original.width, original.height);
    const encoded = prep.viewsFor === viewsKey(config) ? prep.views : undefined;
    // A local server runs one request at a time anyway; parallel requests only split the GPU.
    answers = await mapLimit(views, isLocalProvider(config.vision) ? 1 : 2, async (view, i) => {
      const r = await readView(vision, original, view, config, req.context, !separate, deps, signal, encoded?.find((e) => e.view.y === view.y && e.view.h === view.h), debug);
      stage('ocr', (i + 1) / views.length);
      return { view, ...r };
    });
  }
  for (const { view, answer, usage: u } of answers) {
    usage.push(u);
    entities = entities.concat(answer.entities);
    if (answer.summary) summaries.push(answer.summary);
    for (const b of answer.blocks) {
      const box: Box = [(b.box[0] / 1000) * original.width, view.y + (b.box[1] / 1000) * view.h, ((b.box[2] - b.box[0]) / 1000) * original.width, ((b.box[3] - b.box[1]) / 1000) * view.h];
      if (debug.modelBlocks.length < 200) debug.modelBlocks.push({ box: box.map(Math.round) as Box, text: b.text, ...(b.translation !== undefined ? { translation: b.translation } : {}) });
      located.push({ box: clampBox(box, original.width, original.height), text: b.text, translation: b.translation, type: b.type, vertical: b.vertical, view, speaker: b.speaker, gender: b.gender, ...(b.look ? { look: b.look } : {}), ...(answer.repaired || b.pretranslated ? { low: true } : {}), ...(b.pretranslated ? { pre: true } : {}) });
    }
  }
  tDetected = performance.now();
  const merged = dedupeReads(located, original.height);
  if (merged.length < located.length) addStep(debug, `${located.length - merged.length} text(s) read twice (overlapping views) removed`);
  if (!merged.length) {
    addStep(debug, 'model found no text');
    return finish();
  }

  // Build blocks.
  blocks = merged.map((l, i): TextBlock => {
    const script = detectScript(l.text);
    const language = config.sourceLang !== 'auto' ? config.sourceLang : script === 'latin' ? 'en' : script === 'cyrillic' ? 'ru' : script === 'other' ? 'und' : script;
    // The user's filters: only bubbles, only the chosen language.
    // Already the translation: the source-language filter does not apply to it.
    const skip = l.pre ? !wanted({ ...config, onlySourceLang: undefined }, l.type, l.text) : !wanted(config, l.type, l.text);
    return {
      id: `b${i + 1}`,
      textType: req.generic && l.type === 'DIALOGUE' ? 'OTHER' : l.type,
      originalText: l.text,
      translatedText: l.translation ?? '',
      confidence: 0.9,
      language,
      bbox: l.box.map(Math.round) as Box,
      polygon: boxToPolygon(l.box.map(Math.round) as Box),
      orientation: 0,
      writingDirection: l.vertical ? 'ttb-rl' : 'ltr',
      fontSizeEstimate: estimateFontSize(l.box, l.text),
      bubble: null,
      translate: !skip && !(l.type === 'SFX' && !config.translateSfx),
      ...(l.low ? { lowConfidence: true } : {}),
      ...(l.speaker ? { speaker: l.speaker } : {}),
      ...(l.gender ? { speakerGender: l.gender } : {}),
      ...(l.look ? { style: lookStyle(l.look, l.type) } : {}),
    };
  });

  // A logo drawn letter by letter → one block; credits, the logo and brand names stay as drawn.
  const letters = joinLetterBlocks(blocks);
  if (letters.joined.length) {
    blocks = letters.blocks;
    for (const g of letters.joined) addStep(debug, `letters ${g.join(', ')} joined into one block`);
  }
  // One bubble read as two blocks (lines of it): one block, translated and set as one.
  const rejoined = new Set<string>();
  if (!req.generic) {
    const split = mergeSplitLines(blocks, (x, y, w, h) => {
      const [cx, cy, cw, ch] = clampBox([x, y, w, h], original.width, original.height);
      return original.getRegion(cx, cy, cw, ch);
    }, original.height);
    if (split.joined.length) {
      blocks = split.blocks;
      for (const [a, b] of split.joined) {
        rejoined.add(a);
        addStep(debug, `${b} is the next lines of ${a}'s bubble → joined`);
      }
    }
  }
  for (const b of blocks) {
    const why = b.translate ? keepAsDrawn(b, { translateLogo: config.translateLogo }) : null;
    if (!why) continue;
    b.translate = false;
    b.translatedText = '';
    addStep(debug, `${b.id} kept as drawn (${why})`);
  }

  await takeFreshContext();

  // Lines of the previous pages the model copied into this page (it got them as context): kept
  // only where lettering really stands under the box (see cleanOne), never drawn over the art.
  const echoes = new Set(blocks.filter((b) => echoesContext(b.originalText, req.context?.recentLines ?? [])).map((b) => b.id));
  if (echoes.size) addStep(debug, `text repeating earlier pages: ${[...echoes].join(', ')} (checked for lettering)`);
  const dropped = new Set<string>();

  stage('translating');
  if (separate) {
    const translator = recording(createProvider(translatorCfg!, deps.fetchImpl), 'translate', debug);
    // Blocks the reading step already translated (see readTranslated) keep that translation.
    const pre = new Set(merged.flatMap((l, i) => (l.pre ? [`b${i + 1}`] : [])));
    // A joined block without a translation for both halves is translated as one.
    for (const id of rejoined) if (!blocks.find((b) => b.id === id)?.translatedText) pre.delete(id);
    // Translated on an earlier page of the series (a sign on the wall, a line said again): the same words.
    for (const b of blocks) {
      const known = b.translate && !pre.has(b.id) ? rememberedTranslation(req.context, b.originalText, b.textType) : undefined;
      if (!known) continue;
      b.translatedText = known;
      pre.add(b.id);
      addStep(debug, `${b.id} translated as on an earlier page`);
    }
    const toTranslate = blocks.filter((b) => b.translate && !pre.has(b.id)).map((b) => ({ id: b.id, type: b.textType, text: b.originalText, speaker: b.speaker, gender: b.speakerGender }));
    const res = await translateBlocks(translator, promptInput(config, req.context), toTranslate, { signal });
    usage.push(...res.usage);
    entities = entities.concat(res.entities);
    if (res.summary) summaries.push(res.summary);
    for (const b of blocks) {
      if (pre.has(b.id)) continue;
      const t = res.translations.get(b.id);
      if (t) {
        b.translatedText = t.text;
        if (t.type) b.textType = t.type;
        if (t.lowConfidence) b.lowConfidence = true;
        // Re-typed by the translator (a «speech» that is a sound effect): the filters apply to the new type.
        if (!wanted(config, b.textType, b.originalText) || (b.textType === 'SFX' && !config.translateSfx)) {
          b.translate = false;
          b.translatedText = b.originalText;
        }
      } else if (b.translate) {
        b.translatedText = b.originalText;
        b.lowConfidence = true;
      }
    }
  } else {
    // The model got stuck on a drawn-out word («COOOME…» → «Хххххххх»): ask once more as text only.
    // …and a block the model left untranslated (no "translation": the original text came back).
    const untranslated = (b: TextBlock) => /\p{L}{2,}/u.test(b.originalText) && normText(b.translatedText) === normText(b.originalText) && !scriptFits(detectScript(b.originalText), config.targetLang);
    const stuck = blocks.filter((b) => b.translate && (isDegenerate(b.translatedText, b.originalText) || untranslated(b)));
    if (stuck.length) {
      addStep(debug, `stuck or missing translation asked again as text: ${stuck.map((b) => b.id).join(', ')}`);
      try {
        const res = await translateBlocks(recording(createProvider(config.vision!, deps.fetchImpl), 'translate', debug), promptInput(config, req.context), stuck.map((b) => ({ id: b.id, type: b.textType, text: b.originalText, speaker: b.speaker, gender: b.speakerGender })), { signal, retries: 1 });
        usage.push(...res.usage);
        for (const b of stuck) {
          const t = res.translations.get(b.id);
          if (t) {
            b.translatedText = t.text;
            if (t.lowConfidence) b.lowConfidence = true;
          }
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'CANCELLED') throw e;
      }
    }
    for (const b of blocks) {
      if (b.translate && isDegenerate(b.translatedText, b.originalText)) {
        b.translatedText = b.originalText;
        b.lowConfidence = true;
        continue;
      }
      b.translatedText = tameRuns(b.translatedText);
      const v = findViolations(b.translatedText, findGlossaryHits(b.originalText, config.glossary));
      if (v.length) b.translatedText = applyForbiddenFixes(b.translatedText, v);
    }
  }
  for (const b of blocks) {
    if (b.textType !== 'SFX' || !b.translate || !b.translatedText) continue;
    const fixed = fixSfx(b.originalText, b.translatedText, config.targetLang);
    if (fixed !== b.translatedText) {
      addStep(debug, `${b.id}: sound «${b.translatedText}» → «${fixed}»`);
      b.translatedText = fixed;
    }
  }
  if (!separate) {
    // One request read and translated the page: a text the series already has keeps its translation.
    for (const b of blocks) {
      const known = b.translate ? rememberedTranslation(req.context, b.originalText, b.textType) : undefined;
      if (known && known !== b.translatedText) {
        b.translatedText = known;
        addStep(debug, `${b.id} translated as on an earlier page`);
      }
    }
  }
  tTranslated = performance.now();

  stage('cleaning');
  cleaned = original.clone();
  await yieldIfBusy();
  // Cleaning reads hundreds of regions of both pictures: keep their pixels at hand meanwhile.
  const released = [original.hold()];
  await yieldIfBusy();
  released.push(cleaned.hold());
  await yieldIfBusy();
  try {
    if (dets?.length && !req.generic) {
      // The detector knows where the lettering really is: the model's boxes move onto it.
      const moved = snapBlocksToDetections(blocks, dets, original.width, original.height);
      for (const b of blocks) if (moved.has(b.id)) b.fontSizeEstimate = estimateFontSize(b.bbox, b.originalText);
      if (moved.size) addStep(debug, `snapped to the detector's text boxes: ${[...moved].join(', ')}`);
    }
    const closedBubble = new Map<string, boolean>();
    const letterHeight = new Map<string, number>();
    const cleanOne = async (b: TextBlock): Promise<void> => {
      const erase = b.translate && !(b.textType === 'SFX' && config.sfxStyle === 'original');
      if (req.generic) {
        // UI/screen text: no bubbles; paint a plate behind the text instead.
        const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase, expand: config.inpaintExpand });
        b.bubble = r.bubble ? { ...r.bubble, shape: 'rect', safeArea: [...b.bbox] as Box } : null;
        return;
      }
      // The detector sees text right there: a line said again, not an echo of the context.
      const detectorSees = !!dets?.some((d) => isTextKind(d.kind) && overlapRatio(d.box, b.bbox) > 0.4);
      if (echoes.has(b.id) && !lettersUnder(b) && !detectorSees) {
        dropped.add(b.id);
        addStep(debug, `${b.id} repeats an earlier page and no lettering stands under it → removed`);
        return;
      }
      const placed = erase && b.textType !== 'SFX' ? placeOnLettering(b) : true;
      await yieldIfBusy();
      if (!placed) {
        // The model's box holds no letters and none stand nearby: keep the translation where the
        // model put it, but never erase the art there and never shout over it in big light letters.
        b.lowConfidence = true;
        addStep(debug, `no lettering in the box of ${b.id} → text over art`);
        // Inside a light bubble (empty, or its letters too faint to find) the text may follow its outline.
        const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: true });
        b.bubble = r.closed && r.bubble && luminance(...parseHex(r.bubble.fill)) >= 190 ? r.bubble : null;
        b.fontSizeEstimate = Math.min(b.fontSizeEstimate, Math.round(Math.max(12, original.width * 0.022)));
        b.style = { color: '#111111', strokeColor: '#ffffff', strokeWidth: 3, ...matchLettering(b, undefined), ...(b.style ?? {}) };
        return;
      }
      // The detector's bubble around the text limits the bubble the cleaner looks for.
      const bubbleBox = dets && b.textType !== 'SFX' ? bubbleAround(b.bbox, dets) : undefined;
      // Text within 12 px of the top or bottom edge (a line cut by the seam of two pictures): the
      // letters are looked for up to the edge, so their cut halves do not stay along the seam.
      const [ex, ey, ew, eh] = b.bbox;
      const toTop = erase && ey > 0 && ey <= 12;
      const toBottom = erase && ey + eh < original.height && ey + eh >= original.height - 12;
      const cleanBox: Box = toTop || toBottom ? [ex, toTop ? 0 : ey, ew, (toBottom ? original.height : ey + eh) - (toTop ? 0 : ey)] : b.bbox;
      const r = cleanBlock(cleaned!, cleanBox, { analyzeOnly: !erase, sfx: b.textType === 'SFX', expand: config.inpaintExpand, ...(bubbleBox ? { bubbleBox } : {}) });
      if (bubbleBox && !r.closed && !r.artMask) {
        // The outline was not found, but the detector saw a bubble: lay the text out in an ellipse
        // inscribed in it (erasing still went by the letters' mask).
        r.bubble = ellipseBubble(bubbleBox, r.bubble?.fill ?? '#ffffff', original.width, original.height);
        r.closed = true;
        addStep(debug, `bubble of ${b.id} taken from the detector`);
      }
      if (r.artMask) artMasks.push(r.artMask);
      if (r.redoMask) artMasks.push(r.redoMask);
      if (r.bubble && b.textType !== 'DIALOGUE' && b.textType !== 'NARRATION') {
        // A sign or a sound effect lies inside its own plate or over the art: a "bubble" that does not even
        // hold the middle of the text is a neighbour's bubble, and the translation would go into it.
        const [bx, by, bw, bh] = r.bubble.box;
        const cx = b.bbox[0] + b.bbox[2] / 2;
        const cy = b.bbox[1] + b.bbox[3] / 2;
        if (cx < bx || cx > bx + bw || cy < by || cy > by + bh) {
          addStep(debug, `bubble of ${b.id} lies beside its text → not used`);
          r.bubble = null;
          r.closed = false;
        }
      }
      if (!r.bubble && b.textType !== 'SFX') addStep(debug, `bubble not found for ${b.id} → text over art`);
      if (r.bubble && !r.closed && erase && r.bubble.shape === 'rect' && (b.textType === 'DIALOGUE' || b.textType === 'NARRATION')) {
        // An open bubble (its outline not found) on plain ground: the translation, usually longer,
        // may take the free ground around the original text instead of shrinking.
        const grown = growOverPlain((x, y, w, h) => cleaned!.getRegion(x, y, w, h), r.bubble.safeArea, parseHex(r.bubble.fill), original);
        if (boxArea(grown) > boxArea(r.bubble.safeArea) * 1.05) {
          const bb = r.bubble.box;
          const x0 = Math.min(bb[0], grown[0]);
          const y0 = Math.min(bb[1], grown[1]);
          r.bubble = { ...r.bubble, safeArea: grown, box: [x0, y0, Math.max(bb[0] + bb[2], grown[0] + grown[2]) - x0, Math.max(bb[1] + bb[3], grown[1] + grown[3]) - y0] };
          addStep(debug, `room for ${b.id} grown over the plain ground`);
        }
      }
      b.bubble = r.bubble;
      closedBubble.set(b.id, r.closed);
      if (r.lettering) letterHeight.set(b.id, r.lettering.letterHeight);
      if (r.textBox && b.textType === 'SFX' && !b.textBox) {
        // Two sounds side by side (STOMP STOMP): the letters found may take in the neighbour's too, or
        // only a scrap of this one's — each sound keeps to its own box then, with its own size.
        const others = blocks.filter((o) => o !== b && o.textType === 'SFX');
        if (boxArea(r.textBox) < boxArea(b.bbox) * 0.05) r.textBox = b.bbox;
        else if (others.some((o) => overlapRatio(o.bbox, r.textBox!) > 0.3)) r.textBox = intersectBox(r.textBox, clampBox(expandBox(b.bbox, Math.round(b.bbox[2] * 0.15)), original.width, original.height)) ?? b.bbox;
        const [x, y, w, h] = r.textBox;
        b.textBox = clampBox([x - w * 0.08, y - h * 0.15, w * 1.16, h * 1.3].map(Math.round) as Box, original.width, original.height);
      }
      if (r.textBox && b.textType !== 'SFX') {
        // Use the measured text pixels to correct an imprecise model box (keep the larger safe area).
        b.fontSizeEstimate = fontFromLettering(r.textBox, b.originalText, r.lettering);
      }
      b.style = { ...plainBackgroundStyle(b, r.textBox), ...matchLettering(b, r.lettering), ...(b.style ?? {}) };
      if (r.textGroups && b.textType !== 'SFX' && b.translate) groupsOf.set(b.id, { groups: r.textGroups, lettering: r.lettering });
    };
    /**
     * Text with no bubble found (a loose box over a dark caption plate, a sign): its colours follow
     * what lies under it once cleaned — light letters on a dark plate, dark ones on a light ground.
     */
    const plainBackgroundStyle = (b: TextBlock, textBox: Box | null): Partial<TextStyle> => {
      if (b.bubble || b.textType === 'SFX') return {};
      const bg = backgroundUnder(cleaned!, [textBox ?? b.bbox]);
      if (!bg || bg.flat < 0.6 || bg.lum > 85) return {};
      addStep(debug, `${b.id}: text over a dark plate → light letters`);
      return colourFor(bg.lum);
    };
    /**
     * Make sure the block's box holds the letters the model read. A box with no letters at all (put
     * next to the bubble, over the art) is moved onto the lettering standing nearby that fits the
     * text; false when there is none.
     */
    const placeOnLettering = (b: TextBlock): boolean => {
      // On the original: another block in the same bubble may have erased these letters already.
      if (findLetterClusters(original, expandBox(b.bbox, 12)).some((c) => intersects(c.box, b.bbox))) return true;
      // Lettering the quick look does not know (coloured, outlined): the cleaner's own search.
      if (cleanBlock(original, b.bbox, { analyzeOnly: true }).textBox) return true;
      // The detector's text box nearby, if it saw one nobody else has.
      const det = dets ? detectedTextNear(b, blocks, dets, original.width) : null;
      if (det) {
        addStep(debug, `block ${b.id} snapped to the detector's text box nearby`);
        b.bbox = clampBox(expandBox(det, 2), original.width, original.height);
        b.polygon = boxToPolygon(b.bbox);
        b.fontSizeEstimate = estimateFontSize(b.bbox, b.originalText);
        return true;
      }
      // Only lettering nobody has erased yet can be this block's.
      const found = letteringNear(b, blocks, cleaned!);
      if (!found) return false;
      addStep(debug, `block ${b.id} snapped to lettering nearby`);
      const pad = Math.round(found.letterHeight * 0.2);
      b.bbox = clampBox(expandBox(found.box, pad), original.width, original.height);
      b.polygon = boxToPolygon(b.bbox);
      b.fontSizeEstimate = estimateFontSize(b.bbox, b.originalText);
      return true;
    };
    /** Lettering really stands in the box: about as many marks as the text has letters. */
    const lettersUnder = (b: TextBlock): boolean => {
      const chars = Math.max(1, [...b.originalText.replace(/\s+/g, '')].length);
      const marks = findLetterClusters(original, b.bbox).filter((c) => intersects(c.box, b.bbox)).reduce((n, c) => n + c.count, 0);
      return marks >= Math.max(3, chars * 0.4) && marks <= chars * 3 + 6;
    };
    /** A re-read that repeats a block already there (the same words nearby or in its bubble), or an earlier page. */
    // A re-read of a scrap of a line already read (the cut half of a bubble: «GOING MARRY THE SOMEDAY
    // BECOME» beside «I AM GOING TO MARRY THE PRINCE SOMEDAY…»): its words are mostly that line's.
    const wordsOf = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);
    const scrapOf = (nb: TextBlock, o: TextBlock) => {
      const w = wordsOf(nb.originalText);
      const known = new Set(wordsOf(o.originalText));
      return w.length >= 2 && known.size > w.length && w.filter((x) => known.has(x)).length >= w.length * 0.75;
    };
    const repeatsKnown = (nb: TextBlock): boolean =>
      blocks.some((o) => (sameText(o.originalText, nb.originalText) && (nearBoxes(o.bbox, nb.bbox) || (!!o.bubble && intersects(o.bubble.box, nb.bbox)))) || sameText(o.originalText, nb.originalText, 0.9) || scrapOf(nb, o)) ||
      echoesContext(nb.originalText, req.context?.recentLines ?? []);
    const groupsOf = new Map<string, { groups: Box[]; lettering?: Lettering }>();
    for (const b of blocks) {
      await cleanOne(b);
      // Other messages (the editor, status polls) get their turn between blocks.
      await yieldIfBusy();
    }
    if (dropped.size) blocks = blocks.filter((b) => !dropped.has(b.id));
    // One block whose lettering stands in separate groups far apart (two speeches in joined
    // bubbles, read by the model as one): each group gets its share of the translation in place.
    // Several blocks in that shape already: each is a speech of its own (see mergeSharedBubbles).
    const shares = (b: TextBlock) => blocks.some((o) => o !== b && o.bubble && b.bubble && overlapRatio(o.bubble.box, b.bubble.box) > 0.6);
    const spans = (b: TextBlock, groups: Box[]) => groups.filter((g) => intersects(g, b.bbox)).length;
    if (groupsOf.size)
      blocks = blocks.flatMap((b) => {
        const info = groupsOf.get(b.id);
        if (!info) return [b];
        if (spans(b, info.groups) < 2 && shares(b)) return [b];
        if (info.groups.length > 1) addStep(debug, `block ${b.id} split by ${info.groups.length} lettering groups`);
        return splitByGroups(b, info.groups, info.lettering, original.width, original.height);
      });
    if (!req.generic) {
      // The model sometimes skips text: a second remark in the same bubble, a line of a long one.
      // Lettering still standing on a bubble after cleaning is read again from just that part.
      const probes: LeftoverProbe[] = blocks
        .filter((b) => b.translate && b.textType !== 'SFX' && b.bubble && (letterHeight.get(b.id) ?? 0) >= 6)
        .map((b) => ({ area: b.bubble!.box, fill: parseHex(b.bubble!.fill), letterHeight: letterHeight.get(b.id)! }));
      // …and lettering in light areas nobody reported: a bubble of an unusual shape the model skipped.
      probes.push(...(await findTextRegions(cleaned)));
      const known = blocks.flatMap((b) => (b.textBox ? [b.bbox, b.textBox] : [b.bbox]));
      // What to read again: left-over lettering on bubbles (at most 4) and text the detector is sure
      // of that no block covers (read as a collage already when the page was: then nothing new).
      // All of it in one request — a collage of the crops — not one request each; not in «Быстро»,
      // and not without a model that reads pictures (recognition in the browser).
      const again: { box: Box; near: number; kind?: Detection['kind']; label: string }[] = [];
      if (config.quality !== 'fast' && !ocrMode && config.vision.vision) {
        for (const box of (await findLeftoverText(cleaned, probes, known)).slice(0, 4)) again.push({ box, near: 6, label: 'left-over lettering' });
        for (const det of dets && !collageUsed ? missedDetections(blocks, dets).slice(0, 6) : []) again.push({ box: det.box.map(Math.round) as Box, near: 4, kind: det.kind, label: 'text found by the detector' });
      }
      if (again.length) {
        try {
          for (const a of again) addStep(debug, `${a.label} read again at [${a.box.join(',')}]`);
          const crops = again.map((a) => clampBox(expandBox(a.box, Math.round(Math.max(a.box[2], a.box[3]) * 0.3) + 12), original.width, original.height));
          const r = await recognizeRegions(original, crops, config, deps, { context: req.context, signal, idPrefix: 'x', debug });
          usage.push(...r.usage);
          for (const nb of r.blocks) {
            // The crop it came from: we know where the missed letters are; the model's box is only approximate.
            const from = again[r.from.get(nb.id) ?? 0];
            const near = clampBox(expandBox(from.box, from.near), original.width, original.height);
            const alone = r.blocks.filter((o) => r.from.get(o.id) === r.from.get(nb.id)).length === 1;
            const cut = alone ? near : intersectBox(nb.bbox, near);
            if (!cut) continue;
            nb.bbox = clampBox(cut.map(Math.round) as Box, original.width, original.height);
            nb.polygon = boxToPolygon(nb.bbox);
            nb.fontSizeEstimate = estimateFontSize(nb.bbox, nb.originalText);
            if (!nb.originalText.trim() || !nb.translatedText.trim() || blocks.some((o) => overlapRatio(o.bbox, nb.bbox) > 0.5)) continue;
            // The user's filters (with the detector's own word: text outside bubbles), and no second copy of a known text.
            if (!wanted(config, nb.textType, nb.originalText, from.kind) || (nb.textType === 'SFX' && !config.translateSfx)) continue;
            if (repeatsKnown(nb)) {
              addStep(debug, `re-read ${nb.id} repeats a known text → skipped`);
              continue;
            }
            nb.language = blocks[0]?.language ?? nb.language;
            await cleanOne(nb);
            await yieldIfBusy();
            // Keep reading order: before the first block that starts below it.
            const at = blocks.findIndex((o) => o.bbox[1] > nb.bbox[1]);
            blocks.splice(at < 0 ? blocks.length : at, 0, nb);
          }
        } catch (e) {
          if ((e as { code?: string }).code === 'CANCELLED') throw e;
          // A failed extra read never fails the page.
        }
      }
    }
    const before = blocks.length;
    blocks = mergeSharedBubbles(blocks, closedBubble);
    if (blocks.length < before) addStep(debug, `${before - blocks.length} block(s) merged into shared bubbles`);
    separateAreas(blocks);
    if (artMasks.length && config.lama) {
      // The engine gets the picture only on this computer / network, unless the cloud is allowed.
      const viaEngine = config.lama === 'engine' && config.engine?.url && (config.privacy === 'cloud' || isLocalUrl(config.engine.url));
      const tl = performance.now();
      let why = '';
      if (viaEngine) {
        artRedrawn = (await redrawArt(original, cleaned, artMasks, engineInpainter(config.engine!, deps), signal, (e) => (why = errorText(e)))) > 0;
        if (why) {
          lama = 'engine-down';
          addStep(debug, `LaMa: the engine at ${config.engine!.url} did not answer (${why})${deps.inpaint ? ' → LaMa in the browser' : ''}`);
        }
      } else if (config.lama === 'engine') lama = 'engine-down';
      if (!artRedrawn && deps.inpaint && (config.lama === 'browser' || lama === 'engine-down')) {
        why = '';
        artRedrawn = (await redrawArt(original, cleaned, artMasks, deps.inpaint, signal, (e) => (why = errorText(e)))) > 0;
        if (why) addStep(debug, `LaMa in the browser failed (${why})`);
        if (artRedrawn && lama === 'engine-down') lama = 'browser-instead';
      } else if (!deps.inpaint && config.lama === 'browser') lama = 'not-downloaded';
      if (artRedrawn && !lama) lama = 'ok';
      inpaintMs = Math.round(performance.now() - tl);
    }
  } finally {
    // Also when the page fails half-way (cancelled): the copies are not kept with the pictures.
    for (const release of released) release();
  }
  tCleaned = performance.now();
  return finish();

  async function finish(): Promise<PipelineOutput> {
    const blocksOut = blocks;
    const pageId = await sha256Hex(req.bytes);
    const summary = summaries.join(' ').slice(0, 400);
    const page: PageResult = {
      pageId,
      width: original.width,
      height: original.height,
      source: { lang: blocksOut[0]?.language ?? config.sourceLang, detectedBy: `vision:${config.vision!.model}` },
      targetLang: config.targetLang,
      blocks: blocksOut,
      timings: {
        // Decoded ahead (prefetch): the time it took then; it was not spent waiting now.
        decodeMs: prep.decodeMs,
        ...(prep.textCheck ? { textCheckMs: prep.textCheck.ms } : {}),
        detectMs: Math.round(tDetected - tDecoded),
        ocrMs: 0,
        translateMs: blocksOut.length ? Math.round(tTranslated - tDetected) : 0,
        // Includes inpaintMs (as before LaMa was measured on its own).
        cleanMs: blocksOut.length ? Math.round(tCleaned - tTranslated) : 0,
        inpaintMs,
        ...(detectorMs ? { detectorMs } : {}),
        ...(prep.detectorStats?.windows ? { detectorRunMs: prep.detectorStats.runMs, detectorWaitMs: prep.detectorStats.waitMs, detectorWindows: prep.detectorStats.windows, ...(prep.detectorStats.ep ? { detectorEp: prep.detectorStats.ep } : {}) } : {}),
        totalMs: Math.round(performance.now() - t0),
        ...(prepared ? { prefetched: true } : {}),
      },
      usage,
      pipeline: { version: 1, hash: await pipelineHash(config), mode: 'standalone' },
      summary,
      ...(artMasks.length ? { artText: artMasks.length, artRedrawn, ...(lama ? { lama } : {}) } : {}),
      ...(skipped ? { skippedNoText: true } : {}),
      debug,
      createdAt: new Date().toISOString(),
    };
    const contextUpdate: ContextUpdate = {
      page: pageId.slice(0, 16),
      entities,
      summary,
      // Only lines that stand where they were read: an unsure one would be echoed on later pages.
      lines: blocksOut.filter((b) => b.textType === 'DIALOGUE' && b.translate && !b.lowConfidence && !b.continued).slice(-8).map((b) => ({ src: b.originalText, dst: b.translatedText })),
      memory: blocksOut.filter((b) => b.translate && !b.lowConfidence && !b.continued && b.translatedText.trim() && memoryKey(b.originalText).replace(/\s/g, '').length >= 12).map((b) => ({ src: b.originalText, dst: b.translatedText, type: b.textType })),
    };
    // A skipped picture adds nothing to the story (and is not counted as a page of it).
    const context = req.context && !skipped ? mergeContext(req.context, contextUpdate) : undefined;
    stage('done', 1);
    const check = config.selfCheck !== false && !req.generic && blocksOut.length > 0;
    return { page, original, cleaned: cleaned ?? original.clone(), context, ...(req.context && !skipped ? { contextUpdate } : {}), ...(check ? { selfCheck: true } : {}) };
  }
}

/**
 * Lettering still standing near a block whose box holds none (up to 0.6 of the picture's width
 * away in every direction), not inside another block's box, with about as many marks as the
 * text has letters. The nearest such run, or null.
 */
export function letteringNear(b: TextBlock, blocks: TextBlock[], image: TiledImage): LetterCluster | null {
  const reach = Math.round(image.width * 0.6);
  const area = clampBox([b.bbox[0] - reach, b.bbox[1] - reach, b.bbox[2] + reach * 2, b.bbox[3] + reach * 2], image.width, image.height);
  const chars = Math.max(1, [...b.originalText.replace(/\s+/g, '')].length);
  const taken = blocks.filter((o) => o !== b).flatMap((o) => (o.textBox ? [o.bbox, o.textBox] : [o.bbox]));
  const owned = (c: LetterCluster) =>
    taken.some((t) => {
      const cut = intersectBox(c.box, t);
      return !!cut && cut[2] * cut[3] > c.box[2] * c.box[3] * 0.3;
    });
  const cx = b.bbox[0] + b.bbox[2] / 2;
  const cy = b.bbox[1] + b.bbox[3] / 2;
  const dist = (c: LetterCluster) => Math.hypot(c.box[0] + c.box[2] / 2 - cx, c.box[1] + c.box[3] / 2 - cy);
  const fits = findLetterClusters(image, area).filter((c) => c.count >= Math.max(3, chars * 0.3) && c.count <= chars * 2.2 + 2 && !owned(c));
  return fits.sort((p, q) => dist(p) - dist(q))[0] ?? null;
}

/** Manual OCR: read and translate the text inside one user-selected box. */
export async function recognizeRegion(
  image: TiledImage,
  box: Box,
  config: PipelineConfig,
  deps: StandaloneDeps,
  opts: { context?: TranslationContext; signal?: AbortSignal; idPrefix?: string; debug?: PageDebug } = {},
): Promise<{ blocks: TextBlock[]; usage: Usage[] }> {
  if (!config.vision?.vision) throw new AppError('NOT_CONFIGURED', { retryable: false });
  assertPrivacy(config.privacy, config.vision, 'image');
  const region = clampBox(box, image.width, image.height);
  const pixels = image.getRegion(...region);
  const canvas = deps.backend.createCanvas(region[2], region[3]);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(region[2], region[3]);
  id.data.set(pixels.data);
  ctx.putImageData(id, 0, 0);
  const sub = new TiledImage(deps.backend, region[2], region[3], [{ y: 0, h: region[3], canvas }]);
  const separate = !!config.translator && config.translator.id !== config.vision.id;
  const vision = recording(createProvider(config.vision, deps.fetchImpl), 'region', opts.debug);
  // A crop has no earlier lines of its own: only the names go along (an echo of earlier pages is the risk here).
  const { answer, usage } = await readView(vision, sub, { y: 0, h: region[3] }, { ...config, quality: 'best' }, opts.context ? { ...opts.context, summaries: [], recentLines: [] } : undefined, !separate, deps, opts.signal, undefined, opts.debug);
  const usages = [usage];
  const blocks: TextBlock[] = answer.blocks.map((b, i): TextBlock => {
    const bx: Box = [region[0] + (b.box[0] / 1000) * region[2], region[1] + (b.box[1] / 1000) * region[3], ((b.box[2] - b.box[0]) / 1000) * region[2], ((b.box[3] - b.box[1]) / 1000) * region[3]];
    const rounded = bx.map(Math.round) as Box;
    return {
      id: `${opts.idPrefix ?? 'm'}${Date.now().toString(36)}${i}`,
      textType: b.type,
      originalText: b.text,
      translatedText: b.translation ?? '',
      confidence: 0.9,
      language: config.sourceLang,
      bbox: rounded,
      polygon: boxToPolygon(rounded),
      orientation: 0,
      writingDirection: b.vertical ? 'ttb-rl' : 'ltr',
      fontSizeEstimate: estimateFontSize(rounded, b.text),
      bubble: null,
      translate: true,
      ...(answer.repaired ? { lowConfidence: true } : {}),
    };
  });
  if (separate && blocks.length) {
    assertPrivacy(config.privacy, config.translator!, 'text');
    const res = await translateBlocks(recording(createProvider(config.translator!, deps.fetchImpl), 'region', opts.debug), promptInput(config, opts.context), blocks.map((b) => ({ id: b.id, type: b.textType, text: b.originalText })), { signal: opts.signal });
    usages.push(...res.usage);
    for (const b of blocks) {
      const t = res.translations.get(b.id);
      b.translatedText = t?.text ?? b.originalText;
      if (!t || t.lowConfidence) b.lowConfidence = true;
    }
  }
  return { blocks, usage: usages };
}

/**
 * Several regions of a page read in one request: the crops put together as a collage (one crop:
 * read as it is). `from` tells which crop each block came from.
 */
export async function recognizeRegions(
  image: TiledImage,
  boxes: Box[],
  config: PipelineConfig,
  deps: StandaloneDeps,
  opts: { context?: TranslationContext; signal?: AbortSignal; idPrefix?: string; debug?: PageDebug } = {},
): Promise<{ blocks: TextBlock[]; usage: Usage[]; from: Map<string, number> }> {
  const from = new Map<string, number>();
  if (boxes.length === 1) {
    const r = await recognizeRegion(image, boxes[0], config, deps, opts);
    for (const b of r.blocks) from.set(b.id, 0);
    return { ...r, from };
  }
  if (!config.vision?.vision) throw new AppError('NOT_CONFIGURED', { retryable: false });
  assertPrivacy(config.privacy, config.vision, 'image');
  const plan = planCollage(boxes, COLLAGE_MAX);
  const drawn = await drawCollage(deps.backend, image, plan);
  const separate = !!config.translator && config.translator.id !== config.vision.id;
  const vision = recording(createProvider(config.vision, deps.fetchImpl), 'region', opts.debug);
  const ctx = opts.context ? { ...opts.context, summaries: [], recentLines: [] } : undefined;
  const { answer, usage } = await readView(vision, image, { y: 0, h: image.height }, { ...config, quality: 'best' }, ctx, !separate, deps, opts.signal, undefined, opts.debug, { jpeg: drawn.jpeg, dw: drawn.width, dh: drawn.height, pieces: plan.pieces });
  const usages = [usage];
  const W = image.width;
  const H = image.height;
  const blocks: TextBlock[] = answer.blocks.map((b, i): TextBlock => {
    const rounded = [(b.box[0] / 1000) * W, (b.box[1] / 1000) * H, ((b.box[2] - b.box[0]) / 1000) * W, ((b.box[3] - b.box[1]) / 1000) * H].map(Math.round) as Box;
    const id = `${opts.idPrefix ?? 'm'}${Date.now().toString(36)}${i}`;
    // The crop it lies in most.
    let best = 0;
    let bestV = -1;
    for (const [k, box] of boxes.entries()) {
      const v = overlapRatio(rounded, box);
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    from.set(id, best);
    return {
      id,
      textType: b.type,
      originalText: b.text,
      translatedText: b.translation ?? '',
      confidence: 0.9,
      language: config.sourceLang,
      bbox: rounded,
      polygon: boxToPolygon(rounded),
      orientation: 0,
      writingDirection: b.vertical ? 'ttb-rl' : 'ltr',
      fontSizeEstimate: estimateFontSize(rounded, b.text),
      bubble: null,
      translate: true,
      ...(answer.repaired ? { lowConfidence: true } : {}),
    };
  });
  if (separate && blocks.length) {
    assertPrivacy(config.privacy, config.translator!, 'text');
    const res = await translateBlocks(recording(createProvider(config.translator!, deps.fetchImpl), 'region', opts.debug), promptInput(config, opts.context), blocks.map((b) => ({ id: b.id, type: b.textType, text: b.originalText })), { signal: opts.signal });
    usages.push(...res.usage);
    for (const b of blocks) {
      const t = res.translations.get(b.id);
      b.translatedText = t?.text ?? b.originalText;
      if (!t || t.lowConfidence) b.lowConfidence = true;
    }
  }
  return { blocks, usage: usages, from };
}

/** Re-translate edited source texts (editor "Retranslate"). */
export async function retranslate(blocks: TextBlock[], config: PipelineConfig, deps: StandaloneDeps, context?: TranslationContext, signal?: AbortSignal): Promise<{ blocks: TextBlock[]; usage: Usage[] }> {
  const provider = config.translator ?? config.vision;
  if (!provider) throw new AppError('NOT_CONFIGURED', { retryable: false });
  assertPrivacy(config.privacy, provider, 'text');
  const res = await translateBlocks(createProvider(provider, deps.fetchImpl), promptInput(config, context), blocks.map((b) => ({ id: b.id, type: b.textType, text: b.originalText })), { signal });
  return {
    blocks: blocks.map((b) => {
      const t = res.translations.get(b.id);
      return t ? { ...b, translatedText: t.text, ...(t.lowConfidence ? { lowConfidence: true } : {}) } : b;
    }),
    usage: res.usage,
  };
}
