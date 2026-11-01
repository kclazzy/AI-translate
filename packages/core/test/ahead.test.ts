import { describe, expect, it } from 'vitest';
import { AHEAD, pagesAhead } from '../src/util/ahead';

describe('pictures translated ahead below the screen, by how long the model takes', () => {
  it('before any page is done: a few', () => {
    expect(pagesAhead([])).toBe(AHEAD.start);
  });
  it('a fast online model: the least (the reader does not catch up, and pages cost money)', () => {
    expect(pagesAhead([4000, 5000, 3000])).toBe(AHEAD.min);
  });
  it('a slow local model: more, so the reader does not wait on every page', () => {
    expect(pagesAhead([30_000, 34_000, 26_000])).toBe(4);
  });
  it('never more than the cap (memory, work nobody may read)', () => {
    expect(pagesAhead([120_000, 140_000])).toBe(AHEAD.max);
  });
  it('the recent pages count, not the first slow one (the model was loading)', () => {
    expect(pagesAhead([90_000, 8000, 9000, 8000, 7000, 8000])).toBe(AHEAD.min);
  });
});
