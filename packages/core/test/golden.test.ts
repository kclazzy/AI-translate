/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Golden set: synthetic reference pages run through the whole pipeline (model → cleaning →
 * typesetting) and scored by the same checks every time (see test/golden/score.ts).
 *
 *  - CI (default): a mock "perfect" model (true boxes) must pass every check; a mock "sloppy"
 *    model (loose / shifted / whole-bubble boxes) must keep at least the recorded pass counts.
 *  - Real model, by hand: GOLDEN_REAL=1 GOLDEN_BASE=http://127.0.0.1:11434 GOLDEN_MODEL=qwen3.5:9b-q4_K_M
 *    [GOLDEN_PROVIDER=ollama|openai|anthropic] [GOLDEN_KEY=…] — or `node scripts/golden-real.mjs`.
 *    Writes .test-output/golden/report.html; nothing is asserted (models differ).
 *
 * The sloppy mock model runs in golden-sloppy.test.ts (a separate file: vitest runs both at once).
 * Pictures: .test-output/golden/<page>-original.png, <page>-<mode>.png (rendered), <page>-<mode>-cleaned.png
 * (when a check failed), report-<mode>.html.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { GOLDEN_PAGES } from './golden/pages';
import { pageOf, print, OUT, REAL, realProvider, report, runPage } from './golden/run';
import { CHECKS, scoreTable, type CheckName, type PageScore } from './golden/score';

/**
 * Checks the current pipeline fails even with perfect boxes: improvement targets, not regressions.
 * The perfect-model test fails on any other failed check; when one of these starts to pass, it
 * says so — then delete it here so it stays fixed.
 */
const KNOWN_PERFECT: Record<string, CheckName[]> = {};

describe.skipIf(REAL)('golden set: perfect model', () => {
  const scores: PageScore[] = [];
  afterAll(() => {
    print(`\nGolden set, perfect model\n${scoreTable(scores)}`);
    report('report-perfect.html', scores, 'Golden set — perfect mock model', 'Точные рамки; CI');
  });
  for (const { name } of GOLDEN_PAGES) {
    it(name, async () => {
      const s = await runPage(await pageOf(name), 'perfect');
      scores.push(s);
      const known = KNOWN_PERFECT[name] ?? [];
      const failed = CHECKS.filter((c) => s.checks[c] === false && !known.includes(c));
      expect(failed, s.notes.join('; ')).toEqual([]);
      const fixed = known.filter((c) => s.checks[c] !== false);
      if (fixed.length) print(`golden ${name}: ${fixed.join(', ')} passes now — remove it from KNOWN_PERFECT`);
    }, 30_000);
  }
});

describe.runIf(REAL)('golden set: real model', () => {
  const scores: PageScore[] = [];
  afterAll(() => {
    const cfg = realProvider();
    print(`\nGolden set, ${cfg.model} at ${cfg.baseUrl}\n${scoreTable(scores)}`);
    report('report.html', scores, `Golden set — ${cfg.model}`, `${cfg.baseUrl} · ${new Date().toLocaleString('ru-RU')}`);
    print(`Report: ${OUT}report.html`);
  });
  for (const { name } of GOLDEN_PAGES) {
    it(name, async () => {
      try {
        scores.push(await runPage(await pageOf(name), 'real'));
      } catch (e) {
        // A failed page is reported, not fatal: the others still run.
        scores.push({ page: name, mode: 'real', checks: Object.fromEntries(CHECKS.map((c) => [c, false])) as any, erased: null, artChanged: 1, minFont: null, minReadable: 0, overflow: 0, similarity: null, calls: 0, ms: 0, blocksOut: 0, notes: [`error: ${(e as Error).message}`] });
      }
    }, 15 * 60_000);
  }
});
