/**
 * Self-check after typesetting (cheap, local, no model calls): for every translated block it looks
 * at the cleaned picture and the laid-out text the way a proof-reader would.
 *
 *  - erased:  no original lettering left standing where the block's text was;
 *  - inside:  every laid-out line lies inside the bubble's real interior (when the outline is known);
 *  - readable: the text is not below the readable size (unless the bubble cannot hold it);
 *  - art:     cleaning changed nothing around the bubble beyond the letters (and a few px of them);
 *  - style:   dark letters on a light bubble (no visible halo), light letters on a dark plate,
 *             and never text in the colour of what lies under it.
 *
 * A problem gets one obvious local fix (the lettering cleaned again, the art pixels put back from
 * the original, the text laid out in the bubble's interior, the colour taken from the background)
 * and is checked again; what is still wrong marks the block (`selfCheck.issues`, lowConfidence)
 * for the editor's «Следующее замечание».
 */
import type { ImageBackend } from '../image/backend';
import { cleanBlock, dilate, findLetterClusters, luminance, parseHex, type LetterCluster } from '../image/clean';
import { clampBox, expandBox, type TiledImage } from '../image/tiled';
import { ctxMeasurer, layoutBlock, minReadableSize, shouldDraw } from '../render/render';
import { resolveStyle, targetBox, type StyleDefaults } from '../render/style';
import type { LayoutResult, Measurer } from '../typeset/layout';
import type { Box, BubbleInfo, PageResult, SelfCheckIssue, TextBlock, TextStyle } from '../types';
import { lazyStrings } from '../i18n';
import { yieldIfBusy } from '../util/yield';
import { addStep } from './debug';

export type { SelfCheckIssue } from '../types';

/** Notes on the issues for the reader (interface language, read at use time). */
export const SELF_CHECK_NOTES: Record<SelfCheckIssue, string> = lazyStrings({
  not_erased: 'Оригинал стёрт не полностью',
  outside: 'Текст выходит за бабл',
  too_small: 'Слишком мелкий текст',
  art_changed: 'Задет рисунок вокруг бабла',
  style: 'Цвет текста не подходит к фону',
});

/** Thresholds: how much changed art is a problem, and what counts as a change. */
export const SELF_CHECK_LIMITS = { artShare: 0.005, changed: 40, ink: 200, letterReach: 3, insideTol: 4 };

type Rect = [number, number, number, number];

const intersect = (a: Box, b: Box): Box | null => {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const r = Math.min(a[0] + a[2], b[0] + b[2]);
  const btm = Math.min(a[1] + a[3], b[1] + b[3]);
  return r > x && btm > y ? [x, y, r - x, btm - y] : null;
};
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
};
const area = (b: Box) => Math.max(0, b[2]) * Math.max(0, b[3]);

/** Rectangles of the laid-out letters in page px: [x0, top, x1, baseline]. */
export function lineRects(l: LayoutResult, box: Box): Rect[] {
  if (l.vertical) return l.glyphs.map((g) => [box[0] + g.x - l.fontSize / 2, box[1] + g.y - l.fontSize * 0.8, box[0] + g.x + l.fontSize / 2, box[1] + g.y]);
  return l.lines.map((ln) => {
    const x0 = l.alignment === 'left' ? ln.x : l.alignment === 'right' ? ln.x - ln.width : ln.x - ln.width / 2;
    return [box[0] + x0, box[1] + ln.y - l.fontSize * 0.7, box[0] + x0 + ln.width, box[1] + ln.y];
  });
}

/** Is the bubble's real interior known (its outline was found, or the detector saw an oval)? */
const interiorKnown = (b: BubbleInfo | null): b is BubbleInfo => !!b && (!!b.rows || b.shape === 'ellipse');

/** Is (x, y) inside the bubble's interior (rows of the outline, or the ellipse), with a tolerance? */
export function inInterior(b: BubbleInfo, x: number, y: number, tol = 0): boolean {
  const r = b.rows;
  if (r && r.l.length) {
    const i = Math.round((y - r.y) / r.step);
    if (i < -Math.ceil(tol / r.step) || i >= r.l.length + Math.ceil(tol / r.step)) return false;
    const k = Math.max(0, Math.min(r.l.length - 1, i));
    return x >= r.l[k] - tol && x <= r.r[k] + tol && r.r[k] > r.l[k];
  }
  const [bx, by, bw, bh] = b.box;
  const rx = bw / 2 + tol;
  const ry = bh / 2 + tol;
  return ((x - bx - bw / 2) / rx) ** 2 + ((y - by - bh / 2) / ry) ** 2 <= 1;
}

