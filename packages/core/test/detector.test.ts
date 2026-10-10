/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset, DEFAULT_PROFILES, migrateSettings, defaultSettings, pipelineConfigFromSettings, pipelineHash, runStandalonePipeline } from '../src';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import type { PixelData } from '../src/image/backend';
import { bubbleAround, detectedTextNear, detectorWindows, detectPage, mergeDetections, missedText, parseDetectorOutputs, snapBlocksToDetections, type Detection, type TextDetector } from '../src/pipeline/detect';
import type { Box, TextBlock } from '../src/types';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

/** A detector that "sees" the given page boxes: each call is the next window of the page. */
function fakeDetector(page: Detection[], W: number, H: number, opts: { fail?: boolean } = {}): TextDetector & { calls: number } {
  const wins = detectorWindows(W, H);
  const f = (async (img: PixelData) => {
    if (opts.fail) throw new Error('model broken');
    const win = wins[f.calls++ % wins.length];
    const sx = img.width / win.w;
    const sy = img.height / win.h;
    const boxes: Detection[] = [];
    for (const d of page) {
      const x0 = Math.max(d.box[0], win.x);
      const y0 = Math.max(d.box[1], win.y);
      const x1 = Math.min(d.box[0] + d.box[2], win.x + win.w);
      const y1 = Math.min(d.box[1] + d.box[3], win.y + win.h);
      if (x1 <= x0 || y1 <= y0) continue;
      boxes.push({ kind: d.kind, score: d.score, box: [(x0 - win.x) * sx, (y0 - win.y) * sy, (x1 - x0) * sx, (y1 - y0) * sy] });
    }
    return { boxes };
  }) as TextDetector & { calls: number };
  f.calls = 0;
  return f;
}

const baseConfig = (): any => ({
  mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
  vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, detector: true, skipEmptyPages: true,
});

const answer = (blocks: { box: Box; text: string; translation: string }[], W: number, H: number) =>
  JSON.stringify({ blocks: blocks.map((b) => ({ box: toNorm(b.box, W, H), text: b.text, translation: b.translation, type: 'DIALOGUE', vertical: false })), entities: [], summary: '' });

/** Colourful stripes (art), optional white bubble with dark text, optional outlined text over the art. */
async function page(W: number, H: number, opts: { bubble?: { cx: number; cy: number; rx: number; ry: number; text: string }; art?: { x: number; y: number; text: string }; plain?: boolean; outline?: boolean }): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  if (opts.plain) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  } else {
    for (let x = 0; x < W; x += 10) {
      ctx.fillStyle = `hsl(${(x * 3) % 360}, 55%, 45%)`;
      ctx.fillRect(x, 0, 10, H);
    }
  }
  if (opts.bubble) {
    const b = opts.bubble;
    ctx.beginPath();
    ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    if (opts.outline !== false) {
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#000000';
      ctx.stroke();
    }
    ctx.fillStyle = '#000000';
    ctx.font = '28px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText(b.text, b.cx, b.cy + 10);
  }
  if (opts.art) {
    ctx.font = 'bold 40px TestSans';
    ctx.textAlign = 'left';
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#000000';
    ctx.fillStyle = '#ffffff';
    ctx.strokeText(opts.art.text, opts.art.x, opts.art.y);
    ctx.fillText(opts.art.text, opts.art.x, opts.art.y);
  }
  return new Uint8Array(await c.encode('png'));
}

const inside = (a: Box, b: Box, m = 0) => a[0] >= b[0] - m && a[1] >= b[1] - m && a[0] + a[2] <= b[0] + b[2] + m && a[1] + a[3] <= b[1] + b[3] + m;

