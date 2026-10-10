import type { ImageBackend, ImageMime } from '../image/backend';
import { renderTiles, encodeTiles } from '../render/render';
import { DEFAULT_STYLE_DEFAULTS, type StyleDefaults } from '../render/style';
import type { PageResult } from '../types';
import type { PipelineConfig } from './config';
import { runEnginePipeline } from './engine';
import { runStandalonePipeline, type PipelineOutput, type PipelineRequest, type StandaloneDeps } from './standalone';
import { createProvider } from '../llm/presets';
import { assertPrivacy } from '../llm/privacy';
import { qaBatchPlan, qaPage } from '../translate/qa';
import { addStep, recording } from './debug';
import { selfCheckPage } from './selfcheck';

export async function runPipeline(req: PipelineRequest & { batchReview?: boolean }, deps: StandaloneDeps): Promise<PipelineOutput & { reviewLater?: boolean }> {
  const out: PipelineOutput & { reviewLater?: boolean } = req.config.mode === 'engine' ? await runEnginePipeline(req, deps) : await runStandalonePipeline(req, deps);
  const mode = req.config.qa ?? 'off';
  if (mode !== 'off' && !req.generic && out.page.blocks.length) {
    const t0 = performance.now();
    // Check the translation (linguistic + semantic) with the model that translated the text.
    req.onStage?.({ stage: 'checking' });
    const cfg = req.config.translator ?? req.config.vision;
    let provider = cfg ? recording(createProvider(cfg, deps.fetchImpl), 'review', out.page.debug) : null;
    // The review sends the texts to that model: never outside the privacy mode (rule checks still run).
    if (cfg) {
      try {
        assertPrivacy(req.config.privacy, cfg, 'text');
      } catch {
        provider = null;
      }
    }
    // Batched check (settings → qaBatch, not in "best" quality): 1–2 short bubbles get the rule
    // checks only; a short page gets them now and the model's review later, together with other
    // short pages of the chapter (the caller collects them: `batchReview`).
    const plan = req.config.qaBatch && req.config.quality !== 'best' ? qaBatchPlan(out.page.blocks) : 'page';
    if (plan === 'rules') provider = null;
    else if (plan === 'batch' && req.batchReview && provider && mode !== 'rules') {
      provider = null;
      out.reviewLater = true;
    }
    const usage = await qaPage(out.page.blocks, { provider, mode, targetLang: req.config.targetLang, glossary: req.config.glossary, context: out.context ?? req.context, signal: req.signal });
    out.page.usage = [...out.page.usage, ...usage];
    out.page.timings = { ...out.page.timings, qaMs: Math.round(performance.now() - t0) };
  }
  return out;
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

/**
 * Typeset translated text over the cleaned image and encode the result as image tiles. A fresh
 * pipeline result (`original` with `selfCheck`) is self-checked first: fixes change its blocks and
 * its cleaned picture (`out.cleaned`, in place), so callers store the cleaned layer afterwards.
 */
export async function renderOutput(backend: ImageBackend, out: Pick<PipelineOutput, 'page' | 'cleaned'> & Partial<Pick<PipelineOutput, 'original' | 'selfCheck'>>, defaults: StyleDefaults, mime: ImageMime = 'image/png'): Promise<RenderedPage> {
  const t0 = performance.now();
  let src = out.page;
  if (out.selfCheck && out.original && !src.selfCheck) {
    try {
      const r = selfCheckPage({ backend, original: out.original, cleaned: out.cleaned, page: src, defaults });
      src = { ...src, blocks: r.blocks, selfCheck: { fixed: r.fixed, flagged: r.flagged } };
    } catch (e) {
      // The check never fails a page.
      addStep(src.debug, `selfcheck failed: ${(e as Error)?.message ?? e}`);
    }
  }
  const { tiles, overflow } = renderTiles(backend, out.cleaned, src.blocks, defaults);
  const encoded = await encodeTiles(backend, tiles, mime, mime === 'image/png' ? undefined : 0.92);
  const page: PageResult = {
    ...src,
    blocks: src.blocks.map((b) => ({ ...b, overflow: overflow.has(b.id) })),
    timings: { ...src.timings, renderMs: Math.round(performance.now() - t0) },
  };
  return { page, tiles: encoded, mime };
}
