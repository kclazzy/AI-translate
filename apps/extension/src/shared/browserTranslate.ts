import { AppError, setBrowserTranslate } from '@ait/core';
import { tr } from '@ait/core/i18n';

/**
 * Chrome's built-in translator (the Translator API, Chrome 138+): language packs on this computer,
 * downloaded by the browser once per pair. Registered for the core (see browserTranslator.ts) in
 * every page of the extension that translates or shows the AI mode.
 */
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface TranslatorLike {
  translate(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
}
interface TranslatorApi {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; signal?: AbortSignal; monitor?: (m: EventTarget) => void }): Promise<TranslatorLike>;
}

const api = (): TranslatorApi | undefined => (globalThis as { Translator?: TranslatorApi }).Translator;

export const browserTranslatorHere = (): boolean => !!api();

/** How the pair can be translated: directly, through English, or not (and what has to be downloaded). */
async function route(from: string, to: string): Promise<{ steps: [string, string][]; state: Availability }> {
  const T = api();
  if (!T) return { steps: [], state: 'unavailable' };
  const direct = await T.availability({ sourceLanguage: from, targetLanguage: to }).catch(() => 'unavailable' as const);
  if (direct !== 'unavailable' || from === 'en' || to === 'en') return { steps: [[from, to]], state: direct };
  const a = await T.availability({ sourceLanguage: from, targetLanguage: 'en' }).catch(() => 'unavailable' as const);
  const b = await T.availability({ sourceLanguage: 'en', targetLanguage: to }).catch(() => 'unavailable' as const);
  const rank: Availability[] = ['unavailable', 'downloadable', 'downloading', 'available'];
  const state = rank[Math.min(rank.indexOf(a), rank.indexOf(b))];
  return { steps: [[from, 'en'], ['en', to]], state };
}

/** State of a language pair: 'available' — ready; 'downloadable' — a click downloads the pack. */
export async function translatorStatus(from: string, to: string): Promise<Availability> {
  return (await route(from, to)).state;
}

const ready = new Map<string, Promise<TranslatorLike>>();

function open(from: string, to: string, progress?: (share: number) => void): Promise<TranslatorLike> {
  const key = `${from}>${to}`;
  let t = ready.get(key);
  if (!t) {
    t = api()!.create({
      sourceLanguage: from,
      targetLanguage: to,
      monitor: (m) => m.addEventListener('downloadprogress', (e) => progress?.((e as unknown as { loaded: number }).loaded)),
    });
    ready.set(key, t);
    t.catch(() => ready.delete(key));
  }
  return t;
}

/** Download the language pack(s) for a pair (call it from a click: the browser asks for one). */
export async function prepareTranslator(from: string, to: string, progress?: (share: number) => void): Promise<void> {
  const { steps, state } = await route(from, to);
  if (state === 'unavailable') throw new Error(tr('Браузер не умеет переводить с «{0}» на «{1}».', from, to));
  for (const [i, [a, b]] of steps.entries()) await open(a, b, (p) => progress?.((i + p) / steps.length));
  progress?.(1);
}

async function translateAll(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]> {
  if (!api()) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: tr('Встроенного переводчика нет в этом браузере (нужен Chrome 138 или новее). Выберите модель для перевода.') });
  const { steps, state } = await route(from, to);
  if (state === 'unavailable') throw new AppError('NOT_CONFIGURED', { retryable: false, detail: tr('Встроенный переводчик браузера не умеет переводить с «{0}» на «{1}». Выберите модель для перевода.', from, to) });
  if (state !== 'available') throw new AppError('SETUP_NEEDED', { retryable: false, detail: tr('Скачайте языковой пакет переводчика браузера: Настройки → Режим работы ИИ → Распознавание.') });
  let out = texts;
  for (const [a, b] of steps) {
    const t = await open(a, b);
    out = await translateLines(t, out, signal);
  }
  return out;
}

/**
 * All the lines of a page in one request, one per line (much faster than a request each); when the
 * answer does not come back with as many lines, line by line.
 */
async function translateLines(t: TranslatorLike, lines: string[], signal?: AbortSignal): Promise<string[]> {
  const idx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const out = [...lines];
  if (!idx.length) return out;
  const flat = idx.map((i) => lines[i].replace(/\s*\n\s*/g, ' ').trim());
  if (flat.length > 1) {
    const joined = (await t.translate(flat.join('\n'), { signal })).split(/\r?\n/).map((x) => x.trim());
    if (joined.length === flat.length && joined.every(Boolean)) {
      idx.forEach((i, k) => (out[i] = joined[k]));
      return out;
    }
  }
  for (const [k, i] of idx.entries()) out[i] = await t.translate(flat[k], { signal });
  return out;
}

/** Register the translator for the core (it looks for the browser's API when it runs). */
export function installBrowserTranslate(): void {
  setBrowserTranslate(translateAll, !!api());
}

installBrowserTranslate();
