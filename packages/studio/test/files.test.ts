/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { epubImageOrder, planSlices, readArchiveImages, rowBusyness } from '@ait/core';
import { napiBackend } from '../../core/test/helpers';
import { bookPages, exportCbz, exportEpub, exportPdf, type ExportPage } from '../src/files';

/** A webtoon strip: panels of noisy art separated by plain white gutters at known heights. */
async function strip(width: number, height: number, gutters: number[]): Promise<ExportPage> {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d') as any;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = `rgb(${rnd() * 255},${rnd() * 255},${rnd() * 255})`;
    ctx.fillRect(rnd() * width, rnd() * height, 6 + rnd() * 30, 6 + rnd() * 30);
  }
  ctx.fillStyle = '#ffffff';
  for (const g of gutters) ctx.fillRect(0, g - 20, width, 40);
  // Tiles of 1000 px like the pipeline produces.
  const tiles = [];
  for (let y = 0; y < height; y += 1000) {
    const h = Math.min(1000, height - y);
    const t = createCanvas(width, h);
    t.getContext('2d').drawImage(c as any, 0, -y);
    tiles.push({ y, h, bytes: new Uint8Array(await t.encode('png')) });
  }
  return { name: 'strip.png', width, height, tiles };
}

describe('cutting long strips into book pages', () => {
  it('cuts in the white gutters between panels, not through the art', async () => {
    const gutters = [560, 1150, 1720, 2300];
    const page = await strip(400, 2900, gutters);
    const parts = await bookPages(napiBackend, page, 'image/png');
    expect(parts.length).toBeGreaterThanOrEqual(4);
    let y = 0;
    for (const p of parts.slice(0, -1)) {
      y += p.height;
      // Every cut lands inside a gutter (±20 px around its centre).
      expect(gutters.some((g) => Math.abs(g - y) <= 20), `cut at ${y}`).toBe(true);
    }
    expect(parts.reduce((a, p) => a + p.height, 0)).toBe(2900);
  });
  it('longer pages on request: long ≈ 3× a book page, whole = one page while it fits', async () => {
    const page = await strip(400, 2900, [560, 1150, 1720, 2300]);
    const normal = await bookPages(napiBackend, page, 'image/png');
    const long = await bookPages(napiBackend, page, 'image/png', 0.9, 'long');
    const whole = await bookPages(napiBackend, page, 'image/png', 0.9, 'whole');
    expect(long.length).toBeLessThan(normal.length);
    expect(Math.max(...long.map((p) => p.height))).toBeGreaterThan(1500);
    expect(whole.length).toBe(1);
    expect(whole[0].height).toBe(2900);
  });
  it('keeps ordinary pages whole', () => {
    expect(planSlices(new Float32Array(1100), 800)).toEqual([0]);
    const busy = new Float32Array(5000).fill(10);
    for (let y = 1200; y < 1210; y++) busy[y] = 0;
    expect(planSlices(busy, 800)[1]).toBeGreaterThanOrEqual(1200);
    expect(rowBusyness(new Uint8ClampedArray(4 * 10 * 2).fill(255), 10, 2)[0]).toBe(0);
  });
});

describe('chapter files', () => {
  it('PDF has one page per book page', async () => {
    const page = await strip(400, 2900, [560, 1150, 1720, 2300]);
    const pdf = await exportPdf(napiBackend, [page]);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF')).toBe(true);
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBe((await bookPages(napiBackend, page, 'image/jpeg')).length);
  });
  it('CBZ and EPUB open as archives with the pages in order', async () => {
    const page = await strip(400, 1800, [600, 1200]);
    const n = (await bookPages(napiBackend, page, 'image/jpeg')).length;
    const names = Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, '0')}.jpg`);
    expect(n).toBe(3);
    const cbz = await JSZip.loadAsync(await exportCbz(napiBackend, [page], 'Глава 1'));
    expect(Object.keys(cbz.files).filter((x) => x.endsWith('.jpg')).sort()).toEqual(names);
    expect(await cbz.file('ComicInfo.xml')!.async('string')).toContain('<Title>Глава 1</Title>');
    const epubBytes = await exportEpub(napiBackend, [page], 'Глава 1', 'ru');
    const epub = await JSZip.loadAsync(epubBytes);
    expect(Object.keys(epub.files)[0]).toBe('mimetype');
    expect(await epub.file('mimetype')!.async('string')).toBe('application/epub+zip');
    expect(await epubImageOrder(epub)).toEqual(names.map((x) => `OEBPS/img/${x}`));
    // …and our own importer reads it back in reading order.
    expect((await readArchiveImages(epubBytes)).map((i) => i.name)).toEqual(names);
  });
});
