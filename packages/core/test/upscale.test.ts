import { describe, expect, it } from 'vitest';
import { upscale2x, wantsUpscale, type PixelData, type UpscaleNet } from '../src';

/** A stand-in for waifu2x: nearest-neighbour 2× that loses `offset` output pixels on every side, like the network. */
function nearestNet(offset: number, calls: [number, number][]): UpscaleNet {
  return {
    offset,
    tile: 64,
    run: async (rgb, h, w) => {
      calls.push([h, w]);
      expect(h % 2).toBe(0);
      expect(w % 2).toBe(0);
      const oh = 2 * h - 2 * offset;
      const ow = 2 * w - 2 * offset;
      const out = new Float32Array(3 * oh * ow);
      for (let c = 0; c < 3; c++) for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) out[c * oh * ow + y * ow + x] = rgb[c * h * w + ((y + offset) >> 1) * w + ((x + offset) >> 1)];
      return out;
    },
  };
}

function picture(w: number, h: number): PixelData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([(x * 7) % 256, (y * 5) % 256, (x + y) % 256, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

describe('small scans twice as big', () => {
  it('only small pictures, not tiny ones and not strips', () => {
    expect(wantsUpscale(700, 950)).toBe(true);
    expect(wantsUpscale(800, 1200)).toBe(false);
    expect(wantsUpscale(690, 15000)).toBe(false);
    expect(wantsUpscale(64, 64)).toBe(false);
  });

  it('tiles with their border join without seams, odd sizes too', async () => {
    const calls: [number, number][] = [];
    const src = picture(151, 97);
    const big = await upscale2x(src, nearestNet(36, calls));
    expect(big.width).toBe(302);
    expect(big.height).toBe(194);
    // Several tiles, all of one size (the last ones step back), each with 18 pixels of border.
    expect(calls.length).toBe(6);
    expect(new Set(calls.map((c) => c.join('x')))).toEqual(new Set([`${64 + 36}x${64 + 36}`]));
    let wrong = 0;
    for (let y = 0; y < big.height; y++) {
      for (let x = 0; x < big.width; x++) {
        const s = ((y >> 1) * src.width + (x >> 1)) * 4;
        const d = (y * big.width + x) * 4;
        for (let c = 0; c < 4; c++) if (Math.abs(big.data[d + c] - src.data[s + c]) > 1) wrong++;
      }
    }
    expect(wrong).toBe(0);
  });
});
