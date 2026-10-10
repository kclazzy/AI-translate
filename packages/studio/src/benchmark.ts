import type { PageResult, Usage } from '@ait/core';
import { lazyStrings, uiLocale } from '@ait/core/i18n';

/** Stages of one page, in the order the program does them. */
export type BenchStage = 'read' | 'translate' | 'qa' | 'erase' | 'lama' | 'render';

export interface BenchRow {
  stage: BenchStage | 'total';
  label: string;
  /** Milliseconds; null when this version of the program does not measure the stage. */
  ms: number | null;
}

export interface Benchmark {
  rows: BenchRow[];
  model: string;
  tokens: { input: number; output: number } | null;
  /** The slowest stage and what would speed it up most. */
  slowest: BenchStage | null;
  hint: string | null;
}

/** Timings a page may carry (newer versions add more stages). */
type Timings = PageResult['timings'] & { qaMs?: number; inpaintMs?: number; renderMs?: number };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const sum = (...v: (number | null)[]): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((a, x) => a + (x ?? 0), 0));

export const BENCH_LABEL: Record<BenchRow['stage'], string> = lazyStrings({
  read: 'Чтение картинки',
  translate: 'Перевод',
  qa: 'Проверка',
  erase: 'Стирание',
  lama: 'Дорисовка LaMa',
  render: 'Вёрстка',
  total: 'Всего',
});

export const BENCH_HINT: Record<BenchStage, string> = lazyStrings({
  read: 'модель поменьше или режим «Быстро»',
  translate: 'модель поменьше или выключите «Переводить отдельным шагом»',
  qa: 'выключите проверку или включите «проверять несколько страниц сразу»',
  erase: 'картинка поменьше — стирание идёт на процессоре',
  lama: 'LaMa на видеокарте (WebGPU)',
  render: 'вёрстка и так быстрая — ускорять почти нечего',
});

/** Break the time of one translated page into stages. `wallMs`: the whole call, as the user waited. */
export function benchmarkOf(page: Pick<PageResult, 'timings' | 'usage'>, wallMs: number, fallbackModel = ''): Benchmark {
  const t = (page.timings ?? {}) as Timings;
  const read = sum(num(t.decodeMs), num(t.detectMs), num(t.ocrMs));
  const inpaint = num(t.inpaintMs);
  let clean = num(t.cleanMs);
  // The LaMa redraw happens inside the cleaning step; shown on its own line when it is measured.
  if (clean !== null && inpaint !== null && inpaint <= clean) clean -= inpaint;
  const stages: [BenchStage, number | null][] = [
    ['read', read],
    ['translate', num(t.translateMs)],
    ['qa', num(t.qaMs)],
    ['erase', clean],
    ['lama', inpaint],
    ['render', num(t.renderMs)],
  ];
  const total = Math.max(num(wallMs) ?? 0, num(t.totalMs) ?? 0) || null;
  const rows: BenchRow[] = [...stages.map(([stage, ms]) => ({ stage, label: BENCH_LABEL[stage], ms })), { stage: 'total', label: BENCH_LABEL.total, ms: total }];
  let slowest: BenchStage | null = null;
  for (const [stage, ms] of stages) if (ms !== null && ms > 0 && (slowest === null || ms > (stages.find((s) => s[0] === slowest)![1] ?? 0))) slowest = stage;
  const usage: Usage[] = page.usage ?? [];
  const tokens = usage.length ? { input: usage.reduce((a, u) => a + (u.inputTokens || 0), 0), output: usage.reduce((a, u) => a + (u.outputTokens || 0), 0) } : null;
  const models = [...new Set(usage.map((u) => u.model).filter(Boolean))];
  return { rows, model: models.join(' + ') || fallbackModel, tokens, slowest, hint: slowest ? BENCH_HINT[slowest] : null };
}

/** Seconds with one decimal ("—" when not measured). */
export function fmtSeconds(ms: number | null): string {
  if (ms === null) return '—';
  const d = ms < 10_000 ? 1 : 0;
  return (ms / 1000).toLocaleString(uiLocale(), { minimumFractionDigits: d, maximumFractionDigits: d });
}
