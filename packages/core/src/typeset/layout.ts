import type { Alignment, Box } from '../types';

export interface Measurer {
  /** Width in px of `text` at the given CSS font string. */
  measure(text: string, font: string): number;
}

export interface LayoutInput {
  text: string;
  box: Box;
  shape: 'ellipse' | 'rect';
  fontFamily: string;
  bold?: boolean;
  italic?: boolean;
  /** Fixed size; when null the largest fitting size is searched. */
  fontSize?: number | null;
  minSize?: number;
  maxSize?: number;
  lineHeight?: number;
  vertical?: boolean;
  alignment?: Alignment;
  /** Language of the text; enables character wrapping for CJK. */
  lang?: string;
}

export interface LaidOutLine {
  text: string;
  /** Anchor x (depends on alignment) relative to box left. */
  x: number;
  /** Baseline y relative to box top. */
  y: number;
  width: number;
}

export interface LaidOutGlyph {
  ch: string;
  x: number;
  y: number;
}

export interface LayoutResult {
  fontSize: number;
  font: string;
  lineHeight: number;
  lines: LaidOutLine[];
  /** Only for vertical layouts. */
  glyphs: LaidOutGlyph[];
  vertical: boolean;
  alignment: Alignment;
  overflow: boolean;
}

export function cssFont(size: number, family: string, bold = false, italic = false): string {
  return `${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${size}px ${family}`;
}

const VOWELS = /[аеёиоуыэюяaeiouyαεηιουω]/i;
const LETTER = /\p{L}/u;

/**
 * Split a word that does not fit into a prefix and a remainder.
 * An existing hyphen is used first (no extra hyphen is added). Otherwise both
 * parts must contain a vowel and at least two letters, and the remainder may not
 * start with ь/ъ/й, following Russian hyphenation rules.
 */
export function hyphenate(word: string, fits: (s: string) => boolean): [string, string] | null {
  const chars = [...word];
  // Existing hyphen ("Танака-сан"): break after it.
  for (let i = chars.length - 2; i >= 1; i--) {
    if (chars[i] === '-' && LETTER.test(chars[i - 1]) && LETTER.test(chars[i + 1] ?? '')) {
      const head = chars.slice(0, i + 1).join('');
      if (fits(head)) return [head, chars.slice(i + 1).join('')];
    }
  }
  const letters = chars.filter((c) => LETTER.test(c)).length;
  if (letters < 5) return null;
  let best = -1;
  for (let i = 2; i <= chars.length - 2; i++) {
    const headChars = chars.slice(0, i);
    const tailChars = chars.slice(i);
    if (!fits(headChars.join('') + '-')) break;
    const headLetters = headChars.filter((c) => LETTER.test(c));
    const tailLetters = tailChars.filter((c) => LETTER.test(c));
    if (headLetters.length < 2 || tailLetters.length < 2) continue;
    if (!headLetters.some((c) => VOWELS.test(c)) || !tailLetters.some((c) => VOWELS.test(c))) continue;
    if (/[ьъй]/i.test(tailChars[0])) continue;
    if (!LETTER.test(chars[i - 1]) || !LETTER.test(chars[i])) continue;
    // Prefer a break right after a vowel; otherwise the longest valid head.
    if (VOWELS.test(chars[i - 1]) || best < 0) best = i;
  }
  if (best < 0) return null;
  return [chars.slice(0, best).join('') + '-', chars.slice(best).join('')];
}

function isCjkText(text: string): boolean {
  return /[぀-ヿ㐀-鿿가-힯]/.test(text) && !/\s/.test(text.trim());
}

