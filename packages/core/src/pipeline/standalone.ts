import { familyFor } from '../llm/catalog';
import { AppError } from '../errors';
import type { ImageBackend } from '../image/backend';
import { cleanBlock, findLeftoverText, findTextRegions, luminance, parseHex, type Lettering, type LeftoverProbe } from '../image/clean';
import { boxToPolygon, clampBox, expandBox, overlapRatio, TiledImage } from '../image/tiled';
import { detectScript } from '../languages';
import { assertPrivacy, isLocalProvider } from '../llm/privacy';
import { createProvider } from '../llm/presets';
import type { FetchLike, LlmProvider } from '../llm/types';
import { mergeContext, type TranslationContext } from '../translate/context';
import { applyForbiddenFixes, findGlossaryHits, findViolations } from '../translate/glossary';
import { parseVisionAnswer, type VisionAnswer } from '../translate/parse';
import { buildSystemPrompt, visionFullInstruction, visionOcrInstruction, type PromptInput } from '../translate/prompt';
import { translateBlocks, usageFrom } from '../translate/translator';
import type { Box, PageResult, StageEvent, TextBlock, TextStyle, Usage } from '../types';
import { bytesToBase64, sha256Hex } from '../util/bytes';
import { mapLimit } from '../util/queue';
import { withRetry } from '../util/retry';
import { pipelineHash, type PipelineConfig } from './config';

export interface PipelineRequest {
  bytes: Uint8Array;
  mime?: string;
  config: PipelineConfig;
  context?: TranslationContext;
  signal?: AbortSignal;
  onStage?: (e: StageEvent) => void;
  /** Screen-area / UI text: no bubble analysis, text drawn on plates. */
  generic?: boolean;
}

export interface PipelineOutput {
  page: PageResult;
  original: TiledImage;
  cleaned: TiledImage;
  context?: TranslationContext;
}

export interface StandaloneDeps {
  backend: ImageBackend;
  fetchImpl?: FetchLike;
}

const MAX_SIDE: Record<PipelineConfig['quality'], number> = { fast: 1280, balanced: 1568, best: 2048 };

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
  return { sourceLang: config.sourceLang, targetLang: config.targetLang, profile: config.profile, glossary: config.glossary, context, translateSfx: config.translateSfx };
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
}

