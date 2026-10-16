// The old letters must not show through as a faint ghost when the bubble is not one flat colour
// (a soft gradient, as in webtoon bubbles): the erased spots take the colour around them.
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import { napiBackend } from './helpers';

describe('erasing in a gradient bubble', () => {
  it('leaves no ghost of the letters', async () => {
    const W = 700;
    const H = 500;
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d') as any;
    ctx.fillStyle = '#101018';
    ctx.fillRect(0, 0, W, H);
    // Off-white bubble, lighter in the middle, darker to the edge.
    const g = ctx.createRadialGradient(350, 250, 20, 350, 250, 300);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#d9dee6');
    ctx.fillStyle = g;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(350, 250, 300, 190, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BUT THAT IS THE REASON', 350, 200);
    ctx.fillText('YOU HAVE TO DIE.', 350, 300);
    const img = await TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')), 'image/png');
    const r = cleanBlock(img, [110, 160, 480, 160]);
    expect(r.closed).toBe(true);
    // Every pixel along each text row differs from its neighbour 6 px away by at most a shade:
    // no letter shapes, only the smooth gradient.
    const d = img.getRegion(150, 165, 400, 150).data;
    let worst = 0;
    for (let y = 0; y < 150; y++) {
      for (let x = 0; x + 6 < 400; x++) {
        const a = (y * 400 + x) * 4;
        const b = (y * 400 + x + 6) * 4;
        worst = Math.max(worst, Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]));
      }
    }
    expect(worst).toBeLessThan(18);
  });
});
