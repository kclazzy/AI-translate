/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { defaultSettings, TiledImage } from '@ait/core';
import { napiBackend } from '../../core/test/helpers';
import { cropProjectPage } from '../src/projects';

describe('cropping a project page', () => {
  it('cuts the pictures and moves the texts with them', async () => {
    const mk = () => {
      const t = new TiledImage(napiBackend, 400, 600);
      t.tiles[0].canvas.getContext('2d').fillRect(0, 0, 400, 600);
      return t;
    };
    let assets: any = { original: { bytes: new Uint8Array([1]), mime: 'image/png' }, cleaned: [] };
    let saved: any = null;
    const page: any = { id: 'p1', name: '1', index: 0, status: 'done' };
    const project: any = { id: 'x', pages: [page] };
    const store: any = {
      assets: async () => assets,
      putAssets: async (_p: string, _q: string, a: any) => void (assets = a),
      get: async () => saved ?? project,
      save: async (p: any) => (saved = p),
    };
    const block = (id: string, y: number): any => ({ id, textType: 'DIALOGUE', originalText: 'a', translatedText: 'Привет', confidence: 1, language: 'en', bbox: [100, y, 100, 40], polygon: [[100, y]], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true });
    const result: any = { pageId: 'p', width: 400, height: 600, blocks: [block('in', 300), block('out', 20)], targetLang: 'ru', source: { lang: 'en', detectedBy: 'x' }, timings: {}, usage: [], pipeline: { version: 1, hash: '', mode: 'standalone' }, createdAt: '' };
    const p = await cropProjectPage(store, napiBackend, defaultSettings(), project, page, result, mk(), mk(), [50, 200, 300, 300]);
    const r = p.pages[0].result;
    expect([r.width, r.height]).toEqual([300, 300]);
    expect(r.blocks.map((b: any) => b.id)).toEqual(['in']);
    expect(r.blocks[0].bbox).toEqual([50, 100, 100, 40]);
    const img = await napiBackend.decode(assets.original.bytes, 'image/png');
    expect([img.width, img.height]).toEqual([300, 300]);
    expect(assets.rendered.length).toBeGreaterThan(0);
  });
});
