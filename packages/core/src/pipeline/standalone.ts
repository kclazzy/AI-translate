import { familyFor } from '../llm/catalog';
import { AppError } from '../errors';
import type { ImageBackend } from '../image/backend';
import { cleanBlock, findLeftoverText, findTextRegions, luminance, parseHex, type Lettering, type LeftoverProbe } from '../image/clean';
import { boxToPolygon, clampBox, expandBox, overlapRatio, TiledImage } from '../image/tiled';
import { detectScript } from '../languages';
import { assertPrivacy, isLocalProvider, isLocalUrl } from '../llm/privacy';
import { createProvider } from '../llm/presets';
import type { FetchLike, LlmProvider } from '../llm/types';
import { mergeContext, type TranslationContext } from '../translate/context';
import { applyForbiddenFixes, findGlossaryHits, findViolations } from '../translate/glossary';
import { parseVisionAnswer, type VisionAnswer } from '../translate/parse';
import { buildSystemPrompt, visionFullInstruction, visionOcrInstruction, type PromptInput } from '../translate/prompt';
import { translateBlocks, usageFrom } from '../translate/translator';
import type { Box, BubbleInfo, PageResult, StageEvent, TextBlock, TextStyle, Usage } from '../types';
import { bytesToBase64, sha256Hex } from '../util/bytes';
import { mapLimit } from '../util/queue';
import { withRetry } from '../util/retry';
import { pipelineHash, type PipelineConfig } from './config';
import { EngineClient } from './engine';

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

/**
 * Text over artwork is smudged away with a simple fill first; when the local engine runs, LaMa
 * redraws those areas properly (hair, backgrounds). Any failure keeps the simple result.
 */
export async function lamaViaEngine(original: TiledImage, cleaned: TiledImage, masks: { box: Box; mask: Uint8Array }[], engine: { url: string; token: string }, deps: StandaloneDeps, signal?: AbortSignal): Promise<number> {
  const client = new EngineClient(engine.url, engine.token, deps.fetchImpl);
  let done = 0;
  for (const m of masks.slice(0, 12)) {
    try {
      // Context around the mask helps LaMa: a margin of half the box on every side.
      const pad = Math.round(Math.max(24, Math.max(m.box[2], m.box[3]) * 0.5));
      const area = clampBox([m.box[0] - pad, m.box[1] - pad, m.box[2] + pad * 2, m.box[3] + pad * 2], original.width, original.height);
      const [ax, ay, aw, ah] = area;
      const img = original.getRegion(ax, ay, aw, ah);
      const c = deps.backend.createCanvas(aw, ah);
      const ctx = c.getContext('2d');
      const id = ctx.createImageData(aw, ah);
      id.data.set(img.data);
      ctx.putImageData(id, 0, 0);
      const mc = deps.backend.createCanvas(aw, ah);
      const mctx = mc.getContext('2d');
      const md = mctx.createImageData(aw, ah);
      const inMask = new Uint8Array(aw * ah);
      for (let y = 0; y < m.box[3]; y++) {
        for (let x = 0; x < m.box[2]; x++) {
          if (!m.mask[y * m.box[2] + x]) continue;
          const px = m.box[0] - ax + x;
          const py = m.box[1] - ay + y;
          if (px < 0 || py < 0 || px >= aw || py >= ah) continue;
          const i = py * aw + px;
          inMask[i] = 1;
          md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
        }
      }
      for (let i = 0; i < aw * ah; i++) md.data[i * 4 + 3] = 255;
      mctx.putImageData(md, 0, 0);
      const out = await client.inpaint(await deps.backend.encode(c, 'image/png'), await deps.backend.encode(mc, 'image/png'), signal);
      const dec = await deps.backend.decode(out, 'image/png');
      const oc = deps.backend.createCanvas(aw, ah);
      oc.getContext('2d').drawImage(dec.source, 0, 0, aw, ah);
      dec.close?.();
      const res = oc.getContext('2d').getImageData(0, 0, aw, ah);
      // Only the masked pixels change; everything else stays exactly as cleaned.
      const cur = cleaned.getRegion(ax, ay, aw, ah);
      for (let i = 0; i < inMask.length; i++) if (inMask[i]) for (let k = 0; k < 3; k++) cur.data[i * 4 + k] = res.data[i * 4 + k];
      cleaned.putRegion(cur, ax, ay);
      done++;
    } catch (e) {
      if ((e as { code?: string }).code === 'CANCELLED') throw e;
      break; // the engine is not there or has no LaMa: keep the simple fill
    }
  }
  return done;
}

/** Does text written in this script belong to the language (kanji-only Japanese looks Chinese)? */
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

function mergeGroup(g: TextBlock[]): TextBlock {
  if (g.length === 1) return g[0];
  const first = g[0];
  let bbox = first.bbox;
  for (const o of g.slice(1)) {
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
    // The user's filters: only bubbles, only the chosen language.
    const skip = (config.bubblesOnly && (l.type === 'SFX' || l.type === 'SIGN' || l.type === 'OTHER')) || (config.onlySourceLang && !scriptFits(script, config.sourceLang));
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
  const artMasks: { box: Box; mask: Uint8Array }[] = [];
  const cleanOne = (b: TextBlock) => {
    const erase = b.translate && !(b.textType === 'SFX' && config.sfxStyle === 'original');
    if (req.generic) {
      // UI/screen text: no bubbles; paint a plate behind the text instead.
      const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase, expand: config.inpaintExpand });
      b.bubble = r.bubble ? { ...r.bubble, shape: 'rect', safeArea: [...b.bbox] as Box } : null;
      return;
    }
    const r = cleanBlock(cleaned!, b.bbox, { analyzeOnly: !erase, sfx: b.textType === 'SFX', expand: config.inpaintExpand });
    if (r.artMask) artMasks.push(r.artMask);
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
    if (r.textGroups && b.textType !== 'SFX' && b.translate) groupsOf.set(b.id, { groups: r.textGroups, lettering: r.lettering });
  };
  const groupsOf = new Map<string, { groups: Box[]; lettering?: Lettering }>();
  for (const b of blocks) cleanOne(b);
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
      return splitByGroups(b, info.groups, info.lettering, original.width, original.height);
    });
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
  // The picture goes to the engine: only to one on this computer / network unless the cloud is allowed.
  if (config.lamaEngine && config.engine?.url && artMasks.length && (config.privacy === 'cloud' || isLocalUrl(config.engine.url))) await lamaViaEngine(original, cleaned, artMasks, config.engine, deps, signal);
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
