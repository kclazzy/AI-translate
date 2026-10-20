import { describe, expect, it } from 'vitest';
import { redrawArt } from '../src/pipeline/standalone';
import { TiledImage } from '../src/image/tiled';
import { napiBackend } from './helpers';

describe('LaMa that does not answer', () => {
  it('is reported, the picture keeps the simple fill', async () => {
    const img = new TiledImage(napiBackend, 200, 200);
    // Artwork around the letters (stripes): LaMa is needed there.
    const px = img.getRegion(0, 0, 200, 200);
    for (let i = 0; i < 200 * 200; i++) for (let k = 0; k < 3; k++) px.data[i * 4 + k] = ((i % 200) * 7 + k * 40) % 256;
    for (let i = 0; i < 200 * 200; i++) px.data[i * 4 + 3] = 255;
    img.putRegion(px, 0, 0);
    const cleaned = img.clone();
    const mask = { box: [50, 50, 40, 40] as [number, number, number, number], mask: new Uint8Array(1600).fill(1) };
    const errors: string[] = [];
    const done = await redrawArt(img, cleaned, [mask], async () => { throw new TypeError('Failed to fetch'); }, undefined, (e) => errors.push(String((e as Error).message)));
    expect(done).toBe(0);
    expect(errors).toEqual(['Failed to fetch']);
    const ok = await redrawArt(img, cleaned, [mask], async (px) => ({ width: px.width, height: px.height, data: new Uint8ClampedArray(px.data.length).fill(200) }) as any);
    expect(ok).toBe(1);
  });
});

describe('a plain background around the letters', () => {
  // A ground of `color` with JPEG-like noise (±7) and an optional gradient from top to bottom.
  async function ground(color: [number, number, number], noise: number, gradient = 0) {
    const img = new TiledImage(napiBackend, 200, 200);
    const px = img.getRegion(0, 0, 200, 200);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 200 * 200; i++) {
      const y = Math.floor(i / 200);
      for (let k = 0; k < 3; k++) px.data[i * 4 + k] = Math.max(0, Math.min(255, color[k] + (rnd() - 0.5) * 2 * noise - (gradient * y) / 200));
      px.data[i * 4 + 3] = 255;
    }
    // The letters (to be erased).
    for (let y = 60; y < 80; y++) for (let x = 60; x < 80; x++) px.data.set([0, 0, 0, 255], (y * 200 + x) * 4);
    img.putRegion(px, 0, 0);
    return img;
  }
  const run = async (img: TiledImage) => {
    const cleaned = img.clone();
    let asked = 0;
    const mask = { box: [58, 58, 24, 24] as [number, number, number, number], mask: new Uint8Array(24 * 24).fill(1) };
    await redrawArt(img, cleaned, [mask], async (p) => {
      asked++;
      return p;
    });
    return { asked, cleaned };
  };

  it('a white bubble with JPEG noise is filled with its colour, LaMa is not asked', async () => {
    const r = await run(await ground([250, 250, 250], 7));
    expect(r.asked).toBe(0);
    const c = [...r.cleaned.getRegion(70, 70, 1, 1).data.slice(0, 3)];
    expect(c.every((v) => v > 240)).toBe(true);
  });

  it('a black panel too', async () => {
    expect((await run(await ground([8, 8, 8], 6))).asked).toBe(0);
  });

  it('a grey plate, a coloured ground or a gradient goes to LaMa', async () => {
    expect((await run(await ground([60, 62, 70], 2))).asked).toBe(1);
    expect((await run(await ground([250, 230, 140], 2))).asked).toBe(1);
    expect((await run(await ground([255, 255, 255], 2, 80))).asked).toBe(1);
  });
});
