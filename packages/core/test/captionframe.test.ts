/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { luminance } from '../src/image/clean';
import { fakeDetector, mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const W = 800;
const H = 1280;
type Box = [number, number, number, number];
// Two caption boxes drawn as one stepped frame (the lower one starts inside the upper one's corner).
const A: Box = [70, 368, 502, 264];
const B: Box = [244, 605, 502, 264];
const TEXT_A = ['FOR THE FIRST TIME', 'IN MY HUNTING CAREER,', 'I TOOK DOWN A MONSTER', 'SOLO.'];
const TEXT_B = ['I GOT TO CLAIM ALL', 'THE XP FOR MYSELF, NO', 'SHARING WITH OTHERS.'];

function page() {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 3;
  // The outline of the two boxes together.
  ctx.beginPath();
  ctx.moveTo(A[0], A[1]);
  ctx.lineTo(A[0] + A[2], A[1]);
  ctx.lineTo(A[0] + A[2], B[1]);
  ctx.lineTo(B[0] + B[2], B[1]);
  ctx.lineTo(B[0] + B[2], B[1] + B[3]);
  ctx.lineTo(B[0], B[1] + B[3]);
  ctx.lineTo(B[0], A[1] + A[3]);
  ctx.lineTo(A[0], A[1] + A[3]);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#000000';
  ctx.font = '30px TestSans';
  ctx.textAlign = 'center';
  TEXT_A.forEach((l, i) => ctx.fillText(l, 322, 452 + i * 38));
  TEXT_B.forEach((l, i) => ctx.fillText(l, 500, 706 + i * 38));
  return { c, data: new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data) };
}

const lum = (d: Uint8ClampedArray, x: number, y: number) => luminance(d[(y * W + x) * 4], d[(y * W + x) * 4 + 1], d[(y * W + x) * 4 + 2]);
/** Share of the frame's line still dark along a segment. */
function lineKept(d: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number): number {
  let dark = 0;
  const n = 100;
  for (let i = 5; i < n - 5; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n);
    const y = Math.round(y0 + ((y1 - y0) * i) / n);
    let hit = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (lum(d, x + dx, y + dy) < 100) hit = true;
    if (hit) dark++;
  }
  return dark / (n - 10);
}

describe('captions in a drawn frame (two boxes as one stepped outline)', () => {
  for (const detector of [true, false])
    it(`the frame stays, the letters go${detector ? ' (boxes from the detector)' : ''}`, async () => {
      const p = page();
      const ta: Box = [110, 411, 427, 170];
      const tb: Box = [300, 678, 399, 123];
      const mock = mockOpenAi((_b, call) =>
        call > 1
          ? JSON.stringify({ blocks: [], entities: [], summary: '' })
          : JSON.stringify({
              blocks: [
                { box: toNorm(ta, W, H), text: TEXT_A.join(' '), translation: 'Впервые в своей охотничьей карьере я одолела монстра в одиночку.', type: 'DIALOGUE' },
                { box: toNorm(tb, W, H), text: TEXT_B.join(' '), translation: 'Я получила весь опыт сама, без разделения с другими.', type: 'DIALOGUE' },
              ],
              entities: [],
              summary: '',
            }),
      );
      const out = await runStandalonePipeline(
        { bytes: new Uint8Array(await p.c.encode('png')), config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: false, vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, ...(detector ? { detector: true } : {}) } as any },
        {
          backend: napiBackend,
          fetchImpl: mock.fetchImpl,
          ...(detector
            ? {
                detect: fakeDetector(
                  [
                    { kind: 'bubble', box: [59, 357, 523, 276], score: 0.9 },
                    { kind: 'bubble', box: [231, 609, 525, 191], score: 0.9 },
                    { kind: 'text_bubble', box: ta, score: 0.9 },
                    { kind: 'text_bubble', box: tb, score: 0.9 },
                  ],
                  W,
                  H,
                ),
              }
            : {}),
        } as any,
      );
      const after = out.cleaned.getRegion(0, 0, W, H).data;
      const shot = createCanvas(W, H);
      const id = (shot.getContext('2d') as any).createImageData(W, H);
      id.data.set(after);
      (shot.getContext('2d') as any).putImageData(id, 0, 0);
      writeFileSync(`${OUT}captionframe-cleaned${detector ? '-det' : ''}.png`, new Uint8Array(await shot.encode('png')));
      // Every side of the frame is still drawn.
      const sides: [number, number, number, number][] = [
        [A[0], A[1], A[0] + A[2], A[1]],
        [A[0] + A[2], A[1], A[0] + A[2], B[1]],
        [A[0] + A[2], B[1], B[0] + B[2], B[1]],
        [B[0] + B[2], B[1], B[0] + B[2], B[1] + B[3]],
        [B[0] + B[2], B[1] + B[3], B[0], B[1] + B[3]],
        [B[0], B[1] + B[3], B[0], A[1] + A[3]],
        [B[0], A[1] + A[3], A[0], A[1] + A[3]],
        [A[0], A[1] + A[3], A[0], A[1]],
      ];
      expect(sides.map((s) => Math.round(lineKept(after, ...s) * 100))).toEqual(sides.map(() => 100));
      // The letters are gone: nothing dark is left where they were.
      let dark = 0;
      for (const [x, y, w, h] of [ta, tb]) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (lum(after, xx, yy) < 120) dark++;
      expect(dark).toBeLessThan(20);
    });
});
