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
  it('is filled with its colour, LaMa is not asked', async () => {
    const img = new TiledImage(napiBackend, 200, 200);
    const px = img.getRegion(0, 0, 200, 200);
    for (let i = 0; i < 200 * 200; i++) px.data.set([60, 62, 70, 255], i * 4);
    // The letters (to be erased) in white.
    for (let y = 60; y < 80; y++) for (let x = 60; x < 80; x++) px.data.set([255, 255, 255, 255], (y * 200 + x) * 4);
    img.putRegion(px, 0, 0);
    const cleaned = img.clone();
    let asked = 0;
    const mask = { box: [58, 58, 24, 24] as [number, number, number, number], mask: new Uint8Array(24 * 24).fill(1) };
    const done = await redrawArt(img, cleaned, [mask], async (p) => {
      asked++;
      return p;
    });
    expect(done).toBe(1);
    expect(asked).toBe(0);
    expect([...cleaned.getRegion(70, 70, 1, 1).data.slice(0, 3)]).toEqual([60, 62, 70]);
  });
});
