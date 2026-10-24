/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Abstraction over canvas implementations so the same pipeline runs in
 * an extension offscreen document, a mobile WebView and Node tests (@napi-rs/canvas).
 */
export interface AnyCanvas {
  width: number;
  height: number;
  getContext(type: '2d', opts?: any): any;
}

export interface PixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  /** Anything ctx.drawImage accepts in this backend. */
  source: any;
  close?: () => void;
}

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageBackend {
  createCanvas(width: number, height: number): AnyCanvas;
  decode(bytes: Uint8Array, mime?: string): Promise<DecodedImage>;
  encode(canvas: AnyCanvas, mime: ImageMime, quality?: number): Promise<Uint8Array>;
}

/** Backend for browsers, workers, extension pages and WebViews. */
export const browserBackend: ImageBackend = {
  createCanvas(width, height) {
    const c: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    c.width = width;
    c.height = height;
    // The pipeline reads its canvases' pixels again and again (cleaning, checks, the detector):
    // kept in ordinary memory, not on the video card, each read is not a copy back from the card.
    // The first getContext fixes this; later calls get the same context.
    c.getContext('2d', { willReadFrequently: true });
    return c as unknown as AnyCanvas;
  },
  async decode(bytes, mime) {
    const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
    const bmp = await createImageBitmap(blob);
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
  },
  async encode(canvas, mime, quality) {
    const anyCanvas = canvas as any;
    // The document that translates in the background (the extension's offscreen one, see
    // encodeAtOnce): there convertToBlob waits for an idle moment of the page, up to a second for
    // every picture, and a page being translated has none. Encoded right away instead.
    if (atOnce && typeof document !== 'undefined') {
      const bytes = encodeNow(canvas, mime, quality);
      if (bytes) return bytes;
    }
    if (typeof anyCanvas.convertToBlob === 'function') {
      const blob: Blob = await anyCanvas.convertToBlob({ type: mime, quality });
      return new Uint8Array(await blob.arrayBuffer());
    }
    const blob: Blob = await new Promise((resolve, reject) => anyCanvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality));
    return new Uint8Array(await blob.arrayBuffer());
  },
};

let atOnce = false;
/** Encode pictures at once in this document (one nobody looks at, that does the translating). */
export function encodeAtOnce(on: boolean): void {
  atOnce = on;
}

/** Encode on the spot (a page canvas's toDataURL); null when the browser cannot write that type. */
function encodeNow(canvas: AnyCanvas, mime: ImageMime, quality?: number): Uint8Array | null {
  const c = document.createElement('canvas');
  try {
    c.width = canvas.width;
    c.height = canvas.height;
    c.getContext('2d')!.drawImage(canvas as unknown as CanvasImageSource, 0, 0);
    const url = c.toDataURL(mime, quality);
    if (!url.startsWith(`data:${mime};base64,`)) return null;
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

/**
 * Let a canvas go at once: a browser keeps a canvas's memory (often on the video card) until it is
 * collected, and a long chapter makes hundreds of them. Shrinking it frees that now.
 */
export function releaseCanvas(c: AnyCanvas | null | undefined): void {
  if (!c) return;
  try {
    c.width = 0;
    c.height = 0;
  } catch {
    /* a canvas that cannot be resized is left to the collector */
  }
}

export const MAX_CANVAS_SIDE = 16384;
export const MAX_PIXELS = 150_000_000;
export const TILE_HEIGHT = 4096;

const losslessProbe = new WeakMap<ImageBackend, Promise<boolean>>();

/**
 * Does this backend write WebP without loss at quality 1? Chrome (and WebViews built on it) switch
 * to lossless WebP at exactly 1.0; other browsers may encode lossy or fall back to PNG. Checked once
 * per backend by a round trip of a small picture with sharp edges and noise: only an exact copy of
 * every pixel counts. Stored tiles use WebP only then, so the quality never drops.
 */
export function losslessWebp(backend: ImageBackend): Promise<boolean> {
  let p = losslessProbe.get(backend);
  if (!p) {
    p = (async () => {
      try {
        const w = 48;
        const h = 40;
        const c = backend.createCanvas(w, h);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        const id = ctx.createImageData(w, h);
        let seed = 12345;
        for (let i = 0; i < w * h; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const edge = (i % w) % 7 < 2 ? 0 : 255;
          id.data[i * 4] = edge ^ (seed & 15);
          id.data[i * 4 + 1] = (seed >> 8) & 255;
          id.data[i * 4 + 2] = (seed >> 16) & 255;
          id.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(id, 0, 0);
        const want = ctx.getImageData(0, 0, w, h).data as Uint8ClampedArray;
        const bytes = await backend.encode(c, 'image/webp', 1);
        // RIFF....WEBP: a browser without a WebP encoder hands back PNG.
        if (!(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45)) return false;
        const d = await backend.decode(bytes, 'image/webp');
        const c2 = backend.createCanvas(w, h);
        const ctx2 = c2.getContext('2d', { willReadFrequently: true });
        ctx2.drawImage(d.source, 0, 0);
        d.close?.();
        const got = ctx2.getImageData(0, 0, w, h).data as Uint8ClampedArray;
        for (let i = 0; i < want.length; i++) if (want[i] !== got[i]) return false;
        return true;
      } catch {
        return false;
      }
    })();
    losslessProbe.set(backend, p);
  }
  return p;
}
