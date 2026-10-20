/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { TiledImage, clampBox } from '../src/image/tiled';
import { growOverPlain, mergeSplitLines } from '../src/pipeline/splitLines';
import type { Box, TextBlock } from '../src/types';
import { napiBackend } from './helpers';

const block = (id: string, box: Box, text: string, translated = ''): TextBlock => ({
  id, textType: 'DIALOGUE', originalText: text, translatedText: translated, confidence: 0.9, language: 'en', bbox: box,
  polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 30, bubble: null, translate: true,
});

async function page(outlineBetween: boolean) {
  const c = createCanvas(600, 500);
  const g = c.getContext('2d') as any;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 600, 500);
  g.strokeStyle = '#000';
  g.lineWidth = 4;
  if (outlineBetween) {
    // Two bubbles one on top of the other: their outlines pass between the lines.
    g.beginPath(); g.ellipse(300, 120, 200, 70, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.ellipse(300, 270, 200, 70, 0, 0, Math.PI * 2); g.stroke();
  } else {
    g.beginPath(); g.ellipse(300, 190, 220, 140, 0, 0, Math.PI * 2); g.stroke();
  }
  const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')));
  return (x: number, y: number, w: number, h: number) => {
    const [cx, cy, cw, ch] = clampBox([x, y, w, h], img.width, img.height);
    return img.getRegion(cx, cy, cw, ch);
  };
}

describe('one bubble read as two blocks', () => {
  it('two lines of one bubble become one block, translated as one', async () => {
    const r = mergeSplitLines([block('b1', [200, 140, 200, 32], 'I DID NOT', 'Я НЕ'), block('b2', [210, 180, 180, 32], 'MEAN IT.')], await page(false));
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0].originalText).toBe('I DID NOT MEAN IT.');
    expect(r.blocks[0].translatedText).toBe('');
    expect(r.blocks[0].bbox).toEqual([200, 140, 200, 72]);
  });

  it('two bubbles one above the other stay two', async () => {
    const r = mergeSplitLines([block('b1', [200, 150, 200, 32], 'HELLO'), block('b2', [200, 226, 200, 32], 'GOODBYE')], await page(true));
    expect(r.blocks).toHaveLength(2);
  });

  it('far apart, side by side or of very different sizes: two', async () => {
    const regions = await page(false);
    expect(mergeSplitLines([block('b1', [200, 100, 200, 32], 'A'), block('b2', [200, 220, 200, 32], 'B')], regions).blocks).toHaveLength(2);
    expect(mergeSplitLines([block('b1', [100, 140, 120, 32], 'A'), block('b2', [380, 180, 120, 32], 'B')], regions).blocks).toHaveLength(2);
    expect(mergeSplitLines([block('b1', [200, 140, 200, 32], 'A'), { ...block('b2', [200, 180, 200, 90], 'B'), fontSizeEstimate: 80 }], regions).blocks).toHaveLength(2);
  });

  it('the same box read twice (a collage piece answered with two entries): one', async () => {
    const r = mergeSplitLines([block('b1', [200, 140, 200, 70], 'I DID NOT', 'Я НЕ'), block('b2', [200, 140, 200, 70], 'MEAN IT.', 'ХОТЕЛ.')], await page(false));
    expect(r.blocks.map((b) => b.translatedText)).toEqual(['Я НЕ ХОТЕЛ.']);
  });
});

describe('room for a longer translation over plain ground', () => {
  it('grows to 6 px before the outline, at most 35 % a side', async () => {
    const c = createCanvas(600, 400);
    const g = c.getContext('2d') as any;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 600, 400);
    g.fillStyle = '#000';
    // A frame: 20 px above the box, far below and to the sides.
    g.fillRect(0, 130, 600, 4);
    const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')));
    const regionOf = (x: number, y: number, w: number, h: number) => img.getRegion(x, y, w, h);
    const grown = growOverPlain(regionOf, [200, 154, 200, 100], [255, 255, 255], img);
    expect(grown[1]).toBe(134 + 6);
    expect(grown[1] + grown[3]).toBe(254 + 35 - 6);
    expect(grown[0]).toBe(200 - 70 + 6);
    expect(grown[2]).toBe(200 + 2 * (70 - 6));
  });
});

describe('how the text is lettered (one letter from the model)', () => {
  it('is read from the answer and becomes the style of the translation', async () => {
    const { parseVisionAnswer } = await import('../src/translate/parse');
    const { lookStyle } = await import('../src/pipeline/standalone');
    const a = parseVisionAnswer(JSON.stringify({ blocks: [{ box: [0, 0, 100, 100], text: 'NO!', type: 'DIALOGUE', s: 'b' }, { box: [0, 200, 100, 300], text: 'hm', type: 'DIALOGUE', s: 'x' }] }), false);
    expect(a.blocks.map((b) => b.look)).toEqual(['b', undefined]);
    expect(lookStyle('b', 'DIALOGUE')).toEqual({ bold: true, uppercase: true });
    expect(lookStyle('i', 'DIALOGUE')).toEqual({ italic: true });
    expect(lookStyle('h', 'DIALOGUE').fontFamily).toContain('AIT Comic');
    expect(lookStyle('u', 'NARRATION').fontFamily).toContain('AIT Narration');
    expect(lookStyle('b', 'SFX')).toEqual({});
  });
});
