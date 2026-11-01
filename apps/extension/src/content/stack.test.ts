import { describe, expect, it } from 'vitest';
import { stackedBelow } from './stack';

const r = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, bottom: top + height, right: left + width });

describe('two pictures one under the other in the same column (a strip the site cut into slices)', () => {
  it('touching, or with the small gap sites leave between slices (margins, line height)', () => {
    expect(stackedBelow(r(100, 0, 720, 1024), r(100, 1024, 720, 1024))).toBe(true);
    expect(stackedBelow(r(100, 0, 720, 1024), r(100, 1028, 720, 1024))).toBe(true);
    expect(stackedBelow(r(100, 0, 720, 1024), r(100, 1044, 720, 1024))).toBe(true);
    expect(stackedBelow(r(100, 0, 720, 1024), r(100.4, 1024.5, 719.6, 1024))).toBe(true);
  });
  it('not: another column, another width, far below, or above', () => {
    expect(stackedBelow(r(100, 0, 720, 1024), r(840, 1024, 720, 1024))).toBe(false);
    expect(stackedBelow(r(100, 0, 720, 1024), r(100, 1024, 500, 1024))).toBe(false);
    expect(stackedBelow(r(100, 0, 720, 1024), r(100, 1200, 720, 1024))).toBe(false);
    expect(stackedBelow(r(100, 1024, 720, 1024), r(100, 0, 720, 1024))).toBe(false);
  });
});
