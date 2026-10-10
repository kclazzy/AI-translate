import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { defaultSettings, type PageResult } from '@ait/core';
import { napiBackend } from '../../core/test/helpers';
import { buildProblemReport, problemReportName } from '../src/problemReport';

async function png(w: number, h: number, color: string): Promise<Uint8Array> {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return new Uint8Array(await c.encode('png'));
}

const page: PageResult = {
  pageId: 'abcdef0123456789',
  width: 100,
  height: 200,
  source: { lang: 'ja', detectedBy: 'vision:m' },
  targetLang: 'ru',
  blocks: [],
  timings: { decodeMs: 1, detectMs: 1, ocrMs: 0, translateMs: 1, cleanMs: 1, totalMs: 4 } as PageResult['timings'],
  usage: [{ provider: 'OpenAI', model: 'gpt-x', inputTokens: 1, outputTokens: 1, costUsd: 0 }],
  pipeline: { version: 1, hash: 'h', mode: 'standalone' },
  debug: { answers: [{ stage: 'read', model: 'gpt-x', text: '{"blocks":[]}' }], modelBlocks: [{ box: [1, 2, 3, 4], text: 'あ', translation: 'а' }], steps: ['model found no text'] },
  createdAt: '2026-10-10T00:00:00.000Z',
};

describe('page problem report', () => {
  it('has the pictures, the page with the model answers and settings without secrets', async () => {
    const s = defaultSettings();
    s.providers = [...s.providers, { ...s.providers[0], id: 'c', apiKey: 'sk-secret-123', baseUrl: 'https://user:pass@api.example.com/v1?key=q-secret' }];
    s.engine = { ...s.engine, token: 'tok-secret-456' };
    const original = await png(100, 200, '#f00');
    const tiles = [
      { y: 0, h: 100, bytes: await png(100, 100, '#0f0') },
      { y: 100, h: 100, bytes: await png(100, 100, '#00f') },
    ];
    const date = new Date(2026, 9, 10, 18, 44);
    const { name, bytes } = await buildProblemReport({ page, original: { bytes: original, mime: 'image/png' }, rendered: tiles, cleaned: [tiles[0]], settings: s, version: '0.9.1', platform: 'extension', backend: napiBackend, sourceUrl: 'https://site.example/ch/1', comment: 'Текст поверх рисунка', date, userAgent: 'UA/1' });
    expect(name).toBe('ait-problem-20261010-1844-abcdef01.zip');
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(['README.txt', 'cleaned.png', 'info.txt', 'original.png', 'page.json', 'result.png', 'settings.json']);
    const pj = JSON.parse(await zip.file('page.json')!.async('string'));
    expect(pj.debug.answers[0].text).toBe('{"blocks":[]}');
    const settings = await zip.file('settings.json')!.async('string');
    expect(settings).not.toContain('apiKey');
    let all = '';
    for (const f of Object.values(zip.files)) if (/\.(txt|json)$/.test(f.name)) all += await f.async('string');
    for (const secret of ['sk-secret-123', 'tok-secret-456', 'user:pass', 'q-secret']) expect(all).not.toContain(secret);
    const info = await zip.file('info.txt')!.async('string');
    expect(info).toContain('Текст поверх рисунка');
    expect(info).toContain('gpt-x');
    expect(info).toContain('UA/1');
    expect(info).not.toContain('site.example');
    expect(await zip.file('README.txt')!.async('string')).toContain('Пришлите этот файл разработчику');
    // The stitched result is the whole page.
    const res = await napiBackend.decode(await zip.file('result.png')!.async('uint8array'), 'image/png');
    expect([res.width, res.height]).toEqual([100, 200]);
  });

  it('includes the page address only when asked', async () => {
    const { bytes } = await buildProblemReport({ page, version: '1', platform: 'web', sourceUrl: 'https://site.example/ch/1?token=zzz', includeUrl: true });
    const info = await (await JSZip.loadAsync(bytes)).file('info.txt')!.async('string');
    expect(info).toContain('https://site.example/ch/1');
    expect(info).not.toContain('zzz');
    expect(problemReportName({ pageId: '' })).toMatch(/^ait-problem-\d{8}-\d{4}-[0-9a-z]+\.zip$/);
  });
});