/** The biggest rectangle around the bubble's middle that lies inside its interior. */
export function inscribedBox(b: BubbleInfo, near?: Box): Box | null {
  const [bx, by, bw, bh] = b.box;
  const cx = near ? near[0] + near[2] / 2 : bx + bw / 2;
  const cy = near ? near[1] + near[3] / 2 : by + bh / 2;
  let best: Box | null = null;
  for (let k = 0.2; k <= 0.96; k += 0.04) {
    // A band of height k·bh around the centre row (moved back inside the bubble when needed).
    const h = bh * k;
    const top = Math.max(by, Math.min(by + bh - h, cy - h / 2));
    let l = -Infinity;
    let r = Infinity;
    for (let y = top; y <= top + h; y += 2) {
      // The free span of this row: from the centre outwards.
      let a = cx;
      let z = cx;
      if (!inInterior(b, cx, y)) {
        l = r = cx;
        break;
      }
      while (a > bx && inInterior(b, a - 1, y)) a -= 1;
      while (z < bx + bw && inInterior(b, z + 1, y)) z += 1;
      l = Math.max(l, a);
      r = Math.min(r, z);
    }
    if (r - l < 8) continue;
    const pad = Math.max(2, (r - l) * 0.04);
    const box: Box = [Math.round(l + pad), Math.round(top + 2), Math.round(r - l - pad * 2), Math.round(h - 4)];
    if (box[2] > 0 && box[3] > 0 && (!best || area(box) > area(best))) best = box;
  }
  return best;
}

/** Median grey level and flatness (share within ±25 of it) of a picture under the given rectangles. */
export function backgroundUnder(image: TiledImage, rects: Box[]): { lum: number; flat: number; color: [number, number, number] } | null {
  const hist = new Uint32Array(256);
  let n = 0;
  let sr = 0, sg = 0, sb = 0;
  for (const r0 of rects) {
    const r = clampBox(r0.map(Math.round) as Box, image.width, image.height);
    if (r[2] < 1 || r[3] < 1) continue;
    const px = image.getRegion(...r);
    const step = Math.max(1, Math.floor(Math.sqrt((r[2] * r[3]) / 4000)));
    for (let y = 0; y < r[3]; y += step)
      for (let x = 0; x < r[2]; x += step) {
        const i = (y * r[2] + x) * 4;
        hist[Math.round(luminance(px.data[i], px.data[i + 1], px.data[i + 2]))]++;
        sr += px.data[i];
        sg += px.data[i + 1];
        sb += px.data[i + 2];
        n++;
      }
  }
  if (n < 10) return null;
  let acc = 0;
  let med = 0;
  for (; med < 256; med++) if ((acc += hist[med]) >= n / 2) break;
  let near = 0;
  for (let v = Math.max(0, med - 25); v <= Math.min(255, med + 25); v++) near += hist[v];
  return { lum: med, flat: near / n, color: [sr / n, sg / n, sb / n] };
}

/** Text colours that read on a background of this brightness (a dark plate gets light letters). */
export function colourFor(bgLum: number): Pick<TextStyle, 'color' | 'strokeColor'> {
  return bgLum < 128 ? { color: '#ffffff', strokeColor: '#000000' } : { color: '#111111', strokeColor: '#ffffff' };
}

export interface SelfCheckInput {
  backend: ImageBackend;
  /** The picture as it came in (art to put back) and the cleaned one (changed in place by fixes). */
  original: TiledImage;
  cleaned: TiledImage;
  page: PageResult;
  defaults: StyleDefaults;
}

export interface SelfCheckResult {
  blocks: TextBlock[];
  fixed: number;
  flagged: number;
}

interface Ctx {
  in: SelfCheckInput;
  m: Measurer;
  page: { width: number; height: number };
  minReadable: number;
  /** Bubbles of every block (art inside any of them may be painted over). */
  bubbles: BubbleInfo[];
}

/** Run the self-check over a rendered page's blocks; returns new blocks (the cleaned image may change). */
export function selfCheckPage(input: SelfCheckInput): SelfCheckResult {
  // Every block reads (and may fix) regions of both pictures: keep their pixels at hand meanwhile.
  const released = [input.original.hold(), input.cleaned.hold()];
  try {
    const run = checker(input);
    return run.result(input.page.blocks.map(run.block));
  } finally {
    for (const release of released) release();
  }
}

