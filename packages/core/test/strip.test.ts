/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset, defaultSettings, planChunks, planChunksBy, TranslateService, type StoredResult } from '../src';
import { mockOpenAi, napiBackend, toNorm } from './helpers';

const W = 800;
const H = 1000;

/** One webtoon strip cut by the "site" into two pictures right through a speech bubble. */
async function cutStrip(): Promise<Uint8Array[]> {
  const c = createCanvas(W, H * 2);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#c9d3df';
  ctx.fillRect(0, 0, W, H * 2);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(400, 1000, 260, 150, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 34px TestSans';
  ctx.textAlign = 'center';
  ctx.fillText('WAIT FOR ME,', 400, 975);
  ctx.fillText('I AM COMING!', 400, 1045);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) {
    const p = createCanvas(W, H);
    p.getContext('2d').drawImage(c as any, 0, -i * H);
    parts.push(new Uint8Array(await p.encode('png')));
  }
  return parts;
}

function memoryDb() {
  const m = new Map<string, unknown>();
  return {
    get: async (s: string, k: string) => m.get(`${s}/${k}`),
    put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, structuredClone(v)),
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    entries: async () => [],
  } as any;
}

describe('pictures of one strip translated together', () => {
  it('chunks: tall enough and at a calm seam, never past the maximum', () => {
    expect(planChunks([1000, 1000, 1000, 1000], [true, true, true, true], 2500, 8000)).toEqual([[0, 1, 2], [3]]);
    // Something is drawn across the seam after picture 2: keep going.
    expect(planChunks([1000, 1000, 1000, 1000], [true, true, false, true], 2500, 8000)).toEqual([[0, 1, 2, 3]]);
    expect(planChunks([3000, 3000, 3000], [false, false, true], 1000, 5000)).toEqual([[0], [1], [2]]);
  });

  it('a bubble cut in half by the site is translated once and drawn across both pictures', async () => {
    const parts = await cutStrip();
    const mock = mockOpenAi((body) => {
      const hasImage = JSON.stringify(body).includes('image');
      expect(hasImage).toBe(true);
      // The model sees the whole bubble: one block in the glued page (800×2000).
      return JSON.stringify({ blocks: [{ box: toNorm([250, 940, 300, 120], W, H * 2), text: 'WAIT FOR ME, I AM COMING!', translation: 'ПОДОЖДИ МЕНЯ, Я ИДУ!', type: 'DIALOGUE', vertical: false }], entities: [], summary: '' });
    });
    const settings = {
      ...defaultSettings(),
      providers: [{ ...configFromPreset('lmstudio', 'vlm'), id: 'v', vision: true }],
      visionProviderId: 'v',
      translatorProviderId: null,
      twoStepTranslation: false,
      qaMode: 'off' as const,
      targetLang: 'ru',
      sourceLang: 'en',
      fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' },
    } as any;
    const secrets = { get: async () => undefined } as any;
    const svc = new TranslateService(memoryDb(), secrets, napiBackend, async () => settings, mock.fetchImpl);
    const got: StoredResult[] = [];
    await svc.translateStrip(parts.map((bytes) => ({ bytes, mime: 'image/png' })), { generic: true, onPart: (i, r) => (got[i] = r) });
    expect(mock.calls.length).toBe(1);
    expect(got.map((r) => r.page.height)).toEqual([H, H]);
    // The block belongs to one picture (the one holding the centre of its text) and, as its text
    // crosses the seam, the other picture carries a copy marked `continued`.
    expect(got.map((r) => r.page.blocks.length)).toEqual([1, 1]);
    expect(got.map((r) => !!r.page.blocks[0].continued).sort()).toEqual([false, true]);
    // Both halves of the bubble lost the English lettering (the second half was not "missed").
    for (const [i, r] of got.entries()) {
      const img = await napiBackend.decode(r.cleaned[0].bytes, 'image/png');
      const c = createCanvas(W, img.height);
      c.getContext('2d').drawImage(img.source as any, 0, 0);
      const y = i === 0 ? 950 : 20;
      const d = c.getContext('2d').getImageData(220, y, 360, 40).data;
      let dark = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] < 90 && d[k + 1] < 90 && d[k + 2] < 90) dark++;
      expect(dark, `picture ${i}`).toBeLessThan(30);
    }
    // The second picture now carries the lower half of the Russian text.
    const r1 = await napiBackend.decode(got[1].rendered[0].bytes);
    const c1 = createCanvas(W, r1.height);
    c1.getContext('2d').drawImage(r1.source as any, 0, 0);
    const d1 = c1.getContext('2d').getImageData(220, 0, 360, 120).data;
    let ink = 0;
    for (let k = 0; k < d1.length; k += 4) if (d1[k] < 90) ink++;
    expect(ink).toBeGreaterThan(50);

    // A second run takes every picture from the cache, without asking the model again.
    const again: boolean[] = [];
    await svc.translateStrip(parts.map((bytes) => ({ bytes, mime: 'image/png' })), { generic: true, onPart: (i, _r, cached) => (again[i] = cached) });
    expect(again).toEqual([true, true]);
    expect(mock.calls.length).toBe(1);

    // An edit of one picture is kept when the strip is cut again (another picture edited).
    const own = got.findIndex((r) => !r.page.blocks[0].continued);
    const other = 1 - own;
    const edited = { ...got[own].page, blocks: got[own].page.blocks.map((b) => ({ ...b, translatedText: 'ПРАВКА', edited: true })) };
    await svc.saveEdited(got[own].key, edited);
    await svc.saveEdited(got[other].key, (await svc.getResult(got[other].key))!.page);
    for (const r of got) {
      const now = (await svc.getResult(r.key))!;
      expect(now.page.blocks.map((b) => b.translatedText)).toEqual(['ПРАВКА']);
    }
  });
});

