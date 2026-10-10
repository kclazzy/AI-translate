import type { ImageBackend, PixelData } from '../image/backend';
import { boxArea, clampBox, expandBox, iou, type TiledImage } from '../image/tiled';
import type { Box, BubbleInfo, TextBlock } from '../types';

/**
 * Optional neural text / bubble detector (comic-text-and-bubble-detector, RT-DETR, 640×640): finds
 * the bubbles and the lettering more precisely than the vision model's boxes. It runs in the
 * browser (extension) and is handed to the pipeline as `deps.detect`; everything here is the part
 * that does not depend on ONNX Runtime: windows over tall pages, decoding the model's outputs,
 * merging, and using the boxes (snapping blocks, bubble limits, missed text, the empty-page check).
 */

export type DetectionKind = 'bubble' | 'text_bubble' | 'text_free';

export interface Detection {
  /** Page pixels (for a detector call: pixels of the picture it got). */
  box: Box;
  kind: DetectionKind;
  score: number;
}

/** Picture (RGBA, any size; the pipeline sends 640×640) → boxes in that picture's pixels. */
export type TextDetector = (img: PixelData, signal?: AbortSignal) => Promise<{ boxes: Detection[] }>;

/** The model's input side. */
export const DETECTOR_SIZE = 640;
/** Class ids of the model (id2label). */
export const DETECTOR_LABELS: DetectionKind[] = ['bubble', 'text_bubble', 'text_free'];
/** Kept at all: text from this score, bubbles from this one. */
export const TEXT_MIN = 0.35;
export const BUBBLE_MIN = 0.4;
/** The page has text (empty-page check) when a text box reaches this score. */
export const TEXT_PRESENT = 0.4;
/** Text the vision model did not report is read again from this score. */
export const MISSED_MIN = 0.5;
export const MISSED_MAX = 6;

export const isTextKind = (k: DetectionKind) => k !== 'bubble';

export interface DetectorWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Roughly square windows along the long side (a webtoon strip: windows as tall as the strip is
 * wide), overlapping by 15 %; a page that is nearly square is one window.
 */
export function detectorWindows(width: number, height: number): DetectorWindow[] {
  const tall = height >= width;
  const long = tall ? height : width;
  const side = tall ? width : height;
  if (long <= side * 1.3) return [{ x: 0, y: 0, w: width, h: height }];
  const step = Math.max(1, Math.round(side * 0.85));
  const out: DetectorWindow[] = [];
  for (let at = 0; ; at += step) {
    const start = Math.min(at, long - side);
    out.push(tall ? { x: 0, y: start, w: width, h: side } : { x: start, y: 0, w: side, h: height });
    if (start + side >= long) break;
  }
  return out;
}

/** One tensor of the model's answer, as ONNX Runtime gives it. */
export interface RawTensor {
  name: string;
  dims: readonly number[];
  data: ArrayLike<number | bigint>;
}

const num = (v: number | bigint) => (typeof v === 'bigint' ? Number(v) : v);
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Decode the detector's outputs into boxes in pixels of its `size`×`size` input. Two export forms:
 * Hugging Face (`logits` [1,N,C] before sigmoid + `pred_boxes` [1,N,4] normalised cx,cy,w,h) and the
 * original RT-DETR deploy form (`labels` [1,N], `boxes` [1,N,4] x1,y1,x2,y2 in pixels of
 * orig_target_sizes, `scores` [1,N]). Outputs are found by name, else by shape.
 */