/** selfCheckPage that lets other work run between blocks (see yieldIfBusy). */
export async function selfCheckPageAsync(input: SelfCheckInput): Promise<SelfCheckResult> {
  const released = [input.original.hold(), input.cleaned.hold()];
  try {
    const run = checker(input);
    const blocks: TextBlock[] = [];
    for (const b of input.page.blocks) {
      blocks.push(run.block(b));
      await yieldIfBusy();
    }
    return run.result(blocks);
  } finally {
    for (const release of released) release();
  }
}

function checker(input: SelfCheckInput) {
  const { page, defaults: d } = input;
  const ctx: Ctx = {
    in: input,
    m: ctxMeasurer(input.backend.createCanvas(8, 8).getContext('2d')),
    page: { width: page.width, height: page.height },
    minReadable: minReadableSize(page.width),
    bubbles: page.blocks.flatMap((b) => (interiorKnown(b.bubble) ? [b.bubble] : [])),
  };
  let fixed = 0;
  let flagged = 0;
  const block = (b0: TextBlock): TextBlock => {
    // The user's own work and blocks that are not drawn are left alone.
    if (b0.edited || b0.continued || !shouldDraw(b0, d)) return b0;
    let b: TextBlock = { ...b0 };
    delete b.selfCheck;
    const found = checkBlock(ctx, b);
    if (!found.length) return b;
    const done: SelfCheckIssue[] = [];
    for (const issue of found) {
      const r = fixBlock(ctx, b, issue);
      b = r.block;
      if (r.note) addStep(page.debug, `selfcheck: ${b.id} ${issue} → ${r.note}`);
    }
    const left = checkBlock(ctx, b);
    for (const issue of found) if (!left.includes(issue)) done.push(issue);
    if (left.length) {
      flagged++;
      addStep(page.debug, `selfcheck: ${b.id} needs a look: ${left.join(', ')}`);
      return { ...b, selfCheck: { issues: left }, lowConfidence: true };
    }
    fixed++;
    return b;
  };
  return { block, result: (blocks: TextBlock[]): SelfCheckResult => ({ blocks, fixed, flagged }) };
}

function layoutOf(ctx: Ctx, b: TextBlock): { l: LayoutResult; box: Box } {
  const l = layoutBlock(ctx.m, b, ctx.in.defaults, ctx.page);
  return { l, box: l.box ?? targetBox(b, ctx.in.defaults) };
}

function checkBlock(ctx: Ctx, b: TextBlock): SelfCheckIssue[] {
  const out: SelfCheckIssue[] = [];
  if (leftover(ctx, b).length) out.push('not_erased');
  if (artChanged(ctx, b).share > SELF_CHECK_LIMITS.artShare) out.push('art_changed');
  const { l, box } = layoutOf(ctx, b);
  if (outside(ctx, b, l, box)) out.push('outside');
  if (tooSmall(ctx, b, l)) out.push('too_small');
  if (badStyle(ctx, b, l, box)) out.push('style');
  return out;
}

// ---------------------------------------------------------------- erased

/** Does the block erase the original lettering (sound effects kept as drawn do not)? */
const erases = (b: TextBlock, d: StyleDefaults) => b.translate && !(b.textType === 'SFX' && d.sfxStyle === 'original');

/** Rows of letters standing on the cleaned picture where the original had lettering too. */
function leftover(ctx: Ctx, b: TextBlock): LetterCluster[] {
  if (!erases(b, ctx.in.defaults)) return [];
  const { original, cleaned } = ctx.in;
  let zone = clampBox(expandBox(b.bbox, 4), cleaned.width, cleaned.height);
  if (b.bubble && interiorKnown(b.bubble)) zone = intersect(zone, b.bubble.box) ?? zone;
  if (zone[2] < 8 || zone[3] < 8) return [];
  const before = findLetterClusters(original, zone);
  if (!before.length) return [];
  return findLetterClusters(cleaned, zone).filter((c) => before.some((o) => {
    const cut = intersect(c.box, o.box);
    return !!cut && area(cut) >= area(c.box) * 0.5;
  }));
}

// ---------------------------------------------------------------- art

