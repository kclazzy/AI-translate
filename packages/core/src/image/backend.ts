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
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height) as unknown as AnyCanvas;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c as unknown as AnyCanvas;
  },
  async decode(bytes, mime) {
    const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
    const bmp = await createImageBitmap(blob);
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
  },
  async encode(canvas, mime, quality) {
    const anyCanvas = canvas as any;
    if (typeof anyCanvas.convertToBlob === 'function') {
      const blob: Blob = await anyCanvas.convertToBlob({ type: mime, quality });
      return new Uint8Array(await blob.arrayBuffer());
    }
    const blob: Blob = await new Promise((resolve, reject) => anyCanvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error('toBlob failed'))), mime, quality));
    return new Uint8Array(await blob.arrayBuffer());
  },
};

export const MAX_CANVAS_SIDE = 16384;
export const MAX_PIXELS = 150_000_000;
export const TILE_HEIGHT = 4096;
