/**
 * Golden set with a mock "sloppy" vision model: boxes too loose (±15 %), shifted by 10–30 % of
 * their height, or the whole bubble instead of the text — the way real local models are off.
 * The pass counts may not drop below the recorded baseline (see golden.test.ts for the rest).
 */
import { describe, expect, it } from 'vitest';
import { GOLDEN_PAGES } from './golden/pages';
import { pageOf, print, REAL, report, runPage } from './golden/run';
import { CHECKS, passCount, scoreTable, type CheckName, type PageScore } from './golden/score';

/**
 * Sloppy-model baseline: checks passed (of the pages where the check applies). Raise these when
 * the pipeline gets better; a lower count fails the test (a regression).
 */
const SLOPPY_BASELINE: Record<CheckName, number> = { skip: 17, found: 15, erased: 15, artUntouched: 17, inside: 13, readable: 14, style: 15 };

describe.skipIf(REAL)('golden set: sloppy model', () => {
  const scores: PageScore[] = [];
  for (const { name } of GOLDEN_PAGES) {
    it(name, async () => {
      scores.push(await runPage(await pageOf(name), 'sloppy'));
    }, 30_000);
  }
  it('keeps the recorded pass counts (raise SLOPPY_BASELINE when it gets better)', () => {
    print(`\nGolden set, sloppy model (${scores.map((s) => `${s.page}: ${s.jitters?.join('/') || '-'}`).join(', ')})\n${scoreTable(scores)}`);
    report('report-sloppy.html', scores, 'Golden set — sloppy mock model', 'Неточные рамки (шире, сдвинуты, весь бабл); CI');
    expect(scores).toHaveLength(GOLDEN_PAGES.length);
    const now = Object.fromEntries(CHECKS.map((c) => [c, passCount(scores, c).pass]));
    const worse = CHECKS.filter((c) => now[c] < SLOPPY_BASELINE[c]);
    expect(worse, `now ${JSON.stringify(now)}, baseline ${JSON.stringify(SLOPPY_BASELINE)}`).toEqual([]);
    const better = CHECKS.filter((c) => now[c] > SLOPPY_BASELINE[c]);
    if (better.length) print(`Sloppy model improved on ${better.join(', ')}: raise SLOPPY_BASELINE to ${JSON.stringify(now)}`);
  });
});

