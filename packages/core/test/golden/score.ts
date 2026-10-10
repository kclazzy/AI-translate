/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Quality checks for one golden page after runStandalonePipeline + renderOutput.
 * Every check is true (passed), false (failed) or null (does not apply to this page).
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { luminance, parseHex } from '../../src/image/clean';
import type { PipelineOutput } from '../../src/pipeline/standalone';
import type { RenderedPage } from '../../src/pipeline/run';
import { ctxMeasurer, layoutBlock, minReadableSize, shouldDraw } from '../../src/render/render';
import { resolveStyle, targetBox, type StyleDefaults } from '../../src/render/style';
import type { LayoutResult } from '../../src/typeset/layout';
import type { TextBlock } from '../../src/types';
import type { Box, ExpectedBlock, ExpectedBubble, GoldenPage } from './pages';

export const CHECKS = ['skip', 'found', 'erased', 'artUntouched', 'inside', 'readable', 'style'] as const;
export type CheckName = (typeof CHECKS)[number];

export interface PageScore {
  page: string;
  mode: string;
  checks: Record<CheckName, boolean | null>;
  /** Share of the original letter pixels gone (worst block). */
  erased: number | null;
  /** Share of art pixels changed (worst of: outside the bubbles while cleaning, art regions after rendering). */
  artChanged: number;
  /** Smallest font of a drawn non-SFX block, px (and the readable minimum). */
  minFont: number | null;
  minReadable: number;
  overflow: number;
  /** Mean character-trigram similarity of the translations to the reference (0–1). */
  similarity: number | null;
  calls: number;
  ms: number;
  blocksOut: number;
  /** Why checks failed, short. */
  notes: string[];
  jitters?: string[];
  /** What the self-check after typesetting did (blocks fixed by itself / left flagged). */
  selfCheck?: { fixed: number; flagged: number };
}

/** Thresholds of the checks. */
export const LIMITS = { erased: 0.9, artChanged: 0.005, insideTol: 4, pixelDiff: 40 };

// ---------------------------------------------------------------- geometry

const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);
function intersect(a: Box, b: Box): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}
const expand = (b: Box, m: number): Box => [b[0] - m, b[1] - m, b[2] + m * 2, b[3] + m * 2];

function inBubble(bub: ExpectedBubble, x: number, y: number, tol: number): boolean {
  const [bx, by, bw, bh] = bub.box;
  if (bub.kind === 'ellipse') {
    const rx = bw / 2 + tol, ry = bh / 2 + tol;
    return ((x - bx - bw / 2) / rx) ** 2 + ((y - by - bh / 2) / ry) ** 2 <= 1;
  }
  return x >= bx - tol && x <= bx + bw + tol && y >= by - tol && y <= by + bh + tol;
}

/** Where an expected block may be found: its bubble, or around its letters. */
const regionOf = (e: ExpectedBlock): Box => (e.bubble && e.bubble.kind !== 'none' ? e.bubble.box : expand(e.textBox, Math.max(20, e.textBox[3] * 0.5)));

/** Line rectangles of a layout in page px: [x0, top, x1, baseline]. */
function lineRects(l: LayoutResult, box: Box): [number, number, number, number][] {
  if (l.vertical) return l.glyphs.map((g) => [box[0] + g.x - l.fontSize / 2, box[1] + g.y - l.fontSize * 0.8, box[0] + g.x + l.fontSize / 2, box[1] + g.y]);
  return l.lines.map((ln) => {
    const x0 = l.alignment === 'left' ? ln.x : l.alignment === 'right' ? ln.x - ln.width : ln.x - ln.width / 2;
    return [box[0] + x0, box[1] + ln.y - l.fontSize * 0.7, box[0] + x0 + ln.width, box[1] + ln.y];
  });
}

// ---------------------------------------------------------------- pixels

export async function decodeRendered(r: RenderedPage, W: number, H: number): Promise<Uint8ClampedArray> {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  for (const t of r.tiles) ctx.drawImage(await loadImage(Buffer.from(t.bytes)), 0, t.y);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data);
}

export async function encodePixels(px: Uint8ClampedArray, W: number, H: number): Promise<Uint8Array> {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d') as any;
  const id = ctx.createImageData(W, H);
  id.data.set(px);
  ctx.putImageData(id, 0, 0);
  return new Uint8Array(await c.encode('png'));
}

const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);

// ---------------------------------------------------------------- text similarity

