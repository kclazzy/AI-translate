import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildAnalysisPack } from '../src/problemReport';

const page = (n: number): any => ({
  pageId: `p${n}`, width: 10, height: 10, targetLang: 'ru', source: { lang: 'en', detectedBy: 'x' }, timings: {}, pipeline: { version: 1, hash: '', mode: 'standalone' }, createdAt: '',
  usage: [{ provider: 'Ollama', model: 'qwen3.5:9b-q8_0', inputTokens: 1, outputTokens: 1, costUsd: 0 }],
  blocks: [{ id: 'b1', textType: 'DIALOGUE', originalText: `RAGE IS A\nNORMAL RESPONSE ${n}`, translatedText: 'Гнев\tнормален', translate: true, lowConfidence: n === 2, bbox: [0, 0, 1, 1], polygon: [], qa: { issues: [{ kind: 'grammar', note: 'род' }] } }],
});

describe('«Для анализа»: the chapter pack', () => {
  it('has each picture\'s original, current look and data, and all texts in one table', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { name, bytes } = await buildAnalysisPack({
      pages: [1, 2].map((n) => ({ page: page(n), original: { bytes: png, mime: 'image/png' }, rendered: [{ y: 0, h: 10, bytes: png }] })),
      settings: undefined, version: '1.1.4', platform: 'test', journal: [{ key: 'k' }], errors: [],
    });
    expect(name).toMatch(/^ait-analysis-\d{8}-\d{4}-2p\.zip$/);
    const z = await JSZip.loadAsync(bytes);
    expect(Object.keys(z.files)).toEqual(expect.arrayContaining(['README.txt', '001/original.png', '001/page.json', '002/original.png', 'texts.tsv', 'journal.json', 'errors.json', 'info.txt']));
    const tsv = await z.file('texts.tsv')!.async('string');
    const rows = tsv.replace(/^﻿/, '').trim().split('\n');
    expect(rows).toHaveLength(3);
    // Line breaks and tabs inside a text never break the table.
    expect(rows[1].split('\t')).toEqual(['001', 'b1', 'DIALOGUE', 'yes', '', 'RAGE IS A NORMAL RESPONSE 1', 'Гнев нормален', 'grammar: род']);
    expect(rows[2].split('\t')[4]).toBe('yes');
    expect(await z.file('info.txt')!.async('string')).toContain('Ollama — qwen3.5:9b-q8_0');
  });
});
