/* eslint-disable @typescript-eslint/no-explicit-any */
/** Runs one golden page through the pipeline (mock or real model) and scores it; shared by the golden tests. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { configFromPreset } from '../../src/llm/presets';
import type { ProviderConfig } from '../../src/llm/types';
import { renderOutput } from '../../src/pipeline/run';
import { runStandalonePipeline } from '../../src/pipeline/standalone';
import { DEFAULT_STYLE_DEFAULTS, type StyleDefaults } from '../../src/render/style';
import { DEFAULT_PROFILES } from '../../src/translate/profiles';
import { napiBackend } from '../helpers';
import { goldenModel } from './model';
import { GOLDEN_PAGES, makePage, type GoldenPage } from './pages';
import { CHECKS, decodeRendered, encodePixels, reportHtml, scorePage, type PageScore } from './score';

export const OUT = new URL('../../../../.test-output/golden/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

export const REAL = process.env.GOLDEN_REAL === '1';
const D: StyleDefaults = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans', narrationFont: 'TestSans', sfxFont: 'TestSans' };

/** Test logs: vitest hides console output of passing tests, the tables are wanted every time. */
export const print = (s: string) => process.stderr.write(`${s}\n`);

function config(page: GoldenPage, vision: ProviderConfig, privacy: 'local' | 'cloud') {
  return { mode: 'standalone', privacy, sourceLang: page.sourceLang, targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision, translator: null } as any;
}

export function realProvider(): ProviderConfig {
  const base = process.env.GOLDEN_BASE?.replace(/\/+$/, '');
  const provider = process.env.GOLDEN_PROVIDER ?? (!base || /:11434$/.test(base) ? 'ollama' : 'openai');
  const cfg = configFromPreset(provider === 'anthropic' ? 'anthropic' : provider === 'ollama' ? 'ollama' : 'openai', 'golden');
  // The presets keep the API path (/v1); people usually give just host:port.
  if (base) cfg.baseUrl = /\/v\d+(beta)?$|\/openai$/.test(base) ? base : `${base}/v1`;
  if (process.env.GOLDEN_MODEL) cfg.model = process.env.GOLDEN_MODEL;
  if (process.env.GOLDEN_KEY) cfg.apiKey = process.env.GOLDEN_KEY;
  cfg.vision = true;
  cfg.timeoutMs = 10 * 60_000;
  return cfg;
}

export async function runPage(page: GoldenPage, mode: 'perfect' | 'sloppy' | 'real'): Promise<PageScore> {
  const t0 = performance.now();
  let calls: () => number;
  let out;
  let jitters: string[] | undefined;
  if (mode === 'real') {
    let n = 0;
    const counting = (url: string, init?: RequestInit) => {
      n++;
      return fetch(url, init);
    };
    calls = () => n;
    out = await runStandalonePipeline({ bytes: page.bytes, config: config(page, realProvider(), 'cloud') }, { backend: napiBackend, fetchImpl: counting as any });
  } else {
    const mock = goldenModel(page, mode);
    calls = () => mock.calls.length;
    jitters = mode === 'sloppy' ? mock.jitters : undefined;
    out = await runStandalonePipeline({ bytes: page.bytes, config: config(page, { ...configFromPreset('lmstudio', 'vlm'), vision: true }, 'local') }, { backend: napiBackend, fetchImpl: mock.fetchImpl as any });
  }
  const rendered = await renderOutput(napiBackend, out, D);
  const ms = performance.now() - t0;
  const cleaned = new Uint8ClampedArray(out.cleaned.getRegion(0, 0, page.width, page.height).data);
  const final = await decodeRendered(rendered, page.width, page.height);
  writeFileSync(`${OUT}${page.name}-original.png`, page.bytes);
  writeFileSync(`${OUT}${page.name}-${mode}.png`, rendered.tiles.length === 1 ? rendered.tiles[0].bytes : await encodePixels(final, page.width, page.height));
  const score = scorePage({ page, mode, out, rendered, cleaned, final, calls: calls(), ms, defaults: D });
  // The cleaned picture (before typesetting) helps to see why a check failed.
  if (CHECKS.some((c) => score.checks[c] === false)) writeFileSync(`${OUT}${page.name}-${mode}-cleaned.png`, await encodePixels(cleaned, page.width, page.height));
  return jitters ? { ...score, jitters } : score;
}

const made = new Map<string, Promise<GoldenPage>>();
/** Each page is drawn once per run (both mock models use it). */
export const pageOf = (name: string) => made.get(name) ?? made.set(name, makePage(name)).get(name)!;

const TITLES = Object.fromEntries(GOLDEN_PAGES.map((p) => [p.name, p.title]));

export function report(file: string, scores: PageScore[], title: string, subtitle: string) {
  writeFileSync(`${OUT}${file}`, reportHtml(scores, { title, subtitle, titles: TITLES, images: (s) => ({ before: `${s.page}-original.png`, after: `${s.page}-${s.mode}.png` }) }));
}