describe('detector outputs', () => {
  it('Hugging Face form: sigmoid of the logits, normalised cx,cy,w,h boxes', () => {
    const logits = new Float32Array([-6, 3, -6, 2, -6, -6, -6, -6, -6]); // query 0: text_bubble; 1: bubble; 2: nothing
    const boxes = new Float32Array([0.5, 0.5, 0.25, 0.125, 0.5, 0.5, 0.5, 0.5, 0.1, 0.1, 0.1, 0.1]);
    const d = parseDetectorOutputs([{ name: 'logits', dims: [1, 3, 3], data: logits }, { name: 'pred_boxes', dims: [1, 3, 4], data: boxes }], 640);
    expect(d).toHaveLength(2);
    const t = d.find((x) => x.kind === 'text_bubble')!;
    expect(t.score).toBeCloseTo(1 / (1 + Math.exp(-3)), 5);
    expect(t.box.map(Math.round)).toEqual([240, 280, 160, 80]);
    expect(d.find((x) => x.kind === 'bubble')!.box.map(Math.round)).toEqual([160, 160, 320, 320]);
  });

  it('RT-DETR deploy form: labels, x1,y1,x2,y2 pixel boxes, scores; outputs found by shape too', () => {
    const labels = new BigInt64Array([2n, 0n, 1n]);
    const boxes = new Float32Array([10, 20, 110, 70, 0, 0, 300, 300, 5, 5, 6, 6]);
    const scores = new Float32Array([0.9, 0.8, 0.1]);
    const d = parseDetectorOutputs([{ name: 'labels', dims: [1, 3], data: labels }, { name: 'boxes', dims: [1, 3, 4], data: boxes }, { name: 'scores', dims: [1, 3], data: scores }], 640);
    expect(d.map((x) => x.kind)).toEqual(['text_free', 'bubble']);
    expect(d[0].box).toEqual([10, 20, 100, 50]);
    // Unnamed outputs: told apart by their shapes and types.
    const d2 = parseDetectorOutputs([{ name: 'o1', dims: [1, 3], data: labels }, { name: 'o2', dims: [1, 3, 4], data: boxes }, { name: 'o3', dims: [1, 3], data: scores }], 640);
    expect(d2).toEqual(d);
  });
});

describe('detector windows over tall pages', () => {
  it('a webtoon strip is cut into square windows overlapping by 15 %, reaching the bottom', () => {
    const w = detectorWindows(800, 3000);
    expect(w[0]).toEqual({ x: 0, y: 0, w: 800, h: 800 });
    expect(w[1].y).toBe(680);
    expect(w[w.length - 1].y + w[w.length - 1].h).toBe(3000);
    for (const x of w) expect(x.h).toBe(800);
    expect(detectorWindows(800, 1000)).toEqual([{ x: 0, y: 0, w: 800, h: 1000 }]);
  });

  it('boxes are mapped back to the page; one seen by two windows is kept once, whole', async () => {
    const W = 800;
    const H = 3000;
    const img = await TiledImage.fromBytes(napiBackend, await page(W, H, {}));
    const truth: Detection[] = [
      { box: [100, 200, 200, 80], kind: 'text_bubble', score: 0.9 },
      // In the overlap of windows 0 and 1 (680–800) and cut by window 0's bottom edge.
      { box: [300, 740, 220, 100], kind: 'text_free', score: 0.8 },
      { box: [80, 2600, 500, 300], kind: 'bubble', score: 0.95 },
      { box: [10, 1500, 50, 40], kind: 'text_free', score: 0.2 }, // too weak
    ];
    const det = fakeDetector(truth, W, H);
    const got = await detectPage(img, det, napiBackend);
    expect(det.calls).toBe(detectorWindows(W, H).length);
    expect(got).toHaveLength(3);
    for (const t of truth.slice(0, 3)) {
      const g = got.find((x) => x.kind === t.kind)!;
      for (let k = 0; k < 4; k++) expect(Math.abs(g.box[k] - t.box[k])).toBeLessThanOrEqual(2);
    }
  });

  it('non-maximum suppression: the stronger of two overlapping text boxes wins, bubbles apart', () => {
    const d = mergeDetections([
      { box: [0, 0, 100, 50], kind: 'text_bubble', score: 0.6 },
      { box: [5, 2, 100, 50], kind: 'text_free', score: 0.9 },
      { box: [0, 0, 100, 50], kind: 'bubble', score: 0.5 },
    ]);
    expect(d).toHaveLength(2);
    expect(d.find((x) => x.kind !== 'bubble')!.score).toBe(0.9);
  });
});

const block = (id: string, bbox: Box, extra: Partial<TextBlock> = {}): TextBlock => ({ id, textType: 'DIALOGUE', originalText: 'HELLO', translatedText: 'ПРИВЕТ', confidence: 0.9, language: 'en', bbox, polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true, ...extra });

