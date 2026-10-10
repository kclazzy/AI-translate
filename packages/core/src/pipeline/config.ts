import { familyFor, setCatalog } from '../llm/catalog';
import type { PrivacyMode } from '../llm/privacy';
import type { ProviderConfig } from '../llm/types';
import type { AppSettings, EngineOptions, PipelineMode, Quality } from '../settings';
import { activeProfile, providerById } from '../settings';
import { isLocalProvider } from '../llm/privacy';
import type { GlossaryEntry } from '../translate/glossary';
import type { PromptProfile, SfxStyle } from '../translate/profiles';
import { sha256Hex } from '../util/bytes';
import type { QaMode } from '../translate/qa';
import type { PhrasebookSettings } from '../translate/phrasebook/match';

/** Everything that changes the output of a page; also the cache key ingredient. */
export interface PipelineConfig {
  mode: PipelineMode;
  privacy: PrivacyMode;
  sourceLang: string;
  targetLang: string;
  quality: Quality;
  profile: PromptProfile;
  glossary: GlossaryEntry[];
  translateSfx: boolean;
  sfxStyle: SfxStyle;
  vision: ProviderConfig | null;
  translator: ProviderConfig | null;
  engine?: { url: string; token: string; options: EngineOptions };
  /** Translation check after translating (see translate/qa.ts). */
  qa?: QaMode;
  /**
   * Read the picture first, then translate the whole page in a separate text request (with the
   * speakers, their gender and the story so far): more accurate wording and word endings.
   */
  twoStep?: boolean;
  /** Translate only text in speech bubbles and caption boxes (leave sound effects and signs). */
  bubblesOnly?: boolean;
  /** Translate only text in the chosen source language (leave text in other languages as it is). */
  onlySourceLang?: boolean;
  /** How far past the letters to erase, px. */
  inpaintExpand?: number;
  /** Redo text over artwork with LaMa in the local engine (when it runs). */
  lamaEngine?: boolean;
  /** Where LaMa runs: the local engine, or the browser (needs `inpaint` in the pipeline deps). */
  lama?: 'engine' | 'browser';
  /** Neural text/bubble detector in this browser (needs `detect` in the pipeline deps). */
  detector?: boolean;
  /** Разговорник: hints for recurring expressions (see translate/phrasebook). */
  phrasebook?: PhrasebookSettings;
  /** Pictures without lettering (local check) are not sent to the model; default on. */
  skipEmptyPages?: boolean;
  /** Short pages are reviewed in batches, tiny ones by rules only (see settings.qaBatch). */
  qaBatch?: boolean;
  /** Self-check after typesetting (see pipeline/selfcheck.ts); default on. */
  selfCheck?: boolean;
}

/** Longest side of the picture sent to the vision model, by quality. */
export const MAX_SIDE: Record<Quality, number> = { fast: 1280, balanced: 1568, best: 2048 };

/**
 * Ollama context window for one model, decided once from the settings and never changed between
 * requests (a different num_ctx makes Ollama load the model again). It must hold the picture, the
 * prompt and the answer: picture tokens (28 px patches of a page-shaped picture at the longest
 * side) + the prompt (instructions, glossary, series context, ≈ 2500) + a dense page's answer
 * (≈ 3500; a longer answer only gets more output room, see readView), rounded up to 2 K. Never
 * less than the video-memory default, and at most what the card can hold.
 */
export function contextFor(opts: { vramGb: number; quality: Quality; maxSide?: number; glossary?: number; image: boolean }): number {
  const base = opts.vramGb >= 16 ? 16384 : 8192;
  const cap = opts.vramGb >= 24 ? 32768 : opts.vramGb >= 16 ? 24576 : opts.vramGb >= 12 ? 16384 : 12288;
  const side = Math.min(MAX_SIDE[opts.quality], opts.maxSide ?? Infinity);
  const imageTokens = opts.image ? Math.ceil((side * (side / 1.4)) / (28 * 28)) : 0;
  const prompt = 2500 + Math.min(150, opts.glossary ?? 0) * 20;
  const need = Math.ceil((imageTokens + prompt + 3500) / 2048) * 2048;
  return Math.max(base, Math.min(cap, need));
}

function withKeepAlive(p: ProviderConfig | undefined, s: AppSettings, quality: Quality, visionModel: string | undefined): ProviderConfig | null {
  // Bigger context only with plenty of video memory: on 8 GB it would push the model partly into RAM.
  if (!p) return null;
  // Settings of the model's family from models.json (or the built-in rules).
  const fam = familyFor(p.model);
  // One window per model: the model that reads pictures gets room for one in every request (also
  // its text requests: translation, review), so the same model never gets two sizes.
  const glossary = s.glossary.filter((g) => g.enabled).length;
  const numCtx = fam?.numCtx ?? contextFor({ vramGb: s.gpuVramGb ?? 12, quality, maxSide: fam?.maxSide, glossary, image: p.model === visionModel });
  return { ...p, noThinking: p.noThinking ?? (isLocalProvider(p) ? fam?.noThinking : undefined), keepAliveMin: s.gpuKeepAliveMin ?? DEFAULT_KEEP_ALIVE_MIN, numCtx, fixedCtx: true };
}