export function parseDetectorOutputs(outs: RawTensor[], size = DETECTOR_SIZE, minScore = Math.min(TEXT_MIN, BUBBLE_MIN)): Detection[] {
  const by = (re: RegExp) => outs.find((o) => re.test(o.name));
  const last = (o: RawTensor) => o.dims[o.dims.length - 1];
  const boxesT = by(/pred_boxes|^boxes$|box/i) ?? outs.find((o) => o.dims.length >= 2 && last(o) === 4);
  if (!boxesT) throw new Error('detector: no box output');
  const n = Math.round(boxesT.data.length / 4);
  const logitsT = by(/logit/i) ?? outs.find((o) => o !== boxesT && o.dims.length === 3 && last(o) > 1 && last(o) <= 16);
  const out: Detection[] = [];
  const toBox = (i: number, xyxy: boolean, pixels: boolean): Box => {
    const v = [0, 1, 2, 3].map((k) => num(boxesT.data[i * 4 + k]));
    const s = pixels ? 1 : size;
    if (xyxy) return [v[0] * s, v[1] * s, (v[2] - v[0]) * s, (v[3] - v[1]) * s];
    return [(v[0] - v[2] / 2) * s, (v[1] - v[3] / 2) * s, v[2] * s, v[3] * s];
  };
  let maxCoord = 0;
  for (let i = 0; i < boxesT.data.length; i++) maxCoord = Math.max(maxCoord, Math.abs(num(boxesT.data[i])));
  const pixels = maxCoord > 2;
  if (logitsT) {
    const c = last(logitsT);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < logitsT.data.length; i++) {
      const v = num(logitsT.data[i]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Raw logits (the usual export); an export that already applies the sigmoid stays as it is.
    const prob = lo < 0 || hi > 1 ? sigmoid : (x: number) => x;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < Math.min(c, DETECTOR_LABELS.length); k++) {
        const score = prob(num(logitsT.data[i * c + k]));
        if (score >= minScore) out.push({ box: toBox(i, false, pixels), kind: DETECTOR_LABELS[k], score });
      }
    }
  } else {
    const rest = outs.filter((o) => o !== boxesT);
    const labelsT = by(/label/i) ?? rest.find((o) => o.data instanceof BigInt64Array || o.data instanceof Int32Array);
    const scoresT = by(/score/i) ?? rest.find((o) => o !== labelsT);
    if (!labelsT || !scoresT) throw new Error('detector: unknown outputs');
    for (let i = 0; i < n; i++) {
      const score = num(scoresT.data[i]);
      const kind = DETECTOR_LABELS[num(labelsT.data[i])];
      if (kind && score >= minScore) out.push({ box: toBox(i, true, pixels), kind, score });
    }
  }
  return out.filter((d) => d.box[2] > 1 && d.box[3] > 1);
}

/** Text boxes go with text boxes (either class), bubbles with bubbles. */
const group = (k: DetectionKind) => (k === 'bubble' ? 0 : 1);

/**
 * Non-maximum suppression per group (IoU above `thr`). A box cut by the edge of a window inside
 * the page (`cut`) also gives way to a box from another window that holds most of it.
 */
export function mergeDetections(items: (Detection & { cut?: boolean })[], thr = 0.5): Detection[] {
  const sorted = [...items].sort((a, b) => +!!a.cut - +!!b.cut || b.score - a.score);
  const kept: (Detection & { cut?: boolean })[] = [];
  for (const d of sorted) {
    const clash = kept.some((k) => {
      if (group(k.kind) !== group(d.kind)) return false;
      if (iou(k.box, d.box) > thr) return true;
      if (!d.cut) return false;
      const inter = interArea(k.box, d.box);
      return inter >= boxArea(d.box) * 0.7;
    });
    if (!clash) kept.push(d);
  }
  return kept.map(({ box, kind, score }) => ({ box, kind, score }));
}

function interArea(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/**
 * Run the detector over the page: each window is scaled to 640×640, the boxes are mapped back to
 * page pixels, weak ones dropped (text < 0.35, bubbles < 0.4) and the windows' boxes merged.
 */
export async function detectPage(image: TiledImage, detect: TextDetector, backend: ImageBackend, signal?: AbortSignal): Promise<Detection[]> {
  const all: (Detection & { cut?: boolean })[] = [];
  const S = DETECTOR_SIZE;
  for (const win of detectorWindows(image.width, image.height)) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const canvas = backend.createCanvas(S, S);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    image.drawRegion(ctx, win.x, win.y, win.w, win.h, S, S);
    const px: PixelData = ctx.getImageData(0, 0, S, S);
    const { boxes } = await detect(px, signal);
    const sx = win.w / px.width;
    const sy = win.h / px.height;
    for (const d of boxes) {
      if (d.score < (isTextKind(d.kind) ? TEXT_MIN : BUBBLE_MIN)) continue;
      const raw: Box = [win.x + d.box[0] * sx, win.y + d.box[1] * sy, d.box[2] * sx, d.box[3] * sy];
      const box = clampBox(raw, image.width, image.height);
      // Touches a window edge that is not the page's edge: probably cut in two by the window.
      const m = 3;
      const cut =
        (win.y > 0 && raw[1] <= win.y + m) ||
        (win.y + win.h < image.height && raw[1] + raw[3] >= win.y + win.h - m) ||
        (win.x > 0 && raw[0] <= win.x + m) ||
        (win.x + win.w < image.width && raw[0] + raw[2] >= win.x + win.w - m);
      all.push({ box, kind: d.kind, score: d.score, ...(cut ? { cut: true } : {}) });
    }
  }
  return mergeDetections(all, 0.5);
}

