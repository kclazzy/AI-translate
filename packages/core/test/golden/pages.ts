/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The golden set: synthetic reference pages drawn with @napi-rs/canvas (no real manga is used).
 * Each page knows where its lettering is, which bubble holds it, the text, a reference translation
 * and the art that must stay untouched. The letter pixels are found by drawing the page twice —
 * with and without the lettering — so the checks know exactly which pixels must disappear.
 */
import { createCanvas } from '@napi-rs/canvas';
import type { TextType } from '../../src/types';
import '../helpers'; // registers the test fonts TestCJK (Noto Sans CJK) and TestSans (DejaVu)

export type Box = [number, number, number, number];
type Ctx = any;

export interface ExpectedBubble {
  kind: 'ellipse' | 'rect' | 'cloud' | 'none';
  /** Bounding box of the bubble (may run past the picture's edge when the bubble is cut). */
  box: Box;
  /** Bubble colour, #rrggbb (none: the art behind the text). */
  fill?: string;
}

export interface ExpectedBlock {
  /** Tight box of the original letters (page px), measured from the drawn pixels. */
  textBox: Box;
  bubble?: ExpectedBubble;
  text: string;
  /** Reference translation (Russian). */
  translation: string;
  type: TextType;
  vertical?: boolean;
  /** Colour class of the original letters (the translation should match it). */
  letters: 'dark' | 'light';
  /** An outline / halo around the translation is fine (text over art, SFX). */
  haloOk?: boolean;
}

export interface GoldenPage {
  name: string;
  title: string;
  sourceLang: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  expected: { blocks: ExpectedBlock[]; artRegions: Box[] };
  /** No lettering at all: the page must be skipped without asking the model. */
  noText?: boolean;
  /** RGBA of the page as drawn. */
  pixels: Uint8ClampedArray;
  /** RGBA of the same page drawn without the lettering. */
  clean: Uint8ClampedArray;
  /** 1 = a pixel of the original lettering (differs clearly from the clean page). */
  letters: Uint8Array;
}

interface BlockSpec extends Omit<ExpectedBlock, 'textBox'> {
  /** Draws the lettering; returns roughly where it is (the exact box is measured from pixels). */
  draw: (ctx: Ctx) => Box;
}

interface PageSpec {
  name: string;
  title: string;
  sourceLang: string;
  width: number;
  height: number;
  art: (ctx: Ctx) => void;
  blocks: BlockSpec[];
  artRegions: Box[];
}

// ---------------------------------------------------------------- drawing helpers

function ellipseBubble(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, fill = '#ffffff', stroke: string | null = '#000000', lw = 4) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

function rectBox(ctx: Ctx, [x, y, w, h]: Box, fill: string, stroke: string | null, lw = 3) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.strokeRect(x, y, w, h);
  }
}

/** Centered horizontal lines; `top` is the top of the first line. Returns the rough text box. */
function lines(ctx: Ctx, ls: string[], cx: number, top: number, size: number, opts: { font?: string; color?: string; stroke?: string; strokeWidth?: number; lh?: number } = {}): Box {
  const lh = opts.lh ?? 1.2;
  ctx.font = `bold ${size}px ${opts.font ?? 'TestSans'}`;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  let w = 0;
  ls.forEach((l, i) => {
    const y = top + size * 0.9 + i * size * lh;
    w = Math.max(w, ctx.measureText(l).width);
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = opts.strokeWidth ?? 4;
      ctx.strokeText(l, cx, y);
    }
    ctx.fillStyle = opts.color ?? '#111111';
    ctx.fillText(l, cx, y);
  });
  const pad = opts.stroke ? (opts.strokeWidth ?? 4) : 0;
  return [cx - w / 2 - pad, top - pad, w + pad * 2, ls.length * size * lh + pad * 2];
}

