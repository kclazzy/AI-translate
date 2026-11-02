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

describe('brush / eraser shapes', () => {
  it('a rectangle, an ellipse and a lasso fill their own area of the page', async () => {
    const { shapeMask } = await import('../src/editor/shapes');
    const page = { width: 200, height: 200 };
    const at = (r: { box: number[]; mask: Uint8Array }, x: number, y: number) => r.mask[(y - r.box[1]) * r.box[2] + (x - r.box[0])];
    const rect = shapeMask('rect', [[20, 30], [60, 40], [100, 90]], page)!;
    expect(rect.box).toEqual([20, 30, 80, 60]);
    expect(rect.mask.every((v) => v === 1)).toBe(true);
    const ell = shapeMask('ellipse', [[20, 30], [100, 90]], page)!;
    expect(at(ell, 60, 60)).toBe(1);
    expect(at(ell, 21, 31)).toBe(0); // the corner of the frame is outside the ellipse
    const share = ell.mask.reduce((a, v) => a + v, 0) / ell.mask.length;
    expect(share).toBeGreaterThan(0.74);
    expect(share).toBeLessThan(0.82); // π/4 of the frame
    // A triangle drawn freehand: inside filled, the other half of its box not.
    const lasso = shapeMask('lasso', [[10, 10], [110, 10], [10, 110]], page)!;
    expect(at(lasso, 30, 30)).toBe(1);
    expect(at(lasso, 100, 100)).toBe(0);
    // Kept on the page; nothing for a frame of no size.
    expect(shapeMask('rect', [[150, 150], [260, 300]], page)!.box).toEqual([150, 150, 50, 50]);
    expect(shapeMask('rect', [[10, 10], [10, 10]], page)).toBeNull();
  });
});
