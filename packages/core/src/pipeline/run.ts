import type { ImageBackend, ImageMime } from '../image/backend';
import type { FetchLike } from '../llm/types';
import { renderTiles, encodeTiles } from '../render/render';
import { DEFAULT_STYLE_DEFAULTS, type StyleDefaults } from '../render/style';
import type { PageResult } from '../types';
import type { PipelineConfig } from './config';
import { runEnginePipeline } from './engine';
import { runStandalonePipeline, type PipelineOutput, type PipelineRequest } from './standalone';
import { createProvider } from '../llm/presets';
import { qaPage } from '../translate/qa';

export async function runPipeline(req: PipelineRequest, deps: { backend: ImageBackend; fetchImpl?: FetchLike }): Promise<PipelineOutput> {
  const out = req.config.mode === 'engine' ? await runEnginePipeline(req, deps) : await runStandalonePipeline(req, deps);
  const mode = req.config.qa ?? 'off';
  if (mode !== 'off' && !req.generic && out.page.blocks.length) {
    // Check the translation (linguistic + semantic) with the model that translated the text.
    req.onStage?.({ stage: 'checking' });
    const cfg = req.config.translator ?? req.config.vision;
    const provider = cfg ? createProvider(cfg, deps.fetchImpl) : null;
    const usage = await qaPage(out.page.blocks, { provider, mode, targetLang: req.config.targetLang, glossary: req.config.glossary, context: out.context ?? req.context, signal: req.signal });
    out.page.usage = [...out.page.usage, ...usage];
  }
  return out;
}

export function styleDefaultsFor(config: Pick<PipelineConfig, 'targetLang' | 'sfxStyle'>, fonts?: { dialogue?: string; narration?: string; sfx?: string }): StyleDefaults {
  return {
    ...DEFAULT_STYLE_DEFAULTS,
    targetLang: config.targetLang,
    sfxStyle: config.sfxStyle,
    dialogueFont: fonts?.dialogue || DEFAULT_STYLE_DEFAULTS.dialogueFont,
    narrationFont: fonts?.narration || DEFAULT_STYLE_DEFAULTS.narrationFont,
    sfxFont: fonts?.sfx || DEFAULT_STYLE_DEFAULTS.sfxFont,
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
