/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset, DEFAULT_PROFILES, defaultSettings, pipelineConfigFromSettings, pipelineHash, runStandalonePipeline } from '../src';
import { pieceBoxes, planCollage, withPieceBoxes } from '../src/pipeline/collage';
import { detectorWindows, type Detection, type TextDetector } from '../src/pipeline/detect';
import type { PixelData } from '../src/image/backend';
import type { Box } from '../src/types';
import { mockOpenAi, napiBackend } from './helpers';

function fakeDetector(page: Detection[], W: number, H: number): TextDetector {
  const wins = detectorWindows(W, H);
  let calls = 0;
  return (async (img: PixelData) => {
    const win = wins[calls++ % wins.length];
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
  }) as TextDetector;
}

const W = 800;
const H = 1400;
const bubbles = [
  { cx: 220, cy: 260, rx: 150, ry: 80, text: 'HELLO', box: [175, 245, 90, 28] as Box },
  { cx: 560, cy: 1100, rx: 160, ry: 80, text: 'GOODBYE', box: [495, 1085, 130, 28] as Box },
];

async function page(): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  for (let x = 0; x < W; x += 10) {
    ctx.fillStyle = `hsl(${(x * 3) % 360}, 55%, 45%)`;
    ctx.fillRect(x, 0, 10, H);
  }
  for (const b of bubbles) {
    ctx.beginPath();
    ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.text, b.cx, b.cy);
  }
  return new Uint8Array(await c.encode('png'));
}

const dets: Detection[] = bubbles.flatMap((b) => [
  { box: b.box, kind: 'text_bubble', score: 0.9 } as Detection,
  { box: [b.cx - b.rx, b.cy - b.ry, b.rx * 2, b.ry * 2] as Box, kind: 'bubble', score: 0.9 } as Detection,
]);

const config = (collage = true): any => ({
  mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
  vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, detector: true, skipEmptyPages: true, collage,
});

async function sentImage(body: any): Promise<{ width: number; height: number }> {
  const parts = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
  const url: string = parts.find((p: any) => p.type === 'image_url').image_url.url;
  const img = await loadImage(Buffer.from(url.split(',')[1], 'base64'));
  return { width: img.width, height: img.height };
}
const instruction = (body: any) => body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [{ text: m.content }])).map((p: any) => p.text ?? '').join('\n');
const inside = (a: Box, b: Box, tol = 0) => a[0] >= b[0] - tol && a[1] >= b[1] - tol && a[0] + a[2] <= b[0] + b[2] + tol && a[1] + a[3] <= b[1] + b[3] + tol;

