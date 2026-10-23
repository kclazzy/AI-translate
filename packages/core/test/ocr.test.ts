/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { ctcDecode, detBoxes, readPiece, recDictionary } from '../src/ocr/paddle';

// The real networks (PP-OCRv6 small): only where they are at hand (OCR_MODELS=folder with the .onnx files).
const DIR = process.env.OCR_MODELS ?? '';
const have = !!DIR && existsSync(`${DIR}/PP-OCRv6_rec_small.onnx`);

describe('PaddleOCR in the browser: the parts around the networks', () => {
  it('CTC: repeats joined, blanks dropped, the class after the alphabet is a space', () => {
    const dict = ['A', 'B'];
    // steps: A A blank B space B → "AB B"
    const seq = [1, 1, 0, 2, 3, 2];
    const C = 4;
    const data = new Float32Array(seq.length * C);
    seq.forEach((c, t) => (data[t * C + c] = 0.9));
    expect(ctcDecode({ data, dims: [1, seq.length, C] }, dict)[0].text).toBe('AB B');
  });

  it('lines from the probability map, grown back to the letters', () => {
    const w = 40, h = 20;
    const prob = new Float32Array(w * h);
    for (let y = 5; y < 9; y++) for (let x = 5; x < 30; x++) prob[y * w + x] = 0.9;
    const boxes = detBoxes(prob, w, h, 2, 2);
    expect(boxes).toHaveLength(1);
    const [x, y, bw, bh] = boxes[0];
    expect(x).toBeLessThan(10);
    expect(y).toBeLessThan(10);
    expect(bw).toBeGreaterThan(50);
    expect(bh).toBeGreaterThan(8);
  });
});

describe.skipIf(!have)('PaddleOCR networks (local check)', () => {
  it('reads a bubble of two lines', async () => {
    const ort: any = await import(process.env.ORT_WEB ?? 'onnxruntime-web');
    ort.env.wasm.numThreads = 1;
    const det = await ort.InferenceSession.create(readFileSync(`${DIR}/PP-OCRv6_det_small.onnx`));
    const recBytes = readFileSync(`${DIR}/PP-OCRv6_rec_small.onnx`);
    const rec = await ort.InferenceSession.create(recBytes);
    const dict = recDictionary(new Uint8Array(recBytes))!;
    expect(dict.length).toBeGreaterThan(10000);
    const c = createCanvas(420, 200);
    const g = c.getContext('2d') as any;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 420, 200);
    g.fillStyle = '#000';
    g.font = 'bold 34px sans-serif';
    g.fillText('WHAT ARE YOU', 40, 80);
    g.fillText('DOING HERE?', 50, 130);
    const px = g.getImageData(0, 0, 420, 200);
    const run = async (net: 'det' | 'rec', t: { data: Float32Array; dims: number[] }) => {
      const s = net === 'det' ? det : rec;
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t.data, t.dims) });
      const o = out[s.outputNames[0]];
      return { data: o.data as Float32Array, dims: [...o.dims] };
    };
    const r = await readPiece({ width: 420, height: 200, data: px.data }, run, dict);
    expect(r.text).toBe('WHAT ARE YOU DOING HERE?');
  }, 60000);
});
