import { isLocalProvider } from './llm/privacy';
import type { ProviderConfig } from './llm/types';
import { providerById, type AppSettings } from './settings';

/**
 * Ways to work, switched in one click (popup and settings):
 * - ollama: a vision model on this computer (Ollama, LM Studio) reads and translates the pictures;
 * - cloud: a vision model of an online service (Gemini, OpenAI, Claude…) does; the detector and
 *   LaMa still run on this computer;
 * - ocr: recognition right in the browser (PaddleOCR) reads the text the detector found, and any
 *   text model (on this computer or online) translates it — no Python, no model that reads pictures;
 * - engine: the separate AI Translate Engine (Python) does the reading (settings only).
 */
export type AiMode = 'ollama' | 'cloud' | 'ocr' | 'engine';

const sees = (p: ProviderConfig) => p.vision !== false;

/** The mode the settings are in now. */
export function aiModeOf(s: AppSettings): AiMode {
  if (s.pipeline === 'engine') return 'engine';
  if (s.readMode === 'ocr') return 'ocr';
  const v = providerById(s, s.visionProviderId);
  return v && !isLocalProvider(v) ? 'cloud' : 'ollama';
}

/** The model server a mode would use: the one used in it last, else the first that fits. */
function providerFor(s: AppSettings, mode: 'ollama' | 'cloud'): ProviderConfig | undefined {
  const fits = (p: ProviderConfig | undefined): p is ProviderConfig => !!p && sees(p) && isLocalProvider(p) === (mode === 'ollama');
  const last = providerById(s, s.modeProviders?.[mode]);
  if (fits(last)) return last;
  const current = providerById(s, s.visionProviderId);
  if (fits(current)) return current;
  return s.providers.find(fits);
}

/** Which modes can be switched to (a mode without a model server or engine address cannot). */
export function aiModesAvailable(s: AppSettings): Record<AiMode, boolean> {
  return { ollama: !!providerFor(s, 'ollama'), cloud: !!providerFor(s, 'cloud'), ocr: s.providers.length > 0, engine: !!s.engine?.url };
}

/** The model that translates the recognised text: the one used for it last, else a local one, else any. */
function textProviderFor(s: AppSettings): ProviderConfig | undefined {
  return providerById(s, s.modeProviders?.ocr) ?? providerById(s, s.visionProviderId) ?? s.providers.find((p) => isLocalProvider(p)) ?? s.providers[0];
}

/**
 * The settings changes that switch to a mode (null when it cannot be switched to). The model server
 * of the mode left is remembered, to come back to it. A cloud mode needs the privacy setting to let
 * pictures out: «only this computer» becomes «hybrid».
 */
export function applyAiMode(s: AppSettings, mode: AiMode): Partial<AppSettings> | null {
  const now = aiModeOf(s);
  const remember = { ...(s.modeProviders ?? {}) };
  if (now !== 'engine' && s.visionProviderId) remember[now] = s.visionProviderId;
  if (mode === 'engine') {
    if (!s.engine?.url) return null;
    return { pipeline: 'engine', modeProviders: remember };
  }
  if (mode === 'ocr') {
    const t = textProviderFor(s);
    if (!t) return null;
    remember.ocr = t.id;
    // The text is found by the detector: it is switched on with this mode.
    return { pipeline: 'standalone', readMode: 'ocr', detectorMode: 'browser', visionProviderId: t.id, translationProviderId: null, modeProviders: remember };
  }
  const p = providerFor(s, mode);
  if (!p) return null;
  remember[mode] = p.id;
  const translator = providerById(s, s.translationProviderId);
  return {
    pipeline: 'standalone',
    readMode: 'vision',
    visionProviderId: p.id,
    // A separate translator of the other kind (a cloud one in the local mode) is not carried over.
    ...(translator && isLocalProvider(translator) !== (mode === 'ollama') ? { translationProviderId: null } : {}),
    ...(mode === 'cloud' && s.privacy === 'local' ? { privacy: 'hybrid' as const } : {}),
    modeProviders: remember,
  };
}
