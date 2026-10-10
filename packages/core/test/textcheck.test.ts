import { readFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { checkForText } from '../src/image/textcheck';
import { TiledImage } from '../src/image/tiled';
import { makeMangaPage, napiBackend } from './helpers';

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

async function picture(w: number, h: number, draw: (ctx: Ctx) => void): Promise<TiledImage> {
  const c = createCanvas(w, h);
  draw(c.getContext('2d'));
  return TiledImage.fromBytes(napiBackend, new Uint8Array(await c.encode('png')));
}

const check = async (img: TiledImage | Promise<TiledImage>) => checkForText(await img, { full: true });
const file = (p: string) => TiledImage.fromBytes(napiBackend, new Uint8Array(readFileSync(new URL(p, import.meta.url))));

/** Art without any lettering. */
const noText: Record<string, () => Promise<TiledImage>> = {
  solid: () => picture(800, 1200, (ctx) => {
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, 800, 1200);
  }),
  'black gutter': () => picture(720, 3000, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 720, 3000);
  }),
  gradient: () => picture(800, 2400, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 300, 2400);
    g.addColorStop(0, '#1d2b64');
    g.addColorStop(0.5, '#f8cdda');
    g.addColorStop(1, '#ffffff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 800, 2400);
  }),
  'pixel noise': () => picture(800, 1100, (ctx) => {
    const r = rng(7);
    const id = ctx.createImageData(800, 1100);
    for (let i = 0; i < 800 * 1100; i++) {
      const v = Math.floor(r() * 255);
      id.data[i * 4] = v;
      id.data[i * 4 + 1] = Math.floor(r() * 255);
      id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }),
  'photo-like noise': () => picture(800, 1200, (ctx) => {
    // Smooth value noise (clouds) with fine grain on top.
    const r = rng(11);
    const grid = 40;
    const gw = 800 / grid + 2;
    const gh = 1200 / grid + 2;
    const lattice = Array.from({ length: gw * gh }, () => r() * 255);
    const id = ctx.createImageData(800, 1200);
    for (let y = 0; y < 1200; y++) {
      for (let x = 0; x < 800; x++) {
        const gx = x / grid;
        const gy = y / grid;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fx = gx - ix;
        const fy = gy - iy;
        const v00 = lattice[iy * gw + ix];
        const v10 = lattice[iy * gw + ix + 1];
        const v01 = lattice[(iy + 1) * gw + ix];
        const v11 = lattice[(iy + 1) * gw + ix + 1];
        const v = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy + (r() - 0.5) * 30;
        const i = (y * 800 + x) * 4;
        id.data[i] = v;
        id.data[i + 1] = v * 0.8 + 20;
        id.data[i + 2] = v * 0.6 + 40;
        id.data[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);
  }),
  'line art': () => picture(800, 1100, (ctx) => {
    // A drawn scene: shapes, strokes, a face, speed lines, screentone — no lettering.
    const r = rng(3);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 800, 1100);
    ctx.fillStyle = '#9a9a9a';
    for (let y = 600; y < 1100; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < 800; x += 6) ctx.fillRect(x, y, 2, 2);
    ctx.strokeStyle = '#000';
    for (let i = 0; i < 40; i++) {
      ctx.lineWidth = 1 + r() * 5;
      ctx.beginPath();
      ctx.moveTo(r() * 800, r() * 1100);
      ctx.bezierCurveTo(r() * 800, r() * 1100, r() * 800, r() * 1100, r() * 800, r() * 1100);
      ctx.stroke();
    }
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = r() > 0.5 ? '#222' : '#777';
      ctx.beginPath();
      ctx.ellipse(r() * 800, r() * 1100, 20 + r() * 120, 20 + r() * 120, r() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // A face: two eyes and a mouth.
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(400, 300, 120, 150, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#000';
    for (const ex of [355, 445]) {
      ctx.beginPath();
      ctx.ellipse(ex, 280, 14, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(400, 360, 30, 0.2, Math.PI - 0.2);
    ctx.stroke();
    // Speed lines.
    ctx.lineWidth = 2;
    for (let i = 0; i < 30; i++) {
      ctx.beginPath();
      ctx.moveTo(0, 700 + i * 12);
      ctx.lineTo(300 + r() * 300, 700 + i * 12);
      ctx.stroke();
    }
  }),
  'colour stripes': () => picture(600, 400, (ctx) => {
    for (let x = 0; x < 600; x += 10) {
      ctx.fillStyle = `hsl(${x % 360}, 60%, 50%)`;
      ctx.fillRect(x, 0, 10, 400);
    }
  }),
  'panels with gutters': () => picture(800, 1200, (ctx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 800, 1200);
    ctx.lineWidth = 4;
    const r = rng(9);
    for (const [x, y, w, h] of [[20, 20, 370, 380], [410, 20, 370, 380], [20, 420, 760, 360], [20, 800, 240, 380], [280, 800, 500, 380]]) {
      ctx.fillStyle = `rgb(${150 + r() * 80},${150 + r() * 80},${150 + r() * 80})`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(x, y, w, h);
    }
  }),
  'dot screentone panel': () => picture(800, 9000 / 4, (ctx) => {
    ctx.fillStyle = '#bdbdbd';
    ctx.fillRect(0, 0, 800, 2250);
    ctx.fillStyle = '#8a8a8a';
    for (let y = 10; y < 2250; y += 40) for (let x = 10; x < 800; x += 40) ctx.fillRect(x, y, 14, 14);
  }),
};

/** Pictures with lettering. */
const withText: Record<string, () => Promise<TiledImage>> = {
  'manga page (vertical Japanese in bubbles)': async () => TiledImage.fromBytes(napiBackend, (await makeMangaPage()).bytes),
  'e2e page.png': () => file('../../../e2e/fixtures/page.png'),
  'e2e tall.png': () => file('../../../e2e/fixtures/tall.png'),
  'webtoon bubble with English': () => picture(720, 2000, (ctx) => {
    const r = rng(5);
    for (let y = 0; y < 2000; y += 4) {
      ctx.fillStyle = `rgb(${60 + y / 20},${90 + r() * 20},${140})`;
      ctx.fillRect(0, y, 720, 4);
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(360, 900, 220, 110, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = '28px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText('WHERE ARE YOU', 360, 885);
    ctx.fillText('GOING?', 360, 925);
  }),
  'white caption on a dark box': () => picture(800, 1100, (ctx) => {
    ctx.fillStyle = '#d9d0c0';
    ctx.fillRect(0, 0, 800, 1100);
    ctx.fillStyle = '#111';
    ctx.fillRect(60, 80, 420, 90);
    ctx.fillStyle = '#fff';
    ctx.font = '24px TestSans';
    ctx.fillText('Three years later…', 90, 135);
  }),
  'outlined sound effect over the art': () => picture(600, 400, (ctx) => {
    for (let x = 0; x < 600; x += 10) {
      ctx.fillStyle = `hsl(${x % 360}, 60%, 50%)`;
      ctx.fillRect(x, 0, 10, 400);
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.font = 'bold 48px TestSans';
    ctx.strokeText('DOOM', 200, 220);
    ctx.fillText('DOOM', 200, 220);
  }),
  'one short line in a small bubble': () => picture(900, 1300, (ctx) => {
    ctx.fillStyle = '#777';
    ctx.fillRect(0, 0, 900, 1300);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(700, 1100, 80, 50, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = '22px TestSans';
    ctx.textAlign = 'center';
    ctx.fillText('Huh?', 700, 1108);
  }),
};

describe('text check before the model', () => {
  for (const [name, make] of Object.entries(noText)) {
    it(`skips a picture without text: ${name}`, async () => {
      const r = await check(make());
      expect(r, JSON.stringify(r)).toMatchObject({ noText: true });
    });
  }
  for (const [name, make] of Object.entries(withText)) {
    it(`keeps a picture with text: ${name}`, async () => {
      const r = await check(make());
      expect(r, JSON.stringify(r)).toMatchObject({ noText: false });
    });
  }
});
