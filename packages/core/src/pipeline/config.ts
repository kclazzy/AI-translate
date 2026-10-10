import type { CheckerConfig } from '../translate/crosscheck';
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
  /** «Сверка»: other translators to compare with and the judge (keys filled in memory only). */
  crossCheck?: {
    checkers: (CheckerConfig & { apiKey?: string; provider?: ProviderConfig })[];
    judge: ProviderConfig | null;
    mode: 'report' | 'fix';
  };
}

function withKeepAlive(p: ProviderConfig | undefined, s: AppSettings): ProviderConfig | null {
  // Bigger context only with plenty of video memory: on 8 GB it would push the model partly into RAM.
  if (!p) return null;
  // Settings of the model's family from models.json (or the built-in rules).
  const fam = familyFor(p.model);
  return { ...p, noThinking: p.noThinking ?? (isLocalProvider(p) ? fam?.noThinking : undefined), keepAliveMin: s.gpuKeepAliveMin ?? DEFAULT_KEEP_ALIVE_MIN, numCtx: fam?.numCtx ?? ((s.gpuVramGb ?? 12) >= 16 ? 16384 : 8192) };
}

/** Fast mode applies when the picture is read by a model on this computer / network. */
export function fastLocalActive(s: AppSettings): boolean {
  const v = providerById(s, s.visionProviderId);
  return !!s.fastLocal && s.pipeline !== 'engine' && !!v && isLocalProvider(v);
}

/** How long a local model stays in video memory after the last page, unless the user changes it. */
export const DEFAULT_KEEP_ALIVE_MIN = 5;

function crossCheckConfig(s: AppSettings): PipelineConfig['crossCheck'] {
  const cc = s.crossCheck;
  if (!cc?.enabled) return undefined;
  const checkers = cc.checkers
    .filter((c) => c.enabled)
    .map((c) => ({ ...c, apiKey: (c as { apiKey?: string }).apiKey, provider: c.kind === 'llm' ? providerById(s, c.providerId) : undefined }))
    .filter((c) => c.kind !== 'llm' || c.provider);
  if (!checkers.length) return undefined;
  const judge = cc.judge === 'none' ? null : cc.judge === 'main' ? providerById(s, s.translationProviderId) ?? providerById(s, s.visionProviderId) ?? null : providerById(s, cc.judge) ?? null;
  return { checkers, judge, mode: cc.mode };
}

export function pipelineConfigFromSettings(s: AppSettings, seriesKey?: string): PipelineConfig {
  setCatalog(s.modelCatalog);
  return {
    mode: s.pipeline,
    privacy: s.privacy,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    quality: fastLocalActive(s) ? 'fast' : s.quality,
    profile: activeProfile(s, seriesKey),
    glossary: s.glossary,
    translateSfx: s.translateSfx,
    sfxStyle: s.sfxStyle,
    vision: withKeepAlive(providerById(s, s.visionProviderId), s),
    translator: withKeepAlive(providerById(s, s.translationProviderId), s),
    engine: s.engine,
    qa: fastLocalActive(s) && (s.qaMode ?? 'fix') !== 'off' ? 'rules' : s.qaMode ?? 'fix',
    twoStep: s.twoStepTranslation ?? !(fastLocalActive(s) || s.quality === 'fast'),
    bubblesOnly: s.bubblesOnly || undefined,
    onlySourceLang: (s.onlySourceLang && s.sourceLang !== 'auto') || undefined,
    inpaintExpand: s.inpaintExpand,
    lama: (s.lamaMode ?? (s.lamaEngine ? 'engine' : 'off')) === 'off' ? undefined : (s.lamaMode ?? 'engine') as 'engine' | 'browser',
    crossCheck: crossCheckConfig(s),
  };
}

/** Stable hash of the output-affecting settings (API keys excluded). */
export async function pipelineHash(c: PipelineConfig): Promise<string> {
  const strip = (p: ProviderConfig | null) => (p ? { kind: p.kind, baseUrl: p.baseUrl, model: p.model, temperature: p.temperature, noThinking: p.noThinking } : null);
  const payload = {
    v: 1,
    mode: c.mode,
    // Privacy decides which reviewers and cross-check translators may run, so it changes the result.
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
    cc: c.crossCheck ? [c.crossCheck.mode, c.crossCheck.judge?.model ?? null, c.crossCheck.checkers.map((x) => [x.kind, x.provider?.model ?? x.url ?? ''])] : undefined,
  };
  return (await sha256Hex(JSON.stringify(payload))).slice(0, 24);
}