function tokenize(text: string, lang?: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (lang === 'ja' || lang === 'zh' || lang === 'zh-TW' || isCjkText(clean)) {
    // Character-level wrapping; keep trailing punctuation with previous char.
    const out: string[] = [];
    for (const ch of clean) {
      if (out.length && /[、。，．！？!?…ー」』）)]/.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }
  return clean.split(' ');
}

function availableWidth(shape: 'ellipse' | 'rect', w: number, h: number, top: number, bottom: number): number {
  if (shape === 'rect') return w;
  const cy = h / 2;
  const dy = Math.max(Math.abs(top - cy), Math.abs(bottom - cy));
  const ry = (h / 2) * 1.12;
  const k = 1 - (dy / ry) ** 2;
  return k <= 0 ? 0 : w * Math.sqrt(k);
}

function tryHorizontal(m: Measurer, input: LayoutInput, size: number, allowHyphen = true): LayoutResult | null {
  const [, , w, h] = input.box;
  const font = cssFont(size, input.fontFamily, input.bold, input.italic);
  const lh = size * (input.lineHeight ?? 1.12);
  const tokens = tokenize(input.text, input.lang);
  if (!tokens.length) return { fontSize: size, font, lineHeight: lh, lines: [], glyphs: [], vertical: false, alignment: input.alignment ?? 'center', overflow: false };
  const joiner = tokens.length > 1 && !isCjkText(input.text) && input.lang !== 'ja' && input.lang !== 'zh' ? ' ' : '';
  const maxLines = Math.floor(h / lh);
  if (maxLines < 1) return null;

  // The available width per line depends on how many lines there are (they are centred vertically).
  for (let n = 1; n <= maxLines; n++) {
    const total = n * lh;
    const startY = (h - total) / 2;
    const widths: number[] = [];
    for (let i = 0; i < n; i++) widths.push(availableWidth(input.shape, w, h, startY + i * lh, startY + (i + 1) * lh));
    const lines: string[] = [];
    let queue = [...tokens];
    let ok = true;
    for (let i = 0; i < n && queue.length; i++) {
      const avail = widths[i];
      let line = '';
      while (queue.length) {
        const candidate = line ? line + joiner + queue[0] : queue[0];
        if (m.measure(candidate, font) <= avail) {
          line = candidate;
          queue.shift();
          continue;
        }
        if (!line) {
          // A single token is too wide: hyphenate or give up for this n.
          const split = allowHyphen ? hyphenate(queue[0], (s) => m.measure(s, font) <= avail) : null;
          if (split) {
            line = split[0];
            queue = [split[1], ...queue.slice(1)];
          } else ok = false;
        }
        break;
      }
      if (!ok) break;
      lines.push(line);
    }
    if (!ok || queue.length) continue;
    const used = lines.length;
    const realStart = (h - used * lh) / 2;
    const align = input.alignment ?? 'center';
    const laid: LaidOutLine[] = lines.map((text, i) => {
      const top = realStart + i * lh;
      const avail = availableWidth(input.shape, w, h, top, top + lh);
      const width = m.measure(text, font);
      const x = align === 'center' ? w / 2 : align === 'left' ? (w - avail) / 2 : w - (w - avail) / 2;
      return { text, x, y: top + lh / 2 + size * 0.35, width };
    });
    return { fontSize: size, font, lineHeight: lh, lines: laid, glyphs: [], vertical: false, alignment: align, overflow: false };
  }
  return null;
}

function tryVertical(m: Measurer, input: LayoutInput, size: number): LayoutResult | null {
  const [, , w, h] = input.box;
  const font = cssFont(size, input.fontFamily, input.bold, input.italic);
  const step = size * 1.05;
  const colW = size * (input.lineHeight ?? 1.2);
  const perCol = Math.floor(h / step);
  if (perCol < 1) return null;
  const chars = [...input.text.replace(/\s+/g, '')];
  if (!chars.length) return { fontSize: size, font, lineHeight: colW, lines: [], glyphs: [], vertical: true, alignment: 'center', overflow: false };
  const cols = Math.ceil(chars.length / perCol);
  if (cols * colW > w) return null;
  const startX = (w + cols * colW) / 2 - colW / 2; // rightmost column centre
  const glyphs: LaidOutGlyph[] = [];
  for (let c = 0; c < cols; c++) {
    const colChars = chars.slice(c * perCol, (c + 1) * perCol);
    const colH = colChars.length * step;
    const top = (h - colH) / 2;
    colChars.forEach((ch, i) => glyphs.push({ ch, x: startX - c * colW, y: top + i * step + size * 0.85 }));
  }
  void m;
  return { fontSize: size, font, lineHeight: colW, lines: [], glyphs, vertical: true, alignment: 'center', overflow: false };
}

function searchSize(m: Measurer, input: LayoutInput, attempt: (m: Measurer, i: LayoutInput, size: number) => LayoutResult | null, lo: number, hi: number): LayoutResult | null {
  let best: LayoutResult | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = attempt(m, input, mid);
    if (r) {
      best = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/**
 * Find the largest font size at which the text fits the box (binary search).
 * Word breaks with hyphens are used only when they buy a clearly larger size.
 */
export function layoutText(m: Measurer, input: LayoutInput): LayoutResult {
  const minSize = Math.max(6, input.minSize ?? 9);
  const [, , w, h] = input.box;
  if (input.fontSize) {
    const fixed = input.vertical ? tryVertical(m, input, input.fontSize) : tryHorizontal(m, input, input.fontSize, false) ?? tryHorizontal(m, input, input.fontSize, true);
    if (fixed) return fixed;
    return forceLayout(m, input, input.fontSize);
  }
  const hi = Math.max(minSize, Math.floor(input.maxSize ?? Math.min(72, h * 0.5, w * 0.5)));
  let best: LayoutResult | null;
  if (input.vertical) best = searchSize(m, input, tryVertical, minSize, hi);
  else {
    const plain = searchSize(m, input, (mm, ii, s) => tryHorizontal(mm, ii, s, false), minSize, hi);
    const hyph = searchSize(m, input, (mm, ii, s) => tryHorizontal(mm, ii, s, true), minSize, hi);
    if (plain && hyph) best = hyph.fontSize >= plain.fontSize + Math.max(4, plain.fontSize * 0.35) ? hyph : plain;
    else best = plain ?? hyph;
  }
  if (best) return best;
  // Does not fit even at the minimum: try a rectangle (ignore bubble curvature) before overflowing.
  if (input.shape === 'ellipse') {
    const rect = layoutText(m, { ...input, shape: 'rect' });
    if (!rect.overflow) return rect;
  }
  return forceLayout(m, input, minSize);
}

/** Lay out at a fixed size even if it overflows (flagged for the editor). */
function forceLayout(m: Measurer, input: LayoutInput, size: number): LayoutResult {
  const tall: LayoutInput = { ...input, box: [input.box[0], input.box[1], input.box[2], input.box[3] * 4], shape: 'rect' };
  const r = (input.vertical ? tryVertical : tryHorizontal)(m, tall, size);
  const font = cssFont(size, input.fontFamily, input.bold, input.italic);
  if (!r) {
    return { fontSize: size, font, lineHeight: size * 1.12, lines: [{ text: input.text, x: input.box[2] / 2, y: input.box[3] / 2, width: m.measure(input.text, font) }], glyphs: [], vertical: false, alignment: 'center', overflow: true };
  }
  // Re-centre vertically in the real box.
  const shift = (input.box[3] * 4 - input.box[3]) / 2;
  return { ...r, lines: r.lines.map((l) => ({ ...l, y: l.y - shift })), glyphs: r.glyphs.map((g) => ({ ...g, y: g.y - shift })), overflow: true };
}
