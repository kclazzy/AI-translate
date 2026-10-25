import { tr } from '../i18n';

/** Why the model had nothing to do while pictures were in work (see the extension's activity.ts). */
export type IdleReason = 'picture' | 'prep' | 'context' | 'finish' | 'memory' | 'other';

/** Where the time of a chapter went: the model, the networks on the card, the check, idle (and why). */
export interface ActivitySession {
  startedAt: string;
  endedAt?: string;
  /** Time with pictures in the queue, ms. */
  workMs: number;
  modelMs: number;
  netsMs: number;
  reviewMs: number;
  idleMs: number;
  idle: Record<IdleReason, number>;
  /** Pictures finished in the session. */
  pages: number;
  /** Ollama's own times: loading the model (a load ≥ 1 s counts as one), reading the prompt, writing. */
  ollama: { calls: number; loads: number; loadMs: number; promptMs: number; genMs: number };
  /** A local model (else an online one) answered most of the time. */
  local?: boolean;
}

export const IDLE_LABELS: Record<IdleReason, () => string> = {
  picture: () => tr('картинка ещё качается или читается'),
  prep: () => tr('подготовка на процессоре (декодирование, поиск текста, распознавание)'),
  context: () => tr('ожидание контекста предыдущей страницы'),
  finish: () => tr('стирание и вёрстка (модели нечего делать)'),
  memory: () => tr('следующая страница ждёт памяти'),
  other: () => tr('прочее'),
};

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const sec = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 1 : 0);

/** The session in a few lines for a person (the analysis pack, the settings). */
export function activityLines(s: ActivitySession): string[] {
  const w = s.workMs;
  const lines = [
    tr('Работа: {0} с, страниц: {1}{2}', sec(w), s.pages, s.pages ? tr(' (~{0} с на страницу)', sec(w / s.pages)) : ''),
    tr('Модель занята: {0}% ({1} с)', pct(s.modelMs, w), sec(s.modelMs)),
    tr('Нейросети на видеокарте: {0}%, проверка показанных страниц: {1}%', pct(s.netsMs, w), pct(s.reviewMs, w)),
    tr('Простой модели: {0}% ({1} с)', pct(s.idleMs, w), sec(s.idleMs)),
  ];
  const reasons = (Object.keys(s.idle) as IdleReason[]).filter((r) => s.idle[r] >= 250).sort((a, b) => s.idle[b] - s.idle[a]);
  for (const r of reasons) lines.push(`  · ${IDLE_LABELS[r]()}: ${pct(s.idle[r], w)}% (${sec(s.idle[r])} ${tr('с')})`);
  const o = s.ollama;
  if (o.calls) {
    lines.push(tr('Ollama: запросов {0}; загрузка модели {1} с ({2}×), чтение запроса {3} с, ответ {4} с', o.calls, sec(o.loadMs), o.loads, sec(o.promptMs), sec(o.genMs)));
    if (o.loads > 1) lines.push(tr('  · модель загружалась {0}×: её выгружали между страницами (другая модель или короткое «держать в памяти»)', o.loads));
  }
  return lines;
}

/** The biggest cause of idle time, when it is worth a word (≥ 10% of the work). */
export function mainIdle(s: ActivitySession): IdleReason | null {
  const r = (Object.keys(s.idle) as IdleReason[]).sort((a, b) => s.idle[b] - s.idle[a])[0];
  return r && s.workMs > 0 && s.idle[r] / s.workMs >= 0.1 ? r : null;
}
