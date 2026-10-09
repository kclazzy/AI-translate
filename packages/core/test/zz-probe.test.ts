/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { cleanBlock } from '/home/claude/ai-translate/packages/core/src/image/clean';
import { TiledImage } from '/home/claude/ai-translate/packages/core/src/image/tiled';
import { napiBackend } from '/home/claude/ai-translate/packages/core/test/helpers';
it('probe', async () => {
  const c = createCanvas(900, 1800);
  const ctx = c.getContext('2d') as any;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 900, 1800);
  ctx.fillStyle = '#000000';
  ctx.beginPath(); ctx.ellipse(560, 250, 280, 220, 0, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 34px TestSans'; ctx.textAlign = 'center';
  ['I... COULDN’T', 'SENSE YOU UNTIL', 'JUST NOW.'].forEach((l, i) => ctx.fillText(l, 580, 180 + i * 42));
  const img = TiledImage.fromDecoded(napiBackend, { width: 900, height: 1800, source: c } as any);
  const r = cleanBlock(img, [450, 145, 260, 130]);
  writeFileSync('/tmp/claude-0/-home-claude-ai-translate/14460047-c1ee-5038-8742-4ba3ec0b4e14/scratchpad/probe.json', JSON.stringify({ closed: r.closed, method: r.method, box: r.bubble?.box, fill: r.bubble?.fill, shape: r.bubble?.shape }));
});
