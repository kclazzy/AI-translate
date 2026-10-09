import { systemLanguage } from './i18n';
import { LANGUAGES } from './languages';
import type { ModelCheck } from './llm/selftest';
import type { PrivacyMode } from './llm/privacy';
import type { ProviderConfig } from './llm/types';
import { configFromPreset } from './llm/presets';
import type { GlossaryEntry } from './translate/glossary';
import { DEFAULT_PROFILES, type PromptProfile, type SfxStyle } from './translate/profiles';

export type PipelineMode = 'standalone' | 'engine';
export type Quality = 'fast' | 'balanced' | 'best';
export type UiMode = 'reader' | 'advanced' | 'scanlator';

export interface EngineOptions {
  detector: 'auto' | 'classic' | 'ctd' | 'vision';
  ocr: 'auto' | 'vision' | 'manga-ocr' | 'paddle';
  inpainter: 'auto' | 'fill' | 'telea' | 'lama';
}

export interface ModelPreset {
  id: string;
  name: string;
  pipeline: AppSettings['pipeline'];
  visionProviderId: string | null;
  translationProviderId: string | null;
  quality: AppSettings['quality'];
  twoStepTranslation?: boolean;
  qaMode?: AppSettings['qaMode'];
  /** Models of the providers at the time the preset was saved. */
  models: Record<string, string>;
}

/** Apply a preset: the providers keep their keys and addresses, only the choice and models change. */
export function applyPreset(s: AppSettings, p: ModelPreset): Partial<AppSettings> {
  return {
    pipeline: p.pipeline,
    visionProviderId: s.providers.some((x) => x.id === p.visionProviderId) ? p.visionProviderId : s.visionProviderId,
    translationProviderId: p.translationProviderId && s.providers.some((x) => x.id === p.translationProviderId) ? p.translationProviderId : null,
    quality: p.quality,
    twoStepTranslation: p.twoStepTranslation,
    qaMode: p.qaMode,
    providers: s.providers.map((x) => (p.models[x.id] ? { ...x, model: p.models[x.id] } : x)),
  };
}

export function presetFrom(s: AppSettings, name: string): ModelPreset {
  const ids = [s.visionProviderId, s.translationProviderId].filter(Boolean) as string[];
  return {
    id: `p${Date.now().toString(36)}`,
    name,
    pipeline: s.pipeline,
    visionProviderId: s.visionProviderId,
    translationProviderId: s.translationProviderId,
    quality: s.quality,
    twoStepTranslation: s.twoStepTranslation,
    qaMode: s.qaMode,
    models: Object.fromEntries(s.providers.filter((p) => ids.includes(p.id)).map((p) => [p.id, p.model])),
  };
}

export interface AppSettings {
  version: 1;
  /** @deprecated never used; the interface language is `interfaceLang`. */
  uiLang?: 'ru' | 'en';
  theme: 'system' | 'light' | 'dark';
  uiMode: UiMode;
  pipeline: PipelineMode;
  privacy: PrivacyMode;
  engine: { url: string; token: string; options: EngineOptions };
  /** apiKey is kept out of this object when persisted; see secret store. */
  providers: ProviderConfig[];
  /** Provider that reads the image (must support vision in standalone mode). */
  visionProviderId: string | null;
  /** Separate text translator; null = the vision provider translates in the same call. */
  translationProviderId: string | null;
  sourceLang: string;
  targetLang: string;
  quality: Quality;
  translateSfx: boolean;
  sfxStyle: SfxStyle;
  profiles: PromptProfile[];
  activeProfileId: string;
  /** Per-site/series profile override: hostname or series id → profile id. */
  seriesProfiles: Record<string, string>;
  glossary: GlossaryEntry[];
  concurrency: number;
  autoTranslate: { enabled: boolean; sites: string[] };
  minImageSize: number;
  saveHistory: boolean;
  debug: boolean;
  fonts: { dialogue: string; narration: string; sfx: string };
  cacheDays: number;
  /** First-run setup finished (mobile app shows a setup screen until then). */
  onboarded?: boolean;
  /** Video memory the user picked (GB); decides the recommended local model. */
  gpuVramGb?: number;
  /** Last "Проверить модель" result per server + model (see modelCheckKey). */
  modelChecks?: Record<string, ModelCheck>;
  /** Folder the user wants Ollama to keep models in (applied via Ollama settings or OLLAMA_MODELS). */
  ollamaModelsDir?: string;
  /** Master switch: when false the extension does nothing and frees the model's video memory. */
  enabled?: boolean;
  /** Minutes Ollama keeps the model in video memory after the last page (0 = unload right away). */
  gpuKeepAliveMin?: number;
  /** Days to keep the translation history (the list in «История»); default 30. */
  historyDays?: number;
  /** Translation check: off, report problems, or fix real errors automatically (default). */
  qaMode?: import('./translate/qa').QaMode;
  /** Fast mode for local models: smaller picture for the model, translation check without a model call. */
  fastLocal?: boolean;
  /** Page length when a long strip is saved as PDF/CBZ/EPUB: normal ≈ a book page, long ≈ 3×, whole = as long as possible. */
  exportPageLength?: 'normal' | 'long' | 'whole';
  /** Translate in a separate step after reading the picture (default: on, except fast mode). */
  twoStepTranslation?: boolean;
  /** Translate neighbouring pictures of one webtoon strip together (default on). */
  stitchStrips?: boolean;
  /** «Только баблы»: leave sound effects and signs untranslated. */
  bubblesOnly?: boolean;
  /** «Только выбранный язык»: leave text in other languages untranslated (needs a source language). */
  onlySourceLang?: boolean;
  /** Show translations already in the cache as soon as a page with those pictures opens (default on). */
  autoApplyCached?: boolean;
  /** Save every newly translated picture to Downloads/AI Translate/<site>/ (off unless chosen). */
  autoSave?: boolean;
  /** Named sets of model settings to switch between quickly. */
  presets?: ModelPreset[];
  /** Where the editor shows the other pages of a chapter. */
  editorPageList?: 'bottom' | 'right';
  /** How far past the letters the original text is erased, px (default 3). */
  inpaintExpand?: number;
  /** Text over artwork: redo the background with LaMa in the local engine when it is running. */
  lamaEngine?: boolean;
  /** models.json fetched from the repository (recommended local models, family settings). */
  modelCatalog?: import('./llm/catalog').ModelCatalog;
  modelCatalogCheckedAt?: string;
  /** Interface language: "auto" (default) follows the browser / Windows language. */
  interfaceLang?: string;
}

