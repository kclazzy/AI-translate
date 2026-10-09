import { writePsdUint8Array, type Layer } from 'ag-psd';
import { ctxMeasurer, drawBlock, layoutBlock, resolveStyle, shouldDraw, targetBox, type ImageBackend, type PageResult, type StyleDefaults, type TiledImage } from '@ait/core';

/**
 * A page as a Photoshop file: the original (hidden), the cleaned picture and one layer per
 * translated text — a picture of the letters plus the text itself, so it can be retyped there.
 */
export function exportPsd(backend: ImageBackend, page: PageResult, original: TiledImage, cleaned: TiledImage, d: StyleDefaults): Uint8Array {
  const W = page.width;
  const H = page.height;
  const whole = (img: TiledImage) => {
    const c = backend.createCanvas(W, H);
    img.drawRegion(c.getContext('2d'), 0, 0, W, H, W, H);
    return c as unknown as HTMLCanvasElement;
  };
  const measurer = ctxMeasurer(backend.createCanvas(8, 8).getContext('2d'));
  const texts: Layer[] = [];
  for (const b of page.blocks) {
    if (!shouldDraw(b, d)) continue;
    const l = layoutBlock(measurer, b, d, { width: W, height: H });
    const box = l.box ?? targetBox(b, d);
    const m = Math.ceil(l.fontSize * 1.5);
    const x0 = Math.max(0, Math.floor(box[0] - m));
    const y0 = Math.max(0, Math.floor(box[1] - m));
    const x1 = Math.min(W, Math.ceil(box[0] + box[2] + m));
    const y1 = Math.min(H, Math.ceil(box[1] + box[3] + m));
    if (x1 <= x0 || y1 <= y0) continue;
    const c = backend.createCanvas(x1 - x0, y1 - y0);
    const ctx = c.getContext('2d');
    ctx.translate(-x0, -y0);
    drawBlock(ctx, b, l, d);
    const st = resolveStyle(b, d);
    const hex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16) || 0, g: parseInt(h.slice(3, 5), 16) || 0, b: parseInt(h.slice(5, 7), 16) || 0 });
    texts.push({
      name: (b.translatedText || b.originalText).replace(/\s+/g, ' ').slice(0, 60) || b.id,
      left: x0,
      top: y0,
      canvas: c as unknown as HTMLCanvasElement,
      opacity: Math.max(0, Math.min(1, st.opacity)),
      text: {
        text: l.vertical ? b.translatedText : l.lines.map((x) => x.text).join('\r'),
        transform: [1, 0, 0, 1, box[0] + box[2] / 2, box[1] + (l.lines[0]?.y ?? l.fontSize)],
        style: {
          font: { name: st.fontFamily.split(',')[0].replace(/["']/g, '').trim() || 'Arial' },
          fontSize: Math.round(l.fontSize),
          fillColor: /^#[0-9a-f]{6}$/i.test(st.color) ? hex(st.color) : { r: 0, g: 0, b: 0 },
          fauxBold: st.bold,
        },
        paragraphStyle: { justification: st.alignment === 'left' ? 'left' : st.alignment === 'right' ? 'right' : 'center' },
      },
    });
  }
  const psd = {
    width: W,
    height: H,
    children: [
      { name: 'Оригинал', hidden: true, canvas: whole(original) },
      { name: 'Очищено', canvas: whole(cleaned) },
      { name: 'Перевод', opened: true, children: texts },
    ],
  };
  return writePsdUint8Array(psd, { generateThumbnail: false, invalidateTextLayers: true, noBackground: true });
}