/** Vertical CJK columns, right to left, centred on (cx, cy). */
function columns(ctx: Ctx, text: string, cx: number, cy: number, size: number, cols: number): Box {
  ctx.font = `${size}px TestCJK`;
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  const chars = [...text];
  const per = Math.ceil(chars.length / cols);
  const step = size * 1.05;
  const colW = size * 1.4;
  const top = cy - (per * step) / 2;
  chars.forEach((ch, i) => {
    const col = Math.floor(i / per);
    const row = i % per;
    ctx.fillText(ch, cx + ((cols - 1) / 2 - col) * colW, top + row * step + size * 0.88);
  });
  const w = (cols - 1) * colW + size;
  return [cx - w / 2, top, w, per * step];
}

function screentone(ctx: Ctx, W: number, H: number, bg = '#c8c8c8', dot = '#9a9a9a') {
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dot;
  for (let y = 0; y < H; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < W; x += 6) ctx.fillRect(x, y, 2, 2);
}

/** A simple character: body, head, hair. */
function figure(ctx: Ctx, x: number, y: number, w: number, h: number, body = '#2a2a33', skin = '#e8d2c0', hair = '#3a2418') {
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w * 0.15, y + h * 0.4);
  ctx.lineTo(x + w * 0.85, y + h * 0.4);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.25, w * 0.25, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.2, w * 0.27, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.25, w * 0.25, 0, Math.PI * 2);
  ctx.stroke();
}

function sky(ctx: Ctx, x: number, y: number, w: number, h: number, top = '#3b5bd6', bottom = '#9fb6f5') {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function mountains(ctx: Ctx, W: number, base: number, color = '#4a5a48') {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, base + 300);
  for (let x = 0; x <= W; x += W / 6) ctx.lineTo(x, base + ((x / (W / 6)) % 2 ? 0 : 140));
  ctx.lineTo(W, base + 600);
  ctx.lineTo(0, base + 600);
  ctx.closePath();
  ctx.fill();
}

function hatching(ctx: Ctx, [x, y, w, h]: Box, bg = '#8c96a8', line = '#5d6678', gap = 7) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  for (let d = -h; d < w; d += gap) {
    ctx.beginPath();
    ctx.moveTo(x + d, y + h);
    ctx.lineTo(x + d + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

function speedLines(ctx: Ctx, cx: number, cy: number, W: number, H: number, color = '#222222') {
  ctx.strokeStyle = color;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) {
    ctx.lineWidth = 2 + ((a * 7) % 3);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * W * 0.35, cy + Math.sin(a) * H * 0.35);
    ctx.lineTo(cx + Math.cos(a) * W, cy + Math.sin(a) * H);
    ctx.stroke();
  }
}

const ell = (cx: number, cy: number, rx: number, ry: number, fill = '#ffffff'): ExpectedBubble => ({ kind: 'ellipse', box: [cx - rx, cy - ry, rx * 2, ry * 2], fill });

// ---------------------------------------------------------------- the pages