export function defaultSettings(): AppSettings {
  const lmstudio = configFromPreset('lmstudio', 'lmstudio');
  const ollama = configFromPreset('ollama', 'ollama');
  return {
    version: 1,
    theme: 'system',
    uiMode: 'reader',
    pipeline: 'standalone',
    privacy: 'hybrid',
    engine: { url: 'http://127.0.0.1:8765', token: '', options: { detector: 'auto', ocr: 'auto', inpainter: 'auto' } },
    providers: [ollama, lmstudio],
    visionProviderId: 'ollama',
    translationProviderId: null,
    sourceLang: 'auto',
    // New users read in their own language: the browser / Windows language when we support it.
    targetLang: defaultTargetLang(),
    quality: 'balanced',
    translateSfx: true,
    sfxStyle: 'translated',
    profiles: DEFAULT_PROFILES.map((p) => ({ ...p })),
    activeProfileId: 'natural',
    seriesProfiles: {},
    glossary: [],
    concurrency: 2,
    autoTranslate: { enabled: false, sites: [] },
    minImageSize: 200,
    saveHistory: true,
    debug: false,
    fonts: { dialogue: '', narration: '', sfx: '' },
    cacheDays: 14,
  };
}

/** Fill gaps after upgrades so older stored settings keep working. */
export function migrateSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<AppSettings>;
  return {
    ...d,
    ...r,
    engine: { ...d.engine, ...(r.engine ?? {}), options: { ...d.engine.options, ...(r.engine?.options ?? {}) } },
    autoTranslate: { ...d.autoTranslate, ...(r.autoTranslate ?? {}) },
    fonts: { ...d.fonts, ...(r.fonts ?? {}) },
    profiles: r.profiles?.length ? r.profiles : d.profiles,
    providers: Array.isArray(r.providers) ? r.providers : d.providers,
    glossary: Array.isArray(r.glossary) ? r.glossary : [],
    seriesProfiles: r.seriesProfiles ?? {},
    version: 1,
  };
}

export function activeProfile(s: AppSettings, seriesKey?: string): PromptProfile {
  const id = (seriesKey && s.seriesProfiles[seriesKey]) || s.activeProfileId;
  return s.profiles.find((p) => p.id === id) ?? s.profiles[0] ?? DEFAULT_PROFILES[0];
}

export function providerById(s: AppSettings, id: string | null | undefined): ProviderConfig | undefined {
  return id ? s.providers.find((p) => p.id === id) : undefined;
}

/** Translation language for a new user: the system language if it is in the list, else Russian. */
export function defaultTargetLang(system = systemLanguage()): string {
  const full = system.replace('_', '-');
  const base = full.toLowerCase().split('-')[0];
  if (LANGUAGES.some((l) => l.code === full)) return full;
  if (base === 'zh') return /tw|hk|hant/i.test(full) ? (LANGUAGES.some((l) => l.code === 'zh-TW') ? 'zh-TW' : 'zh') : 'zh';
  return LANGUAGES.some((l) => l.code === base) ? base : 'ru';
}
