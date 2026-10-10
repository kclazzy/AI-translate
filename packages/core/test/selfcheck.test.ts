/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { findLetterClusters } from '../src/image/clean';
import { configFromPreset } from '../src/llm/presets';
import { pipelineHash } from '../src/pipeline/config';
import { renderOutput } from '../src/pipeline/run';
import { inInterior, lineRects, selfCheckPage } from '../src/pipeline/selfcheck';
import { runStandalonePipeline, type PipelineOutput } from '../src/pipeline/standalone';
import { ctxMeasurer, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS, targetBox } from '../src/render/style';
import { migrateSettings } from '../src/settings';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import type { Box, TextBlock } from '../src/types';
import { goldenModel } from './golden/model';
import { makePage, type GoldenPage } from './golden/pages';
import { napiBackend } from './helpers';
import { createCanvas } from '@napi-rs/canvas';

const D = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' };

function config(page: GoldenPage, extra: Record<string, unknown> = {}) {
  return { mode: 'standalone', privacy: 'local', sourceLang: page.sourceLang, targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, ...extra } as any;
}

async function translated(name: string, extra: Record<string, unknown> = {}): Promise<{ page: GoldenPage; out: PipelineOutput }> {
  const page = await makePage(name);
  const mock = goldenModel(page, 'perfect');
  const out = await runStandalonePipeline({ bytes: page.bytes, config: config(page, extra) }, { backend: napiBackend, fetchImpl: mock.fetchImpl as any });
  return { page, out };
}

const check = (out: PipelineOutput, blocks?: TextBlock[]) => selfCheckPage({ backend: napiBackend, original: out.original, cleaned: out.cleaned, page: { ...out.page, blocks: blocks ?? out.page.blocks }, defaults: D });
const steps = (out: PipelineOutput) => (out.page.debug?.steps ?? []).filter((s) => s.startsWith('selfcheck'));