function trigrams(s: string): Map<string, number> {
  const t = ` ${s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const m = new Map<string, number>();
  const ch = [...t];
  for (let i = 0; i + 3 <= ch.length; i++) {
    const g = ch.slice(i, i + 3).join('');
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character trigrams (case, ё/е and punctuation ignored), 0–1. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a), y = trigrams(b);
  let common = 0, nx = 0, ny = 0;
  for (const v of x.values()) nx += v;
  for (const v of y.values()) ny += v;
  for (const [g, v] of x) common += Math.min(v, y.get(g) ?? 0);
  return nx + ny ? (2 * common) / (nx + ny) : 1;
}

// ---------------------------------------------------------------- scoring

export interface ScoreInput {
  page: GoldenPage;
  mode: string;
  out: PipelineOutput;
  rendered: RenderedPage;
  /** Cleaned and rendered pixels (RGBA, page size). */
  cleaned: Uint8ClampedArray;
  final: Uint8ClampedArray;
  calls: number;
  ms: number;
  defaults: StyleDefaults;
}

export function scorePage(s: ScoreInput): PageScore {
  const { page, out, defaults: d } = s;
  const W = page.width, H = page.height;
  const notes: string[] = [];
  const exp = page.expected.blocks;
  const blocks = s.rendered.page.blocks;
  const drawn = blocks.filter((b) => shouldDraw(b, d));
  const minReadable = minReadableSize(W);
  const checks = Object.fromEntries(CHECKS.map((c) => [c, null])) as Record<CheckName, boolean | null>;

  // skip: a page without text is skipped without asking the model; a page with text is not.
  if (page.noText) {
    checks.skip = !!out.page.skippedNoText && s.calls === 0;
    if (!checks.skip) notes.push(`skip: skippedNoText=${!!out.page.skippedNoText}, calls=${s.calls}`);
  } else {
    checks.skip = !out.page.skippedNoText;
    if (!checks.skip) notes.push('skip: page with text skipped');
  }

  // Match output blocks to expected ones by overlap with the expected bubble / letter area.
  const owner = new Map<TextBlock, number>();
  for (const b of blocks) {
    let best = -1, bestA = 0;
    exp.forEach((e, i) => {
      const a = intersect(b.bbox, regionOf(e));
      if (a > bestA) [best, bestA] = [i, a];
    });
    if (best >= 0) owner.set(b, best);
  }
  const byExp = exp.map((_, i) => drawn.filter((b) => owner.get(b) === i));

  // found: every expected block got a drawn translation.
  if (exp.length) {
    const missing = exp.map((e, i) => (byExp[i].length ? null : e.text.slice(0, 20))).filter(Boolean);
    checks.found = !missing.length;
    if (missing.length) notes.push(`found: missing ${missing.join(' | ')}`);
  }

  // erased: original letter pixels inside the expected text boxes are gone from the cleaned picture
  // (closer to the page drawn without lettering than to the lettered one).
  let erasedMin: number | null = null;
  for (const e of exp) {
    const [x, y, w, h] = e.textBox;
    let n = 0, gone = 0;
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const p = yy * W + xx;
        if (!page.letters[p]) continue;
        n++;
        if (diff(s.cleaned, page.clean, p * 4) < diff(s.cleaned, page.pixels, p * 4)) gone++;
      }
    const share = n ? gone / n : 1;
    erasedMin = Math.min(erasedMin ?? 1, share);
  }
  if (erasedMin !== null) {
    checks.erased = erasedMin >= LIMITS.erased;
    if (!checks.erased) notes.push(`erased ${(erasedMin * 100).toFixed(0)}%`);
  }

  // artUntouched: (a) cleaning changes nothing outside the expected bubbles / letter areas;
  // (b) the listed art regions are the same after rendering.
  const zone = new Uint8Array(W * H);
  for (const e of exp) {
    const bub = e.bubble && e.bubble.kind !== 'none' ? e.bubble : null;
    const m = bub ? 24 : Math.max(20, e.textBox[3] * 0.5);
    const r = expand(bub ? bub.box : e.textBox, m);
    for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(H, r[1] + r[3]); y++)
      for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(W, r[0] + r[2]); x++) if (!bub || inBubble(bub, x, y, m)) zone[y * W + x] = 1;
  }
  let outside = 0, changed = 0;
  for (let p = 0; p < W * H; p++) {
    if (zone[p]) continue;
    outside++;
    if (diff(s.cleaned, page.pixels, p * 4) > LIMITS.pixelDiff) changed++;
  }
  let artChanged = outside ? changed / outside : 0;
  for (const r of page.expected.artRegions) {
    let n = 0, c = 0;
    for (let y = Math.max(0, r[1]); y < Math.min(H, r[1] + r[3]); y++)
      for (let x = Math.max(0, r[0]); x < Math.min(W, r[0] + r[2]); x++) {
        n++;
        const i = (y * W + x) * 4;
        if (diff(s.final, page.pixels, i) > LIMITS.pixelDiff || diff(s.cleaned, page.pixels, i) > LIMITS.pixelDiff) c++;
      }
    if (n) artChanged = Math.max(artChanged, c / n);
  }
  checks.artUntouched = artChanged < LIMITS.artChanged;
  if (!checks.artUntouched) notes.push(`art changed ${(artChanged * 100).toFixed(2)}%`);

  // Layout of every drawn block, as renderTiles lays it out.
  const m = ctxMeasurer(createCanvas(8, 8).getContext('2d') as any);
  const layouts = new Map(drawn.map((b) => [b, layoutBlock(m, b, d, { width: W, height: H })]));

  // inside: every line of a block lies inside its expected bubble (or one joined to it).
  const insideFails: string[] = [];
  let insideApplies = false;
  for (const b of drawn) {
    const i = owner.get(b);
    if (i === undefined) {
      insideApplies = true;
      insideFails.push(`stray block "${b.translatedText.slice(0, 16)}"`);
      continue;
    }
    const bub = exp[i].bubble;
    if (!bub || bub.kind === 'none') continue;
    insideApplies = true;
    const shapes = exp.map((e) => e.bubble).filter((o): o is ExpectedBubble => !!o && o.kind !== 'none' && (o === bub || intersect(o.box, bub.box) > 0));
    const l = layouts.get(b)!;
    const box = l.box ?? targetBox(b, d);
    let worst = 0;
    for (const [x0, y0, x1, y1] of lineRects(l, box))
      for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) if (!shapes.some((sh) => inBubble(sh, x, y, LIMITS.insideTol))) worst++;
    if (worst) insideFails.push(`${b.id}: ${worst} corner(s) outside`);
  }
  if (insideApplies) {
    checks.inside = !insideFails.length;
    if (insideFails.length) notes.push(`inside: ${insideFails.join(', ')}`);
  }

  // readable: big enough, unless flagged for the editor (overflow).
  let minFont: number | null = null;
  let overflow = 0;
  const small: string[] = [];
  for (const b of drawn) {
    const l = layouts.get(b)!;
    if (l.overflow || b.overflow) overflow++;
    if (b.textType === 'SFX') continue;
    minFont = Math.min(minFont ?? Infinity, l.fontSize);
    if (l.fontSize < minReadable && !(l.overflow || b.overflow)) small.push(`${b.id} ${l.fontSize}px`);
  }
  if (minFont !== null) {
    checks.readable = !small.length;
    if (small.length) notes.push(`small: ${small.join(', ')} < ${minReadable}px`);
  }

  // style: dark letters on light bubbles (no visible halo), light letters on dark ones.
  const styleFails: string[] = [];
  for (const b of drawn) {
    const i = owner.get(b);
    if (i === undefined) continue;
    const e = exp[i];
    const st = resolveStyle(b, d);
    const l = layouts.get(b)!;
    const lum = luminance(...parseHex(st.color));
    if (e.letters === 'dark' ? lum >= 100 : lum <= 155) styleFails.push(`${b.id} ${e.letters} expected, got ${st.color}`);
    if (!e.haloOk && e.bubble?.fill) {
      const strokePx = st.strokeColor && st.strokeWidth > 0 ? (st.strokeWidth * l.fontSize) / 18 : 0;
      const visible = st.strokeColor ? Math.abs(luminance(...parseHex(st.strokeColor)) - luminance(...parseHex(e.bubble.fill))) > 60 : false;
      if ((strokePx > l.fontSize * 0.12 && visible) || st.glow) styleFails.push(`${b.id} halo ${st.strokeColor ?? st.glow}`);
    }
  }
  if (exp.length && drawn.some((b) => owner.has(b))) {
    checks.style = !styleFails.length;
    if (styleFails.length) notes.push(`style: ${styleFails.join(', ')}`);
  }

  // Translation similarity to the reference (meaningful with a real model).
  let similarity: number | null = null;
  if (exp.length) {
    const sims = exp.map((e, i) => trigramSimilarity(byExp[i].map((b) => b.translatedText).join(' '), e.translation));
    similarity = sims.reduce((a, b) => a + b, 0) / sims.length;
  }

  const sc = s.rendered.page.selfCheck;
  return { page: page.name, mode: s.mode, checks, erased: erasedMin, artChanged, minFont, minReadable, overflow, similarity, calls: s.calls, ms: s.ms, blocksOut: blocks.length, notes, ...(sc ? { selfCheck: sc } : {}) };
}

// ---------------------------------------------------------------- reports

const mark = (v: boolean | null) => (v === null ? '–' : v ? '✓' : '✗');

/** Plain-text table for the test log. */
export function scoreTable(scores: PageScore[]): string {
  const head = ['page', ...CHECKS, 'sim', 'ms', 'notes'];
  const rows = scores.map((s) => [s.page, ...CHECKS.map((c) => mark(s.checks[c])), s.similarity === null ? '–' : s.similarity.toFixed(2), String(Math.round(s.ms)), s.notes.join('; ').slice(0, 110)]);
  const foot = ['pass rate', ...CHECKS.map((c) => rate(scores, c)), '', '', ''];
  const w = head.map((h, i) => Math.max(h.length, ...[...rows, foot].map((r) => [...r[i]].length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat(w[i] - [...c].length))).join('  ');
  return [line(head), ...rows.map(line), line(foot)].join('\n');
}

/** "passed/applicable" for one check. */
export function passCount(scores: PageScore[], c: CheckName): { pass: number; of: number } {
  const app = scores.filter((s) => s.checks[c] !== null);
  return { pass: app.filter((s) => s.checks[c]).length, of: app.length };
}
const rate = (scores: PageScore[], c: CheckName) => {
  const r = passCount(scores, c);
  return `${r.pass}/${r.of}`;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** HTML report: per page the checks, similarity, time and before/after thumbnails (files next to it). */
export function reportHtml(scores: PageScore[], meta: { title: string; subtitle: string; titles: Record<string, string>; images: (s: PageScore) => { before: string; after: string } }): string {
  const rows = scores
    .map((s) => {
      const img = meta.images(s);
      const cells = CHECKS.map((c) => `<td class="${s.checks[c] === null ? 'na' : s.checks[c] ? 'ok' : 'bad'}">${mark(s.checks[c])}</td>`).join('');
      return `<tr><td><b>${esc(s.page)}</b><br><small>${esc(meta.titles[s.page] ?? '')}</small></td>${cells}<td>${s.similarity === null ? '–' : s.similarity.toFixed(2)}</td><td>${(s.ms / 1000).toFixed(1)} s</td><td class="th"><a href="${esc(img.before)}"><img src="${esc(img.before)}" loading="lazy"></a><a href="${esc(img.after)}"><img src="${esc(img.after)}" loading="lazy"></a></td><td class="notes">${esc([...s.notes, ...(s.selfCheck && s.selfCheck.fixed + s.selfCheck.flagged ? [`самопроверка: исправлено ${s.selfCheck.fixed}, требуют внимания ${s.selfCheck.flagged}`] : [])].join('; '))}</td></tr>`;
    })
    .join('\n');
  const totals = CHECKS.map((c) => `<td>${rate(scores, c)}</td>`).join('');
  const sims = scores.filter((s) => s.similarity !== null);
  const meanSim = sims.length ? (sims.reduce((a, s) => a + s.similarity!, 0) / sims.length).toFixed(2) : '–';
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Golden set report</title>
<style>
:root{--bg:#fff;--fg:#1b1b1f;--mut:#666;--line:#ddd;--ok:#1d7a3a;--bad:#c0262d;--head:#f4f4f6}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#e8e8ec;--mut:#9a9aa3;--line:#33333a;--ok:#5bd17f;--bad:#ff6b6b;--head:#1e1e23}}
body{background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;margin:16px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--mut);margin:0 0 16px}
.wrap{overflow-x:auto}table{border-collapse:collapse;min-width:900px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:center;vertical-align:middle}
th{background:var(--head);position:sticky;top:0}td:first-child{text-align:left}
.ok{color:var(--ok);font-weight:700}.bad{color:var(--bad);font-weight:700}.na{color:var(--mut)}
.th img{max-height:140px;max-width:160px;margin:0 3px;border:1px solid var(--line)}
.notes{text-align:left;font-size:12px;color:var(--mut);max-width:320px}
</style></head><body>
<h1>${esc(meta.title)}</h1><p>${esc(meta.subtitle)} · средняя похожесть перевода: ${meanSim}</p>
<div class="wrap"><table>
<tr><th>Страница</th>${CHECKS.map((c) => `<th>${c}</th>`).join('')}<th>похожесть</th><th>время</th><th>до / после</th><th>замечания</th></tr>
${rows}
<tr><th>Итого</th>${totals}<th>${meanSim}</th><th></th><th></th><th></th></tr>
</table></div></body></html>
`;
}
