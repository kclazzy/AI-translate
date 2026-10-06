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
export class TiledImage {
  readonly tiles: Tile[];

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

  /** Read pixels of a region that may span several tiles. */
  getRegion(x: number, y: number, w: number, h: number): PixelData {
    [x, y, w, h] = clampBox([x, y, w, h], this.width, this.height);
    const tmp = this.backend.createCanvas(w, h);
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    for (const t of this.tiles) {
      if (t.y + t.h <= y || t.y >= y + h) continue;
      ctx.drawImage(t.canvas, -x, t.y - y);
    }
    return ctx.getImageData(0, 0, w, h);
  }

  /** Write pixels back; only the tiles that intersect are touched. */
  putRegion(data: PixelData, x: number, y: number): void {
    const tmp = this.backend.createCanvas(data.width, data.height);
    const tctx = tmp.getContext('2d');
    const imageData = tctx.createImageData(data.width, data.height);
    imageData.data.set(data.data);
    for (const t of this.tiles) {
      const top = Math.max(y, t.y);
      const bottom = Math.min(y + data.height, t.y + t.h);
      if (bottom <= top) continue;
      const ctx = t.canvas.getContext('2d');
      ctx.putImageData(imageData, x, y - t.y, 0, top - y, data.width, bottom - top);
    }
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
