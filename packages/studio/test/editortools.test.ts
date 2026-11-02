import { describe, expect, it } from 'vitest';
import type { TextBlock } from '@ait/core';
import { presetStyle, removePreset, savePreset } from '../src/editor/presets';
import { duplicateBlocks } from '../src/editor/blocks';

const block = (id: string, x: number): TextBlock =>
  ({ id, textType: 'DIALOGUE', originalText: 'Hi', translatedText: 'Привет', confidence: 1, language: 'en', bbox: [x, 100, 120, 60], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: { box: [x - 10, 90, 140, 80], fill: '#fff', safeArea: [x, 100, 120, 60], shape: 'ellipse' }, translate: true, style: { color: '#ff0000', fontSize: 30, rotation: 5 } }) as unknown as TextBlock;

describe('style presets', () => {
  it('keep the look (font, colours, outline, effects), not the size or turn of one block', () => {
    expect(presetStyle({ fontFamily: 'Comic', color: '#ff0000', strokeColor: '#000', strokeWidth: 3, glow: '#fff', fontSize: 30, rotation: 5, bold: true })).toEqual({ fontFamily: 'Comic', color: '#ff0000', strokeColor: '#000', strokeWidth: 3, glow: '#fff', bold: true });
  });
  it('are saved by name (the same name replaces), newest first, and removed by name', () => {
    let list = savePreset([], 'Крик', { color: '#f00' });
    list = savePreset(list, 'Мысли', { italic: true });
    list = savePreset(list, 'Крик', { color: '#0f0' });
    expect(list.map((p) => [p.name, p.style])).toEqual([['Крик', { color: '#0f0' }], ['Мысли', { italic: true }]]);
    expect(removePreset(list, 'Крик').map((p) => p.name)).toEqual(['Мысли']);
    expect(savePreset(list, '  ', { color: '#000' })).toBe(list);
  });
});

describe('duplicating blocks', () => {
  it('copies the chosen blocks a little lower and to the right, with new ids, after the originals', () => {
    let n = 0;
    const blocks = [block('b1', 100), block('b2', 400), block('b3', 700)];
    const { blocks: out, added } = duplicateBlocks(blocks, new Set(['b1', 'b3']), { width: 1000, height: 1000 }, () => `d${++n}`);
    expect(out.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'd1', 'd2']);
    expect(added).toEqual(['d1', 'd2']);
    const d1 = out[3];
    expect(d1.bbox).toEqual([116, 116, 120, 60]);
    expect(d1.bubble?.box).toEqual([106, 106, 140, 80]);
    expect(d1.style).toEqual(blocks[0].style);
    expect(d1.edited).toBe(true);
    // Never off the page.
    const edge = duplicateBlocks([block('e', 880)], new Set(['e']), { width: 1000, height: 1000 }, () => 'x').blocks[1];
    expect(edge.bbox[0] + edge.bbox[2]).toBeLessThanOrEqual(1000);
  });
});
