/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { luminance } from '../src/image/clean';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const W = 900;
const H = 700;
const PANEL: [number, number, number, number] = [180, 200, 560, 300];
const LINES = ['Trick Blade:', 'ATK Bonus: +110%', 'Time Remaining: 0s'];

/** A game window: a dark see-through plate with glowing edges over a light page, white lettering. */
function page(streaks = false) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#f4f1f6';
  ctx.fillRect(0, 0, W, H);
  // Light streaks behind (they show through the see-through plate: its ground is not one colour).
  if (streaks) for (let x = 0; x < W; x += 23) {
    ctx.fillStyle = x % 46 ? '#ffe6cf' : '#d9d2e6';
    ctx.fillRect(x, 0, 9 + (x % 5), H);
  }
  // Something drawn behind the window (it shows through the plate).
  ctx.fillStyle = '#c9b7d8';
  ctx.beginPath();
  ctx.ellipse(470, 330, 330, 120, -0.3, 0, Math.PI * 2);
  ctx.fill();
  const [x, y, w, h] = PANEL;
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  const a = streaks ? 0.7 : 1;
  g.addColorStop(0, `rgba(40,40,58,${0.86 * a})`);
  g.addColorStop(0.5, `rgba(30,30,44,${0.92 * a})`);
  g.addColorStop(1, `rgba(48,44,60,${0.8 * a})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // Glowing edges.
  ctx.strokeStyle = '#ffcf8a';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#ff9a3c';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.stroke();
  ctx.shadowBlur = 0;
  // White lettering with a thin dark outline, flush left.
  ctx.font = 'bold 40px TestSans';
  ctx.textAlign = 'left';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#1b1b24';
  ctx.fillStyle = '#ffffff';
  LINES.forEach((l, i) => {
    ctx.strokeText(l, 240, 280 + i * 62);
    ctx.fillText(l, 240, 280 + i * 62);
  });
  return { c, data: new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data) };
}

const lum = (d: Uint8ClampedArray, x: number, y: number) => luminance(d[(y * W + x) * 4], d[(y * W + x) * 4 + 1], d[(y * W + x) * 4 + 2]);

describe('lettering on a dark see-through panel of a game window', () => {
  for (const streaks of [false, true])
  it(`is erased with the panel's own dark ground, and nothing outside the panel changes${streaks ? ' (light streaks show through it)' : ''}`, async () => {
    const p = page(streaks);
    const textBox: [number, number, number, number] = [232, 240, 470, 205];
    const mock = mockOpenAi((_b, call) =>
      call > 1
        ? JSON.stringify({ blocks: [], entities: [], summary: '' })
        : JSON.stringify({ blocks: [{ box: toNorm(textBox, W, H), text: LINES.join('\n'), translation: 'Клинок-обманка:\nБонус к атаке: +110%\nОсталось времени: 0 с', type: 'NARRATION' }], entities: [], summary: '' }),
    );
    const out = await runStandalonePipeline(
      { bytes: new Uint8Array(await p.c.encode('png')), config: { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: false, vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any },
      { backend: napiBackend, fetchImpl: mock.fetchImpl },
    );
    const after = out.cleaned.getRegion(0, 0, W, H).data;
    const shot = createCanvas(W, H);
    const id = (shot.getContext('2d') as any).createImageData(W, H);
    id.data.set(after);
    (shot.getContext('2d') as any).putImageData(id, 0, 0);
    writeFileSync(`${OUT}panel-cleaned${streaks ? '-streaks' : ''}.png`, new Uint8Array(await shot.encode('png')));
    writeFileSync(`${OUT}panel-steps${streaks ? '-streaks' : ''}.txt`, JSON.stringify({ steps: out.page.debug?.steps, b: out.page.blocks.map((x) => ({ id: x.id, bbox: x.bbox, bubble: x.bubble?.box, fill: x.bubble?.fill, shape: x.bubble?.shape, style: x.style })) }, null, 1));
    // Where the letters were: the panel's dark ground (30–110 bright, the streaks showing through), no light patch.
    let light = 0;
    let n = 0;
    for (let y = textBox[1]; y < textBox[1] + textBox[3]; y += 2)
      for (let x = textBox[0]; x < textBox[0] + textBox[2]; x += 2) {
        n++;
        if (lum(after, x, y) > 150) light++;
      }
    expect(light / n).toBeLessThan(0.01);
    // The white letters are gone.
    let white = 0;
    for (let y = textBox[1]; y < textBox[1] + textBox[3]; y += 2) for (let x = textBox[0]; x < textBox[0] + textBox[2]; x += 2) if (lum(after, x, y) > 232) white++;
    expect(white / n).toBeLessThan(0.005);
    // Outside the panel nothing is painted.
    let changed = 0;
    for (let y = 0; y < H; y += 2)
      for (let x = 0; x < W; x += 2) {
        const inside = x >= PANEL[0] - 20 && x < PANEL[0] + PANEL[2] + 20 && y >= PANEL[1] - 20 && y < PANEL[1] + PANEL[3] + 20;
        if (!inside && Math.abs(lum(after, x, y) - lum(p.data, x, y)) > 30) changed++;
      }
    expect(changed).toBeLessThan(50);
    // The translation: light letters on the dark panel, one item per line, flush left.
    const b = out.page.blocks[0];
    expect(b.translatedText.split('\n')).toHaveLength(3);
  });
});
