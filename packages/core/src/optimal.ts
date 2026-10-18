import type { AppSettings } from './settings';
import { providerById } from './settings';
import { isLocalProvider } from './llm/privacy';
import { tr } from './i18n';
import { qaModeOf } from './pipeline/config';

/**
 * «Оптимально для локальной модели»: the settings that give the best translation a model on this
 * computer can make in reasonable time, for the video memory set in the settings. Only the way of
 * translating changes: models, keys, languages, glossary and the user's look stay as they are.
 * Returns only what differs from the current settings, with a line per change for the user.
 */
export function optimalLocalSettings(s: AppSettings): { patch: Partial<AppSettings>; changes: string[] } {
  const vram = s.gpuVramGb ?? 12;
  const big = vram >= 16;
  const want: Partial<AppSettings> = {
    // The fast mode shrinks the picture and drops the model review: accuracy first.
    fastLocal: false,
    quality: vram >= 8 ? 'balanced' : 'fast',
    // Reading, then translating the text with the series context: better meaning and endings.
    twoStepTranslation: vram >= 12,
    // The model's review with fixes changes good lines as often as bad ones on a small local model:
    // the checks without a model stay (untranslated text, numbers, glossary, names).
    qaMode: 'rules',
    qaBatch: true,
    translateSfx: true,
    sfxStyle: 'translated',
    stitchStrips: true,
    bubblesOnly: false,
    onlySourceLang: s.sourceLang !== 'auto',
    skipEmptyPages: true,
    selfCheck: true,
    gpuKeepAliveMin: 15,
    phrasebook: s.phrasebook ? { ...s.phrasebook, enabled: true } : s.phrasebook,
    // Up to 12 GB the model needs all the video memory: the neural nets in the browser would push it out.
    ...(big ? {} : { detectorMode: 'off' as const, ...(s.lamaMode === 'browser' ? { lamaMode: 'off' as const } : {}) }),
  };
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
    detectorMode: () => tr('Точный поиск текста: выкл (видеопамять нужна модели)'),
    lamaMode: () => tr('LaMa в браузере: выкл (видеопамять нужна модели)'),
  };
  const patch: Partial<AppSettings> = {};
  const changes: string[] = [];
  const cur = s as unknown as Record<string, unknown>;
  const defaults: Partial<Record<keyof AppSettings, unknown>> = { twoStepTranslation: !(s.fastLocal || s.quality === 'fast'), qaMode: qaModeOf(s), stitchStrips: true, skipEmptyPages: true, selfCheck: true, detectorMode: 'off', lamaMode: 'off', gpuKeepAliveMin: 5 };
  for (const [k, v] of Object.entries(want) as [keyof AppSettings, unknown][]) {
    if (v === undefined) continue;
    const now = cur[k] ?? defaults[k];
    const same = k === 'phrasebook' ? !!s.phrasebook?.enabled : now === v || (v === false && now === undefined);
    if (same) continue;
    (patch as Record<string, unknown>)[k] = v;
    changes.push(label[k]?.(v) ?? String(k));
  }
  return { patch, changes };
}

/** The button makes sense when the pictures are read by a model on this computer. */
export function readsLocally(s: AppSettings): boolean {
  const v = providerById(s, s.visionProviderId);
  return s.pipeline !== 'engine' && !!v && isLocalProvider(v);
}
