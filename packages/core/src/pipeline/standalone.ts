import { AppError } from '../errors';
import type { ImageBackend } from '../image/backend';
import { cleanBlock } from '../image/clean';
import { boxToPolygon, clampBox, overlapRatio, TiledImage } from '../image/tiled';
import { detectScript } from '../languages';
import { assertPrivacy } from '../llm/privacy';
import { createProvider } from '../llm/presets';
import type { FetchLike, LlmProvider } from '../llm/types';
import { mergeContext, type TranslationContext } from '../translate/context';
import { applyForbiddenFixes, findGlossaryHits, findViolations } from '../translate/glossary';
import { parseVisionAnswer, type VisionAnswer } from '../translate/parse';
import { buildSystemPrompt, visionFullInstruction, visionOcrInstruction, type PromptInput } from '../translate/prompt';
import { translateBlocks, usageFrom } from '../translate/translator';
import type { Box, PageResult, StageEvent, TextBlock, Usage } from '../types';
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
}

async function readView(provider: LlmProvider, image: TiledImage, view: View, config: PipelineConfig, context: TranslationContext | undefined, withTranslation: boolean, deps: StandaloneDeps, signal?: AbortSignal): Promise<{ answer: VisionAnswer; usage: Usage }> {
  const maxSide = MAX_SIDE[config.quality];
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
      return { answer: parseVisionAnswer(res.text, withTranslation), usage: usageFrom(provider, res.model, res.inputTokens, res.outputTokens) };
    },
    { retries: 2, signal },
  );
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
  const separate = !!config.translator && config.translator.id !== config.vision.id;
  if (separate) assertPrivacy(config.privacy, config.translator!, 'text');

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
  const answers = await mapLimit(views, 2, async (view, i) => {
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
      located.push({ box: clampBox(box, original.width, original.height), text: b.text, translation: b.translation, type: b.type, vertical: b.vertical, view });
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
    };
  });

  stage('translating');
  if (separate) {
    const translator = createProvider(config.translator!, deps.fetchImpl);
    const toTranslate = blocks.filter((b) => b.translate).map((b) => ({ id: b.id, type: b.textType, text: b.originalText }));
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
  for (const b of blocks) {
    const erase = b.translate && !(b.textType === 'SFX' && config.sfxStyle === 'original');
    if (req.generic) {
      // UI/screen text: no bubbles; paint a plate behind the text instead.
      const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase });
      b.bubble = r.bubble ? { ...r.bubble, shape: 'rect', safeArea: b.bbox } : null;
      continue;
    }
    const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase });
    b.bubble = r.bubble;
    if (r.textBox && b.textType !== 'SFX') {
      // Use the measured text pixels to correct an imprecise model box (keep the larger safe area).
      b.fontSizeEstimate = estimateFontSize(r.textBox, b.originalText);
    }
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
