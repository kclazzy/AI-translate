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

describe('a chapter for Photoshop', () => {
  const napi = {
    createCanvas: (w: number, h: number) => createCanvas(w, h),
    decode: async (bytes: Uint8Array) => {
      const { loadImage } = await import('@napi-rs/canvas');
      const im = await loadImage(Buffer.from(bytes));
      return { source: im, width: im.width, height: im.height };
    },
    encode: async (c: any) => new Uint8Array(await c.encode('png')),
  } as unknown as ImageBackend;
  const png = async (w: number, h: number, color: string) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return new Uint8Array(await c.encode('png'));
  };
  const pageOf = (text: string) =>
    ({
      pageId: 'p', width: 300, height: 200, source: { lang: 'en', detectedBy: 'x' }, targetLang: 'ru', timings: {}, usage: [], pipeline: { version: 1, hash: '', mode: 'standalone' }, createdAt: '',
      blocks: [{ id: 'b1', textType: 'DIALOGUE', originalText: 'Hi', translatedText: text, confidence: 1, language: 'en', bbox: [50, 50, 200, 80], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true }],
    }) as unknown as PageResult;

  it('is a ZIP with one layered PSD per picture, in order; a picture gone from the cache is left out', async () => {
    const { exportPsdChapter } = await import('../src/psd');
    const JSZip = (await import('jszip')).default;
    const stored = async (text: string) => ({ page: pageOf(text), original: { bytes: await png(300, 200, '#ffffff'), mime: 'image/png' }, cleaned: [{ y: 0, h: 200, bytes: await png(300, 200, '#fefefe') }] });
    const results = [await stored('Первая'), undefined, await stored('Третья')];
    const { bytes, pages } = await exportPsdChapter(napi, results.map((r, i) => ({ name: String(i + 1).padStart(3, '0'), load: async () => r })), DEFAULT_STYLE_DEFAULTS);
    expect(pages).toBe(2);
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(['001.psd', '003.psd']);
    const psd = readPsd(await zip.file('003.psd')!.async('uint8array'), { skipCompositeImageData: true, skipThumbnail: true, skipLayerImageData: true });
    expect(psd.children?.map((c) => c.name)).toEqual(['Оригинал', 'Очищено', 'Перевод']);
    expect(psd.children?.[2].children?.[0].text?.text).toContain('Третья');
  });
});
