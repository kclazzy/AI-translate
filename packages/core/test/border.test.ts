/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import type { Box } from '../src/types';
import { napiBackend } from './helpers';

const OUT = new URL('../../../.test-output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/**
 * A bubble that breaks out of its panel: its top half sits in the white gutter (no outline
 * there — the bubble and the gutter are one white area), its bottom half is over the panel
 * art with an outline. The model's box misses the first line («THE DAY'S»).
 */
const W = 800;
const H = 520;
const BUBBLE = { cx: 420, cy: 150, rx: 175, ry: 100 };
const BORDER_Y = 110;

function scene(ctx: any, withText: boolean, lines: string[]) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // Panel art: colourful noisy blobs inside the panel frame.
  ctx.save();
  ctx.beginPath();
  ctx.rect(40, BORDER_Y, W - 80, H - BORDER_Y - 30);
  ctx.clip();
  ctx.fillStyle = '#6d7f96';
  ctx.fillRect(0, 0, W, H);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgb(${60 + rnd() * 150},${50 + rnd() * 120},${70 + rnd() * 140})`;
    ctx.beginPath();
    ctx.arc(rnd() * W, BORDER_Y + rnd() * (H - BORDER_Y), 3 + rnd() * 16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.strokeRect(40, BORDER_Y, W - 80, H - BORDER_Y - 30);
  // The bubble: white, outlined only where it is over the panel.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(BUBBLE.cx, BUBBLE.cy, BUBBLE.rx, BUBBLE.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, BORDER_Y + 2, W, H);
  ctx.clip();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(BUBBLE.cx, BUBBLE.cy, BUBBLE.rx, BUBBLE.ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
  if (!withText) return;
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 34px TestSans';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, BUBBLE.cx, 78 + i * 38));
}

function inside(x: number, y: number, grow = 0) {
  return ((x - BUBBLE.cx) / (BUBBLE.rx + grow)) ** 2 + ((y - BUBBLE.cy) / (BUBBLE.ry + grow)) ** 2 <= 1;
}

describe('a bubble that breaks out of the panel into the gutter', () => {
  it('erases every line, keeps the art and the outline', async () => {
    const lines = ["THE DAY'S", 'WORK IS', 'DONE, RIGHT?'];
    const make = async (t: boolean) => {
      const c = createCanvas(W, H);
      scene(c.getContext('2d'), t, lines);
      return { c, data: (c.getContext('2d') as any).getImageData(0, 0, W, H).data as Uint8ClampedArray, bytes: new Uint8Array(await c.encode('png')) };
    };
    const withText = await make(true);
    const clean = await make(false);
    const image = await TiledImage.fromBytes(napiBackend, withText.bytes, 'image/png');
    const modelBox: Box = [330, 118, 180, 72]; // lines 2–3 only
    cleanBlock(image, modelBox);
    const out = image.getRegion(0, 0, W, H).data;
    const shot = createCanvas(W, H);
    const id = (shot.getContext('2d') as any).createImageData(W, H);
    id.data.set(out);
    (shot.getContext('2d') as any).putImageData(id, 0, 0);
    writeFileSync(`${OUT}border-cleaned.png`, new Uint8Array(await shot.encode('png')));

    const a = withText.data;
    const b = clean.data;
    let letters = 0, left = 0, art = 0, artChanged = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const dAB = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        const dOut = Math.abs(out[i] - b[i]) + Math.abs(out[i + 1] - b[i + 1]) + Math.abs(out[i + 2] - b[i + 2]);
        if (dAB > 150) {
          letters++;
          const dText = Math.abs(out[i] - a[i]) + Math.abs(out[i + 1] - a[i + 1]) + Math.abs(out[i + 2] - a[i + 2]);
          if (dText < dOut) left++;
        } else if (!inside(x, y, 4)) {
          art++;
          if (dOut > 40) artChanged++;
        }
      }
    }
    console.log(`letters left ${left}/${letters}, art changed ${artChanged}/${art}`);
    expect(left / letters, 'original lettering still visible').toBeLessThan(0.01);
    expect(artChanged, 'painted over the art outside the bubble').toBeLessThan(40);
  });
});
