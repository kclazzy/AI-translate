import { existsSync } from 'node:fs';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import type { ImageBackend } from '../src/image/backend';

// The test pictures need real glyphs (the text check skips pictures without letters).
for (const f of ['/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']) {
  if (!existsSync(f)) throw new Error(`Test font missing: ${f} (apt install fonts-noto-cjk fonts-dejavu-core)`);
}
GlobalFonts.registerFromPath('/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', 'TestCJK');
GlobalFonts.registerFromPath('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'TestSans');

export const napiBackend: ImageBackend = {
  createCanvas: (w, h) => createCanvas(w, h) as any,
  async decode(bytes) {
    const img = await loadImage(Buffer.from(bytes));
    return { width: img.width, height: img.height, source: img };
  },
  async encode(canvas, mime, quality) {
    const fmt = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'webp';
    const buf = await (canvas as any).encode(fmt, quality !== undefined ? Math.round(quality * 100) : undefined);
    return new Uint8Array(buf);
  },
};

export interface SyntheticBubble {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  text: string;
  /** Text box actually drawn (page px). */
  textBox: [number, number, number, number];
}

/**
 * Draw a manga-like page: grey screentone background, white elliptical bubbles
 * with black outlines and vertical Japanese text inside.
 */
export async function makeMangaPage(width = 800, height = 1100, bubbles?: { cx: number; cy: number; rx: number; ry: number; text: string }[]): Promise<{ bytes: Uint8Array; bubbles: SyntheticBubble[] }> {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  // Screentone-ish background.
  ctx.fillStyle = '#c8c8c8';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#9a9a9a';
  for (let y = 0; y < height; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < width; x += 6) ctx.fillRect(x, y, 2, 2);
  const specs = bubbles ?? [
    { cx: 220, cy: 260, rx: 120, ry: 170, text: 'たなかさん待って' },
    { cx: 580, cy: 700, rx: 110, ry: 160, text: 'どこへ行くの' },
  ];
  const out: SyntheticBubble[] = [];
  for (const b of specs) {
    ctx.beginPath();
    ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    // Vertical text: two columns, right to left.
    const size = 30;
    ctx.font = `${size}px TestCJK`;
    ctx.fillStyle = '#000000';
    ctx.textAlign = 'center';
    const chars = [...b.text];
    const perCol = Math.ceil(chars.length / 2);
    const colX = [b.cx + 22, b.cx - 22];
    const top = b.cy - (perCol * size * 1.05) / 2;
    chars.forEach((ch, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      ctx.fillText(ch, colX[col], top + row * size * 1.05 + size * 0.85);
    });
    const tb: [number, number, number, number] = [b.cx - 22 - size / 2, top, 44 + size, perCol * size * 1.05];
    out.push({ ...b, textBox: tb.map(Math.round) as [number, number, number, number] });
  }
  return { bytes: new Uint8Array(await c.encode('png')), bubbles: out };
}

/** Count near-black pixels inside an ellipse (excluding a margin near the outline). */
export async function darkPixelsInside(bytes: Uint8Array, b: { cx: number; cy: number; rx: number; ry: number }, margin = 10): Promise<number> {
  const img = await loadImage(Buffer.from(bytes));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  let n = 0;
  for (let y = Math.floor(b.cy - b.ry); y < b.cy + b.ry; y++) {
    for (let x = Math.floor(b.cx - b.rx); x < b.cx + b.rx; x++) {
      const nx = (x - b.cx) / (b.rx - margin);
      const ny = (y - b.cy) / (b.ry - margin);
      if (nx * nx + ny * ny > 1) continue;
      const i = (y * img.width + x) * 4;
      if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) n++;
    }
  }
  return n;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fake OpenAI-compatible endpoint: `answer` gets the parsed request body. */
export function mockOpenAi(answer: (body: any, call: number) => string | Response) {
  const calls: any[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: _url, body, headers: init?.headers });
    const a = answer(body, calls.length);
    if (a instanceof Response) return a;
    return jsonResponse({ choices: [{ message: { content: a } }], usage: { prompt_tokens: 1000, completion_tokens: 200 }, model: body.model });
  };
  return { fetchImpl, calls };
}

/** Convert page-pixel boxes to the 0–1000 space used by the vision prompt. */
export function toNorm(box: [number, number, number, number], w: number, h: number): [number, number, number, number] {
  return [Math.round((box[0] / w) * 1000), Math.round((box[1] / h) * 1000), Math.round(((box[0] + box[2]) / w) * 1000), Math.round(((box[1] + box[3]) / h) * 1000)];
}
