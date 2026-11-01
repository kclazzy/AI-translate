import { describe, expect, it } from 'vitest';
import { planStack } from '../src/editor/stack';

const pages = (sizes: [number, number][]) => sizes.map(([width, height], i) => ({ key: `k${i}`, n: i + 1, width, height }));

describe('whole chapter in the editor: which pages go into the strip', () => {
  it('pages of another width are in it too, centred (a site that scans pages a little differently)', () => {
    const plan = planStack(pages([[800, 1100], [800, 1100], [720, 1100], [784, 1100]]), 'k0', 90_000_000);
    expect(plan.width).toBe(800);
    expect(plan.chosen.map((c) => [c.key, c.x, c.y])).toEqual([['k0', 0, 0], ['k1', 0, 1100], ['k2', 40, 2200], ['k3', 8, 3300]]);
    expect(plan.skipped).toEqual([]);
  });
  it('a long chapter: the part around the opened page that fits in memory, the rest named', () => {
    const plan = planStack(pages([[800, 1000], [800, 1000], [800, 1000], [800, 1000], [800, 1000]]), 'k2', 800 * 3000);
    expect(plan.chosen.map((c) => c.key)).toEqual(['k1', 'k2', 'k3']);
    expect(plan.skipped).toEqual([{ n: 1, why: 'window' }, { n: 5, why: 'window' }]);
  });
  it('a double spread much wider than the rest stays out (it would shrink every page around it)', () => {
    const plan = planStack(pages([[800, 1100], [1600, 1100], [800, 1100]]), 'k0', 90_000_000);
    expect(plan.chosen.map((c) => c.key)).toEqual(['k0', 'k2']);
    expect(plan.skipped).toEqual([{ n: 2, why: 'width' }]);
  });
});
