import type { PixelData } from '../image/backend';
import type { OcrResult, OcrTensor } from './paddle';
import { resizeRgba } from './paddle';

/**
 * Manga OCR (kha-white/manga-ocr-base, Apache-2.0): reads a whole Japanese bubble at once —
 * vertical or horizontal, several lines, furigana ignored — far better than a line reader on
 * manga. A picture encoder (ViT, 224×224 grey) and a text decoder that writes one token at a time.
 * The ONNX export is the one Koharu uses (mayocream/manga-ocr-onnx). The networks are run by the
 * caller, as for PaddleOCR.
 */
export type MangaOcrRun = (net: 'encoder' | 'decoder', inputs: Record<string, OcrTensor | { data: BigInt64Array; dims: number[] }>) => Promise<OcrTensor>;

export const MANGA_OCR_SIZE = 224;
const START = 2; // [CLS]
const END = 3; // [SEP]
const FIRST_TEXT = 5; // below: [PAD] [UNK] [CLS] [SEP] [MASK]

/** The picture as the encoder takes it: grey, 224×224, scaled to −1…1. */
export function mangaOcrInput(px: PixelData): OcrTensor {
  const S = MANGA_OCR_SIZE;
  const rgba = resizeRgba(px, S, S);
  const data = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    // Grey as Pillow's convert('L'): 299/587/114.
    const g = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    const v = (g / 255 - 0.5) / 0.5;
    data[i] = v;
    data[S * S + i] = v;
    data[2 * S * S + i] = v;
  }
  return { data, dims: [1, 3, S, S] };
}

/** Token ids back to text, as manga-ocr does it: word pieces joined, no spaces, ASCII made full-width. */
export function mangaOcrText(ids: number[], vocab: string[]): string {
  let text = '';
  for (const id of ids) {
    if (id < FIRST_TEXT) continue;
    const t = vocab[id];
    if (t === undefined || /^\[.*\]$/.test(t)) continue;
    text += t.startsWith('##') ? t.slice(2) : t;
  }
  text = text.replace(/\s+/g, '').replace(/…/g, '...');
  text = text.replace(/[・.]{2,}/g, (m) => '.'.repeat(m.length));
  // jaconv.h2z(ascii=True, digit=True): ! … ~ to their full-width forms.
  return text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
}

function argmaxLast(out: OcrTensor): number {
  const [, n, v] = out.dims;
  const off = (n - 1) * v;
  let best = 0;
  let bestV = -Infinity;
  for (let i = 0; i < v; i++) {
    const x = out.data[off + i];
    if (x > bestV) {
      bestV = x;
      best = i;
    }
  }
  return best;
}

/** Read one piece of a page (a bubble). `maxTokens` stops a decoder that does not end. */
export async function mangaOcrRead(px: PixelData, run: MangaOcrRun, vocab: string[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<OcrResult> {
  const hidden = await run('encoder', { pixel_values: mangaOcrInput(px) });
  const ids = [START];
  const max = opts.maxTokens ?? 120;
  // One token at a time; a bubble is short (a few dozen tokens), so no cache of the past is kept.
  for (let i = 0; i < max; i++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const logits = await run('decoder', {
      encoder_hidden_states: hidden,
      input_ids: { data: BigInt64Array.from(ids.map(BigInt)), dims: [1, ids.length] },
    });
    const next = argmaxLast(logits);
    if (next === END) break;
    ids.push(next);
    // The same token over and over: the decoder is lost (an empty or noisy piece).
    if (ids.length > 12 && ids.slice(-8).every((t) => t === next)) break;
  }
  const text = mangaOcrText(ids, vocab);
  const vertical = px.height > px.width * 1.2;
  return { text, lines: text ? [{ box: [0, 0, px.width, px.height], text, score: 1, vertical }] : [] };
}


/**
 * The networks of Manga OCR read with a cache (models-3, see scripts/models/manga_ocr_kv.py): the
 * picture's features become the cross-attention's keys and values once per bubble, and each next
 * character is one small step with the cache of the steps before — instead of running the whole
 * text against the picture again for every character.
 */
export interface MangaOcrNets {
  encode(input: OcrTensor): Promise<OcrTensor>;
  /** Keys and values of the cross-attention of both layers (ck0, cv0, ck1, cv1). */
  cross(hidden: OcrTensor): Promise<OcrTensor[]>;
  /** One character: its id and place, the mask over the cache, the cache (k0, v0, k1, v1) → scores and the cache with it. */
  step(input: { id: number; pos: number; mask: BigInt64Array; past: OcrTensor[]; cross: OcrTensor[] }): Promise<{ logits: OcrTensor; present: OcrTensor[] }>;
}

const KV_HEADS = 12;
const KV_DIM = 64;

export async function mangaOcrReadCached(px: PixelData, nets: MangaOcrNets, vocab: string[], opts: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<OcrResult> {
  const hidden = await nets.encode(mangaOcrInput(px));
  const cross = await nets.cross(hidden);
  // A first column that is masked out keeps every shape non-empty.
  let past: OcrTensor[] = Array.from({ length: 4 }, () => ({ data: new Float32Array(KV_HEADS * KV_DIM), dims: [1, KV_HEADS, 1, KV_DIM] }));
  const ids = [START];
  const max = opts.maxTokens ?? 120;
  for (let t = 0; t < max; t++) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const mask = new BigInt64Array(t + 2).fill(1n);
    mask[0] = 0n;
    const { logits, present } = await nets.step({ id: ids[ids.length - 1], pos: t, mask, past, cross });
    past = present;
    const next = argmaxLast(logits);
    if (next === END) break;
    ids.push(next);
    if (ids.length > 12 && ids.slice(-8).every((x) => x === next)) break;
  }
  const text = mangaOcrText(ids, vocab);
  const vertical = px.height > px.width * 1.2;
  return { text, lines: text ? [{ box: [0, 0, px.width, px.height], text, score: 1, vertical }] : [] };
}
