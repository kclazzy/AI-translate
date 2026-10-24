import type { AppSettings } from './settings';
import { providerById } from './settings';
import { isLocalProvider } from './llm/privacy';
import { isBrowserTranslator } from './llm/browserTranslator';
import { tr } from './i18n';
import { qaModeOf } from './pipeline/config';

/**
 * What the pictures are translated with, as far as the best settings go:
 * - local: a model on this computer reads the pictures (Ollama, LM Studio);
 * - cloud: an online model reads them;
 * - ocr-browser / ocr-local / ocr-cloud: «Распознавание», the text translated by the browser's own
 *   translator, a model on this computer or an online one;
 * - engine: the separate AI Translate Engine.
 */
export type OptimalProfile = 'local' | 'cloud' | 'ocr-browser' | 'ocr-local' | 'ocr-cloud' | 'engine';

export function optimalProfile(s: AppSettings): OptimalProfile {
  if (s.pipeline === 'engine') return 'engine';
  const v = providerById(s, s.visionProviderId);
  if (s.readMode === 'ocr') {
    if (!v || isBrowserTranslator(v)) return 'ocr-browser';
    return isLocalProvider(v) ? 'ocr-local' : 'ocr-cloud';
  }
  return v && !isLocalProvider(v) ? 'cloud' : 'local';
}

/** The settings that depend on the model: switched by themselves when the model changes. */
const MODEL_KEYS = ['fastLocal', 'quality', 'twoStepTranslation', 'qaMode', 'qaBatch', 'gpuKeepAliveMin', 'detectorMode', 'lamaMode'] as const;

function wanted(s: AppSettings, profile: OptimalProfile): Partial<AppSettings> {
  const vram = s.gpuVramGb ?? 12;
  const big = vram >= 16;
  // The user's taste in what to translate: only the button sets it, never a model switch.
  const common: Partial<AppSettings> = {
    translateSfx: true,
    sfxStyle: 'translated',
    stitchStrips: true,
    bubblesOnly: false,
    onlySourceLang: s.sourceLang !== 'auto',
    skipEmptyPages: true,
    selfCheck: true,
    phrasebook: s.phrasebook ? { ...s.phrasebook, enabled: true } : s.phrasebook,
  };
  // Up to 12 GB a local model needs all the video memory: LaMa in the browser would push it out.
  const lamaOff = !big && s.lamaMode === 'browser' ? { lamaMode: 'off' as const } : {};
  switch (profile) {
    case 'local':
      return {
        ...common,
        // The fast mode shrinks the picture and drops the model review: accuracy first.
        fastLocal: false,
        quality: vram >= 8 ? 'balanced' : 'fast',
        // Reading, then translating the text with the series context: better meaning and endings.
        twoStepTranslation: vram >= 12,
        // The model's review with fixes changes good lines as often as bad ones on a small local model:
        // the checks without a model stay (untranslated text, numbers, glossary, names).
        qaMode: 'rules',
        qaBatch: true,
        gpuKeepAliveMin: 15,
        ...(big ? {} : { detectorMode: 'off' as const, ...lamaOff }),
      };
    case 'cloud':
      // An online model: the whole picture at full size, a separate translation step and the review
      // with fixes; no video memory to save.
      return { ...common, quality: 'best', twoStepTranslation: true, qaMode: 'fix', qaBatch: true };
    case 'ocr-browser':
      // The browser's translator takes no context and no review: the checks without a model only.
      return { ...common, quality: 'balanced', qaMode: 'rules', detectorMode: 'browser' };
    case 'ocr-local':
      return { ...common, fastLocal: false, quality: 'balanced', twoStepTranslation: vram >= 12, qaMode: 'rules', qaBatch: true, gpuKeepAliveMin: 15, detectorMode: 'browser', ...lamaOff };
    case 'ocr-cloud':
      return { ...common, quality: 'balanced', twoStepTranslation: true, qaMode: 'fix', qaBatch: true, detectorMode: 'browser' };
    case 'engine':
      return common;
  }
}

