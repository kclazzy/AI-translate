import type { PixelData } from '../image/backend';
import type { Box } from '../types';

/**
 * Text recognition without a model that reads pictures: PaddleOCR (PP-OCR, Apache-2.0) networks
 * run in the browser — one finds the lines of text in a piece of the page (DB detector), the other
 * reads each line (CTC recogniser). The networks themselves are run by the caller (`run`), so the
 * same code works with ONNX Runtime in the browser, in tests and on a phone.
 */

export interface OcrTensor {
  data: Float32Array;
  dims: number[];
}

export type OcrRun = (net: 'det' | 'rec', input: OcrTensor) => Promise<OcrTensor>;

export interface OcrLine {
  /** In the coordinates of the piece read. */
  box: Box;
  text: string;
  /** Mean probability of the characters (0–1). */
  score: number;
  vertical: boolean;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
}

/** Bilinear resize of RGBA pixels. */
export function resizeRgba(px: PixelData, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = px.width / w;
  const sy = px.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(px.height - 1, Math.floor(fy));
    const y1 = Math.min(px.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(px.width - 1, Math.floor(fx));
      const x1 = Math.min(px.width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = px.data[(y0 * px.width + x0) * 4 + c] * (1 - wx) + px.data[(y0 * px.width + x1) * 4 + c] * wx;
        const b = px.data[(y1 * px.width + x0) * 4 + c] * (1 - wx) + px.data[(y1 * px.width + x1) * 4 + c] * wx;
        out[(y * w + x) * 4 + c] = a * (1 - wy) + b * wy;
      }
    }
  }
  return out;
}

function crop(px: PixelData, b: Box): PixelData {
  const [x, y, w, h] = b;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) data.set(px.data.subarray(((y + r) * px.width + x) * 4, ((y + r) * px.width + x + w) * 4), r * w * 4);
  return { width: w, height: h, data };
}

/** Turn a column of vertical text a quarter to the left, so it reads as a line (as PaddleOCR does). */
function rotateLeft(px: PixelData): PixelData {
  const { width: w, height: h } = px;
  const data = new Uint8ClampedArray(w * h * 4);
  // new (x', y') = (y, w - 1 - x); new width = h, height = w
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((w - 1 - x) * h + y) * 4;
      data[d] = px.data[s];
      data[d + 1] = px.data[s + 1];
      data[d + 2] = px.data[s + 2];
      data[d + 3] = px.data[s + 3];
    }
  }
  return { width: h, height: w, data };
}

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

/** The detector's input: the piece scaled so its sides are multiples of 32 (longest at most `maxSide`), BGR, normalised. */
export function detInput(px: PixelData, maxSide = 960): { input: OcrTensor; w: number; h: number } {
  const k = Math.min(1, maxSide / Math.max(px.width, px.height));
  const w = Math.max(32, Math.round((px.width * k) / 32) * 32);
  const h = Math.max(32, Math.round((px.height * k) / 32) * 32);
  const rgba = resizeRgba(px, w, h);
  const data = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++) {
    // BGR order, as the networks were trained on OpenCV pictures.
    for (let c = 0; c < 3; c++) data[c * w * h + i] = (rgba[i * 4 + (2 - c)] / 255 - DET_MEAN[c]) / DET_STD[c];
  }
  return { input: { data, dims: [1, 3, h, w] }, w, h };
}

/**
 * Lines of text from the detector's probability map: connected areas over `thresh`, kept when their
 * mean probability passes `boxThresh`, grown back by `unclip` (the network draws lines shrunk) and
 * scaled to the piece's pixels.
 */
export function detBoxes(prob: Float32Array, w: number, h: number, scaleX: number, scaleY: number, opts: { thresh?: number; boxThresh?: number; unclip?: number; minSize?: number } = {}): Box[] {
  const thresh = opts.thresh ?? 0.3;
  const boxThresh = opts.boxThresh ?? 0.5;
  const unclip = opts.unclip ?? 1.6;
  const minSize = opts.minSize ?? 3;
  const seen = new Uint8Array(w * h);
  const out: Box[] = [];
  const stack: number[] = [];
  for (let p = 0; p < w * h; p++) {
    if (seen[p] || prob[p] <= thresh) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, n = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % w;
      const y = (q - x) / w;
      sum += prob[q];
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const r of [q - 1, q + 1, q - w, q + w]) {
        if (r < 0 || r >= w * h || seen[r] || prob[r] <= thresh) continue;
        if ((r === q - 1 && x === 0) || (r === q + 1 && x === w - 1)) continue;
        seen[r] = 1;
        stack.push(r);
      }
    }
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < minSize || sum / n < boxThresh) continue;
    // Unclip: grow by area × ratio / perimeter on every side (the DB network shrinks text regions).
    const d = (bw * bh * unclip) / (2 * (bw + bh));
    out.push([Math.max(0, (x0 - d) * scaleX), Math.max(0, (y0 - d) * scaleY), (bw + 2 * d) * scaleX, (bh + 2 * d) * scaleY]);
  }
  return out;
}

export const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 2400;

