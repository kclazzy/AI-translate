import { AppError } from '../errors';
import { tr } from '../i18n';
import { detectScript } from '../languages';
import type { CompletionRequest, CompletionResult, LlmProvider, ProviderConfig } from './types';

/**
 * The translator built into the browser (Chrome 138+: the Translator API, models on this computer,
 * downloaded by the browser once per language pair). Not a language model: it gets the recognised
 * lines one by one and gives each back translated — no context of the series, no glossary rules,
 * no character voices; but no Ollama, no online service and no key are needed.
 *
 * It stands in the settings as a model server with a fixed id; the app registers the function that
 * runs it (`setBrowserTranslate`), the pipeline calls it through `translateBlocks`.
 */
export const BROWSER_TRANSLATOR_ID = 'browser-translator';

export const BROWSER_TRANSLATOR: ProviderConfig = {
  id: BROWSER_TRANSLATOR_ID,
  label: 'Browser translator',
  kind: 'openai-compatible',
  preset: 'browser',
  // Nothing is sent anywhere; a local address keeps the privacy checks simple.
  baseUrl: 'http://localhost/browser-translator',
  model: 'browser-translator',
  vision: false,
  jsonMode: 'none',
};

export const isBrowserTranslator = (p: ProviderConfig | null | undefined): boolean => !!p && (p.id === BROWSER_TRANSLATOR_ID || p.preset === 'browser');

/** Translate lines from one language to another (the browser's own translator). */
export type BrowserTranslate = (texts: string[], from: string, to: string, signal?: AbortSignal) => Promise<string[]>;

let impl: BrowserTranslate | null = null;
let supported = false;

/** Register the browser's translator (`isSupported`: the browser has one at all, for the mode switch). */
export function setBrowserTranslate(fn: BrowserTranslate | null, isSupported = !!fn): void {
  impl = fn;
  supported = isSupported;
}

/** Does this browser have a built-in translator (as far as this page knows)? */
export function browserTranslateSupported(): boolean {
  return supported;
}

/** The language of the recognised text when the source is «auto» (by its script). */
export function guessLanguage(texts: string[], fallback = 'en'): string {
  const s = detectScript(texts.join(' '));
  return s === 'ja' || s === 'ko' || s === 'zh' ? s : s === 'cyrillic' ? 'ru' : fallback;
}

/** Base language of a tag for the browser's translator ('zh-Hans' stays, 'pt-BR' → 'pt'). */
export function translatorLang(tag: string): string {
  if (/^zh/i.test(tag)) return /hant|tw|hk/i.test(tag) ? 'zh-Hant' : 'zh';
  return tag.split('-')[0].toLowerCase();
}

export class BrowserTranslatorProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async complete(_req: CompletionRequest): Promise<CompletionResult> {
    throw new AppError('NOT_CONFIGURED', { retryable: false, detail: tr('Встроенный переводчик браузера только переводит текст; для этого нужна модель.') });
  }

  /** Each line translated on its own (see translateWithBrowser). */
  translateTexts(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]> {
    return translateWithBrowser(texts, from, to, signal);
  }
}

/** Each line translated on its own; lines that come back empty keep the original. */
export async function translateWithBrowser(texts: string[], from: string, to: string, signal?: AbortSignal): Promise<string[]> {
  if (!impl) throw new AppError('NOT_CONFIGURED', { retryable: false, detail: tr('Встроенного переводчика нет в этом браузере (нужен Chrome 138 или новее). Выберите модель для перевода.') });
  const src = translatorLang(from === 'auto' ? guessLanguage(texts) : from);
  const dst = translatorLang(to);
  if (src === dst) return texts;
  const out = await impl(texts, src, dst, signal);
  return texts.map((t, i) => out[i]?.trim() || t);
}

/**
 * The source languages whose packs the browser's translator gets right away (manga, manhwa,
 * manhua, comics and the big European languages), so «авто» and a change of language just work.
 */
export const TRANSLATOR_MAIN_LANGS = ['en', 'ja', 'ko', 'zh', 'zh-Hant', 'es', 'fr', 'de', 'pt', 'it'];

/** Language pairs to prepare for these languages: the chosen source first, then the main ones (into the target). */
export function translatorPairs(sourceLang: string, targetLang: string): [string, string][] {
  const to = translatorLang(targetLang);
  const first = sourceLang === 'auto' ? [] : [translatorLang(sourceLang)];
  return [...new Set([...first, ...TRANSLATOR_MAIN_LANGS])].filter((l) => l !== to).map((l) => [l, to]);
}