const label: Partial<Record<keyof AppSettings, (v: unknown) => string>> = {
  fastLocal: () => tr('Ускорение Ollama: выкл'),
  quality: (v) => tr('Качество: {0}', v === 'balanced' ? tr('Баланс') : v === 'fast' ? tr('Быстро') : tr('Максимум')),
  twoStepTranslation: (v) => (v ? tr('Перевод отдельным шагом: вкл') : tr('Перевод отдельным шагом: выкл')),
  qaMode: (v) => (v === 'fix' ? tr('Проверка перевода: исправлять') : v === 'rules' ? tr('Проверка перевода: только без модели') : tr('Проверка перевода: выкл')),
  qaBatch: () => tr('Проверять короткие страницы вместе: вкл'),
  translateSfx: () => tr('Переводить звуки: вкл'),
  sfxStyle: () => tr('Звуки: перевод'),
  stitchStrips: () => tr('Склеивать картинки ленты: вкл'),
  bubblesOnly: () => tr('Только баблы: выкл'),
  onlySourceLang: (v) => (v ? tr('Только текст на исходном языке: вкл') : tr('Только текст на исходном языке: выкл')),
  skipEmptyPages: () => tr('Пропускать картинки без текста: вкл'),
  selfCheck: () => tr('Самопроверка: вкл'),
  gpuKeepAliveMin: () => tr('Держать модель в памяти: 15 мин'),
  phrasebook: () => tr('Разговорник: вкл'),
  detectorMode: (v) => (v === 'browser' ? tr('Точный поиск текста: вкл') : tr('Точный поиск текста: выкл (видеопамять нужна модели)')),
  lamaMode: () => tr('LaMa в браузере: выкл (видеопамять нужна модели)'),
};

/**
 * The settings that give the best translation the model in use can make in reasonable time (for a
 * local model: for the video memory set in the settings). Only the way of translating changes:
 * models, keys, languages, glossary and the user's look stay as they are. `onlyModel` keeps to the
 * settings that depend on the model (what a model switch changes by itself). Returns only what
 * differs from the current settings, with a line per change for the user.
 */
export function optimalSettings(s: AppSettings, opts: { profile?: OptimalProfile; onlyModel?: boolean } = {}): { patch: Partial<AppSettings>; changes: string[]; profile: OptimalProfile } {
  const profile = opts.profile ?? optimalProfile(s);
  const want = wanted(s, profile);
  const patch: Partial<AppSettings> = {};
  const changes: string[] = [];
  const cur = s as unknown as Record<string, unknown>;
  const defaults: Partial<Record<keyof AppSettings, unknown>> = { twoStepTranslation: !(s.fastLocal || s.quality === 'fast'), qaMode: qaModeOf(s), stitchStrips: true, skipEmptyPages: true, selfCheck: true, detectorMode: 'off', lamaMode: 'off', gpuKeepAliveMin: 5 };
  for (const [k, v] of Object.entries(want) as [keyof AppSettings, unknown][]) {
    if (v === undefined) continue;
    if (opts.onlyModel && !(MODEL_KEYS as readonly string[]).includes(k)) continue;
    const now = cur[k] ?? defaults[k];
    const same = k === 'phrasebook' ? !!s.phrasebook?.enabled : now === v || (v === false && now === undefined);
    if (same) continue;
    (patch as Record<string, unknown>)[k] = v;
    changes.push(label[k]?.(v) ?? String(k));
  }
  return { patch, changes, profile };
}

/** «Оптимально для локальной модели» (the settings for a model on this computer). */
export function optimalLocalSettings(s: AppSettings): { patch: Partial<AppSettings>; changes: string[] } {
  const { patch, changes } = optimalSettings(s, { profile: 'local' });
  return { patch, changes };
}

/** What a change of model is seen by: the mode, the servers and their models. */
export function modelKey(s: AppSettings): string {
  const v = providerById(s, s.visionProviderId);
  const t = providerById(s, s.translationProviderId);
  return [s.pipeline, s.readMode ?? 'vision', v?.id ?? '', v?.model ?? '', t?.id ?? '', t?.model ?? ''].join('|');
}

/**
 * A settings change that switches the model (the mode, the model server or its model) brings the
 * settings that suit the new model with it, unless the user turned that off. What the change sets
 * itself (a preset, a choice made in the same click) stays as given. Null: nothing to add.
 */
export function autoOptimal(prev: AppSettings, patch: Partial<AppSettings>): { patch: Partial<AppSettings>; changes: string[]; before: Partial<AppSettings> } | null {
  const next = { ...prev, ...patch };
  if (next.autoOptimal === false || modelKey(prev) === modelKey(next)) return null;
  const opt = optimalSettings(next, { onlyModel: true });
  const add: Partial<AppSettings> = {};
  const before: Partial<AppSettings> = {};
  const changes: string[] = [];
  for (const k of Object.keys(opt.patch) as (keyof AppSettings)[]) {
    if (k in patch) continue;
    (add as Record<string, unknown>)[k] = opt.patch[k];
    (before as Record<string, unknown>)[k] = prev[k];
    changes.push(label[k]?.(opt.patch[k]) ?? String(k));
  }
  return changes.length ? { patch: add, changes, before } : null;
}

/** The button makes sense when the pictures are read by a model on this computer. */
export function readsLocally(s: AppSettings): boolean {
  const v = providerById(s, s.visionProviderId);
  return s.pipeline !== 'engine' && !!v && isLocalProvider(v);
}