describe('collage of the text pieces', () => {
  it('pads, merges touching boxes and keeps reading order', () => {
    const boxes = pieceBoxes([[500, 100, 100, 40], [100, 100, 100, 40], [100, 145, 100, 40], [100, 900, 50, 30]], 800, 1000);
    expect(boxes).toHaveLength(3);
    expect(boxes[0][0]).toBeLessThan(100);
    expect(boxes[0][3]).toBeGreaterThan(85); // the two touching boxes are one piece
    expect(boxes[1][0]).toBeGreaterThan(400);
    expect(boxes[2][1]).toBeGreaterThan(800);
  });

  it('lays pieces out in a narrow picture with room for the numbers', () => {
    const plan = planCollage([[0, 0, 300, 100], [0, 200, 300, 100], [0, 400, 300, 100], [0, 600, 1500, 200]], 1024);
    expect(plan.width).toBeLessThanOrEqual(1024);
    expect(plan.pieces.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(plan.pieces[3].at[2]).toBeLessThan(1024);
    for (const p of plan.pieces) expect(p.at[0]).toBeGreaterThanOrEqual(30);
  });

  it('maps the answer back onto the page; two bubbles in one piece get one each', () => {
    const plan = planCollage([[100, 100, 400, 100]], 1024, [[110, 110, 150, 80], [300, 110, 150, 80]]);
    const out = JSON.parse(withPieceBoxes(JSON.stringify({ blocks: [{ id: 1, text: 'A' }, { id: 1, text: 'B' }, { id: 7, text: 'X' }] }), plan.pieces, 1000, 1000));
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[0].box).toEqual([110, 110, 260, 190]);
    expect(out.blocks[1].box).toEqual([300, 110, 450, 190]);
  });

  it('the pipeline sends a small picture of the bubbles, and the text lands in its bubble', async () => {
    const { fetchImpl, calls } = mockOpenAi(() => JSON.stringify({ blocks: [{ id: 1, text: 'HELLO', translation: 'ПРИВЕТ', type: 'DIALOGUE' }, { id: 2, text: 'GOODBYE', translation: 'ПОКА', type: 'DIALOGUE' }], entities: [], summary: '' }));
    const out = await runStandalonePipeline({ bytes: await page(), config: config(), debug: true } as any, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: fakeDetector(dets, W, H) });
    expect(calls).toHaveLength(1);
    expect(instruction(calls[0].body)).toContain('collage of 2 pieces');
    const img = await sentImage(calls[0].body);
    expect(img.width * img.height).toBeLessThan(W * H * 0.15);
    const hello = out.page.blocks.find((b) => b.translatedText === 'ПРИВЕТ');
    const bye = out.page.blocks.find((b) => b.translatedText === 'ПОКА');
    expect(hello && inside(hello.bbox, [bubbles[0].cx - bubbles[0].rx, bubbles[0].cy - bubbles[0].ry, bubbles[0].rx * 2, bubbles[0].ry * 2])).toBe(true);
    expect(bye && inside(bye.bbox, [bubbles[1].cx - bubbles[1].rx, bubbles[1].cy - bubbles[1].ry, bubbles[1].rx * 2, bubbles[1].ry * 2])).toBe(true);
  });

  it('nothing read from the collage → the whole page is read as before', async () => {
    const { fetchImpl, calls } = mockOpenAi((body, n) =>
      n === 1
        ? JSON.stringify({ blocks: [], entities: [], summary: '' })
        : JSON.stringify({ blocks: [{ box: [219, 175, 331, 196], text: 'HELLO', translation: 'ПРИВЕТ', type: 'DIALOGUE', vertical: false }], entities: [], summary: '' }),
    );
    const out = await runStandalonePipeline({ bytes: await page(), config: config() }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: fakeDetector(dets, W, H) });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(instruction(calls[1].body)).not.toContain('collage');
    expect(out.page.blocks.find((b) => b.translatedText === 'ПРИВЕТ')).toBeTruthy();
  });

  it('off: the whole page is sent', async () => {
    const { fetchImpl, calls } = mockOpenAi(() => JSON.stringify({ blocks: [], entities: [], summary: '' }));
    await runStandalonePipeline({ bytes: await page(), config: config(false) }, { backend: napiBackend, fetchImpl: fetchImpl as any, detect: fakeDetector(dets, W, H) });
    expect(instruction(calls[0].body)).not.toContain('collage');
  });

  it('setting: on by default with a local model and the detector, off with a cloud one; part of the cache key', async () => {
    const d = defaultSettings();
    const local = { ...d, detectorMode: 'browser' as const, providers: [{ ...configFromPreset('lmstudio', 'vlm'), id: 'l', vision: true }], visionProviderId: 'l' } as any;
    expect(pipelineConfigFromSettings(local).collage).toBe(true);
    expect(pipelineConfigFromSettings({ ...local, readCrops: false }).collage).toBeUndefined();
    expect(pipelineConfigFromSettings({ ...local, detectorMode: undefined }).collage).toBeUndefined();
    const cloud = { ...local, providers: [{ ...configFromPreset('openai', 'gpt-4o'), id: 'c', vision: true }], visionProviderId: 'c' };
    expect(pipelineConfigFromSettings(cloud).collage).toBeUndefined();
    expect(pipelineConfigFromSettings({ ...cloud, readCrops: true }).collage).toBe(true);
    expect(await pipelineHash(pipelineConfigFromSettings(local))).not.toBe(await pipelineHash(pipelineConfigFromSettings({ ...local, readCrops: false })));
  });
});
