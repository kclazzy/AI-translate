import { describe, expect, it } from 'vitest';
import { exportTexts, importTexts } from '../src/editor/texts';

const blocks = [
  { id: 'b1', originalText: 'Wait!', translatedText: 'Стой!', textType: 'DIALOGUE' },
  { id: 'b2', originalText: 'Where\nare you going?', translatedText: 'Куда\nты идёшь?', textType: 'DIALOGUE' },
] as never[];

describe('page texts as a file', () => {
  it('round-trips through .txt and JSON, changing only edited translations', () => {
    const txt = exportTexts(blocks, 'Глава 1', 'txt');
    expect(txt).toContain('[2] Where are you going?');
    expect(importTexts(blocks, txt).changed).toBe(0);
    const edited = txt.replace('=> Стой!', '=> Подожди!');
    const r = importTexts(blocks, edited);
    expect(r.changed).toBe(1);
    expect((r.blocks[0] as { translatedText: string }).translatedText).toBe('Подожди!');
    expect((r.blocks[1] as { translatedText: string }).translatedText).toBe('Куда\nты идёшь?');
    const json = JSON.parse(exportTexts(blocks, 't', 'json'));
    json.blocks[1].translation = 'Куда собрался?';
    expect((importTexts(blocks, JSON.stringify(json)).blocks[1] as { translatedText: string }).translatedText).toBe('Куда собрался?');
  });
});
