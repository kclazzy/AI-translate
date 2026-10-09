import type { ImageBackend, ImageMime } from '../image/backend';
import type { FetchLike } from '../llm/types';
import { renderTiles, encodeTiles } from '../render/render';
import { DEFAULT_STYLE_DEFAULTS, type StyleDefaults } from '../render/style';
import type { PageResult, TextBlock, Usage } from '../types';
import type { PipelineConfig } from './config';
import { runEnginePipeline } from './engine';
import { runStandalonePipeline, type PipelineOutput, type PipelineRequest } from './standalone';
import { createProvider } from '../llm/presets';
import { assertPrivacy } from '../llm/privacy';
import { qaPage } from '../translate/qa';
import { CHECKER_LABELS, checkerIsCloud, crossCheckPage, machineTranslate, type Reference } from '../translate/crosscheck';
import { translateBlocks } from '../translate/translator';
import type { PromptInput } from '../translate/prompt';
import type { TranslationContext } from '../translate/context';
import type { LlmProvider } from '../llm/types';

export async function runPipeline(req: PipelineRequest, deps: { backend: ImageBackend; fetchImpl?: FetchLike }): Promise<PipelineOutput> {
  const out = req.config.mode === 'engine' ? await runEnginePipeline(req, deps) : await runStandalonePipeline(req, deps);
  const mode = req.config.qa ?? 'off';
  if (mode !== 'off' && !req.generic && out.page.blocks.length) {
    // Check the translation (linguistic + semantic) with the model that translated the text.
    req.onStage?.({ stage: 'checking' });
    const cfg = req.config.translator ?? req.config.vision;
    let provider = cfg ? createProvider(cfg, deps.fetchImpl) : null;
    // The review sends the texts to that model: never outside the privacy mode (rule checks still run).
    if (cfg) {
      try {
        assertPrivacy(req.config.privacy, cfg, 'text');
      } catch {
        provider = null;
      }
    }
    const usage = await qaPage(out.page.blocks, { provider, mode, targetLang: req.config.targetLang, glossary: req.config.glossary, context: out.context ?? req.context, signal: req.signal });
    out.page.usage = [...out.page.usage, ...usage];
  }
  if (req.config.crossCheck && !req.generic && out.page.blocks.length) {
    req.onStage?.({ stage: 'checking', message: 'crosscheck' });
    const usage = await runCrossCheck(out.page.blocks, req.config, deps, { signal: req.signal, context: out.context ?? req.context });
    out.page.usage = [...out.page.usage, ...usage];
  }
  return out;
}

/**
 * «Сверка» of a page's blocks with the translators chosen in the settings. Text goes only where
 * the privacy mode allows: in «local» mode only translators on this computer / network are asked.
 */
export async function runCrossCheck(
  blocks: TextBlock[],
  config: PipelineConfig,
  deps: { fetchImpl?: FetchLike },
  opts: { signal?: AbortSignal; context?: TranslationContext; onError?: (label: string, e: unknown) => void } = {},
): Promise<Usage[]> {
  const cc = config.crossCheck;
  if (!cc) return [];
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const usage: Usage[] = [];
  const references: Reference[] = [];
  for (const c of cc.checkers) {
    if (config.privacy === 'local' && checkerIsCloud(c, c.provider)) continue;
    if (c.kind === 'llm' && c.provider) {
      const provider = createProvider(c.provider, deps.fetchImpl);
      references.push({
        label: c.provider.model || c.provider.label,
        translate: async (texts) => {
          const input: PromptInput = { sourceLang: config.sourceLang, targetLang: config.targetLang, profile: config.profile, glossary: config.glossary, context: opts.context, translateSfx: config.translateSfx };
          const res = await translateBlocks(provider, input, texts.map((text, i) => ({ id: `r${i}`, type: 'DIALOGUE', text })), { signal: opts.signal, retries: 0 });
          usage.push(...res.usage);
          return texts.map((_, i) => res.translations.get(`r${i}`)?.text ?? '');
        },
      });
    } else if (c.kind !== 'llm') {
      references.push({ label: CHECKER_LABELS[c.kind], translate: (texts) => machineTranslate(c, c.apiKey, texts, config.sourceLang, config.targetLang, fetchImpl, opts.signal) });
    }
  }
  let judge: LlmProvider | null = cc.judge ? createProvider(cc.judge, deps.fetchImpl) : null;
  if (cc.judge) {
    try {
      assertPrivacy(config.privacy, cc.judge, 'text');
    } catch {
      judge = null;
    }
  }
  usage.push(...(await crossCheckPage(blocks, { references, judge, mode: cc.mode, targetLang: config.targetLang, signal: opts.signal, onError: opts.onError })));
  return usage;
}

export function styleDefaultsFor(config: Pick<PipelineConfig, 'targetLang' | 'sfxStyle'>, fonts?: { dialogue?: string; narration?: string; sfx?: string; scale?: number }): StyleDefaults {
  return {
    ...DEFAULT_STYLE_DEFAULTS,
    targetLang: config.targetLang,
    sfxStyle: config.sfxStyle,
    dialogueFont: fonts?.dialogue || DEFAULT_STYLE_DEFAULTS.dialogueFont,
    narrationFont: fonts?.narration || DEFAULT_STYLE_DEFAULTS.narrationFont,
    sfxFont: fonts?.sfx || DEFAULT_STYLE_DEFAULTS.sfxFont,
    fontScale: fonts?.scale,
  };
}

export interface RenderedPage {
  page: PageResult;
  tiles: { y: number; h: number; bytes: Uint8Array }[];
  mime: ImageMime;
}

/** Typeset translated text over the cleaned image and encode the result as image tiles. */
export async function renderOutput(backend: ImageBackend, out: Pick<PipelineOutput, 'page' | 'cleaned'>, defaults: StyleDefaults, mime: ImageMime = 'image/png'): Promise<RenderedPage> {
  const t0 = performance.now();
  const { tiles, overflow } = renderTiles(backend, out.cleaned, out.page.blocks, defaults);
  const encoded = await encodeTiles(backend, tiles, mime, mime === 'image/png' ? undefined : 0.92);
  const page: PageResult = {
    ...out.page,
    blocks: out.page.blocks.map((b) => ({ ...b, overflow: overflow.has(b.id) })),
    timings: { ...out.page.timings, renderMs: Math.round(performance.now() - t0) },
  };
  return { page, tiles: encoded, mime };
}