describe('a strip is cut only where no bubble crosses the seam', () => {
  // Seams after pictures 0..4: which the detector sees a bubble or text across.
  const crossed = new Set([1, 3]);
  const free = async (i: number) => !crossed.has(i);
  it('a seam that looks calm (the white middle of a bubble) but has a bubble across it is not a cut', async () => {
    const chunks = await planChunksBy([1000, 1000, 1000, 1000, 1000, 1000], [true, true, true, true, true, true], free, 0, 8000);
    expect(chunks).toEqual([[0], [1, 2], [3, 4], [5]]);
  });
  it('a chunk grown past the limit is cut at the last seam nothing crosses, not where it happens to be', async () => {
    // Nothing is calm (art all along); the limit falls after picture 2, but seam 1 and 3 are crossed.
    const chunks = await planChunksBy([3000, 3000, 3000, 3000, 3000], [false, false, false, false, true], free, 0, 8000);
    expect(chunks).toEqual([[0], [1, 2], [3, 4]]);
  });
  it('without a detector the seams are judged by their pixels as before', async () => {
    expect(await planChunksBy([1000, 1000, 1000, 1000], [true, true, false, true], undefined, 2500, 8000)).toEqual(planChunks([1000, 1000, 1000, 1000], [true, true, false, true], 2500, 8000));
  });
});

describe('a bubble whose white middle lies on the seam is not cut in two', () => {
  async function whiteSeamStrip(): Promise<Uint8Array[]> {
    const c = createCanvas(W, H * 2);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H * 2);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3;
    // A caption box wider than the picture: on the seam only white (it looks calm).
    ctx.strokeRect(-10, 700, W + 20, 600);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 34px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText('WAIT FOR ME,', 400, 860);
    ctx.fillText('I AM COMING!', 400, 1150);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 2; i++) {
      const p = createCanvas(W, H);
      p.getContext('2d').drawImage(c as any, 0, -i * H);
      parts.push(new Uint8Array(await p.encode('png')));
    }
    return parts;
  }
  it('the detector sees the bubble across the seam: the two pictures go to the model as one', async () => {
    const parts = await whiteSeamStrip();
    const mock = mockOpenAi(() => JSON.stringify({ blocks: [{ box: [100, 400, 900, 600], text: 'WAIT FOR ME, I AM COMING!', translation: 'ПОДОЖДИ МЕНЯ, Я ИДУ!', type: 'DIALOGUE' }], entities: [], summary: '' }));
    const settings = { ...defaultSettings(), providers: [{ ...configFromPreset('lmstudio', 'vlm'), id: 'v', vision: true }], visionProviderId: 'v', twoStepTranslation: false, qaMode: 'off' as const, targetLang: 'ru', sourceLang: 'en', detectorMode: 'browser', readCrops: false, fonts: { dialogue: 'TestSans', narration: 'TestSans', sfx: 'TestSans' } } as any;
    const svc = new TranslateService(memoryDb(), { get: async () => undefined } as any, napiBackend, async () => settings, mock.fetchImpl);
    // The detector finds the bubble (and its text) wherever it is shown a picture holding it.
    svc.detector = (async (img: { width: number; height: number }) => ({ boxes: [{ kind: 'bubble', score: 0.9, box: [10 * (img.width / 800), 0, 780 * (img.width / 800), img.height] }, { kind: 'text_bubble', score: 0.9, box: [img.width * 0.3, img.height * 0.3, img.width * 0.4, img.height * 0.4] }] })) as any;
    const got: StoredResult[] = [];
    await svc.translateStrip(parts.map((bytes) => ({ bytes, mime: 'image/png' })), { onPart: (i, r) => (got[i] = r) });
    expect(new Set(got.map((r) => r.strip?.parent)).size).toBe(1);
  }, 60000);
});
