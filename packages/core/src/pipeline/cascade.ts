/**
 * Cascade (settings → «Сначала распознавание»): the text of a page is read first by the recognition
 * in the browser (fast, on the video card); when every piece of it is read clearly, the model only
 * translates the text — no picture goes to it, the request is several times shorter. When anything
 * is unsure — a piece read as nothing, a line the recognition doubts, text outside the bubbles not
 * read cleanly — the model reads the picture as it would without the cascade.
 */

/** One piece of a page the detector found, as the recognition read it. */
export interface PieceRead {
  text: string;
  /** Each line's own certainty (0–1). */
  lines: { score: number }[];
  /** Outside the bubbles (sounds, signs, narration): read wrong more often. */
  free: boolean;
}

/**
 * How sure the readings must be to be trusted. Starting values; the analysis pack shows which way
 * each page went (timings.readBy and the reason in its steps), to tune them on real chapters.
 */
export const CASCADE_LIMITS = {
  /** The least certainty of any line in a bubble. */
  line: 0.75,
  /** …of any line outside the bubbles. */
  free: 0.9,
  /** The page's average over its lines. */
  mean: 0.85,
} as const;

export type ReadRoute = 'ocr' | 'vision';

/** Which way the page goes, and why (for the page's steps). */
export function cascadeRoute(pieces: PieceRead[]): { route: ReadRoute; reason: string } {
  const vision = (reason: string) => ({ route: 'vision' as const, reason });
  if (!pieces.length) return vision('the detector found no text');
  const scores: number[] = [];
  for (const [i, p] of pieces.entries()) {
    if (!p.text.trim()) return vision(`piece ${i + 1} read as nothing`);
    if (!p.lines.length) return vision(`piece ${i + 1} read without a certainty`);
    const least = Math.min(...p.lines.map((l) => l.score));
    const need = p.free ? CASCADE_LIMITS.free : CASCADE_LIMITS.line;
    if (least < need) return vision(`piece ${i + 1} unsure (${least.toFixed(2)} < ${need})`);
    scores.push(...p.lines.map((l) => l.score));
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (mean < CASCADE_LIMITS.mean) return vision(`the page is unsure on average (${mean.toFixed(2)} < ${CASCADE_LIMITS.mean})`);
  return { route: 'ocr', reason: `${pieces.length} piece(s) read clearly (average ${mean.toFixed(2)})` };
}
