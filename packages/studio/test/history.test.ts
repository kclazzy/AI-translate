import { describe, expect, it } from 'vitest';
import type { PixelData } from '@ait/core';
import { EditHistory, type HistoryItem } from '../src/editor/history';

const px = (bytes: number): PixelData => ({ width: bytes / 4, height: 1, data: new Uint8ClampedArray(bytes) });
const pixels = (bytes: number): HistoryItem => ({ kind: 'pixels', box: [0, 0, 1, 1], before: px(bytes / 2), after: px(bytes / 2) });
const texts = (): HistoryItem => ({ kind: 'blocks', before: [], after: [] });

describe('edit history', () => {
  it('drops the oldest steps when the pixels take more than the byte budget', () => {
    const h = new EditHistory(60, 1000);
    h.push(pixels(400));
    h.push(texts());
    h.push(pixels(400));
    expect(h.size).toBe(3);
    h.push(pixels(400));
    expect(h.bytes).toBeLessThanOrEqual(1000);
    expect(h.size).toBe(3);
    expect(h.bytes).toBe(800);
  });

  it('keeps the newest step even when it alone is too big', () => {
    const h = new EditHistory(60, 100);
    h.push(pixels(40));
    h.push(pixels(400));
    expect(h.size).toBe(1);
    expect(h.canUndo).toBe(true);
  });

  it('limits the number of steps and forgets redo after a new edit', () => {
    const h = new EditHistory(3, Infinity);
    for (let i = 0; i < 5; i++) h.push(pixels(8));
    expect(h.size).toBe(3);
    expect(h.bytes).toBe(24);
    const it = h.undo();
    expect(h.canRedo).toBe(true);
    expect(h.bytes).toBe(24);
    expect(h.redo()).toBe(it);
    h.undo();
    h.push(texts());
    expect(h.canRedo).toBe(false);
    expect(h.bytes).toBe(16);
  });
});
