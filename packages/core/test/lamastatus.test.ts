import { describe, expect, it } from 'vitest';
import { redrawArt } from '../src/pipeline/standalone';
import { TiledImage } from '../src/image/tiled';
import { napiBackend } from './helpers';

describe('LaMa that does not answer', () => {
  it('is reported, the picture keeps the simple fill', async () => {
    const img = new TiledImage(napiBackend, 200, 200);
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
