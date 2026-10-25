import { describe, expect, it } from 'vitest';
import { bytesCost, fitsInMemory, imageDims, isMemoryError, MemoryBackoff, memoryBudget, pageCost, pagesInFlight, TaskQueue, TYPICAL_PAGE_COST } from '../src';
import { napiBackend } from './helpers';

describe('pages in work by the computer', () => {
  it('more cores and memory, more pages; a local model at most 3; little memory, fewer', () => {
    expect(pagesInFlight({ cores: 16, memoryGb: 8 }, { setting: 'auto', local: false }).n).toBe(4);
    expect(pagesInFlight({ cores: 16, memoryGb: 8 }, { setting: 'auto', local: true }).n).toBe(3);
    expect(pagesInFlight({ cores: 6, memoryGb: 8 }, { setting: 'auto', local: false }).n).toBe(3);
    expect(pagesInFlight({ cores: 4 }, { setting: 'auto', local: false }).n).toBe(2);
    expect(pagesInFlight({ cores: 16, memoryGb: 4 }, { setting: 'auto', local: false }).n).toBe(2);
    expect(pagesInFlight({ cores: 16, memoryGb: 2 }, { setting: 'auto', local: false }).n).toBe(1);
    // Firefox tells no memory: by the cores.
    expect(pagesInFlight({ cores: 12 }, { setting: 'auto', local: false }).n).toBe(4);
    // Chosen by hand (capped at 4), and one fewer after running out of memory.
    expect(pagesInFlight({ cores: 2 }, { setting: 3, local: true }).n).toBe(3);
    expect(pagesInFlight({ cores: 2 }, { setting: 9, local: false }).n).toBe(4);
    expect(pagesInFlight({ cores: 16, memoryGb: 8 }, { setting: 'auto', local: false, lowered: 2 })).toMatchObject({ n: 2, lowered: true });
    expect(pagesInFlight({ cores: 16 }, { setting: 'auto', local: false, lowered: 9 }).n).toBe(1);
  });

  it('a page is costed by its pixels; the pages in work stay within a share of the memory', () => {
    expect(memoryBudget({ memoryGb: 8 })).toBeCloseTo(1.44 * 1024 ** 3, -6);
    expect(memoryBudget({ memoryGb: 1 })).toBe(Math.round(0.3 * 1024 ** 3));
    const webtoon = pageCost(800, 30000);
    // 8 GB: three typical pages fit, a long webtoon strip next to three of them does not.
    expect(fitsInMemory({ memoryGb: 8 }, [TYPICAL_PAGE_COST, TYPICAL_PAGE_COST], TYPICAL_PAGE_COST)).toBe(true);
    expect(fitsInMemory({ memoryGb: 8 }, [webtoon, webtoon, webtoon], webtoon)).toBe(false);
    expect(fitsInMemory({ memoryGb: 2 }, [webtoon], webtoon)).toBe(false);
    // The script heap nearly full: nothing more.
    expect(fitsInMemory({ memoryGb: 8, heap: { used: 3.5e9, limit: 4e9 } }, [1], 1)).toBe(false);
  });

  it('the size is read from the header of PNG, JPEG, WebP and GIF', async () => {
    const c = napiBackend.createCanvas(321, 123);
    c.getContext('2d').fillRect(0, 0, 10, 10);
    for (const mime of ['image/png', 'image/jpeg', 'image/webp'] as const) {
      const bytes = await napiBackend.encode(c, mime, 0.8);
      expect(imageDims(bytes), mime).toEqual({ width: 321, height: 123 });
    }
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x41, 0x01, 0x7b, 0x00, ...new Array(20).fill(0)]);
    expect(imageDims(gif)).toEqual({ width: 321, height: 123 });
    expect(imageDims(new Uint8Array(40))).toBeNull();
    expect(bytesCost(new Uint8Array(40))).toBe(TYPICAL_PAGE_COST);
  });

  it('running out of memory lowers the number for a while, then it comes back', () => {
    let t = 0;
    const b = new MemoryBackoff(1000, () => t);
    expect(b.lowered).toBe(0);
    b.hit();
    b.hit();
    expect(b.lowered).toBe(2);
    t = 1500;
    expect(b.lowered).toBe(0);
    expect(isMemoryError(new RangeError('Array buffer allocation failed'))).toBe(true);
    expect(isMemoryError(new Error('The model ran out of video memory'))).toBe(false);
    expect(isMemoryError(new Error('network'))).toBe(false);
  });

  it('the queue holds the next page while memory is short and lets it in when a page is done', async () => {
    const q = new TaskQueue(3);
    let budget = 2;
    q.gate = (inWork, next) => inWork.reduce((a: number, c) => a + (c ?? 1), 0) + (next ?? 1) <= budget;
    const started: string[] = [];
    const release: Record<string, () => void> = {};
    const task = (key: string, cost: number) => q.add({ key, priority: 0, cost, run: () => new Promise<void>((r) => (started.push(key), (release[key] = r))) });
    const all = [task('a', 1), task('b', 1), task('c', 1)];
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['a', 'b']);
    expect(q.waitingForMemory).toBe(true);
    release.a();
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['a', 'b', 'c']);
    // One page always runs, however big.
    budget = 0;
    release.b();
    release.c();
    await Promise.all(all);
    const big = task('d', 100);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toContain('d');
    release.d();
    await big;
  });
});
