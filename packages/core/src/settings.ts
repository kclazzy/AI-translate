import { systemLanguage } from './i18n';
import { LANGUAGES } from './languages';
import type { ModelCheck } from './llm/selftest';
import type { PrivacyMode } from './llm/privacy';
import type { ProviderConfig } from './llm/types';
import { configFromPreset } from './llm/presets';
import type { GlossaryEntry } from './translate/glossary';import { DEFAULT_PROFILES, type PromptProfile, type SfxStyle } from './translate/profiles';

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
  /** Fonts by text type; `scale` makes all automatic sizes bigger or smaller (1 = as fits). */
  fonts: { dialogue: string; narration: string; sfx: string; scale?: number };
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
  /** Save every newly translated picture into the folder the user chose (off unless chosen). */
  autoSave?: boolean;
  /**
   * Where: a folder picked by the user (its handle is kept in the database, `autosave-dir`; this is
   * its name for display) or 'downloads' = Downloads/AI Translate (browsers without folder picking).
   */
  autoSaveDir?: string;
  /** Named sets of model settings to switch between quickly. */
  presets?: ModelPreset[];
  /** Where the editor shows the other pages of a chapter. */
  editorPageList?: 'bottom' | 'right';
  /** «Сверка с другими переводчиками» (keys are in the secret store as checker:<id>). */
  crossCheck?: import('./translate/crosscheck').CrossCheckSettings;
  /** How far past the letters the original text is erased, px (default 3). */
  inpaintExpand?: number;
  /** Text over artwork: redo the background with LaMa in the local engine when it is running. */
  lamaEngine?: boolean;
  /** Text over artwork redrawn by LaMa: in the local engine or right in the browser (model downloaded once). */
  lamaMode?: 'off' | 'engine' | 'browser';
  /** The user said «Не предлагать» to the LaMa offer shown after a page with text over artwork. */
  lamaOfferDismissed?: boolean;
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

// ---- validation of stored / imported settings ---------------------------------------------------
// Settings come from storage written by older versions and from settings files other people share,
// so every field is checked: a wrong type falls back to the default instead of breaking the UI.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const strOr = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const stringMap = (v: unknown): Record<string, string> => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : {});

/** Copy only optional fields of the right type. */
function pickTyped(src: Obj, out: Obj, kinds: Record<string, 'string' | 'number' | 'boolean' | 'object'>): void {
  for (const [k, kind] of Object.entries(kinds)) {
    const v = src[k];
    if (v === undefined) continue;
    if (kind === 'number' ? isNum(v) : kind === 'object' ? isObj(v) : typeof v === kind) out[k] = v;
  }
}

function cleanProvider(v: unknown): ProviderConfig | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || typeof v.baseUrl !== 'string') return null;
  const out: Obj = {
    id: v.id,
    label: strOr(v.label, v.id),
    kind: oneOf(v.kind, ['openai-compatible', 'anthropic'] as const, 'openai-compatible'),
    preset: strOr(v.preset, 'custom'),
    baseUrl: v.baseUrl,
    model: strOr(v.model, ''),
    vision: v.vision === true,
    jsonMode: oneOf(v.jsonMode, ['json_object', 'none'] as const, 'json_object'),
  };
  pickTyped(v, out, { apiKey: 'string', priceInput: 'number', priceOutput: 'number', timeoutMs: 'number', maxOutputTokens: 'number', temperature: 'number', noThinking: 'boolean', keepAliveMin: 'number', numCtx: 'number' });
  return out as unknown as ProviderConfig;
}

function cleanGlossaryEntry(v: unknown, i: number): GlossaryEntry | null {
  if (!isObj(v) || typeof v.source !== 'string' || typeof v.target !== 'string') return null;
  const out: GlossaryEntry = {
    id: typeof v.id === 'string' && v.id ? v.id : `g${i}`,
    source: v.source,
    target: v.target,
    matchMode: oneOf(v.matchMode, ['exact', 'regex'] as const, 'exact'),
    caseSensitive: v.caseSensitive === true,
    forbidden: strings(v.forbidden),
    enabled: v.enabled !== false,
  };
  if (typeof v.note === 'string') out.note = v.note;
  return out;
}

