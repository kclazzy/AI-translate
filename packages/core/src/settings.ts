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

export interface AppSettings {
  version: 1;
  uiLang: 'ru' | 'en';
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
}

export function defaultSettings(): AppSettings {
  const lmstudio = configFromPreset('lmstudio', 'lmstudio');
  const ollama = configFromPreset('ollama', 'ollama');
  return {
    version: 1,
    uiLang: 'ru',
    theme: 'system',
    uiMode: 'reader',
    pipeline: 'standalone',
    privacy: 'hybrid',
    engine: { url: 'http://127.0.0.1:8765', token: '', options: { detector: 'auto', ocr: 'auto', inpainter: 'auto' } },
    providers: [ollama, lmstudio],
    visionProviderId: 'ollama',
    translationProviderId: null,
    sourceLang: 'auto',
    targetLang: 'ru',
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
