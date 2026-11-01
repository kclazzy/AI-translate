// Lever, not a CI test: runs the pack check on a real analysis pack (unpacked folder) and prints
// what it found. PACK=/path/to/unpacked-pack npx vitest run test/packcheck.pack.test.ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, it } from 'vitest';
import { checkPack, spillRegions, type PackIssue, type PackPage } from '../src/diag/packCheck';
import type { Box } from '../src/types';

const PACK = process.env.PACK;

async function grey(file: string, w: number, h: number): Promise<Uint8ClampedArray> {
  const img = await loadImage(readFileSync(file));
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

describe.skipIf(!PACK)('analysis pack check on a real pack', () => {
  it('lists seam cuts, loose boxes and spills', { timeout: 600_000 }, async () => {
    const dir = PACK!;
    const names = readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort();
    const pages: PackPage[] = [];
    const issues: PackIssue[] = [];
    for (const name of names) {
      const d = JSON.parse(readFileSync(join(dir, name, 'page.json'), 'utf8'));
      const blocks = (d.blocks ?? []).map((b: { id: string; originalText: string; translatedText?: string; translate?: boolean; bbox: Box; bubble?: { box: Box } }) => ({ id: b.id, text: b.originalText, translation: b.translate === false ? '' : (b.translatedText ?? ''), bbox: b.bbox, bubble: b.bubble?.box }));
      pages.push({ name, width: d.width, height: d.height, blocks, joined: d.joined });
      const orig = readdirSync(join(dir, name)).find((f) => f.startsWith('original.'));
      if (!orig || !existsSync(join(dir, name, 'result.jpg')) || !blocks.length) continue;
      const [a, r] = await Promise.all([grey(join(dir, name, orig), d.width, d.height), grey(join(dir, name, 'result.jpg'), d.width, d.height)]);
      const changed = new Uint8Array(d.width * d.height);
      for (let i = 0; i < changed.length; i++) {
        const o = (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3;
        const n = (r[i * 4] + r[i * 4 + 1] + r[i * 4 + 2]) / 3;
        changed[i] = Math.abs(o - n) > 60 ? 1 : 0;
      }
      const m = 8;
      const allowed: Box[] = blocks.flatMap((b: { bbox: Box; bubble?: Box }) => [b.bbox, b.bubble].filter(Boolean).map((x) => [x![0] - m, x![1] - m, x![2] + 2 * m, x![3] + 2 * m] as Box));
      for (const s of spillRegions(changed, d.width, d.height, allowed, 1500)) issues.push({ kind: 'spill', page: name, ...s });
    }
    issues.push(...checkPack(pages));
    const count = (k: string) => issues.filter((i) => i.kind === k).length;
    const report = [`pages ${pages.length}: seam-cut ${count('seam-cut')} (glued ${issues.filter((i) => i.kind === 'seam-cut' && i.glued).length}), loose-box ${count('loose-box')}, spill ${count('spill')} on ${new Set(issues.filter((i) => i.kind === 'spill').map((i) => (i as { page: string }).page)).size} pictures`, ...issues.map((i) => JSON.stringify(i))].join('\n');
    if (process.env.OUT) writeFileSync(process.env.OUT, report);
    console.log(report);
  });
});