const SPECS: PageSpec[] = [
  {
    name: 'ja-oval-vertical',
    title: 'Белый овал, вертикальный японский текст',
    sourceLang: 'ja',
    width: 800,
    height: 1100,
    art: (ctx) => {
      screentone(ctx, 800, 1100);
      figure(ctx, 480, 140, 240, 420);
      ellipseBubble(ctx, 220, 330, 130, 190);
      ellipseBubble(ctx, 600, 850, 120, 170);
    },
    blocks: [
      { text: 'まって！どこへいくの', translation: 'Подожди! Куда ты идёшь?', type: 'DIALOGUE', vertical: true, letters: 'dark', bubble: ell(220, 330, 130, 190), draw: (ctx) => columns(ctx, 'まって！どこへいくの', 220, 330, 32, 2) },
      { text: 'ここはあぶない', translation: 'Здесь опасно.', type: 'DIALOGUE', vertical: true, letters: 'dark', bubble: ell(600, 850, 120, 170), draw: (ctx) => columns(ctx, 'ここはあぶない', 600, 850, 32, 2) },
    ],
    artRegions: [[480, 150, 240, 400], [20, 640, 360, 420]],
  },
  {
    name: 'en-oval',
    title: 'Горизонтальный английский текст в овале',
    sourceLang: 'en',
    width: 900,
    height: 700,
    art: (ctx) => {
      sky(ctx, 0, 0, 900, 700);
      figure(ctx, 60, 280, 260, 420);
      ellipseBubble(ctx, 600, 220, 250, 140);
    },
    blocks: [
      {
        text: 'I NEVER THOUGHT I’D SEE THIS PLACE AGAIN.',
        translation: 'Я НИКОГДА НЕ ДУМАЛ, ЧТО СНОВА УВИЖУ ЭТО МЕСТО.',
        type: 'DIALOGUE',
        letters: 'dark',
        bubble: ell(600, 220, 250, 140),
        draw: (ctx) => lines(ctx, ['I NEVER THOUGHT I’D', 'SEE THIS PLACE', 'AGAIN.'], 600, 165, 30),
      },
    ],
    artRegions: [[60, 290, 260, 400], [420, 420, 470, 270]],
  },
  {
    name: 'ko-webtoon',
    title: 'Корейский вебтун: овал с тонким контуром',
    sourceLang: 'ko',
    width: 720,
    height: 1400,
    art: (ctx) => {
      ctx.fillStyle = '#f3e9dd';
      ctx.fillRect(0, 0, 720, 1400);
      const g = ctx.createLinearGradient(0, 600, 0, 1400);
      g.addColorStop(0, '#d9b99b');
      g.addColorStop(1, '#8a6a4f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 600, 720, 800);
      figure(ctx, 200, 700, 320, 700, '#30406a', '#f0d8c8', '#1c1c24');
      ellipseBubble(ctx, 360, 300, 240, 120, '#ffffff', '#9a9a9a', 2);
    },
    blocks: [
      { text: '어디 가는 거야? 같이 가자!', translation: 'Куда ты идёшь? Пойдём вместе!', type: 'DIALOGUE', letters: 'dark', bubble: ell(360, 300, 240, 120), draw: (ctx) => lines(ctx, ['어디 가는 거야?', '같이 가자!'], 360, 258, 34, { font: 'TestCJK' }) },
    ],
    artRegions: [[200, 720, 320, 660], [0, 620, 180, 700]],
  },
  {
    name: 'zh-bubble',
    title: 'Китайский текст в овале',
    sourceLang: 'zh',
    width: 800,
    height: 1000,
    art: (ctx) => {
      screentone(ctx, 800, 1000, '#d8d8d8', '#a8a8a8');
      ctx.fillStyle = '#555b66';
      for (const [x, h] of [[80, 300], [220, 380], [380, 260], [520, 420], [660, 330]]) ctx.fillRect(x, 1000 - h, 110, h);
      ellipseBubble(ctx, 400, 280, 230, 130);
    },
    blocks: [
      { text: '你到底想要什么？我已经受够了！', translation: 'Чего ты вообще хочешь? С меня хватит!', type: 'DIALOGUE', letters: 'dark', bubble: ell(400, 280, 230, 130), draw: (ctx) => lines(ctx, ['你到底想要什么？', '我已经受够了！'], 400, 238, 36, { font: 'TestCJK' }) },
    ],
    artRegions: [[80, 600, 700, 400]],
  },
  {
    name: 'glow-spiky-black',
    title: 'Светящийся рваный колючий контур на чёрном',
    sourceLang: 'en',
    width: 900,
    height: 700,
    art: (ctx) => {
      const E = { cx: 330, cy: 200, rx: 318, ry: 172 };
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, 900, 700);
      ctx.fillStyle = '#1c1b2a';
      ctx.beginPath();
      ctx.ellipse(520, 560, 380, 120, 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a2f3f';
      ctx.fillRect(600, 430, 90, 270);
      ctx.fillStyle = '#7d6a78';
      ctx.beginPath();
      ctx.arc(645, 420, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 22, 700);
      ctx.save();
      ctx.shadowColor = '#7fb2ff';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(E.cx, E.cy, E.rx, E.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#2f5fc8';
      ctx.lineWidth = 9;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
        ctx.beginPath();
        ctx.ellipse(E.cx, E.cy, E.rx - 3, E.ry - 3, 0, a, a + Math.PI / 9);
        ctx.stroke();
      }
      ctx.fillStyle = '#2a50b0';
      for (let a = Math.PI * 0.15; a < Math.PI * 0.85; a += Math.PI / 40) {
        const x = E.cx + Math.cos(a) * (E.rx - 4);
        const y = E.cy + Math.sin(a) * (E.ry - 4);
        ctx.beginPath();
        ctx.moveTo(x - 5, y);
        ctx.lineTo(E.cx + Math.cos(a) * (E.rx - 26), E.cy + Math.sin(a) * (E.ry - 22));
        ctx.lineTo(x + 5, y);
        ctx.fill();
      }
    },
    blocks: [
      {
        text: 'WE GAVE THOSE RIFTS A NAME: DUNGEON.',
        translation: 'МЫ ДАЛИ ЭТИМ РАЗРЫВАМ НАЗВАНИЕ: ПОДЗЕМЕЛЬЯ.',
        type: 'DIALOGUE',
        letters: 'dark',
        bubble: ell(330, 200, 318, 172),
        draw: (ctx) => lines(ctx, ['WE GAVE THOSE RIFTS A', 'NAME: DUNGEON.'], 330, 200 - 34 * 1.2, 34, { color: '#0a0a0a' }),
      },
    ],
    artRegions: [[560, 440, 180, 260], [150, 470, 400, 230]],
  },
  {
    name: 'cut-by-edge',
    title: 'Бабл, обрезанный нижним краем картинки',
    sourceLang: 'en',
    width: 507,
    height: 340,
    art: (ctx) => {
      ctx.fillStyle = '#3b5bd6';
      ctx.fillRect(0, 0, 507, 340);
      ctx.fillStyle = '#6f8cf0';
      ctx.beginPath();
      ctx.ellipse(177, 51, 228, 41, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2a2a33';
      ctx.fillRect(127, 0, 111, 102);
      ctx.fillStyle = '#3fd1b0';
      ctx.fillRect(112, 95, 152, 20);
      ellipseBubble(ctx, 255, 300, 250, 160, '#ffffff', '#111111');
    },
    blocks: [
      {
        text: 'WHAT OVERWATCH DID FOR ME WHEN I FIRST CAME TO EARTH.',
        translation: 'ЧТО ОВЕРВОТЧ СДЕЛАЛ ДЛЯ МЕНЯ, КОГДА Я ВПЕРВЫЕ ПРИШЛА НА ЗЕМЛЮ.',
        type: 'DIALOGUE',
        letters: 'dark',
        bubble: ell(255, 300, 250, 160),
        draw: (ctx) => lines(ctx, ['WHAT OVERWATCH DID FOR', 'ME WHEN I FIRST', 'CAME TO EARTH.'], 255, 200, 24, { color: '#151515' }),
      },
    ],
    artRegions: [[120, 0, 130, 115], [420, 0, 87, 120]],
  },
  {
    name: 'joined-bubbles',
    title: 'Два сросшихся бабла с общим контуром',
    sourceLang: 'en',
    width: 900,
    height: 1000,
    art: (ctx) => {
      screentone(ctx, 900, 1000);
      ctx.fillStyle = '#3d3d48';
      ctx.fillRect(650, 760, 220, 220);
      // Union outline: stroke both ovals, then fill both again a little smaller (the inner arcs vanish).
      for (const [cx, cy, rx, ry] of [[560, 250, 270, 190], [330, 560, 250, 180]]) ellipseBubble(ctx, cx, cy, rx, ry);
      for (const [cx, cy, rx, ry] of [[560, 250, 270, 190], [330, 560, 250, 180]]) ellipseBubble(ctx, cx, cy, rx - 2, ry - 2, '#ffffff', null);
      // The short shared border where the two meet.
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(400, 410);
      ctx.lineTo(470, 425);
      ctx.stroke();
    },
    blocks: [
      { text: 'I... COULDN’T SENSE YOU UNTIL JUST NOW.', translation: 'Я... НЕ ЧУВСТВОВАЛ ТЕБЯ ДО ЭТОГО МОМЕНТА.', type: 'DIALOGUE', letters: 'dark', bubble: ell(560, 250, 270, 190), draw: (ctx) => lines(ctx, ['I... COULDN’T', 'SENSE YOU UNTIL', 'JUST NOW.'], 590, 160, 32) },
      { text: 'I DIDN’T KNOW YOU WERE IN TROUBLE.', translation: 'Я НЕ ЗНАЛ, ЧТО ТЫ В БЕДЕ.', type: 'DIALOGUE', letters: 'dark', bubble: ell(330, 560, 250, 180), draw: (ctx) => lines(ctx, ['I DIDN’T', 'KNOW YOU WERE', 'IN TROUBLE.'], 300, 520, 32) },
    ],
    artRegions: [[650, 760, 220, 220], [20, 800, 500, 180]],
  },
  {
    name: 'caption-narration',
    title: 'Прямоугольная плашка рассказчика',
    sourceLang: 'en',
    width: 800,
    height: 1000,
    art: (ctx) => {
      sky(ctx, 0, 0, 800, 1000, '#d6e2f0', '#8fa8c8');
      mountains(ctx, 800, 520);
      rectBox(ctx, [40, 40, 380, 140], '#ffffff', '#000000');
    },
    blocks: [
      {
        text: 'MEANWHILE, FAR AWAY IN THE NORTHERN MOUNTAINS...',
        translation: 'ТЕМ ВРЕМЕНЕМ ДАЛЕКО В СЕВЕРНЫХ ГОРАХ...',
        type: 'NARRATION',
        letters: 'dark',
        bubble: { kind: 'rect', box: [40, 40, 380, 140], fill: '#ffffff' },
        draw: (ctx) => lines(ctx, ['MEANWHILE, FAR AWAY', 'IN THE NORTHERN', 'MOUNTAINS...'], 230, 64, 26),
      },
    ],
    artRegions: [[0, 560, 800, 440], [480, 40, 300, 300]],
  },
  {
    name: 'white-on-dark-box',
    title: 'Белый текст на тёмной плашке',
    sourceLang: 'en',
    width: 800,
    height: 1000,
    art: (ctx) => {
      sky(ctx, 0, 0, 800, 1000, '#f2d7b0', '#c48a5a');
      figure(ctx, 80, 300, 280, 700, '#523b2c');
      rectBox(ctx, [400, 780, 360, 170], '#111111', null);
    },
    blocks: [
      {
        text: 'THAT WAS THE DAY EVERYTHING CHANGED.',
        translation: 'В ТОТ ДЕНЬ ВСЁ ИЗМЕНИЛОСЬ.',
        type: 'NARRATION',
        letters: 'light',
        bubble: { kind: 'rect', box: [400, 780, 360, 170], fill: '#111111' },
        draw: (ctx) => lines(ctx, ['THAT WAS THE DAY', 'EVERYTHING', 'CHANGED.'], 580, 812, 28, { color: '#ffffff' }),
      },
    ],
    artRegions: [[80, 310, 280, 690], [420, 40, 340, 500]],
  },
  {
    name: 'free-text-on-art',
    title: 'Текст прямо на рисунке (без бабла)',
    sourceLang: 'en',
    width: 800,
    height: 900,
    art: (ctx) => {
      hatching(ctx, [0, 0, 800, 900]);
      figure(ctx, 60, 300, 300, 600, '#3a3240', '#f0dccc');
    },
    blocks: [
      { text: 'so cute...', translation: 'какая милота...', type: 'DIALOGUE', letters: 'dark', haloOk: true, bubble: { kind: 'none', box: [0, 0, 0, 0] }, draw: (ctx) => lines(ctx, ['so cute...'], 580, 160, 34, { color: '#111111', stroke: '#ffffff', strokeWidth: 5 }) },
    ],
    artRegions: [[60, 320, 300, 580], [420, 450, 360, 430]],
  },
  {
    name: 'sfx-outlined',
    title: 'Звукоподражание с обводкой поверх рисунка',
    sourceLang: 'en',
    width: 800,
    height: 900,
    art: (ctx) => {
      const g = ctx.createRadialGradient(400, 430, 40, 400, 430, 520);
      g.addColorStop(0, '#f2a03a');
      g.addColorStop(1, '#b8402a');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 800, 900);
      speedLines(ctx, 400, 450, 800, 900, '#5a1a10');
      ctx.fillStyle = '#6a4a3a';
      ctx.beginPath();
      ctx.arc(400, 800, 120, 0, Math.PI * 2);
      ctx.fill();
    },
    blocks: [{ text: 'BOOM!', translation: 'БУМ!', type: 'SFX', letters: 'light', haloOk: true, bubble: { kind: 'none', box: [0, 0, 0, 0] }, draw: (ctx) => lines(ctx, ['BOOM!'], 400, 360, 110, { color: '#ffffff', stroke: '#000000', strokeWidth: 8 }) }],
    artRegions: [[0, 0, 220, 250], [580, 650, 220, 250], [290, 690, 220, 210]],
  },
  {
    name: 'tiny-bubble-long',
    title: 'Крошечный бабл и длинный перевод',
    sourceLang: 'en',
    width: 800,
    height: 1000,
    art: (ctx) => {
      screentone(ctx, 800, 1000);
      figure(ctx, 250, 350, 300, 650);
      ellipseBubble(ctx, 600, 200, 52, 32);
    },
    blocks: [{ text: 'EH?', translation: 'ЧТО? ТЫ ЭТО СЕРЬЁЗНО ГОВОРИШЬ?', type: 'DIALOGUE', letters: 'dark', bubble: ell(600, 200, 52, 32), draw: (ctx) => lines(ctx, ['EH?'], 600, 188, 20) }],
    artRegions: [[250, 370, 300, 630], [40, 40, 400, 260]],
  },
  {
    name: 'webtoon-strip-tall',
    title: 'Длинная полоса вебтуна 800×4000, баблы у краёв',
    sourceLang: 'ko',
    width: 800,
    height: 4000,
    art: (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 800, 4000);
      sky(ctx, 40, 250, 720, 1400, '#5a7fd8', '#e4ecfa');
      figure(ctx, 230, 900, 340, 750, '#36507a');
      sky(ctx, 40, 2050, 720, 1600, '#1a1622', '#4a3a52');
      figure(ctx, 260, 2700, 300, 950, '#c8b0d0', '#f0e0e8', '#e0e0f0');
      ellipseBubble(ctx, 400, 110, 260, 95, '#ffffff', '#555555', 3);
      ellipseBubble(ctx, 400, 1850, 250, 110, '#ffffff', '#555555', 3);
      ellipseBubble(ctx, 420, 3880, 280, 100, '#ffffff', '#555555', 3);
    },
    blocks: [
      { text: '정말 괜찮은 거야?', translation: 'Ты правда в порядке?', type: 'DIALOGUE', letters: 'dark', bubble: ell(400, 110, 260, 95), draw: (ctx) => lines(ctx, ['정말 괜찮은 거야?'], 400, 88, 36, { font: 'TestCJK' }) },
      { text: '걱정하지 마. 금방 돌아올게.', translation: 'Не волнуйся. Я скоро вернусь.', type: 'DIALOGUE', letters: 'dark', bubble: ell(400, 1850, 250, 110), draw: (ctx) => lines(ctx, ['걱정하지 마.', '금방 돌아올게.'], 400, 1810, 34, { font: 'TestCJK' }) },
      { text: '내일 다시 만나자. 약속이야!', translation: 'Встретимся завтра. Обещаешь!', type: 'DIALOGUE', letters: 'dark', bubble: ell(420, 3880, 280, 100), draw: (ctx) => lines(ctx, ['내일 다시 만나자.', '약속이야!'], 420, 3840, 34, { font: 'TestCJK' }) },
    ],
    artRegions: [[60, 300, 680, 1300], [60, 2100, 680, 1500]],
  },
  {
    name: 'art-only',
    title: 'Страница без текста (только рисунок)',
    sourceLang: 'ja',
    width: 800,
    height: 1100,
    art: (ctx) => {
      screentone(ctx, 800, 1100);
      sky(ctx, 30, 30, 740, 500, '#f0f0f0', '#a0a0a0');
      mountains(ctx, 800, 300, '#505050');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 540, 800, 20);
      sky(ctx, 30, 570, 740, 500, '#e8e8e8', '#9a9a9a');
      rectBox(ctx, [80, 610, 260, 200], '#f6f6f6', '#333333', 6);
      ctx.fillStyle = '#6a6a6a';
      ctx.fillRect(30, 900, 740, 170);
      figure(ctx, 430, 620, 240, 450);
    },
    blocks: [],
    artRegions: [[0, 0, 800, 1100]],
  },
  {
    name: 'art-speedlines',
    title: 'Без текста: линии скорости за персонажем',
    sourceLang: 'ja',
    width: 800,
    height: 1100,
    art: (ctx) => {
      screentone(ctx, 800, 1100);
      ctx.fillStyle = '#e0e0e0';
      ctx.fillRect(30, 30, 740, 1040);
      speedLines(ctx, 400, 550, 740, 1040, '#555555');
      figure(ctx, 260, 330, 280, 740);
    },
    blocks: [],
    artRegions: [[0, 0, 800, 1100]],
  },
  {
    name: 'dark-bubble-white-text',
    title: 'Тёмный бабл с белым текстом',
    sourceLang: 'en',
    width: 800,
    height: 1000,
    art: (ctx) => {
      screentone(ctx, 800, 1000, '#e4e4e4', '#b8b8b8');
      figure(ctx, 420, 480, 320, 520, '#2a2030');
      ellipseBubble(ctx, 380, 280, 250, 150, '#141414', '#ffffff', 3);
    },
    blocks: [
      { text: 'YOU CAN’T ESCAPE FROM ME.', translation: 'ТЕБЕ ОТ МЕНЯ НЕ СБЕЖАТЬ.', type: 'DIALOGUE', letters: 'light', bubble: ell(380, 280, 250, 150, '#141414'), draw: (ctx) => lines(ctx, ['YOU CAN’T ESCAPE', 'FROM ME.'], 380, 242, 32, { color: '#ffffff' }) },
    ],
    artRegions: [[430, 500, 300, 500], [20, 500, 380, 480]],
  },
  {
    name: 'long-ru-words',
    title: 'Несколько строк и длинные русские слова (переносы)',
    sourceLang: 'en',
    width: 800,
    height: 1000,
    art: (ctx) => {
      sky(ctx, 0, 0, 800, 1000, '#ffe9c8', '#f0a868');
      ctx.fillStyle = '#7a4a2a';
      for (const [x, h] of [[30, 260], [170, 340], [600, 300], [700, 380]]) ctx.fillRect(x, 1000 - h, 90, h);
      ellipseBubble(ctx, 400, 330, 215, 175);
    },
    blocks: [
      {
        text: 'THE SIGHTSEEING SPOTS OF THE CAPITAL ARE OVERWHELMING, YOUR EXCELLENCY!',
        translation: 'ДОСТОПРИМЕЧАТЕЛЬНОСТИ СТОЛИЦЫ ПРОСТО ОШЕЛОМИТЕЛЬНЫЕ, ВАШЕ ВЫСОКОПРЕВОСХОДИТЕЛЬСТВО!',
        type: 'DIALOGUE',
        letters: 'dark',
        bubble: ell(400, 330, 215, 175),
        draw: (ctx) => lines(ctx, ['THE SIGHTSEEING', 'SPOTS OF THE CAPITAL', 'ARE OVERWHELMING,', 'YOUR EXCELLENCY!'], 400, 262, 26),
      },
    ],
    artRegions: [[20, 620, 120, 380], [590, 620, 210, 380]],
  },
];