/** Lines for the recogniser: each scaled to 48 px high, padded to the widest, BGR, normalised to −1…1. */
export function recInput(lines: PixelData[]): OcrTensor {
  const widths = lines.map((l) => Math.min(REC_MAX_WIDTH, Math.max(8, Math.ceil((REC_HEIGHT * l.width) / Math.max(1, l.height)))));
  const W = Math.max(...widths);
  const H = REC_HEIGHT;
  const data = new Float32Array(lines.length * 3 * H * W);
  for (const [n, l] of lines.entries()) {
    const w = widths[n];
    const rgba = resizeRgba(l, w, H);
    const base = n * 3 * H * W;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) data[base + c * H * W + y * W + x] = (rgba[i + (2 - c)] / 255 - 0.5) / 0.5;
      }
    }
  }
  return { data, dims: [lines.length, 3, H, W] };
}

/** Greedy CTC: the most likely class per step, repeats joined, blanks (class 0) dropped. */
export function ctcDecode(out: OcrTensor, dict: string[]): { text: string; score: number }[] {
  const [N, T, C] = out.dims;
  const res: { text: string; score: number }[] = [];
  for (let n = 0; n < N; n++) {
    let text = '';
    let prev = -1;
    let sum = 0;
    let k = 0;
    for (let t = 0; t < T; t++) {
      const base = (n * T + t) * C;
      let best = 0;
      let bp = out.data[base];
      for (let c = 1; c < C; c++) if (out.data[base + c] > bp) (bp = out.data[base + c]), (best = c);
      if (best !== 0 && best !== prev) {
        // Class i is dict[i - 1]; the class after the dictionary is a space.
        text += best - 1 < dict.length ? dict[best - 1] : ' ';
        sum += bp;
        k++;
      }
      prev = best;
    }
    res.push({ text: text.replace(/\s+/g, ' ').trim(), score: k ? sum / k : 0 });
  }
  return res;
}

/**
 * Read the text of one piece of a page (a bubble, a caption): its lines found, read and put in
 * reading order — top to bottom for lines, right to left for vertical columns.
 */
export async function readPiece(px: PixelData, run: OcrRun, dict: string[], opts: { minScore?: number } = {}): Promise<OcrResult> {
  const det = detInput(px);
  const prob = await run('det', det.input);
  const [, , ph, pw] = prob.dims.length === 4 ? prob.dims : [1, 1, det.h, det.w];
  const boxes = detBoxes(prob.data, pw, ph, px.width / pw, px.height / ph)
    .map((b) => {
      const x = Math.max(0, Math.floor(b[0]));
      const y = Math.max(0, Math.floor(b[1]));
      return [x, y, Math.max(1, Math.min(px.width - x, Math.ceil(b[2]))), Math.max(1, Math.min(px.height - y, Math.ceil(b[3])))] as Box;
    })
    .filter((b) => b[2] >= 4 && b[3] >= 4);
  if (!boxes.length) return { text: '', lines: [] };
  const vertical = boxes.map((b) => b[3] >= b[2] * 1.5);
  const crops = boxes.map((b, i) => (vertical[i] ? rotateLeft(crop(px, b)) : crop(px, b)));
  // Lines of a similar length go together (less padding), at most 16 at a time.
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height);
  const read: { text: string; score: number }[] = new Array(crops.length);
  for (let i = 0; i < order.length; i += 16) {
    const group = order.slice(i, i + 16);
    const out = await run('rec', recInput(group.map((j) => crops[j])));
    const dims = out.dims.length === 3 ? out.dims : [group.length, out.data.length / group.length / dict.length, dict.length];
    for (const [k, r] of ctcDecode({ data: out.data, dims }, dict).entries()) read[group[k]] = r;
  }
  const minScore = opts.minScore ?? 0.5;
  const lines: OcrLine[] = boxes
    .map((box, i) => ({ box, text: read[i].text, score: read[i].score, vertical: vertical[i] }))
    .filter((l) => l.text && l.score >= minScore);
  const columns = lines.filter((l) => l.vertical).length > lines.length / 2;
  lines.sort((a, b) =>
    columns
      ? b.box[0] + b.box[2] - (a.box[0] + a.box[2])
      : Math.abs(a.box[1] - b.box[1]) < Math.min(a.box[3], b.box[3]) * 0.5
        ? a.box[0] - b.box[0]
        : a.box[1] - b.box[1],
  );
  // CJK lines join without spaces; others with one.
  const cjk = /[぀-ヿ㐀-鿿]/.test(lines.map((l) => l.text).join(''));
  return { text: lines.map((l) => l.text).join(cjk ? '' : ' ').replace(/\s+/g, ' ').trim(), lines };
}

/**
 * Key–value metadata of an ONNX model (ModelProto field 14), read from the file's bytes without a
 * protobuf library: the recogniser keeps its alphabet there ('character', one per line).
 */
export function onnxMetadata(bytes: Uint8Array): Record<string, string> {
  let p = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = bytes[p++];
      v += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  };
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  while (p < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) varint();
    else if (wire === 1) p += 8;
    else if (wire === 5) p += 4;
    else if (wire === 2) {
      const len = varint();
      if (field === 14) {
        // StringStringEntryProto: key = 1, value = 2.
        const end = p + len;
        let k = '';
        let v = '';
        while (p < end) {
          const kk = varint();
          const l = varint();
          const s = dec.decode(bytes.subarray(p, p + l));
          p += l;
          if (kk >> 3 === 1) k = s;
          else if (kk >> 3 === 2) v = s;
        }
        out[k] = v;
      } else p += len;
    } else break;
  }
  return out;
}

/** The recogniser's alphabet from its metadata. */
export function recDictionary(bytes: Uint8Array): string[] | null {
  const ch = onnxMetadata(bytes).character;
  return ch ? ch.split('\n') : null;
}
