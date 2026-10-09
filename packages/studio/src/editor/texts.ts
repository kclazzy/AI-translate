import type { TextBlock } from '@ait/core';

/**
 * Texts of a page as a file: for proof-reading in any text editor or a spreadsheet, and loading
 * the corrected translations back.
 *
 * .txt:
 *   [1] original text
 *   => translation
 */
export function exportTexts(blocks: TextBlock[], title: string | undefined, format: 'txt' | 'json'): string {
  if (format === 'json') return JSON.stringify({ title, blocks: blocks.map((b, i) => ({ n: i + 1, id: b.id, type: b.textType, original: b.originalText, translation: b.translatedText })) }, null, 2);
  const lines = [`# AI Translate${title ? ` — ${title}` : ''}`, ''];
  blocks.forEach((b, i) => {
    lines.push(`[${i + 1}] ${b.originalText.replace(/\s*\n\s*/g, ' ')}`);
    lines.push(`=> ${b.translatedText.replace(/\n/g, '\\n')}`);
    lines.push('');
  });
  return lines.join('\n');
}

/** Put translations from a file back: matched by block id (JSON) or by number. */
export function importTexts(blocks: TextBlock[], text: string): { blocks: TextBlock[]; changed: number } {
  const byId = new Map<string, string>();
  const byN = new Map<number, string>();
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed) as { blocks?: unknown[] } | unknown[];
    const list = (Array.isArray(json) ? json : json.blocks ?? []) as { id?: string; n?: number; translation?: string }[];
    for (const x of list) {
      if (typeof x?.translation !== 'string') continue;
      if (x.id) byId.set(x.id, x.translation);
      if (typeof x.n === 'number') byN.set(x.n, x.translation);
    }
  } else {
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      const head = /^\[(\d+)\]/.exec(line);
      if (head) n = Number(head[1]);
      else if (line.startsWith('=>') && n) byN.set(n, line.replace(/^=>\s?/, '').replace(/\\n/g, '\n'));
    }
  }
  let changed = 0;
  const next = blocks.map((b, i) => {
    const t = byId.get(b.id) ?? byN.get(i + 1);
    if (t === undefined || t === b.translatedText) return b;
    changed++;
    return { ...b, translatedText: t, edited: true };
  });
  return { blocks: next, changed };
}

/** All pages of a chapter in one text file: a heading per page, then its lines. */
export function exportChapterTexts(pages: TextBlock[][], title: string | undefined): string {
  const lines = [`# AI Translate${title ? ` — ${title}` : ''}`, ''];
  let n = 0;
  pages.forEach((blocks, p) => {
    if (!blocks.length) return;
    lines.push(`## ${p + 1}`, '');
    for (const b of blocks) {
      n++;
      lines.push(`[${n}] ${b.originalText.replace(/\s*\n\s*/g, ' ')}`);
      lines.push(`=> ${b.translatedText.replace(/\n/g, '\\n')}`);
      lines.push('');
    }
  });
  return lines.join('\n');
}
