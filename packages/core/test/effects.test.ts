/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { ctxMeasurer, drawBlock, layoutBlock } from '../src/render/render';
import { DEFAULT_STYLE_DEFAULTS } from '../src/render/style';
import type { TextBlock } from '../src/types';

const block = (style: TextBlock['style']): TextBlock =>
  ({ id: 'b1', textType: 'DIALOGUE', originalText: 'x', translatedText: 'ПРИВЕТ', confidence: 1, language: 'en', bbox: [20, 20, 360, 120], polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 30, bubble: null, translate: true, textBox: [20, 20, 360, 120], style: { fontSize: 40, ...style } }) as any;

const d = { ...DEFAULT_STYLE_DEFAULTS, dialogueFont: 'TestSans' };

function draw(b: TextBlock) {
  const c = createCanvas(400, 160);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 400, 160);
  const l = layoutBlock(ctxMeasurer(ctx), b, d, { width: 400, height: 160 });
  drawBlock(ctx, b, l, d);
  return { data: ctx.getImageData(0, 0, 400, 160).data as Uint8ClampedArray, l };
}

describe('text effects', () => {
  it('letter spacing widens the line, glow paints a halo, gradient changes colour top to bottom', () => {
    const plain = draw(block({ color: '#000000', strokeColor: null, strokeWidth: 0 }));
    const wide = draw(block({ color: '#000000', strokeColor: null, strokeWidth: 0, letterSpacing: 0.2 }));
    expect(wide.l.lines[0].width).toBeGreaterThan(plain.l.lines[0].width + 20);

    const glow = draw(block({ color: '#000000', strokeColor: null, strokeWidth: 0, glow: '#00ff00', glowSize: 8 }));
    let green = 0;
    for (let i = 0; i < glow.data.length; i += 4) if (glow.data[i + 1] > 150 && glow.data[i] < 120 && glow.data[i + 2] < 120) green++;
    expect(green).toBeGreaterThan(200);

    const grad = draw(block({ color: '#ff0000', gradient: '#0000ff', strokeColor: null, strokeWidth: 0 }));
    let reddish = 0;
    let bluish = 0;
    for (let i = 0; i < grad.data.length; i += 4) {
      const [r, , b] = [grad.data[i], grad.data[i + 1], grad.data[i + 2]];
      if (r > 150 && b < 100) reddish++;
      if (b > 150 && r < 100) bluish++;
    }
    expect(reddish).toBeGreaterThan(30);
    expect(bluish).toBeGreaterThan(30);
  });
});
