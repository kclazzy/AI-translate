/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { initializeCanvas, readPsd } from 'ag-psd';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE_DEFAULTS, TiledImage, type ImageBackend, type PageResult } from '@ait/core';
import { exportPsd } from '../src/psd';

initializeCanvas(((w: number, h: number) => createCanvas(w, h)) as any);
const backend = {
  createCanvas: (w: number, h: number) => createCanvas(w, h),
  decode: async () => { throw new Error('unused'); },
  encode: async () => new Uint8Array(),
} as unknown as ImageBackend;

describe('PSD export', () => {
  it('has the original, the cleaned picture and one layer per text with the text itself', () => {
    const img = new TiledImage(backend, 300, 200);
    for (const t of img.tiles) {
      const ctx = t.canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 300, 200);
    }
    const page = {
      pageId: 'p', width: 300, height: 200, source: { lang: 'en', detectedBy: 'x' }, targetLang: 'ru', timings: {}, usage: [], pipeline: { version: 1, hash: '', mode: 'standalone' }, createdAt: '',
      blocks: [{ id: 'b1', textType: 'DIALOGUE', originalText: 'Hi', translatedText: 'Привет', confidence: 1, language: 'en', bbox: [50, 50, 200, 80], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true }],
    } as unknown as PageResult;
    const bytes = exportPsd(backend, page, img, img.clone(), DEFAULT_STYLE_DEFAULTS);
    const psd = readPsd(bytes, { skipCompositeImageData: true, skipThumbnail: true, skipLayerImageData: true });
    expect(psd.width).toBe(300);
    expect(psd.children?.map((c) => c.name)).toEqual(['Оригинал', 'Очищено', 'Перевод']);
    const text = psd.children?.[2].children?.[0];
    expect(text?.name).toBe('Привет');
    expect(text?.text?.text).toContain('Привет');
  });
});