// ---------------------------------------------------------------- building

function letterMask(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8Array {
  const m = new Uint8Array(a.length / 4);
  for (let i = 0; i < m.length; i++) {
    const d = Math.abs(a[i * 4] - b[i * 4]) + Math.abs(a[i * 4 + 1] - b[i * 4 + 1]) + Math.abs(a[i * 4 + 2] - b[i * 4 + 2]);
    if (d > 100) m[i] = 1;
  }
  return m;
}

function boundsIn(mask: Uint8Array, W: number, H: number, [x, y, w, h]: Box): Box | null {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w)), y1 = Math.min(H, Math.ceil(y + h));
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let yy = y0; yy < y1; yy++)
    for (let xx = x0; xx < x1; xx++)
      if (mask[yy * W + xx]) {
        a = Math.min(a, xx);
        b = Math.min(b, yy);
        c = Math.max(c, xx);
        d = Math.max(d, yy);
      }
  return Number.isFinite(a) ? [a, b, c - a + 1, d - b + 1] : null;
}

async function build(s: PageSpec): Promise<GoldenPage> {
  const page = createCanvas(s.width, s.height);
  const pctx = page.getContext('2d') as Ctx;
  s.art(pctx);
  const rough = s.blocks.map((b) => b.draw(pctx));
  const clean = createCanvas(s.width, s.height);
  const cctx = clean.getContext('2d') as Ctx;
  s.art(cctx);
  const pixels = new Uint8ClampedArray(pctx.getImageData(0, 0, s.width, s.height).data);
  const cleanPx = new Uint8ClampedArray(cctx.getImageData(0, 0, s.width, s.height).data);
  const letters = letterMask(pixels, cleanPx);
  const blocks: ExpectedBlock[] = s.blocks.map((b, i) => {
    const r = rough[i];
    const textBox = boundsIn(letters, s.width, s.height, [r[0] - 10, r[1] - 10, r[2] + 20, r[3] + 20]);
    if (!textBox) throw new Error(`${s.name}: block ${i} drew no letters`);
    const { draw: _draw, ...rest } = b;
    return { ...rest, textBox, ...(b.bubble?.kind === 'none' ? { bubble: { kind: 'none' as const, box: textBox } } : {}) };
  });
  return {
    name: s.name,
    title: s.title,
    sourceLang: s.sourceLang,
    bytes: new Uint8Array(await page.encode('png')),
    width: s.width,
    height: s.height,
    expected: { blocks, artRegions: s.artRegions },
    ...(s.blocks.length ? {} : { noText: true }),
    pixels,
    clean: cleanPx,
    letters,
  };
}

/** Names and titles of the golden pages, in order (the pages themselves are drawn by `makePage`). */
export const GOLDEN_PAGES: { name: string; title: string }[] = SPECS.map((s) => ({ name: s.name, title: s.title }));

export function makePage(name: string): Promise<GoldenPage> {
  const s = SPECS.find((x) => x.name === name);
  if (!s) throw new Error(`No golden page ${name}`);
  return build(s);
}

export async function makeAllPages(): Promise<GoldenPage[]> {
  return Promise.all(SPECS.map(build));
}