function cleanProfile(v: unknown): PromptProfile | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null;
  const base = DEFAULT_PROFILES[0];
  return {
    id: v.id,
    name: strOr(v.name, v.id),
    customPrompt: strOr(v.customPrompt, ''),
    honorifics: oneOf(v.honorifics, ['keep', 'adapt', 'drop'] as const, base.honorifics),
    names: oneOf(v.names, ['transliterate', 'keep-original', 'adapt'] as const, base.names),
    sfx: oneOf(v.sfx, ['translate', 'keep'] as const, base.sfx),
    sfxStyle: oneOf(v.sfxStyle, SFX_STYLES, base.sfxStyle),
    tone: strOr(v.tone, ''),
  };
}

const SFX_STYLES = ['original', 'translated', 'small', 'large', 'artistic'] as const;
const CHECKER_KINDS = ['deepl', 'google', 'yandex', 'libre', 'llm'] as const;

function cleanCrossCheck(v: unknown): AppSettings['crossCheck'] {
  if (!isObj(v)) return undefined;
  const checkers = (Array.isArray(v.checkers) ? v.checkers : []).flatMap((c) => {
    if (!isObj(c) || typeof c.id !== 'string' || !c.id || !CHECKER_KINDS.includes(c.kind as never)) return [];
    const out: Obj = { id: c.id, kind: c.kind, enabled: c.enabled !== false };
    pickTyped(c, out, { url: 'string', folderId: 'string', providerId: 'string' });
    return [out as unknown as NonNullable<AppSettings['crossCheck']>['checkers'][number]];
  });
  return { enabled: v.enabled === true, checkers, judge: strOr(v.judge, 'main'), mode: oneOf(v.mode, ['report', 'fix'] as const, 'report') };
}

function cleanPreset(v: unknown): ModelPreset | null {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  const out: Obj = {
    id: v.id,
    name: v.name,
    pipeline: oneOf(v.pipeline, ['standalone', 'engine'] as const, 'standalone'),
    visionProviderId: strOrNull(v.visionProviderId),
    translationProviderId: strOrNull(v.translationProviderId),
    quality: oneOf(v.quality, ['fast', 'balanced', 'best'] as const, 'balanced'),
    models: stringMap(v.models),
  };
  pickTyped(v, out, { twoStepTranslation: 'boolean', qaMode: 'string' });
  return out as unknown as ModelPreset;
}

const ENGINE_DETECTORS = ['auto', 'classic', 'ctd', 'vision'] as const;
const ENGINE_OCR = ['auto', 'vision', 'manga-ocr', 'paddle'] as const;
const ENGINE_INPAINTERS = ['auto', 'fill', 'telea', 'lama'] as const;

