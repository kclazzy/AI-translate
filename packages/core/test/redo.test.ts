/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import { napiBackend } from './helpers';

/** A bubble with black letters, its inside one colour or a soft vertical gradient. */
async function bubble(gradient: boolean): Promise<TiledImage> {
  const c = createCanvas(600, 400);
  const g = c.getContext('2d') as any;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 600, 400);
  g.beginPath();
  g.ellipse(300, 200, 220, 140, 0, 0, Math.PI * 2);
  if (gradient) {
    const gr = g.createLinearGradient(0, 60, 0, 340);
    gr.addColorStop(0, '#f4f0ff');
    gr.addColorStop(1, '#b9a8e8');
    g.fillStyle = gr;
  } else g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#000';
  g.stroke();
  g.fillStyle = '#000';
  g.font = 'bold 34px sans-serif';
  g.textAlign = 'center';
  g.fillText('WHAT IS THIS', 300, 190);
  g.fillText('PLACE?', 300, 235);
  return TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')));
}

describe('a one-colour fill on ground that varies', () => {
  it('a gradient bubble: the erased letters are handed to LaMa to redo', async () => {
    const img = await bubble(true);
    const r = cleanBlock(img, [190, 160, 220, 90]);
    expect(r.redoMask).toBeTruthy();
  });

  it('a plain white bubble: the fill is exact, nothing to redo', async () => {
    const img = await bubble(false);
    const r = cleanBlock(img, [190, 160, 220, 90]);
    expect(r.redoMask).toBeUndefined();
    expect(r.closed).toBe(true);
  });

  it('JPEG noise on a white bubble is not a ground that varies', async () => {
    const { ringVaries } = await import('../src/image/clean');
    const w = 120, h = 80;
    const data = new Uint8ClampedArray(w * h * 4);
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < w * h; i++) {
      for (let k = 0; k < 3; k++) data[i * 4 + k] = 255 - rnd() * 14;
      data[i * 4 + 3] = 255;
    }
    const mask = new Uint8Array(w * h);
    for (let y = 30; y < 50; y++) for (let x = 30; x < 90; x++) mask[y * w + x] = 1;
    expect(ringVaries({ width: w, height: h, data }, mask)).toBe(false);
    // The same with a gradient from top to bottom: it varies.
    for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) data[i * 4 + k] = 255 - Math.floor(i / w) * 1.2;
    expect(ringVaries({ width: w, height: h, data }, mask)).toBe(true);
  });
});
