import { AppError } from '../errors';
import type { Box } from '../types';
import { MAX_PIXELS, TILE_HEIGHT, type AnyCanvas, type DecodedImage, type ImageBackend, type PixelData } from './backend';

export interface Tile {
  y: number;
  h: number;
  canvas: AnyCanvas;
}

/**
 * An image stored as horizontal strips of at most TILE_HEIGHT pixels.
 * Browsers cap canvas height (~32k) and memory, so long webtoon strips
 * (e.g. 1200×60000) are never held in one canvas.
 */
/** Pictures up to this size keep a copy of their pixels in memory while one is held (≤ 64 MB). */
export const HOLD_MAX_PIXELS = 16_000_000;

export class TiledImage {
  readonly tiles: Tile[];
  /** All pixels (RGBA), kept while the picture is held (see hold()). */
  private pixels: Uint8ClampedArray | null = null;
  private holds = 0;

  constructor(readonly backend: ImageBackend, readonly width: number, readonly height: number, tiles?: Tile[]) {
    if (width <= 0 || height <= 0) throw new AppError('UNSUPPORTED_FORMAT', { detail: 'Empty image' });
    if (width * height > MAX_PIXELS) throw new AppError('IMAGE_TOO_LARGE', { detail: `${width}×${height}` });
    if (tiles) this.tiles = tiles;
    else {
      this.tiles = [];
      for (let y = 0; y < height; y += TILE_HEIGHT) {
        const h = Math.min(TILE_HEIGHT, height - y);
        this.tiles.push({ y, h, canvas: backend.createCanvas(width, h) });
      }
    }
  }

  static fromDecoded(backend: ImageBackend, img: DecodedImage): TiledImage {
    const t = new TiledImage(backend, img.width, img.height);
    for (const tile of t.tiles) {
      const ctx = tile.canvas.getContext('2d');
      ctx.drawImage(img.source, 0, tile.y, img.width, tile.h, 0, 0, img.width, tile.h);
    }
    return t;
  }

  static async fromBytes(backend: ImageBackend, bytes: Uint8Array, mime?: string): Promise<TiledImage> {
    let img: DecodedImage;
    try {
      img = await backend.decode(bytes, mime);
    } catch (e) {
      throw new AppError('UNSUPPORTED_FORMAT', { detail: (e as Error)?.message, retryable: false });
    }
    try {
      return TiledImage.fromDecoded(backend, img);
    } finally {
      img.close?.();
    }
  }

  clone(): TiledImage {
    const tiles = this.tiles.map((t) => {
      const c = this.backend.createCanvas(this.width, t.h);
      c.getContext('2d').drawImage(t.canvas, 0, 0);
      return { y: t.y, h: t.h, canvas: c };
    });
    return new TiledImage(this.backend, this.width, this.height, tiles);
  }

  /**
   * Read pixels of a region that may span several tiles, straight from the tiles (no scratch
   * canvas: a canvas per read costs a full-size allocation outside the JS heap every time).
   */
  getRegion(x: number, y: number, w: number, h: number): PixelData {
    [x, y, w, h] = clampBox([x, y, w, h], this.width, this.height);
    if (this.pixels) {
      const all = this.pixels;
      const data = new Uint8ClampedArray(w * h * 4);
      if (x === 0 && w === this.width) data.set(all.subarray(y * w * 4, (y + h) * w * 4));
      else for (let r = 0; r < h; r++) data.set(all.subarray(((y + r) * this.width + x) * 4, ((y + r) * this.width + x + w) * 4), r * w * 4);
      return { width: w, height: h, data };
    }
    return this.readTiles(x, y, w, h);
  }

  private readTiles(x: number, y: number, w: number, h: number): PixelData {
    const parts = this.tiles.filter((t) => t.y < y + h && t.y + t.h > y);
    if (parts.length === 1) {
      const t = parts[0];
      // A plain object: the pixel loops read `data`/`width` in every step, and an ImageData's
      // properties are native getters.
      return { width: w, height: h, data: t.canvas.getContext('2d').getImageData(x, y - t.y, w, h).data };
    }
    const data = new Uint8ClampedArray(w * h * 4);
    for (const t of parts) {
      const top = Math.max(y, t.y);
      const bottom = Math.min(y + h, t.y + t.h);
      data.set(t.canvas.getContext('2d').getImageData(x, top - t.y, w, bottom - top).data, (top - y) * w * 4);
    }
    return { width: w, height: h, data };
  }