/** Where art around the block was changed by cleaning beyond the letters and the bubble interiors. */
function artChanged(ctx: Ctx, b: TextBlock): { share: number; zone: Box; mask: Uint8Array | null } {
  const { original, cleaned } = ctx.in;
  let core = b.bbox;
  if (b.textBox) core = union(core, b.textBox);
  if (b.bubble) core = union(core, b.bubble.box);
  const zone = clampBox(expandBox(core, Math.max(24, Math.round(Math.min(core[2], core[3]) * 0.25))), cleaned.width, cleaned.height);
  if (zone[2] < 2 || zone[3] < 2) return { share: 0, zone, mask: null };
  const a = original.getRegion(...zone);
  const c = cleaned.getRegion(...zone);
  const [zx, zy, w, h] = zone;
  const n = w * h;
  const diff = (i: number) => Math.abs(a.data[i] - c.data[i]) + Math.abs(a.data[i + 1] - c.data[i + 1]) + Math.abs(a.data[i + 2] - c.data[i + 2]);
  // The letters: pixels the cleaning changed strongly (dark letters made light, white made dark…)
  // in strokes no thicker than lettering is. A solid slab painted over the art survives an opening
  // (erode, grow back) of that size; strokes of letters vanish in it.
  const strong = new Uint8Array(n);
  let changedAny = false;
  for (let p = 0; p < n; p++) {
    const v = diff(p * 4);
    if (v > SELF_CHECK_LIMITS.changed) changedAny = true;
    if (v > SELF_CHECK_LIMITS.ink) strong[p] = 1;
  }
  if (!changedAny) return { share: 0, zone, mask: null };
  const r = Math.max(5, Math.round((b.fontSizeEstimate || 24) * 0.2));
  const solid = opening(strong, w, h, r);
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (strong[p] && !solid[p]) ink[p] = 1;
  const near = dilate(ink, w, h, SELF_CHECK_LIMITS.letterReach);
  const bubbles = ctx.bubbles.filter((bb) => intersect(bb.box, zone));
  const mask = new Uint8Array(n);
  let bad = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (near[p] || diff(p * 4) <= SELF_CHECK_LIMITS.changed) continue;
      if (bubbles.some((bb) => inInterior(bb, zx + x, zy + y, 1))) continue;
      mask[p] = 1;
      bad++;
    }
  return { share: bad / n, zone, mask };
}

/** Morphological opening by a square of radius r: the parts of the mask thicker than 2r. */
function opening(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // Erode = complement of the dilated complement (the area's border counts as inside: a slab cut
  // by the edge of the zone is still solid).
  const comp = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) comp[p] = mask[p] ? 0 : 1;
  const grown = dilate(comp, w, h, r);
  const core = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) core[p] = grown[p] ? 0 : 1;
  const back = dilate(core, w, h, r);
  for (let p = 0; p < mask.length; p++) back[p] = back[p] && mask[p] ? 1 : 0;
  return back;
}

// ---------------------------------------------------------------- layout

function outside(ctx: Ctx, b: TextBlock, l: LayoutResult, box: Box): boolean {
  if (!interiorKnown(b.bubble) || resolveStyle(b, ctx.in.defaults).rotation) return false;
  const bub = b.bubble;
  // A bubble joined to this one (two lobes of one shape) counts too.
  const shapes = [bub, ...ctx.bubbles.filter((o) => o !== bub && intersect(o.box, bub.box))];
  const tol = SELF_CHECK_LIMITS.insideTol;
  for (const [x0, y0, x1, y1] of lineRects(l, box))
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) if (!shapes.some((s) => inInterior(s, x, y, tol))) return true;
  return false;
}

function tooSmall(ctx: Ctx, b: TextBlock, l: LayoutResult): boolean {
  if (b.textType === 'SFX' || b.style?.fontSize || l.vertical) return false;
  const scale = Math.max(0.5, Math.min(2, ctx.in.defaults.fontScale ?? 1));
  // «The bubble cannot hold it» is reported as overflow already (text does not fit).
  return !l.overflow && l.fontSize < Math.floor(ctx.minReadable * Math.min(1, scale));
}

// ---------------------------------------------------------------- style

const lumOf = (hex: string | null | undefined) => (hex ? luminance(...parseHex(hex)) : null);

function badStyle(ctx: Ctx, b: TextBlock, l: LayoutResult, box: Box): boolean {
  return styleFix(ctx, b, l, box) !== null;
}