function allInside(b: TextBlock, page: { width: number; height: number }): boolean {
  const l = layoutBlock(ctxMeasurer(createCanvas(8, 8).getContext('2d') as any), b, D, page);
  const box = l.box ?? targetBox(b, D);
  return lineRects(l, box).every(([x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].every(([x, y]) => inInterior(b.bubble!, x, y, 4)));
}

describe('self-check after typesetting', () => {
  it('a good page: nothing fixed, nothing flagged; the summary is stored with the page', async () => {
    const { out } = await translated('en-oval');
    expect(out.selfCheck).toBe(true);
    const r = await renderOutput(napiBackend, out, D);
    expect(r.page.selfCheck).toEqual({ fixed: 0, flagged: 0 });
    expect(r.page.blocks.every((b) => !b.selfCheck)).toBe(true);
  });

  it('lettering left standing is cleaned again', async () => {
    const { page, out } = await translated('en-oval');
    const tb = page.expected.blocks[0].textBox;
    out.cleaned.putRegion(out.original.getRegion(...tb), tb[0], tb[1]);
    expect(findLetterClusters(out.cleaned, tb).length).toBeGreaterThan(0);
    const r = check(out);
    expect(r).toMatchObject({ fixed: 1, flagged: 0 });
    expect(findLetterClusters(out.cleaned, tb)).toEqual([]);
    expect(steps(out).join(' ')).toMatch(/b1 not_erased → cleaned again/);
  });

  it('art painted over next to the bubble is put back from the original', async () => {
    const { out } = await translated('en-oval');
    const slab: Box = [295, 170, 50, 70];
    const dark = { width: slab[2], height: slab[3], data: new Uint8ClampedArray(slab[2] * slab[3] * 4).map((_, i) => (i % 4 === 3 ? 255 : 10)) };
    out.cleaned.putRegion(dark, slab[0], slab[1]);
    const r = check(out);
    expect(r).toMatchObject({ fixed: 1, flagged: 0 });
    expect(Array.from(out.cleaned.getRegion(...slab).data)).toEqual(Array.from(out.original.getRegion(...slab).data));
    expect(steps(out).join(' ')).toMatch(/art_changed → art restored/);
  });

  it('text running out of the bubble is laid out again inside it', async () => {
    const { page, out } = await translated('en-oval');
    const b = out.page.blocks[0];
    const wide: TextBlock = { ...b, textBox: [600, 90, 380, 70] };
    expect(allInside(wide, page)).toBe(false);
    const r = check(out, [wide]);
    expect(r).toMatchObject({ fixed: 1, flagged: 0 });
    expect(allInside(r.blocks[0], page)).toBe(true);
    expect(steps(out).join(' ')).toMatch(/b1 outside → re-laid out/);
  });

  it('light letters on a white bubble are recoloured dark', async () => {
    const { out } = await translated('en-oval');
    const b = out.page.blocks[0];
    const r = check(out, [{ ...b, style: { ...(b.style ?? {}), color: '#f4f4f4' } }]);
    expect(r).toMatchObject({ fixed: 1, flagged: 0 });
    expect(r.blocks[0].style?.color).toBe('#111111');
  });

  it('dark letters on a black plate are recoloured light', async () => {
    const { out } = await translated('white-on-dark-box');
    const b = out.page.blocks[0];
    const r = check(out, [{ ...b, style: { ...(b.style ?? {}), color: '#111111', strokeColor: '#ffffff', strokeWidth: 3 } }]);
    expect(r).toMatchObject({ fixed: 1, flagged: 0 });
    expect(r.blocks[0].style).toMatchObject({ color: '#ffffff', strokeColor: '#000000' });
  });

  it('what cannot be fixed is flagged for the editor (and marked low confidence)', async () => {
    const { out } = await translated('en-oval');
    const b = out.page.blocks[0];
    // A size the user's style fixed, far too big for the bubble: the text cannot get inside.
    const r = check(out, [{ ...b, style: { ...(b.style ?? {}), fontSize: 70 } }]);
    expect(r).toMatchObject({ fixed: 0, flagged: 1 });
    expect(r.blocks[0].selfCheck?.issues).toContain('outside');
    expect(r.blocks[0].lowConfidence).toBe(true);
    expect(steps(out).join(' ')).toMatch(/b1 needs a look: outside/);
  });

  it('blocks edited by hand are left alone', async () => {
    const { out } = await translated('en-oval');
    const b = out.page.blocks[0];
    const mine: TextBlock = { ...b, edited: true, style: { ...(b.style ?? {}), color: '#f4f4f4' } };
    const r = check(out, [mine]);
    expect(r).toMatchObject({ fixed: 0, flagged: 0 });
    expect(r.blocks[0]).toBe(mine);
  });

  it('runs only on a fresh result and only when the setting is on', async () => {
    const { out } = await translated('en-oval', { selfCheck: false });
    expect(out.selfCheck).toBeUndefined();
    const r = await renderOutput(napiBackend, out, D);
    expect(r.page.selfCheck).toBeUndefined();
    // A re-render after editing (no original picture) is not checked again.
    const on = await translated('en-oval');
    const again = await renderOutput(napiBackend, { page: on.out.page, cleaned: on.out.cleaned }, D);
    expect(again.page.selfCheck).toBeUndefined();
  });

  it('setting: default on, validated, in the cache key only when off', async () => {
    expect(migrateSettings({}).selfCheck).toBeUndefined();
    expect(migrateSettings({ selfCheck: false }).selfCheck).toBe(false);
    expect(migrateSettings({ selfCheck: 'no' }).selfCheck).toBeUndefined();
    const page = await makePage('en-oval');
    const base = config(page);
    const h = await pipelineHash(base);
    expect(await pipelineHash({ ...base, selfCheck: true })).toBe(h);
    expect(await pipelineHash({ ...base, selfCheck: false })).not.toBe(h);
  });
});
