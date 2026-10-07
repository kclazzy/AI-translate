/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { cleanBlock, parseHex, luminance } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import { matchLettering } from '../src/pipeline/standalone';
import type { TextBlock } from '../src/types';
import { napiBackend } from './helpers';

async function page(draw: (ctx: any) => void) {
  const c = createCanvas(600, 400);
  const ctx = c.getContext('2d') as any;
  draw(ctx);
  return TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')), 'image/png');
}

describe('the translation keeps the look of the original lettering', () => {
  it('white letters with a black outline keep both colours', async () => {
    const img = await page((ctx) => {
      ctx.fillStyle = '#8a8f99';
      ctx.fillRect(0, 0, 600, 400);
      ctx.font = 'bold 54px TestSans';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 7;
      ctx.strokeStyle = '#000';
      ctx.fillStyle = '#fff';
      ctx.strokeText('STOP IT', 120, 150);
      ctx.fillText('STOP IT', 120, 150);
    });
    const r = cleanBlock(img, [110, 140, 260, 75], { analyzeOnly: true });
    expect(r.lettering?.fill).toBeTruthy();
    expect(luminance(...parseHex(r.lettering!.fill!))).toBeGreaterThan(200);
    expect(luminance(...parseHex(r.lettering!.outline!))).toBeLessThan(80);
    const style = matchLettering({ originalText: 'STOP IT', textType: 'DIALOGUE', bubble: null } as unknown as TextBlock, r.lettering);
    expect(style.strokeWidth).toBeGreaterThanOrEqual(2);
  });
  it('a caption written flush left stays left-aligned', async () => {
    const img = await page((ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 600, 400);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.strokeRect(40, 80, 520, 200);
      ctx.fillStyle = '#111';
      ctx.font = '28px TestSans';
      ctx.textBaseline = 'top';
      ['MEANWHILE, FAR AWAY', 'IN THE NORTH', 'A STORM WAS COMING'].forEach((l, i) => ctx.fillText(l, 70, 110 + i * 40));
    });
    const r = cleanBlock(img, [65, 105, 360, 120], { analyzeOnly: true });
    expect(r.lettering?.align).toBe('left');
    const style = matchLettering({ originalText: 'X', textType: 'NARRATION', bubble: r.bubble } as unknown as TextBlock, r.lettering);
    expect(style.alignment).toBe('left');
  });
});

describe('plain lettering', () => {
  it('black letters on white are not mistaken for outlined ones', async () => {
    const c = createCanvas(600, 300);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 600, 300);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(300, 150, 250, 120, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 40px TestSans';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('HEY YOU!', 300, 130);
    const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')), 'image/png');
    const r = cleanBlock(img, [200, 125, 200, 50], { analyzeOnly: true });
    expect(r.lettering?.outline).toBeUndefined();
  });
});
