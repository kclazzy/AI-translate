/**
 * Interface language. Source strings are written in Russian right in the code: t('Готово')
 * looks the string up in the dictionary of the current language and falls back to the source.
 * Placeholders {0}, {1}… are filled from the extra arguments.
 *
 * "auto" follows the browser's interface language, which on Windows is the Windows display
 * language unless the user changed it in Chrome. Unsupported languages fall back to English.
 */

export interface UiLanguage {
  code: string;
  /** Name in the language itself, shown in the picker. */
  native: string;
}

export const UI_LANGS: UiLanguage[] = [
  { code: 'ru', native: 'Русский' },
  { code: 'en', native: 'English' },
  { code: 'uk', native: 'Українська' },
  { code: 'es', native: 'Español' },
  { code: 'pt', native: 'Português' },
  { code: 'de', native: 'Deutsch' },
  { code: 'fr', native: 'Français' },
  { code: 'ja', native: '日本語' },
  { code: 'ko', native: '한국어' },
  { code: 'zh', native: '中文（简体）' },
];

export type UiLangPref = 'auto' | string;
export type Dictionary = Record<string, string>;

const STORAGE_KEY = 'ait-ui-lang';
const dictionaries: Record<string, Dictionary> = {};

/** Language of the browser / system interface, e.g. "ru-RU". */
export function systemLanguage(): string {
  try {
    const c = (globalThis as { chrome?: { i18n?: { getUILanguage?: () => string } } }).chrome;
    const ui = c?.i18n?.getUILanguage?.();
    if (ui) return ui;
  } catch {
    /* not an extension */
  }
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  return nav?.languages?.[0] ?? nav?.language ?? 'en';
}

/** Supported interface language for a preference ("auto" → the system's, if we have it). */
export function resolveUiLang(pref?: UiLangPref | null, system = systemLanguage()): string {
  const want = !pref || pref === 'auto' ? system : pref;
  const base = want.toLowerCase().split(/[-_]/)[0];
  return UI_LANGS.some((l) => l.code === base) ? base : 'en';
}

function storedPref(): UiLangPref | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

let pref: UiLangPref = storedPref() ?? 'auto';
let lang = resolveUiLang(pref);
try {
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = lang;
} catch {
  /* no document */
}

/** Current interface language code. */
export function uiLang(): string {
  return lang;
}

/** The preference the current language came from ("auto" or a code). */
export function uiLangPref(): UiLangPref {
  return pref;
}

/**
 * Switch the interface language. Remembered synchronously (localStorage) so that pages pick it
 * up before anything renders; returns true when the language actually changed.
 */
export function setUiLang(p: UiLangPref | null | undefined, remember = true): boolean {
  pref = p || 'auto';
  try {
    if (remember) globalThis.localStorage?.setItem(STORAGE_KEY, pref);
  } catch {
    /* no storage (service worker) */
  }
  const next = resolveUiLang(pref);
  const changed = next !== lang;
  lang = next;
  try {
    if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = lang;
  } catch {
    /* no document */
  }
  return changed;
}

export function registerDictionary(code: string, dict: Dictionary): void {
  dictionaries[code] = dict;
}

export function dictionaryFor(code: string): Dictionary | undefined {
  return dictionaries[code];
}

/** Translate an interface string (Russian source) into the current interface language. */
export function t(src: string, ...args: unknown[]): string {
  const s = lang === 'ru' ? src : dictionaries[lang]?.[src] ?? dictionaries.en?.[src] ?? src;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s;
}

/** Locale for dates and numbers in the interface. */
export function uiLocale(): string {
  return lang === 'zh' ? 'zh-CN' : lang === 'pt' ? 'pt-BR' : lang;
}

/** Same as t(): the name used in code where `t` is often a local variable. */
export const tr = t;

/**
 * A table of interface strings for module-level constants: each read is translated into the
 * language current at that moment (a content script or service worker learns it after loading).
 */
export function lazyStrings<T extends Record<string, string>>(src: T): T {
  const out = {} as T;
  for (const k of Object.keys(src)) Object.defineProperty(out, k, { get: () => t(src[k]), enumerable: true });
  return out;
}

/**
 * Apply the language from the settings in a page. True when the page should reload so that
 * everything (including texts built when modules loaded) appears in the new language; never
 * true when the choice cannot be remembered, so a page cannot reload in a loop.
 */
export function applyUiLangFromSettings(p: UiLangPref | null | undefined): boolean {
  const changed = setUiLang(p);
  return changed && storedPref() === (p || 'auto');
}

/**
 * Marks an interface string kept as data (a preset label, a default name): stored in Russian and
 * translated where it is shown, with tr(). Returns the string unchanged.
 */
export const N_ = (s: string): string => s;
