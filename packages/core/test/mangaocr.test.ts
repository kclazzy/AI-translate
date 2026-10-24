/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { mangaOcrInput, mangaOcrRead, mangaOcrText, type MangaOcrRun } from '../src/ocr/mangaOcr';

// The real networks: MANGA_OCR_MODELS=folder with manga-ocr-{encoder,decoder}-<kind>.onnx and manga-ocr-vocab.txt.
const DIR = process.env.MANGA_OCR_MODELS ?? '';
const KIND = process.env.MANGA_OCR_KIND ?? 'int8';
const have = !!DIR && existsSync(`${DIR}/manga-ocr-encoder-${KIND}.onnx`);

describe('Manga OCR: the parts around the networks', () => {
  it('grey picture 224×224 in −1…1, the same in the three channels', () => {
    const data = new Uint8ClampedArray(10 * 10 * 4).fill(255);
    const t = mangaOcrInput({ width: 10, height: 10, data });
    expect(t.dims).toEqual([1, 3, 224, 224]);
    expect(t.data[0]).toBeCloseTo(1, 3);
    expect(t.data[224 * 224 * 2 + 5]).toBeCloseTo(1, 3);
  });

  it('tokens back to text: specials dropped, word pieces joined, ASCII full-width, dots kept', () => {
    const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]', 'こん', '##にちは', '!', '…', '1'];
    expect(mangaOcrText([2, 5, 6, 7, 8, 9], vocab)).toBe('こんにちは！．．．１');
  });

  it('writes until the end token and stops a decoder that repeats itself', async () => {
    const V = 8;
    const seq = [5, 6, 3];
    let step = 0;
    const logitsFor = (n: number, tok: number) => {
      const data = new Float32Array(n * V);
      data[(n - 1) * V + tok] = 1;
      return { data, dims: [1, n, V] };
    };
    const run: MangaOcrRun = async (net, inputs) => {
      if (net === 'encoder') return { data: new Float32Array(4), dims: [1, 1, 4] };
      const n = (inputs.input_ids.dims as number[])[1];
      return logitsFor(n, seq[step++]);
    };
    const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]', 'あ', 'い', 'う'];
    const r = await mangaOcrRead({ width: 20, height: 60, data: new Uint8ClampedArray(20 * 60 * 4) }, run, vocab);
    expect(r.text).toBe('あい');
    expect(r.lines[0].vertical).toBe(true);
    let calls = 0;
    const stuck: MangaOcrRun = async (net, inputs) => (net === 'encoder' ? { data: new Float32Array(4), dims: [1, 1, 4] } : (calls++, logitsFor((inputs.input_ids.dims as number[])[1], 7)));
    expect((await mangaOcrRead({ width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) }, stuck, vocab)).text).toMatch(/^う+$/);
    expect(calls).toBeLessThan(20);
  });
});

describe.skipIf(!have)('Manga OCR networks (local check)', () => {
  it('reads a vertical Japanese bubble', async () => {
    const ort: any = await import(process.env.ORT_WEB ?? 'onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const enc = await ort.InferenceSession.create(readFileSync(`${DIR}/manga-ocr-encoder-${KIND}.onnx`));
    const dec = await ort.InferenceSession.create(readFileSync(`${DIR}/manga-ocr-decoder-${KIND}.onnx`));
    const vocab = readFileSync(`${DIR}/manga-ocr-vocab.txt`, 'utf8').split(/\r?\n/);
    const font = process.env.JA_FONT;
    if (font) GlobalFonts.registerFromPath(font, 'JA');
    const c = createCanvas(140, 300);
    const g = c.getContext('2d') as any;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 140, 300);
    g.fillStyle = '#000';
    g.font = '40px JA, "Noto Sans CJK JP", sans-serif';
    // Two columns, read right to left: 「なにを」「してる」.
    [...'なにを'].forEach((ch, i) => g.fillText(ch, 80, 60 + i * 48));
    [...'してる'].forEach((ch, i) => g.fillText(ch, 20, 60 + i * 48));
    const px = g.getImageData(0, 0, 140, 300);
    const run: MangaOcrRun = async (net, inputs) => {
      const s = net === 'encoder' ? enc : dec;
      const feeds: Record<string, any> = {};
      for (const [k, t] of Object.entries(inputs)) feeds[k] = new ort.Tensor(t.data instanceof BigInt64Array ? 'int64' : 'float32', t.data, t.dims);
      const out = await s.run(feeds);
      const o = out[net === 'decoder' && out.logits ? 'logits' : s.outputNames[0]];
      return { data: o.data as Float32Array, dims: [...o.dims] };
    };
    const t0 = performance.now();
    const r = await mangaOcrRead({ width: 140, height: 300, data: px.data }, run, vocab);
    console.log(`manga-ocr ${KIND}: «${r.text}» in ${Math.round(performance.now() - t0)} ms`);
    expect(r.text).toBe('なにをしてる');
  }, 120000);
});

describe('Manga OCR with a cache', () => {
  it('one step per character: the cache grows, the masked first column stays, the text is the same', async () => {
    const { mangaOcrReadCached } = await import('../src/ocr/mangaOcr');
    const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '[MASK]', 'な', 'に', 'し'];
    const want = [5, 6, 7, 3];
    const seen: { pos: number; mask: number[]; past: number }[] = [];
    const nets = {
      encode: async () => ({ data: new Float32Array(197 * 768), dims: [1, 197, 768] }),
      cross: async () => Array.from({ length: 4 }, () => ({ data: new Float32Array(12 * 197 * 64), dims: [1, 12, 197, 64] })),
      step: async ({ pos, mask, past }: { id: number; pos: number; mask: BigInt64Array; past: { dims: number[] }[] }) => {
        seen.push({ pos, mask: [...mask].map(Number), past: past[0].dims[2] });
        const logits = new Float32Array(vocab.length);
        logits[want[pos]] = 1;
        const p = past[0].dims[2] + 1;
        return { logits: { data: logits, dims: [1, 1, vocab.length] }, present: Array.from({ length: 4 }, () => ({ data: new Float32Array(12 * p * 64), dims: [1, 12, p, 64] })) };
      },
    };
    const r = await mangaOcrReadCached({ width: 100, height: 300, data: new Uint8ClampedArray(100 * 300 * 4).fill(255) }, nets, vocab);
    expect(r.text).toBe('なにし');
    expect(r.lines[0].vertical).toBe(true);
    expect(seen.map((s) => s.pos)).toEqual([0, 1, 2, 3]);
    expect(seen.map((s) => s.past)).toEqual([1, 2, 3, 4]);
    expect(seen[2].mask).toEqual([0, 1, 1, 1]);
  });
});