  /** Write pixels back; only the tiles that intersect are touched. */
  putRegion(data: PixelData, x: number, y: number): void {
    let imageData: { data: Uint8ClampedArray } | null = null;
    for (const t of this.tiles) {
      const top = Math.max(y, t.y);
      const bottom = Math.min(y + data.height, t.y + t.h);
      if (bottom <= top) continue;
      const ctx = t.canvas.getContext('2d');
      if (!imageData) {
        imageData = ctx.createImageData(data.width, data.height) as { data: Uint8ClampedArray };
        imageData.data.set(data.data);
      }
      ctx.putImageData(imageData, x, y - t.y, 0, top - y, data.width, bottom - top);
    }
    if (this.pixels) {
      // What the canvas really keeps (its colours may be rounded when they are not opaque).
      const [cx, cy, cw, ch] = clampBox([x, y, data.width, data.height], this.width, this.height);
      const back = this.readTiles(cx, cy, cw, ch).data;
      for (let r = 0; r < ch; r++) this.pixels.set(back.subarray(r * cw * 4, (r + 1) * cw * 4), ((cy + r) * this.width + cx) * 4);
    }
  }

  /**
   * Keep a copy of all pixels in memory while many regions are read (the cleaning stage reads
   * hundreds of them; each read from a canvas copies its pixels out again, from video memory in
   * a browser). Writes go through putRegion() while held. Returns the release function; a
   * picture too big to copy is simply read from its canvases as usual.
   */
  hold(): () => void {
    if (this.width * this.height > HOLD_MAX_PIXELS) return () => undefined;
    if (!this.pixels) this.pixels = this.readTiles(0, 0, this.width, this.height).data;
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.holds === 0) this.pixels = null;
    };
  }

  /** Draw a source region of this image scaled into a destination context. */
  drawRegion(ctx: { drawImage: (...a: unknown[]) => void }, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number): void {
    const scaleX = dw / sw;
    const scaleY = dh / sh;
    for (const t of this.tiles) {
      const top = Math.max(sy, t.y);
      const bottom = Math.min(sy + sh, t.y + t.h);
      if (bottom <= top) continue;
      ctx.drawImage(t.canvas, sx, top - t.y, sw, bottom - top, 0, (top - sy) * scaleY, sw * scaleX, (bottom - top) * scaleY);
    }
  }

  /** Copy into one canvas (only for images that fit). */
  toSingleCanvas(): AnyCanvas {
    const c = this.backend.createCanvas(this.width, this.height);
    const ctx = c.getContext('2d');
    for (const t of this.tiles) ctx.drawImage(t.canvas, 0, t.y);
    return c;
  }
}

export function clampBox(b: Box, maxW: number, maxH: number): Box {
  const x = Math.max(0, Math.min(maxW - 1, Math.floor(b[0])));
  const y = Math.max(0, Math.min(maxH - 1, Math.floor(b[1])));
  const x2 = Math.max(x + 1, Math.min(maxW, Math.ceil(b[0] + b[2])));
  const y2 = Math.max(y + 1, Math.min(maxH, Math.ceil(b[1] + b[3])));
  return [x, y, x2 - x, y2 - y];
}

export function expandBox(b: Box, dx: number, dy = dx): Box {
  return [b[0] - dx, b[1] - dy, b[2] + 2 * dx, b[3] + 2 * dy];
}

export function boxArea(b: Box): number {
  return Math.max(0, b[2]) * Math.max(0, b[3]);
}

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of the smaller box covered by the intersection. */
export function overlapRatio(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const small = Math.min(boxArea(a), boxArea(b));
  return small > 0 ? inter / small : 0;
}

export function boxToPolygon(b: Box): [number, number][] {
  return [
    [b[0], b[1]],
    [b[0] + b[2], b[1]],
    [b[0] + b[2], b[1] + b[3]],
    [b[0], b[1] + b[3]],
  ];
}
