import type { PrivacyMode } from '../llm/privacy';
import type { ProviderConfig } from '../llm/types';
import type { AppSettings, EngineOptions, PipelineMode, Quality } from '../settings';
import { activeProfile, providerById } from '../settings';
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
}

function withKeepAlive(p: ProviderConfig | undefined, s: AppSettings): ProviderConfig | null {
  return p ? { ...p, keepAliveMin: s.gpuKeepAliveMin ?? DEFAULT_KEEP_ALIVE_MIN } : null;
}

/** How long a local model stays in video memory after the last page, unless the user changes it. */
export const DEFAULT_KEEP_ALIVE_MIN = 5;

export function pipelineConfigFromSettings(s: AppSettings, seriesKey?: string): PipelineConfig {
  return {
    mode: s.pipeline,
    privacy: s.privacy,
    sourceLang: s.sourceLang,
    targetLang: s.targetLang,
    quality: s.quality,
    profile: activeProfile(s, seriesKey),
    glossary: s.glossary,
    translateSfx: s.translateSfx,
    sfxStyle: s.sfxStyle,
    vision: withKeepAlive(providerById(s, s.visionProviderId), s),
    translator: withKeepAlive(providerById(s, s.translationProviderId), s),
    engine: s.engine,
    qa: s.qaMode ?? 'fix',
  };
}

/** Stable hash of the output-affecting settings (API keys excluded). */
export async function pipelineHash(c: PipelineConfig): Promise<string> {
  const strip = (p: ProviderConfig | null) => (p ? { kind: p.kind, baseUrl: p.baseUrl, model: p.model } : null);
  const payload = {
    v: 1,
    mode: c.mode,
    src: c.sourceLang,
    dst: c.targetLang,
    q: c.quality,
    profile: { ...c.profile, id: undefined, name: undefined },
    glossary: c.glossary.filter((g) => g.enabled).map((g) => [g.source, g.target, g.matchMode, g.caseSensitive, g.forbidden]),
    sfx: [c.translateSfx, c.sfxStyle],
    vision: strip(c.vision),
    translator: strip(c.translator),
    engine: c.mode === 'engine' ? c.engine?.options : undefined,
    qa: c.qa ?? 'off',
  };
  return (await sha256Hex(JSON.stringify(payload))).slice(0, 24);
}