/** Fast mode applies when the picture is read by a model on this computer / network. */
export function fastLocalActive(s: AppSettings): boolean {
  const v = providerById(s, s.visionProviderId);
  return !!s.fastLocal && s.pipeline !== 'engine' && !!v && isLocalProvider(v);
}

/** How long a local model stays in video memory after the last page, unless the user changes it. */
export const DEFAULT_KEEP_ALIVE_MIN = 5;

export function pipelineConfigFromSettings(s: AppSettings, seriesKey?: string): PipelineConfig {
  setCatalog(s.modelCatalog);
  const quality: Quality = fastLocalActive(s) ? 'fast' : s.quality;
  const visionModel = s.pipeline === 'engine' ? undefined : providerById(s, s.visionProviderId)?.model;
  return {
    mode: s.pipeline,
    privacy: s.privacy,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    quality,
    profile: activeProfile(s, seriesKey),
    glossary: s.glossary,
    translateSfx: s.translateSfx,
    sfxStyle: s.sfxStyle,
    vision: withKeepAlive(providerById(s, s.visionProviderId), s, quality, visionModel),
    translator: withKeepAlive(providerById(s, s.translationProviderId), s, quality, visionModel),
    engine: s.engine,
    qa: fastLocalActive(s) && (s.qaMode ?? 'fix') !== 'off' ? 'rules' : s.qaMode ?? 'fix',
    twoStep: s.twoStepTranslation ?? !(fastLocalActive(s) || s.quality === 'fast'),
    bubblesOnly: s.bubblesOnly || undefined,
    onlySourceLang: (s.onlySourceLang && s.sourceLang !== 'auto') || undefined,
    inpaintExpand: s.inpaintExpand,
    phrasebook: s.phrasebook,
    lama: (s.lamaMode ?? (s.lamaEngine ? 'engine' : 'off')) === 'off' ? undefined : (s.lamaMode ?? 'engine') as 'engine' | 'browser',
    detector: s.detectorMode === 'browser' || undefined,
    skipEmptyPages: s.skipEmptyPages ?? true,
    qaBatch: s.qaBatch || undefined,
    selfCheck: s.selfCheck ?? true,
  };
}

/** Stable hash of the output-affecting settings (API keys excluded). */
export async function pipelineHash(c: PipelineConfig): Promise<string> {
  const strip = (p: ProviderConfig | null) => (p ? { kind: p.kind, baseUrl: p.baseUrl, model: p.model, temperature: p.temperature, noThinking: p.noThinking } : null);
  const payload = {
    v: 1,
    mode: c.mode,
    // Privacy decides whether the reviewer may run, so it changes the result.
    privacy: c.privacy,
    src: c.sourceLang,
    dst: c.targetLang,
    q: c.quality,
    profile: { ...c.profile, id: undefined, name: undefined },
    glossary: c.glossary.filter((g) => g.enabled).map((g) => [g.source, g.target, g.matchMode, g.caseSensitive, g.forbidden, g.note ?? '']),
    sfx: [c.translateSfx, c.sfxStyle],
    vision: strip(c.vision),
    translator: strip(c.translator),
    engine: c.mode === 'engine' ? c.engine?.options : undefined,
    qa: c.qa ?? 'off',
    two: c.twoStep ? 1 : undefined,
    bo: c.bubblesOnly ? 1 : undefined,
    osl: c.onlySourceLang ? 1 : undefined,
    ie: c.inpaintExpand,
    lama: c.lama ?? (c.lamaEngine ? 'engine' : undefined),
    pb: c.phrasebook ? await phrasebookHash(c.phrasebook) : undefined,
    // Only the non-default values: results made before these settings existed keep their keys.
    nse: c.skipEmptyPages === false ? 1 : undefined,
    qb: c.qaBatch ? 1 : undefined,
    det: c.detector ? 1 : undefined,
    nsc: c.selfCheck === false ? 1 : undefined,
  };
  return (await sha256Hex(JSON.stringify(payload))).slice(0, 24);
}

/** Short hash of the phrasebook settings: another result only when they change. */
async function phrasebookHash(p: PhrasebookSettings): Promise<string> {
  if (!p.enabled) return 'off';
  const payload = [[...p.genres].sort(), [...p.disabled].sort(), p.user.map((u) => [u.source, u.src, u.variants.map((v) => [v.text, v.when]), u.note ?? ''])];
  return (await sha256Hex(JSON.stringify(payload))).slice(0, 8);
}