async function readView(provider: LlmProvider, image: TiledImage, view: View, config: PipelineConfig, context: TranslationContext | undefined, withTranslation: boolean, deps: StandaloneDeps, signal?: AbortSignal): Promise<{ answer: VisionAnswer; usage: Usage }> {
  const family = familyFor(provider.config.model);
  const maxSide = Math.min(MAX_SIDE[config.quality], family?.maxSide ?? Infinity);
  const scale = Math.min(1, maxSide / Math.max(image.width, view.h));
  const dw = Math.max(1, Math.round(image.width * scale));
  const dh = Math.max(1, Math.round(view.h * scale));
  const canvas = deps.backend.createCanvas(dw, dh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  image.drawRegion(ctx, 0, view.y, image.width, view.h, dw, dh);
  const jpeg = await deps.backend.encode(canvas, 'image/jpeg', 0.92);
  const system = buildSystemPrompt(promptInput(config, context));
  const instruction = withTranslation ? visionFullInstruction(dw, dh) : visionOcrInstruction(dw, dh);
  return withRetry(
    async () => {
      const res = await provider.complete({
        system,
        messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/jpeg', base64: bytesToBase64(jpeg) }, { type: 'text', text: instruction }] }],
        json: true,
        signal,
        maxTokens: 6000,
      });
      const answer = parseVisionAnswer(res.text, withTranslation);
      // Some families answer in pixels of the picture they got: bring them to 0–1000.
      if (family?.coords === 'pixels') for (const b of answer.blocks) b.box = [(b.box[0] / dw) * 1000, (b.box[1] / dh) * 1000, (b.box[2] / dw) * 1000, (b.box[3] / dh) * 1000];
      return { answer, usage: usageFrom(provider, res.model, res.inputTokens, res.outputTokens) };
    },
    // A local model that timed out will time out again: report it instead of waiting 3× longer.
    { retries: 2, signal, shouldRetry: (e) => e.retryable && !(e.code === 'TIMEOUT' && isLocalProvider(config.vision!)) },
  );
}

/** Letters with case (Latin, Cyrillic, Greek) and all of them capitals: comic lettering. */
export function isAllCaps(text: string): boolean {
  const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
  return letters.length >= 3 && letters.every((c) => c === c.toUpperCase());
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
    if (l.fill && l.outline && b.textType !== 'SFX') {
      style.color = l.fill;
      style.strokeColor = l.outline;
      style.strokeWidth = Math.max(2, Math.min(8, Math.round(l.stroke * 0.5)));
    }
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
    const g = b.bubble && closed.get(b.id) && b.textType !== 'SFX' ? groups.find((gr) => gr[0].bubble && overlapRatio(gr[0].bubble.box, b.bubble!.box) > 0.6) : undefined;
    if (g) g.push(b);
    else groups.push([b]);
  }
  for (const g of groups) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    g.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    const first = g[0];
    let bbox = first.bbox;
    for (const o of g.slice(1)) {
      const x = Math.min(bbox[0], o.bbox[0]);
      const y = Math.min(bbox[1], o.bbox[1]);
      bbox = [x, y, Math.max(bbox[0] + bbox[2], o.bbox[0] + o.bbox[2]) - x, Math.max(bbox[1] + bbox[3], o.bbox[1] + o.bbox[3]) - y];
    }
    out.push({
      ...first,
      bbox,
      polygon: boxToPolygon(bbox),
      originalText: g.map((x) => x.originalText).join('\n'),
      translatedText: g.map((x) => x.translatedText.trim()).filter(Boolean).join(' '),
      fontSizeEstimate: Math.min(...g.map((x) => x.fontSizeEstimate || Infinity)) || first.fontSizeEstimate,
    });
  }
  return out;
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
  return Math.max(8, Math.min(byArea, Math.round(l.letterHeight / ratio)));
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
  const { config, signal } = req;
  const stage = (s: StageEvent['stage'], progress?: number) => req.onStage?.({ stage: s, progress });
  if (!config.vision) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: 'No vision provider' });
  if (!config.vision.vision) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: `${config.vision.label} does not accept images; pick a vision model or use the engine` });
  assertPrivacy(config.privacy, config.vision, 'image');
  // A separate translation request: another model, or the same one in two steps (more accurate).
  const translatorCfg = config.translator && config.translator.id !== config.vision.id ? config.translator : config.twoStep ? config.vision : null;
  const separate = !!translatorCfg;
  if (translatorCfg) assertPrivacy(config.privacy, translatorCfg, 'text');

  stage('decoding');
  const original = await TiledImage.fromBytes(deps.backend, req.bytes, req.mime);
  const tDecoded = performance.now();
  const vision = createProvider(config.vision, deps.fetchImpl);
  const usage: Usage[] = [];
  let blocks: TextBlock[] = [];
  let cleaned: TiledImage | null = null;
  let tTranslated = 0;
  let tCleaned = 0;

  stage('detecting');
  const views = planViews(original.width, original.height);
  const located: Located[] = [];
  let entities: unknown[] = [];
  const summaries: string[] = [];
  // A local server runs one request at a time anyway; parallel requests only split the GPU.
  const answers = await mapLimit(views, isLocalProvider(config.vision) ? 1 : 2, async (view, i) => {
    const r = await readView(vision, original, view, config, req.context, !separate, deps, signal);
    stage('ocr', (i + 1) / views.length);
    return { view, ...r };
  });
  for (const { view, answer, usage: u } of answers) {
    usage.push(u);
    entities = entities.concat(answer.entities);
    if (answer.summary) summaries.push(answer.summary);
    for (const b of answer.blocks) {
      const box: Box = [(b.box[0] / 1000) * original.width, view.y + (b.box[1] / 1000) * view.h, ((b.box[2] - b.box[0]) / 1000) * original.width, ((b.box[3] - b.box[1]) / 1000) * view.h];
      located.push({ box: clampBox(box, original.width, original.height), text: b.text, translation: b.translation, type: b.type, vertical: b.vertical, view, speaker: b.speaker, gender: b.gender });
    }
  }
  const tDetected = performance.now();
  const merged = dedupe(located);
  if (!merged.length) {
    return finish();
  }

  // Build blocks.
  blocks = merged.map((l, i): TextBlock => {
    const script = detectScript(l.text);
    const language = config.sourceLang !== 'auto' ? config.sourceLang : script === 'latin' ? 'en' : script === 'cyrillic' ? 'ru' : script === 'other' ? 'und' : script;
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
      translate: !(l.type === 'SFX' && !config.translateSfx),
      ...(l.speaker ? { speaker: l.speaker } : {}),
      ...(l.gender ? { speakerGender: l.gender } : {}),
    };
  });

  stage('translating');
  if (separate) {
    const translator = createProvider(translatorCfg!, deps.fetchImpl);
    const toTranslate = blocks.filter((b) => b.translate).map((b) => ({ id: b.id, type: b.textType, text: b.originalText, speaker: b.speaker, gender: b.speakerGender }));
    const res = await translateBlocks(translator, promptInput(config, req.context), toTranslate, { signal });
    usage.push(...res.usage);
    entities = entities.concat(res.entities);
    if (res.summary) summaries.push(res.summary);
    for (const b of blocks) {
      const t = res.translations.get(b.id);
      if (t) {
        b.translatedText = t.text;
        if (t.type) b.textType = t.type;
      } else if (b.translate) {
        b.translatedText = b.originalText;
        b.lowConfidence = true;
      }
    }
  } else {
    for (const b of blocks) {
      const v = findViolations(b.translatedText, findGlossaryHits(b.originalText, config.glossary));
      if (v.length) b.translatedText = applyForbiddenFixes(b.translatedText, v);
    }
  }
  tTranslated = performance.now();

  stage('cleaning');
  cleaned = original.clone();
  const closedBubble = new Map<string, boolean>();
  const letterHeight = new Map<string, number>();
  const cleanOne = (b: TextBlock) => {
    const erase = b.translate && !(b.textType === 'SFX' && config.sfxStyle === 'original');
    if (req.generic) {
      // UI/screen text: no bubbles; paint a plate behind the text instead.
      const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase });
      b.bubble = r.bubble ? { ...r.bubble, shape: 'rect', safeArea: [...b.bbox] as Box } : null;
      return;
    }
    const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase, sfx: b.textType === 'SFX' });
    b.bubble = r.bubble;
    closedBubble.set(b.id, r.closed);
    if (r.lettering) letterHeight.set(b.id, r.lettering.letterHeight);
    if (r.textBox && b.textType === 'SFX' && !b.textBox) {
      // Sound effects go where the original letters were, not in the middle of a loose model box.
      const [x, y, w, h] = r.textBox;
      b.textBox = clampBox([x - w * 0.08, y - h * 0.15, w * 1.16, h * 1.3].map(Math.round) as Box, original.width, original.height);
    }
    if (r.textBox && b.textType !== 'SFX') {
      // Use the measured text pixels to correct an imprecise model box (keep the larger safe area).
      b.fontSizeEstimate = fontFromLettering(r.textBox, b.originalText, r.lettering);
    }
    b.style = { ...matchLettering(b, r.lettering), ...(b.style ?? {}) };
  };
  for (const b of blocks) cleanOne(b);
  if (!req.generic) {
    // The model sometimes skips text: a second remark in the same bubble, a line of a long one.
    // Lettering still standing on a bubble after cleaning is read again from just that part.
    const probes: LeftoverProbe[] = blocks
      .filter((b) => b.translate && b.textType !== 'SFX' && b.bubble && (letterHeight.get(b.id) ?? 0) >= 6)
      .map((b) => ({ area: b.bubble!.box, fill: parseHex(b.bubble!.fill), letterHeight: letterHeight.get(b.id)! }));
    // …and lettering in light areas nobody reported: a bubble of an unusual shape the model skipped.
    probes.push(...findTextRegions(cleaned));
    const known = blocks.flatMap((b) => (b.textBox ? [b.bbox, b.textBox] : [b.bbox]));
    for (const [k, box] of findLeftoverText(cleaned, probes, known).slice(0, 4).entries()) {
      try {
        const pad = Math.round(Math.max(box[2], box[3]) * 0.3) + 12;
        const r = await recognizeRegion(original, expandBox(box, pad), config, deps, { context: req.context, signal, idPrefix: `x${k}` });
        usage.push(...r.usage);
        const near = expandBox(box, 6);
        for (const nb of r.blocks) {
          // We know where the left-over letters are; the model's box in a crop is only approximate.
          const cut = r.blocks.length === 1 ? near : intersectBox(nb.bbox, near);
          if (!cut) continue;
          nb.bbox = clampBox(cut.map(Math.round) as Box, original.width, original.height);
          nb.polygon = boxToPolygon(nb.bbox);
          nb.fontSizeEstimate = estimateFontSize(nb.bbox, nb.originalText);
          if (!nb.originalText.trim() || !nb.translatedText.trim() || blocks.some((o) => overlapRatio(o.bbox, nb.bbox) > 0.5)) continue;
          nb.language = blocks[0]?.language ?? nb.language;
          cleanOne(nb);
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
  blocks = mergeSharedBubbles(blocks, closedBubble);
  separateAreas(blocks);
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
        decodeMs: Math.round(tDecoded - t0),
        detectMs: Math.round(tDetected - tDecoded),
        ocrMs: 0,
        translateMs: blocksOut.length ? Math.round(tTranslated - tDetected) : 0,
        cleanMs: blocksOut.length ? Math.round(tCleaned - tTranslated) : 0,
        totalMs: Math.round(performance.now() - t0),
      },
      usage,
      pipeline: { version: 1, hash: await pipelineHash(config), mode: 'standalone' },
      summary,
      createdAt: new Date().toISOString(),
    };
    const context = req.context
      ? mergeContext(req.context, {
          entities,
          summary,
          lines: blocksOut.filter((b) => b.textType === 'DIALOGUE' && b.translate).slice(-8).map((b) => ({ src: b.originalText, dst: b.translatedText })),
        })
      : undefined;
    stage('done', 1);
    return { page, original, cleaned: cleaned ?? original.clone(), context };
  }
}

