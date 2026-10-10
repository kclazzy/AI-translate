/**
 * Mock vision models for the golden set (CI): a "perfect" one that answers with the true boxes,
 * text and translation, and a "sloppy" one whose boxes are off the way real local models are off
 * (too loose, shifted, or the whole bubble instead of the text).
 */
import { planViews } from '../../src/pipeline/standalone';
import { mockOpenAi } from '../helpers';
import type { Box, ExpectedBlock, GoldenPage } from './pages';

export type Jitter = 'loose' | 'shift' | 'bubble';

/** Small deterministic PRNG (mulberry32) seeded by a string. */
function rng(seed: string): () => number {
  let h = 1779033703;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clip = ([x, y, w, h]: Box, W: number, H: number): Box => {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  return [x0, y0, Math.max(1, Math.min(W, x + w) - x0), Math.max(1, Math.min(H, y + h) - y0)];
};

/** The box a sloppy model reports for one block, and which kind of mistake it made. */
export function sloppyBox(page: GoldenPage, b: ExpectedBlock, i: number): { box: Box; jitter: Jitter } {
  const r = rng(`${page.name}#${i}`);
  const kinds: Jitter[] = ['loose', 'shift', 'bubble'];
  let jitter = kinds[Math.floor(r() * 3)];
  if (jitter === 'bubble' && (!b.bubble || b.bubble.kind === 'none')) jitter = 'loose';
  const [x, y, w, h] = b.textBox;
  let box: Box;
  if (jitter === 'loose') {
    // ±15 %: each side moves out (or in) by up to 15 % of the box size.
    const dx0 = (r() * 0.3 - 0.05) * w, dx1 = (r() * 0.3 - 0.05) * w;
    const dy0 = (r() * 0.3 - 0.05) * h, dy1 = (r() * 0.3 - 0.05) * h;
    box = [x - dx0, y - dy0, w + dx0 + dx1, h + dy0 + dy1];
  } else if (jitter === 'shift') {
    // Shifted by 10–30 % of the box height (up or down) and a little sideways.
    const dy = (0.1 + r() * 0.2) * h * (r() < 0.5 ? -1 : 1);
    const dx = (r() * 0.16 - 0.08) * w;
    box = [x + dx, y + dy, w, h];
  } else {
    box = b.bubble!.box;
  }
  return { box: clip(box.map(Math.round) as Box, page.width, page.height), jitter };
}

/**
 * A fake vision endpoint for one page. The pipeline asks one view at a time (a local preset: one
 * request at a time), so the n-th call is the n-th view of planViews; later calls (re-reading a
 * crop with left-over letters) get an empty answer.
 */
export function goldenModel(page: GoldenPage, mode: 'perfect' | 'sloppy') {
  const views = planViews(page.width, page.height);
  const boxes = page.expected.blocks.map((b, i) => (mode === 'perfect' ? { box: b.textBox, jitter: undefined } : sloppyBox(page, b, i)));
  const mock = mockOpenAi((_body, call) => {
    const view = views[call - 1];
    if (!view) return JSON.stringify({ blocks: [], entities: [], summary: '' });
    const blocks = page.expected.blocks.flatMap((b, i) => {
      const [x, y, w, h] = boxes[i].box;
      // A block is reported by every view that holds it whole (the pipeline merges duplicates);
      // one no view holds whole, by the view holding its middle.
      const whole = (v: { y: number; h: number }) => y >= v.y && y + h <= v.y + v.h;
      const mid = y + h / 2;
      if (!(whole(view) || (!views.some(whole) && views.find((v) => mid >= v.y && mid < v.y + v.h) === view))) return [];
      const n = (v: number, d: number) => Math.round((v / d) * 1000);
      return [{ box: [n(x, page.width), n(y - view.y, view.h), n(x + w, page.width), n(y + h - view.y, view.h)], text: b.text, translation: b.translation, type: b.type, vertical: !!b.vertical, speaker: '', gender: 'unknown' }];
    });
    return JSON.stringify({ blocks, entities: [], summary: '' });
  });
  return { ...mock, jitters: boxes.map((b) => b.jitter).filter(Boolean) as Jitter[] };
}
