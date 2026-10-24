import { releaseCanvas, type ImageBackend, type PixelData } from './backend';
import { TiledImage } from './tiled';

/**
 * Small scans are made twice as big before the text is looked for (the upscaler runs in this
 * browser: waifu2x CUNet for art, see .github/workflows/models.yml). Letters a few pixels high read
 * far better, and the picture with the translation comes out sharper. The network is run by the
 * caller, as for LaMa; here are the rules and the cutting into tiles.
 */

/** Only pictures whose long side is below this are made bigger (a webtoon strip or a big page is not). */
export const UPSCALE_BELOW = 1000;
/** …and not tiny ones (an icon, a button). */
export const UPSCALE_MIN = 120;

export function wantsUpscale(width: number, height: number): boolean {
  return Math.max(width, height) < UPSCALE_BELOW && Math.min(width, height) >= UPSCALE_MIN;
}

/**
 * The network: a tile of RGB values 0–1 (planar, 3×h×w, h and w even) → twice the size less a
 * border of `offset` output pixels on every side ((2h − 2·offset) × (2w − 2·offset)).
 */
export type UpscaleRun = (rgb: Float32Array, h: number, w: number) => Promise<Float32Array>;

export interface UpscaleNet {
  run: UpscaleRun;
  /** Output pixels lost on every side (36 for waifu2x CUNet 2×: 18 input pixels). */
  offset: number;
  /** Input pixels of a tile without its border (even). */
  tile?: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Make the picture twice as big, tile by tile (each tile with its border, edges repeated outward). */
export async function upscale2x(px: PixelData, net: UpscaleNet, signal?: AbortSignal): Promise<PixelData> {
  const { width: W, height: H, data } = px;
  const pad = net.offset / 2;
  const T = net.tile ?? 256;
  const OW = W * 2;
  const OH = H * 2;
  const out = new Uint8ClampedArray(OW * OH * 4);
  // Every tile the same size (a video card compiles the network once per size): the last one in a
  // row or column steps back over its neighbour instead of being smaller.
  const starts = (n: number) => {
    if (n <= T) return [0];
    const out: number[] = [];
    for (let v = 0; v + T < n; v += T) out.push(v);
    out.push(n - T);
    return out;
  };
  const even = (v: number) => v + (v % 2);
  for (const ty of starts(H)) {
    for (const tx of starts(W)) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      // The tile, made even (the network halves and doubles it), with its border.
      const th = even(Math.min(T, H));
      const tw = even(Math.min(T, W));
      const ih = th + 2 * pad;
      const iw = tw + 2 * pad;
      const rgb = new Float32Array(3 * ih * iw);
      const plane = ih * iw;
      for (let y = 0; y < ih; y++) {
        const sy = clamp(ty + y - pad, 0, H - 1);
        for (let x = 0; x < iw; x++) {
          const sx = clamp(tx + x - pad, 0, W - 1);
          const s = (sy * W + sx) * 4;
          const d = y * iw + x;
          rgb[d] = data[s] / 255;
          rgb[plane + d] = data[s + 1] / 255;
          rgb[2 * plane + d] = data[s + 2] / 255;
        }
      }
      const res = await net.run(rgb, ih, iw);
      const rh = th * 2;
      const rw = tw * 2;
      const rp = rh * rw;
      if (res.length !== 3 * rp) throw new Error(`upscaler gave ${res.length} values for ${rh}×${rw}`);
      for (let y = 0; y < rh && ty * 2 + y < OH; y++) {
        for (let x = 0; x < rw && tx * 2 + x < OW; x++) {
          const s = y * rw + x;
          const d = ((ty * 2 + y) * OW + tx * 2 + x) * 4;
          out[d] = res[s] * 255;
          out[d + 1] = res[rp + s] * 255;
          out[d + 2] = res[2 * rp + s] * 255;
          // The picture's own transparency, doubled.
          out[d + 3] = data[(Math.min(H - 1, (ty * 2 + y) >> 1) * W + Math.min(W - 1, (tx * 2 + x) >> 1)) * 4 + 3];
        }
      }
    }
  }
  return { width: OW, height: OH, data: out };
}

/** Bytes of a small scan → the same picture twice as big (PNG), or null when it is not small. */
export async function upscaleBytes(backend: ImageBackend, bytes: Uint8Array, mime: string, net: UpscaleNet, signal?: AbortSignal): Promise<Uint8Array | null> {
  const img = await TiledImage.fromBytes(backend, bytes, mime);
  try {
    if (!wantsUpscale(img.width, img.height)) return null;
    const big = await upscale2x(img.getRegion(0, 0, img.width, img.height), net, signal);
    const canvas = backend.createCanvas(big.width, big.height);
    try {
      const ctx = canvas.getContext('2d');
      const id = ctx.createImageData(big.width, big.height);
      id.data.set(big.data);
      ctx.putImageData(id, 0, 0);
      return await backend.encode(canvas, 'image/png');
    } finally {
      releaseCanvas(canvas);
    }
  } finally {
    img.dispose();
  }
}