describe('using the boxes', () => {
  it('a loose model box snaps to the text box it covers; a text box two blocks share is cut between them; SFX keep theirs', () => {
    const dets: Detection[] = [
      { box: [100, 100, 120, 40], kind: 'text_bubble', score: 0.9 },
      { box: [400, 100, 100, 200], kind: 'text_bubble', score: 0.9 },
      { box: [700, 700, 50, 50], kind: 'text_free', score: 0.9 },
    ];
    const blocks = [block('a', [60, 60, 260, 140]), block('b', [400, 90, 100, 100]), block('c', [400, 200, 100, 110]), block('s', [690, 690, 200, 200], { textType: 'SFX' })];
    const moved = snapBlocksToDetections(blocks, dets, 1000, 1000);
    expect(blocks[0].bbox).toEqual([98, 98, 124, 44]);
    expect(inside(blocks[1].bbox, [400, 90, 100, 100], 2)).toBe(true);
    expect(inside(blocks[2].bbox, [400, 200, 100, 110], 2)).toBe(true);
    expect(blocks[3].bbox).toEqual([690, 690, 200, 200]);
    expect([...moved].sort()).toEqual(['a', 'b', 'c']);
  });

  it('a block with no text box finds the nearest free one; bubbles hold their block; missed text is what no block covers', () => {
    const dets: Detection[] = [
      { box: [500, 100, 80, 30], kind: 'text_bubble', score: 0.9 },
      { box: [300, 100, 80, 30], kind: 'text_bubble', score: 0.9 },
      { box: [280, 60, 140, 120], kind: 'bubble', score: 0.9 },
      { box: [200, 20, 400, 300], kind: 'bubble', score: 0.9 },
      { box: [100, 800, 80, 30], kind: 'text_free', score: 0.45 },
    ];
    const blocks = [block('a', [150, 100, 60, 30]), block('b', [495, 95, 90, 40])];
    expect(detectedTextNear(blocks[0], blocks, dets, 1000)).toEqual([300, 100, 80, 30]);
    expect(bubbleAround([300, 100, 80, 30], dets)).toEqual([280, 60, 140, 120]);
    expect(bubbleAround([150, 100, 60, 30], dets)).toBeUndefined();
    expect(missedText(blocks, dets)).toEqual([[300, 100, 80, 30]]);
  });

  it('a bubble much bigger than its text closes only with the detector, and only inside its box', async () => {
    const c = createCanvas(900, 900);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#505050';
    ctx.fillRect(0, 0, 900, 900);
    // A big rectangular caption box (not an oval): bigger than the text allows on its own.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(150, 150, 600, 500);
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.strokeRect(150, 150, 600, 500);
    ctx.fillStyle = '#000000';
    ctx.font = '28px TestSans';
    ctx.fillText('HI', 430, 410);
    const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')));
    const text: Box = [425, 385, 45, 32];
    expect(cleanBlock(img, text, { analyzeOnly: true }).closed).toBe(false);
    const r = cleanBlock(img, text, { analyzeOnly: true, bubbleBox: [146, 146, 608, 508] });
    expect(r.closed).toBe(true);
    expect(inside(r.bubble!.box, [146, 146, 608, 508], 4)).toBe(true);
    // The detector saw a smaller bubble: the flood that spills past it is not that bubble.
    expect(cleanBlock(img, text, { analyzeOnly: true, bubbleBox: [380, 350, 140, 100] }).closed).toBe(false);
  });
});