/** The style the block needs on what lies under it, or null when it reads fine. */
function styleFix(ctx: Ctx, b: TextBlock, l: LayoutResult, box: Box): Partial<TextStyle> | null {
  const st = resolveStyle(b, ctx.in.defaults);
  if (st.gradient) return null;
  const rects = lineRects(l, box).map(([x0, y0, x1, y1]): Box => [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]);
  const bg = backgroundUnder(ctx.in.cleaned, rects);
  const text = lumOf(st.color);
  if (!bg || text === null) return null;
  const strokePx = st.strokeColor && st.strokeWidth > 0 ? (st.strokeWidth * l.fontSize) / 18 : 0;
  const stroke = strokePx > 0 ? lumOf(st.strokeColor) : null;
  const haloVisible = (stroke !== null && strokePx > l.fontSize * 0.12 && Math.abs(stroke - bg.lum) > 60) || !!st.glow;
  const inBubble = interiorKnown(b.bubble);
  const plate = bg.flat >= 0.6;
  if (plate && bg.lum >= 170) {
    // A light bubble or caption: dark letters; inside a bubble without a halo.
    if (text >= 110) return { color: '#111111', ...(inBubble ? { strokeColor: null, strokeWidth: 0, glow: null } : { strokeColor: '#ffffff' }) };
    if (inBubble && haloVisible) return { strokeColor: null, strokeWidth: 0, glow: null };
    return null;
  }
  if (plate && bg.lum <= 85) {
    // A dark plate: light letters; an outline only in the plate's own dark colour.
    if (text <= 155) return { color: '#ffffff', strokeColor: '#000000', glow: null };
    if (inBubble && haloVisible && stroke !== null && stroke > 85) return { strokeColor: '#000000' };
    return null;
  }
  // Busy art: the letters (or their outline) must stand out from it.
  const reads = Math.abs(text - bg.lum) >= 60 || (stroke !== null && strokePx >= 1 && Math.abs(stroke - bg.lum) >= 60 && Math.abs(stroke - text) >= 60);
  if (reads) return null;
  return { ...colourFor(bg.lum), strokeWidth: Math.max(3, st.strokeWidth || 0), glow: null };
}

// ---------------------------------------------------------------- fixes

function fixBlock(ctx: Ctx, b: TextBlock, issue: SelfCheckIssue): { block: TextBlock; note?: string } {
  const { cleaned, original } = ctx.in;
  switch (issue) {
    case 'not_erased': {
      // Clean again just where the letters still stand.
      const left = leftover(ctx, b);
      for (const c of left) {
        const pad = Math.max(2, Math.round(c.letterHeight * 0.15));
        cleanBlock(cleaned, clampBox(expandBox(c.box, pad), cleaned.width, cleaned.height), { sfx: b.textType === 'SFX', expand: 2 });
      }
      return { block: b, note: left.length ? `cleaned again (${left.length} place(s))` : undefined };
    }
    case 'art_changed': {
      // Put the art back where it was changed away from the letters; keep it only if the
      // lettering stays erased.
      const r = artChanged(ctx, b);
      if (!r.mask) return { block: b };
      const before = cleaned.getRegion(...r.zone);
      const orig = original.getRegion(...r.zone);
      const next = { width: before.width, height: before.height, data: new Uint8ClampedArray(before.data) };
      for (let p = 0; p < r.mask.length; p++) if (r.mask[p]) for (let k = 0; k < 3; k++) next.data[p * 4 + k] = orig.data[p * 4 + k];
      const hadLeft = leftover(ctx, b).length;
      cleaned.putRegion(next, r.zone[0], r.zone[1]);
      if (leftover(ctx, b).length > hadLeft) {
        cleaned.putRegion(before, r.zone[0], r.zone[1]);
        return { block: b };
      }
      return { block: b, note: 'art restored from the original' };
    }
    case 'outside':
    case 'too_small': {
      if (!b.bubble) return { block: b };
      // Lay the text out in the bubble's interior: its own outline rows, or the biggest rectangle in it.
      const { l: l0 } = layoutOf(ctx, b);
      const tries: TextBlock[] = [];
      if (b.textBox) {
        const { textBox: _t, ...rest } = b;
        tries.push(rest as TextBlock);
      }
      const inner = interiorKnown(b.bubble) ? inscribedBox(b.bubble, b.bbox) : null;
      if (inner) tries.push({ ...b, textBox: inner });
      for (const t of tries) {
        const { l, box } = layoutOf(ctx, t);
        if (outside(ctx, t, l, box) || tooSmall(ctx, t, l)) continue;
        // Never a smaller text than before for the sake of a few pixels (unless it was outside).
        if (issue === 'too_small' && l.fontSize < l0.fontSize) continue;
        return { block: t, note: 're-laid out in the bubble' };
      }
      return { block: b };
    }
    case 'style': {
      const { l, box } = layoutOf(ctx, b);
      const fix = styleFix(ctx, b, l, box);
      if (!fix) return { block: b };
      return { block: { ...b, style: { ...(b.style ?? {}), ...fix } }, note: `recoloured (${fix.color ?? fix.strokeColor ?? 'no halo'})` };
    }
  }
}
