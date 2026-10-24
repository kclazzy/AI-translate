import type { ErrorCode } from '../errors';
import { BROWSER_TRANSLATOR, browserTranslateSupported, isBrowserTranslator } from '../llm/browserTranslator';
import type { ProviderConfig } from '../llm/types';
import { providerById, type AppSettings } from '../settings';
import { tr } from '../i18n';
import type { PipelineConfig } from './config';

/**
 * The usual model did not answer: what stands in so the page is still translated (and marked as such).
 * Only failures of the model server — not a picture without text, a stop or the privacy setting.
 */
export const FALLBACK_ON = new Set<ErrorCode>(['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'RATE_LIMITED', 'INVALID_API_KEY', 'OUT_OF_MEMORY', 'TRANSLATION_FAILED', 'TRANSLATION_INVALID_OUTPUT', 'NOT_CONFIGURED']);

/** The stand-in chosen in the settings: a model server, the browser's translator (default), or none. */
export function fallbackProvider(s: AppSettings): ProviderConfig | undefined {
  if (s.fallbackProviderId === 'off') return undefined;
  if (s.fallbackProviderId) {
    const p = providerById(s, s.fallbackProviderId);
    if (p && (!isBrowserTranslator(p) || browserTranslateSupported())) return p;
  }
  return browserTranslateSupported() ? BROWSER_TRANSLATOR : undefined;
}

/**
 * The settings for the stand-in. A model that reads pictures takes the usual one's place; a text
 * model or the browser's translator translates what recognition in the browser reads (needs the
 * detector and the line reader: `canRecognize`). Null: nothing can stand in.
 */
export function fallbackConfig(cfg: PipelineConfig, s: AppSettings, canRecognize: boolean): { cfg: PipelineConfig; by: string } | null {
  if (cfg.mode !== 'standalone') return null;
  const p = fallbackProvider(s);
  if (!p) return null;
  const usual = cfg.ocr ? cfg.translator ?? cfg.vision : cfg.vision;
  if (usual && usual.id === p.id && usual.model === p.model) return null;
  const by = isBrowserTranslator(p) ? tr('переводчик браузера') : `${tr(p.label)} · ${p.model}`;
  if (!cfg.ocr && !isBrowserTranslator(p) && p.vision !== false) return { cfg: { ...cfg, vision: p, translator: null }, by };
  if (!canRecognize) return null;
  const plain = isBrowserTranslator(p);
  return {
    cfg: {
      ...cfg,
      ocr: true,
      detector: true,
      collage: undefined,
      vision: p,
      translator: null,
      // The browser's translator takes no context and no review.
      ...(plain ? { twoStep: false, qa: cfg.qa === 'off' ? 'off' : 'rules' } : {}),
    },
    by,
  };
}
