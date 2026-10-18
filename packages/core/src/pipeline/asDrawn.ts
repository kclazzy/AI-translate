import type { Box, TextBlock } from '../types';
import { isCommonEnglish } from '../translate/englishWords';

const letters = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '');

/**
 * A title logo drawn letter by letter (cut-out letters, each its own sign): the model reads every
 * letter as a block («I», «D», «a», …) and each gets «translated» on its own. Letters standing in one
 * row are joined into one block (a wider gap is a space). Returns the joined blocks' ids.
 */
export function joinLetterBlocks(blocks: TextBlock[]): { blocks: TextBlock[]; joined: string[][] } {
  const single = blocks.filter((b) => b.textType !== 'DIALOGUE' && b.textType !== 'NARRATION' && letters(b.originalText).length > 0 && letters(b.originalText).length <= 2);
  const used = new Set<string>();
  const groups: TextBlock[][] = [];
  const sorted = [...single].sort((a, b) => a.bbox[0] - b.bbox[0]);
  for (const s of sorted) {
    if (used.has(s.id)) continue;
    const g = [s];
    used.add(s.id);
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of sorted) {
        if (used.has(o.id)) continue;
        const last = g.reduce((a, b) => (b.bbox[0] + b.bbox[2] > a.bbox[0] + a.bbox[2] ? b : a));
        const h = Math.min(last.bbox[3], o.bbox[3]);
        const overlapY = Math.min(last.bbox[1] + last.bbox[3], o.bbox[1] + o.bbox[3]) - Math.max(last.bbox[1], o.bbox[1]);
        const gap = o.bbox[0] - (last.bbox[0] + last.bbox[2]);
        if (overlapY >= h * 0.4 && gap <= Math.max(last.bbox[3], o.bbox[3]) * 0.9 && gap >= -last.bbox[2] * 0.6) {
          g.push(o);
          used.add(o.id);
          grew = true;
        }
      }
    }
    if (g.length >= 3) groups.push(g);
  }
  if (!groups.length) return { blocks, joined: [] };
  const drop = new Set<string>();
  const joinedIds: string[][] = [];
  const out = blocks.map((b) => {
    const g = groups.find((x) => x[0].id === b.id || x.includes(b));
    if (!g) return b;
    if (g[0].id !== b.id) {
      drop.add(b.id);
      return b;
    }
    const byX = [...g].sort((a, c) => a.bbox[0] - c.bbox[0]);
    const w = byX.reduce((a, c) => a + c.bbox[2], 0) / byX.length;
    let text = '';
    for (const [i, c] of byX.entries()) {
      const gap = i ? c.bbox[0] - (byX[i - 1].bbox[0] + byX[i - 1].bbox[2]) : 0;
      text += (i && gap > w * 0.45 ? ' ' : '') + c.originalText.trim();
    }
    const x0 = Math.min(...g.map((c) => c.bbox[0]));
    const y0 = Math.min(...g.map((c) => c.bbox[1]));
    const x1 = Math.max(...g.map((c) => c.bbox[0] + c.bbox[2]));
    const y1 = Math.max(...g.map((c) => c.bbox[1] + c.bbox[3]));
    const bbox: Box = [x0, y0, x1 - x0, y1 - y0];
    joinedIds.push(g.map((c) => c.id));
    return { ...b, textType: 'SIGN' as const, originalText: text, translatedText: '', bbox, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][], logo: true, bubble: null };
  });
  return { blocks: out.filter((b) => !drop.has(b.id)), joined: joinedIds };
}

const CREDIT = /^(?:original\s+)?(?:story|art|artist|script|scenario|writer|written|original|adapt(?:ed|ation)|illustrat(?:ion|ed|or)|drawn|drawing|colou?r(?:s|ing)?|letter(?:ing|er)|translat(?:ion|ed|or)|edit(?:ed|or|ing)|cover|author|creator|studio|publisher|presented)(?:\s+by)?\s*[:\-–—]?\s+\S/i;

/**
 * Text that stays as drawn, not translated and not erased: the credits (Story …, Art …), a title logo
 * (unless asked: settings → translate the logo) and a sign that is one unknown word in capitals — a
 * shop or brand name (HOWZEN), not a word to translate.
 */
export function keepAsDrawn(b: TextBlock & { logo?: boolean }, opts: { translateLogo?: boolean } = {}): 'credit' | 'logo' | 'brand' | null {
  const t = b.originalText.replace(/\s+/g, ' ').trim();
  if (b.textType === 'DIALOGUE') return null;
  if (t.length <= 60 && t.split(/\n| {2,}/).every((line) => CREDIT.test(line.trim()) || !line.trim()) && CREDIT.test(t)) return 'credit';
  // Several credit lines read as one block: «Story Bongsoo Art dai».
  if (t.length <= 80 && /^(?:story|art|script|original)\b/i.test(t) && /\b(?:art|story|script|illustration)\b/i.test(t.replace(/^\S+/, ''))) return 'credit';
  if (b.logo && !opts.translateLogo) return 'logo';
  if ((b.textType === 'SIGN' || b.textType === 'OTHER') && /^[A-Z][A-Z'’-]{3,}$/.test(t) && !isCommonEnglish(t)) return 'brand';
  return null;
}