describe('the pipeline with the detector', () => {
  const W = 800;
  const H = 900;
  const bubble = { cx: 250, cy: 300, rx: 150, ry: 90, text: 'HELLO' };
  const helloBox: Box = [210, 290, 85, 25];

  it('reads text the model skipped where the detector found it (at most 6), and not without the detector', async () => {
    const bytes = await page(W, H, { bubble, art: { x: 420, y: 700, text: 'HEY YOU' } });
    const heyBox: Box = [415, 665, 180, 50];
    const dets: Detection[] = [
      { box: helloBox, kind: 'text_bubble', score: 0.9 },
      { box: [100, 210, 300, 180], kind: 'bubble', score: 0.9 },
      { box: heyBox, kind: 'text_free', score: 0.85 },
    ];
    const run = async (detect?: TextDetector) => {
      const { fetchImpl, calls } = mockOpenAi((_b, n) => (n === 1 ? answer([{ box: [205, 280, 100, 40], text: 'HELLO', translation: 'ПРИВЕТ' }], W, H) : JSON.stringify({ blocks: [{ box: [150, 150, 850, 850], text: 'HEY YOU', translation: 'ЭЙ ТЫ', type: 'DIALOGUE', vertical: false }], entities: [], summary: '' })));
      const out = await runStandalonePipeline({ bytes, config: baseConfig() }, { backend: napiBackend, fetchImpl: fetchImpl as any, ...(detect ? { detect } : {}) });
      return { out, calls };
    };
    const withDet = await run(fakeDetector(dets, W, H));
    const hey = withDet.out.page.blocks.find((b) => b.translatedText === 'ЭЙ ТЫ');
    expect(hey).toBeTruthy();
    expect(inside(hey!.bbox, heyBox, 6)).toBe(true);
    expect(withDet.out.page.blocks.find((b) => b.translatedText === 'ПРИВЕТ')).toBeTruthy();
    expect(withDet.out.page.timings.detectorMs).toBeGreaterThanOrEqual(0);
    const without = await run();
    expect(without.out.page.blocks.find((b) => b.translatedText === 'ЭЙ ТЫ')).toBeUndefined();
  });

  it('snaps a loose model box onto the lettering and keeps the bubble', async () => {
    const bytes = await page(W, H, { bubble });
    const dets: Detection[] = [
      { box: helloBox, kind: 'text_bubble', score: 0.9 },
      { box: [100, 210, 300, 180], kind: 'bubble', score: 0.9 },
    ];
    const { fetchImpl } = mockOpenAi(() => answer([{ box: [150, 250, 330, 170], text: 'HELLO', translation: 'ПРИВЕТ' }], W, H));
    const out = await runStandalonePipeline({ bytes, config: baseConfig() }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: fakeDetector(dets, W, H) });
    const b = out.page.blocks[0];
    expect(inside(b.bbox, helloBox, 4)).toBe(true);
    expect(b.bubble?.shape).toBe('ellipse');
    expect(inside(b.bubble!.box, [100, 210, 300, 180], 4)).toBe(true);
  });

  it('a bubble the cleaner cannot close (no outline) gets an ellipse inscribed in the detector bubble', async () => {
    const bytes = await page(W, H, { bubble: { ...bubble }, plain: true, outline: false });
    const det: Box = [100, 210, 300, 180];
    const dets: Detection[] = [
      { box: helloBox, kind: 'text_bubble', score: 0.9 },
      { box: det, kind: 'bubble', score: 0.9 },
    ];
    const { fetchImpl } = mockOpenAi(() => answer([{ box: helloBox, text: 'HELLO', translation: 'ПРИВЕТ' }], W, H));
    const out = await runStandalonePipeline({ bytes, config: baseConfig() }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: fakeDetector(dets, W, H) });
    const b = out.page.blocks[0];
    expect(b.bubble?.shape).toBe('ellipse');
    expect(b.bubble?.box).toEqual(det);
    expect(inside(b.bubble!.safeArea, det)).toBe(true);
  });

  it('the empty-page check follows the detector: no text box → skipped; text box on a page the heuristic calls empty → read', async () => {
    const withText = await page(W, H, { bubble });
    const a = mockOpenAi(() => answer([], W, H));
    const skipped = await runStandalonePipeline({ bytes: withText, config: baseConfig() }, { backend: napiBackend, fetchImpl: a.fetchImpl as any, detect: fakeDetector([{ box: [100, 210, 300, 180], kind: 'bubble', score: 0.9 }], W, H) });
    expect(skipped.page.skippedNoText).toBe(true);
    expect(a.calls).toHaveLength(0);

    const blank = await page(W, H, {});
    const b = mockOpenAi(() => answer([], W, H));
    const read = await runStandalonePipeline({ bytes: blank, config: baseConfig() }, { backend: napiBackend, fetchImpl: b.fetchImpl as any, detect: fakeDetector([{ box: [100, 100, 100, 40], kind: 'text_free', score: 0.9 }], W, H) });
    expect(read.page.skippedNoText).toBeUndefined();
    expect(b.calls.length).toBeGreaterThan(0);

    // A broken detector: the local heuristic decides, as without it.
    const c = mockOpenAi(() => answer([], W, H));
    const fallback = await runStandalonePipeline({ bytes: blank, config: baseConfig() }, { backend: napiBackend, fetchImpl: c.fetchImpl as any, detect: fakeDetector([], W, H, { fail: true }) });
    expect(fallback.page.skippedNoText).toBe(true);
  });

  it('switched off in the settings: the detector is not called', async () => {
    const det = fakeDetector([{ box: helloBox, kind: 'text_bubble', score: 0.9 }], W, H);
    const { fetchImpl } = mockOpenAi(() => answer([{ box: helloBox, text: 'HELLO', translation: 'ПРИВЕТ' }], W, H));
    await runStandalonePipeline({ bytes: await page(W, H, { bubble }), config: { ...baseConfig(), detector: undefined } }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: det });
    expect(det.calls).toBe(0);
  });
});

describe('detector setting', () => {
  it('is validated, becomes part of the pipeline config, and changes the cache key only when on', async () => {
    const d = defaultSettings();
    expect(migrateSettings({ ...d, detectorMode: 'browser' }).detectorMode).toBe('browser');
    expect(migrateSettings({ ...d, detectorMode: 'gpu' } as any).detectorMode).toBeUndefined();
    const off = pipelineConfigFromSettings(d);
    const on = pipelineConfigFromSettings({ ...d, detectorMode: 'browser' });
    expect(off.detector).toBeUndefined();
    expect(on.detector).toBe(true);
    expect(await pipelineHash(pipelineConfigFromSettings({ ...d, detectorMode: 'off' }))).toBe(await pipelineHash(off));
    expect(await pipelineHash(on)).not.toBe(await pipelineHash(off));
  });
});
