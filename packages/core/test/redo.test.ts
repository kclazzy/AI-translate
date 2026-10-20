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
});
