/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Performance regression: cleaning must cost about the same per block whatever the size of the
 * picture (the work around a block stays within a window around it), a tall webtoon strip must
 * not run out of memory, and a long run must let other work in (cooperative yielding).
 *
 * The picture: white oval bubbles with lettering over busy art (a gradient criss-crossed by
 * coloured lines). The mock model answers every request — each view of a tall strip and every
 * region read again — with all the bubbles of the page, so most of its boxes land on bare art:
 * a stress test of loose boxes, the slowest case for the cleaner.
 *
 * Limits are about 3× the times measured on a developer machine, so CI noise does not fail them
 * (before the fix: 800×5000 took ~14 s and 800×8000 crashed the worker out of memory).
 */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset } from '../src/llm/presets';
import { runStandalonePipeline } from '../src/pipeline/standalone';
import { renderOutput } from '../src/pipeline/run';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { mockOpenAi, napiBackend } from './helpers';

function strip(W: number, H: number, n: number) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#203050');
  g.addColorStop(1, '#a0c0e0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 400; i++) {
    ctx.strokeStyle = `hsl(${(i * 37) % 360},60%,40%)`;
    ctx.beginPath();
    ctx.moveTo(rnd() * W, rnd() * H);
    ctx.lineTo(rnd() * W, rnd() * H);
    ctx.stroke();
  }
  const blocks: any[] = [];
  for (let i = 0; i < n; i++) {
    const cx = 200 + (i % 2) * 400;
    const cy = 400 + (i * (H - 800)) / Math.max(1, n - 1);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 170, 110, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 26px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText('WHERE ARE YOU', cx, cy - 10);
    ctx.fillText('GOING NOW?', cx, cy + 22);
    const box = [(cx - 110) / W, (cy - 40) / H, (cx + 110) / W, (cy + 35) / H].map((v) => Math.round(v * 1000));
    blocks.push({ box, text: 'WHERE ARE YOU GOING NOW?', translation: 'КУДА ТЫ СЕЙЧАС ИДЁШЬ?', type: 'DIALOGUE' });
  }
  return { bytes: new Uint8Array(c.toBuffer('image/png')), blocks };
}

/** Run a page; also the longest time the event loop had to wait for a turn meanwhile. */
async function run(W: number, H: number, n: number) {
  const { bytes, blocks } = strip(W, H, n);
  const mock = mockOpenAi(() => JSON.stringify({ blocks, entities: [], summary: '' }));
  // Measured from the cleaning on (decoding a picture is one call to the image library).
  let longest = 0;
  let measuring = false;
  let last = performance.now();
  let ticking = true;
  const tick = () => {
    const now = performance.now();
    if (measuring) longest = Math.max(longest, now - last);
    last = now;
    if (ticking) setTimeout(tick, 5);
  };
  setTimeout(tick, 5);
  const config = { mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', selfCheck: true, vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null } as any;
  try {
    const onStage = (e: { stage: string }) => void (measuring ||= e.stage === 'cleaning');
    const out = await runStandalonePipeline({ bytes, noSkip: true, config, onStage }, { backend: napiBackend, fetchImpl: mock.fetchImpl });
    const rendered = await renderOutput(napiBackend, out, DEFAULT_STYLE_DEFAULTS);
    if (process.env.PERF_LOG) console.log(`perf ${W}x${H}: cleanMs=${out.page.timings.cleanMs} longest=${Math.round(longest)} rss=${Math.round(process.memoryUsage().rss / 1e6)}MB`);
    return { cleanMs: out.page.timings.cleanMs, blocks: rendered.page.blocks.length, longest };
  } finally {
    ticking = false;
  }
}

describe('performance', () => {
  it('800×1200, 2 bubbles', async () => {
    const r = await run(800, 1200, 2);
    expect(r.blocks).toBeGreaterThanOrEqual(2);
    expect(r.cleanMs).toBeLessThan(1800);
  }, 60_000);

  it('800×5000, 5 bubbles', async () => {
    const r = await run(800, 5000, 5);
    expect(r.blocks).toBeGreaterThanOrEqual(5);
    expect(r.cleanMs).toBeLessThan(6000);
  }, 120_000);

  it('800×8000, 8 bubbles: no crash, memory and turns for other work', async () => {
    const r = await run(800, 8000, 8);
    expect(r.blocks).toBeGreaterThanOrEqual(8);
    expect(r.cleanMs).toBeLessThan(10_500);
    // The worker used to run out of memory here (several GB of scratch canvases).
    expect(process.memoryUsage().rss).toBeLessThan(2.5 * 1024 ** 3);
    // Other work waited at most about one block's cleaning, never the whole page (was ~10 s).
    expect(r.longest).toBeLessThan(1000);
  }, 180_000);
});