/** Remove duplicates from overlapping views; keep the copy read nearer its view's centre. */
function dedupe(items: Located[]): Located[] {
  const out: Located[] = [];
  for (const it of items) {
    const dupIndex = out.findIndex((o) => overlapRatio(o.box, it.box) > 0.55);
    if (dupIndex < 0) {
      out.push(it);
      continue;
    }
    const o = out[dupIndex];
    const centre = (l: Located) => Math.abs(l.box[1] + l.box[3] / 2 - (l.view.y + l.view.h / 2)) / l.view.h;
    if (centre(it) < centre(o)) out[dupIndex] = it;
  }
  return out;
}

/** Manual OCR: read and translate the text inside one user-selected box. */
export async function recognizeRegion(
  image: TiledImage,
  box: Box,
  config: PipelineConfig,
  deps: StandaloneDeps,
  opts: { context?: TranslationContext; signal?: AbortSignal; idPrefix?: string } = {},
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
  const vision = createProvider(config.vision, deps.fetchImpl);
  const { answer, usage } = await readView(vision, sub, { y: 0, h: region[3] }, { ...config, quality: 'best' }, opts.context, !separate, deps, opts.signal);
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
    };
  });
  if (separate && blocks.length) {
    assertPrivacy(config.privacy, config.translator!, 'text');
    const res = await translateBlocks(createProvider(config.translator!, deps.fetchImpl), promptInput(config, opts.context), blocks.map((b) => ({ id: b.id, type: b.textType, text: b.originalText })), { signal: opts.signal });
    usages.push(...res.usage);
    for (const b of blocks) b.translatedText = res.translations.get(b.id)?.text ?? b.originalText;
  }
  return { blocks, usage: usages };
}

/** Re-translate edited source texts (editor "Retranslate"). */
export async function retranslate(blocks: TextBlock[], config: PipelineConfig, deps: StandaloneDeps, context?: TranslationContext, signal?: AbortSignal): Promise<{ blocks: TextBlock[]; usage: Usage[] }> {
  const provider = config.translator ?? config.vision;
  if (!provider) throw new AppError('NOT_CONFIGURED', { retryable: false });
  assertPrivacy(config.privacy, provider, 'text');
  const res = await translateBlocks(createProvider(provider, deps.fetchImpl), promptInput(config, context), blocks.map((b) => ({ id: b.id, type: b.textType, text: b.originalText })), { signal });
  return {
    blocks: blocks.map((b) => ({ ...b, translatedText: res.translations.get(b.id)?.text ?? b.translatedText })),
    usage: res.usage,
  };
}