/** The text check by the detector: no text box of 0.4 or more → the page has no lettering. */
export function detectorFindsText(dets: Detection[]): boolean {
  return dets.some((d) => isTextKind(d.kind) && d.score >= TEXT_PRESENT);
}

const inter = (a: Box, b: Box): Box | null => {
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

/** Does the detector's text box belong to the block's box (one mostly inside the other, or a fair overlap)? */
function hits(block: Box, det: Box): boolean {
  const i = interArea(block, det);
  if (!i) return false;
  return i >= boxArea(det) * 0.6 || i >= boxArea(block) * 0.6 || iou(block, det) >= 0.3;
}

/**
 * Snap the model's boxes to the detector's text boxes: a block takes the box(es) of the lettering
 * it covers; a text box several blocks share is cut to each block's part. Sound effects keep their
 * own box (the detector has no class for them). Returns the ids of the blocks that moved.
 */
export function snapBlocksToDetections(blocks: TextBlock[], dets: Detection[], width: number, height: number): Set<string> {
  const texts = dets.filter((d) => isTextKind(d.kind));
  const moved = new Set<string>();
  if (!texts.length) return moved;
  const usable = blocks.filter((b) => b.textType !== 'SFX');
  const claims = texts.map((d) => usable.filter((b) => hits(b.bbox, d.box)).length);
  for (const b of usable) {
    let target: Box | null = null;
    texts.forEach((d, i) => {
      if (!hits(b.bbox, d.box)) return;
      const part = claims[i] > 1 ? inter(d.box, b.bbox) : d.box;
      if (part) target = target ? union(target, part) : part;
    });
    if (!target) continue;
    const box = clampBox(expandBox(target, 2), width, height);
    if (box.every((v, k) => v === b.bbox[k])) continue;
    b.bbox = box;
    b.polygon = [
      [box[0], box[1]],
      [box[0] + box[2], box[1]],
      [box[0] + box[2], box[1] + box[3]],
      [box[0], box[1] + box[3]],
    ];
    moved.add(b.id);
  }
  return moved;
}

/**
 * A detector text box near a block whose box holds no lettering (the model put it beside the
 * bubble): the nearest one within reach that no other block covers, or null.
 */
export function detectedTextNear(b: TextBlock, blocks: TextBlock[], dets: Detection[], width: number): Box | null {
  const reach = width * 0.6;
  const cx = b.bbox[0] + b.bbox[2] / 2;
  const cy = b.bbox[1] + b.bbox[3] / 2;
  const taken = blocks.filter((o) => o !== b).flatMap((o) => (o.textBox ? [o.bbox, o.textBox] : [o.bbox]));
  let best: Box | null = null;
  let bestD = Infinity;
  for (const d of dets) {
    if (!isTextKind(d.kind)) continue;
    if (taken.some((t) => interArea(t, d.box) > boxArea(d.box) * 0.3)) continue;
    const dist = Math.hypot(d.box[0] + d.box[2] / 2 - cx, d.box[1] + d.box[3] / 2 - cy);
    if (dist <= reach && dist < bestD) {
      best = d.box;
      bestD = dist;
    }
  }
  return best;
}

/** The detector's bubble holding the block's box (the smallest such), or undefined. */
export function bubbleAround(box: Box, dets: Detection[]): Box | undefined {
  let best: Box | undefined;
  for (const d of dets) {
    if (d.kind !== 'bubble' || d.score < BUBBLE_MIN) continue;
    if (interArea(box, d.box) < boxArea(box) * 0.7) continue;
    if (!best || boxArea(d.box) < boxArea(best)) best = d.box;
  }
  return best;
}

/** The bubble the detector saw, as an ellipse inscribed in its box (for the layout only). */
export function ellipseBubble(box: Box, fill: string, width: number, height: number): BubbleInfo {
  const inset = 0.12;
  const safe: Box = [box[0] + box[2] * inset, box[1] + box[3] * inset, box[2] * (1 - 2 * inset), box[3] * (1 - 2 * inset)];
  return { box: [...box] as Box, fill, safeArea: clampBox(safe.map(Math.round) as Box, width, height), shape: 'ellipse' };
}

/** Confident text boxes no block covers: the model skipped them (at most `max`, best first). */
export function missedText(blocks: TextBlock[], dets: Detection[], max = MISSED_MAX): Box[] {
  const known = blocks.flatMap((b) => (b.textBox ? [b.bbox, b.textBox] : [b.bbox]));
  return dets
    .filter((d) => isTextKind(d.kind) && d.score >= MISSED_MIN)
    .filter((d) => !known.some((k) => interArea(k, d.box) > boxArea(d.box) * 0.25))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((d) => d.box);
}