/** Fill gaps after upgrades so older stored settings keep working; drop anything of the wrong shape. */
export function migrateSettings(raw: unknown): AppSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  const r = raw;
  const engine = isObj(r.engine) ? r.engine : {};
  const options = isObj(engine.options) ? engine.options : {};
  const fonts = isObj(r.fonts) ? r.fonts : {};
  const auto = isObj(r.autoTranslate) ? r.autoTranslate : {};
  const providers = Array.isArray(r.providers) ? r.providers.map(cleanProvider).filter((p): p is ProviderConfig => !!p) : d.providers;
  const profiles = Array.isArray(r.profiles) ? r.profiles.map(cleanProfile).filter((p): p is PromptProfile => !!p) : [];
  const out: Obj = {
    ...d,
    theme: oneOf(r.theme, ['system', 'light', 'dark'] as const, d.theme),
    uiMode: oneOf(r.uiMode, ['reader', 'advanced', 'scanlator'] as const, d.uiMode),
    pipeline: oneOf(r.pipeline, ['standalone', 'engine'] as const, d.pipeline),
    privacy: oneOf(r.privacy, ['local', 'hybrid', 'cloud'] as const, d.privacy),
    engine: {
      url: strOr(engine.url, d.engine.url),
      token: strOr(engine.token, ''),
      options: {
        detector: oneOf(options.detector, ENGINE_DETECTORS, 'auto'),
        ocr: oneOf(options.ocr, ENGINE_OCR, 'auto'),
        inpainter: oneOf(options.inpainter, ENGINE_INPAINTERS, 'auto'),
      },
    },
    providers,
    visionProviderId: r.visionProviderId === undefined ? d.visionProviderId : strOrNull(r.visionProviderId),
    translationProviderId: strOrNull(r.translationProviderId),
    sourceLang: strOr(r.sourceLang, d.sourceLang),
    targetLang: strOr(r.targetLang, d.targetLang),
    quality: oneOf(r.quality, ['fast', 'balanced', 'best'] as const, d.quality),
    translateSfx: typeof r.translateSfx === 'boolean' ? r.translateSfx : d.translateSfx,
    sfxStyle: oneOf(r.sfxStyle, SFX_STYLES, d.sfxStyle),
    profiles: profiles.length ? profiles : d.profiles,
    activeProfileId: strOr(r.activeProfileId, d.activeProfileId),
    seriesProfiles: stringMap(r.seriesProfiles),
    glossary: Array.isArray(r.glossary) ? r.glossary.map(cleanGlossaryEntry).filter((g): g is GlossaryEntry => !!g) : [],
    concurrency: isNum(r.concurrency) ? Math.max(1, Math.min(16, Math.round(r.concurrency))) : d.concurrency,
    autoTranslate: { enabled: auto.enabled === true, sites: strings(auto.sites) },
    minImageSize: isNum(r.minImageSize) ? r.minImageSize : d.minImageSize,
    saveHistory: typeof r.saveHistory === 'boolean' ? r.saveHistory : d.saveHistory,
    debug: r.debug === true,
    fonts: { dialogue: strOr(fonts.dialogue, ''), narration: strOr(fonts.narration, ''), sfx: strOr(fonts.sfx, ''), ...(isNum(fonts.scale) ? { scale: fonts.scale } : {}) },
    cacheDays: isNum(r.cacheDays) ? r.cacheDays : d.cacheDays,
    version: 1,
  };
  pickTyped(r, out, {
    uiLang: 'string',
    onboarded: 'boolean',
    gpuVramGb: 'number',
    modelChecks: 'object',
    ollamaModelsDir: 'string',
    enabled: 'boolean',
    gpuKeepAliveMin: 'number',
    historyDays: 'number',
    qaMode: 'string',
    fastLocal: 'boolean',
    exportPageLength: 'string',
    twoStepTranslation: 'boolean',
    stitchStrips: 'boolean',
    bubblesOnly: 'boolean',
    onlySourceLang: 'boolean',
    autoApplyCached: 'boolean',
    autoSave: 'boolean',
    autoSaveDir: 'string',
    editorPageList: 'string',
    inpaintExpand: 'number',
    lamaEngine: 'boolean',
    lamaMode: 'string',
    lamaOfferDismissed: 'boolean',
    modelCatalog: 'object',
    modelCatalogCheckedAt: 'string',
    interfaceLang: 'string',
  });
  if (out.qaMode !== undefined && !['off', 'rules', 'report', 'fix'].includes(out.qaMode as string)) delete out.qaMode;
  if (out.exportPageLength !== undefined && !['normal', 'long', 'whole'].includes(out.exportPageLength as string)) delete out.exportPageLength;
  if (out.editorPageList !== undefined && !['bottom', 'right'].includes(out.editorPageList as string)) delete out.editorPageList;
  if (out.lamaMode !== undefined && !['off', 'engine', 'browser'].includes(out.lamaMode as string)) delete out.lamaMode;
  if (r.crossCheck !== undefined) {
    const cc = cleanCrossCheck(r.crossCheck);
    if (cc) out.crossCheck = cc;
  }
  if (Array.isArray(r.presets)) out.presets = r.presets.map(cleanPreset).filter((p): p is ModelPreset => !!p);
  return out as unknown as AppSettings;
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
