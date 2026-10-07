import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { ctxMeasurer } from '../src/render/render';
import { hyphenate, layoutText } from '../src/typeset/layout';
import './helpers';

const measurer = ctxMeasurer(createCanvas(10, 10).getContext('2d'));

describe('layoutText', () => {
  it('fits Russian text inside the box and centres lines', () => {
    const r = layoutText(measurer, { text: 'Танака-сан, подожди меня у станции!', box: [0, 0, 160, 200], shape: 'ellipse', fontFamily: 'TestSans' });
    expect(r.overflow).toBe(false);
    expect(r.lines.length).toBeGreaterThan(1);
    for (const l of r.lines) {
      expect(l.width).toBeLessThanOrEqual(160 + 0.5);
      expect(l.y).toBeGreaterThan(0);
      expect(l.y).toBeLessThan(200);
    }
    expect(r.fontSize).toBeGreaterThanOrEqual(9);
  });

  it('picks a larger font for shorter text', () => {
    const short = layoutText(measurer, { text: 'Что?!', box: [0, 0, 160, 200], shape: 'ellipse', fontFamily: 'TestSans' });
    const long = layoutText(measurer, { text: 'Это очень длинная реплика, которая должна поместиться в тот же самый бабл без переполнения', box: [0, 0, 160, 200], shape: 'ellipse', fontFamily: 'TestSans' });
    expect(short.fontSize).toBeGreaterThan(long.fontSize);
  });

  it('respects an ellipse: needs more lines than a rectangle of the same size', () => {
    const text = 'раз два три четыре пять шесть семь восемь девять десять';
    const ell = layoutText(measurer, { text, box: [0, 0, 200, 200], shape: 'ellipse', fontFamily: 'TestSans', fontSize: 16 });
    const rect = layoutText(measurer, { text, box: [0, 0, 200, 200], shape: 'rect', fontFamily: 'TestSans', fontSize: 16 });
    expect(ell.lines.length).toBeGreaterThanOrEqual(rect.lines.length);
    // Every line fits the ellipse width at its own height.
    for (const l of ell.lines) {
      const dy = Math.abs(l.y - 100) + 8;
      const avail = 200 * Math.sqrt(Math.max(0, 1 - (dy / 112) ** 2));
      expect(l.width).toBeLessThanOrEqual(avail + 2);
    }
  });

  it('flags overflow instead of silently cutting text', () => {
    const r = layoutText(measurer, { text: 'Слишком много текста для такого крошечного бабла, правда-правда', box: [0, 0, 30, 20], shape: 'rect', fontFamily: 'TestSans' });
    expect(r.overflow).toBe(true);
  });

  it('lays out vertical CJK text in right-to-left columns', () => {
    const r = layoutText(measurer, { text: '田中さん待って', box: [0, 0, 100, 160], shape: 'rect', fontFamily: 'TestCJK', vertical: true });
    expect(r.vertical).toBe(true);
    expect(r.glyphs.length).toBe(7);
    // First glyph is in the rightmost column.
    const xs = r.glyphs.map((g) => g.x);
    expect(r.glyphs[0].x).toBe(Math.max(...xs));
  });

  it('wraps CJK text by character when typesetting horizontally', () => {
    const r = layoutText(measurer, { text: '今日はいい天気ですね本当に', box: [0, 0, 90, 200], shape: 'rect', fontFamily: 'TestCJK', lang: 'ja' });
    expect(r.overflow).toBe(false);
    expect(r.lines.length).toBeGreaterThan(1);
  });
});

describe('hyphenate', () => {
  it('splits a long word after a vowel with a hyphen', () => {
    const r = hyphenate('восстановление', (s) => s.length <= 8);
    expect(r).not.toBeNull();
    expect(r![0].endsWith('-')).toBe(true);
    expect(r![0].length).toBeLessThanOrEqual(8);
    expect(r![0].slice(0, -1) + r![1]).toBe('восстановление');
  });

  it('refuses to split short words', () => {
    expect(hyphenate('кот', () => false)).toBeNull();
  });
});

describe('text stays inside the picture', () => {
  it('a bubble cut by the top edge with a long translation keeps its first line visible', async () => {
    const { layoutBlock } = await import('../src/render/render');
    const b = {
      id: 'b1', textType: 'DIALOGUE', originalText: "THE DAY'S WORK IS DONE, RIGHT?", translatedText: 'РАБОТА НА СЕГОДНЯ ЗАКОНЧЕНА, ВЕРНО?',
      confidence: 0.9, language: 'en', bbox: [20, -30, 120, 70], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 22,
      bubble: null, translate: true, style: { fontSize: 22 },
    } as never;
    const free = layoutBlock(measurer, b);
    const kept = layoutBlock(measurer, b, undefined, { width: 400, height: 300 });
    const top = (l: typeof free) => -30 + Math.min(...l.lines.map((x) => x.y)) - l.fontSize * 0.95;
    expect(top(free)).toBeLessThan(0); // without the page limit the first line would be cut off
    expect(top(kept)).toBeGreaterThanOrEqual(0);
    expect(kept.lines.length).toBe(free.lines.length);
  });
});
