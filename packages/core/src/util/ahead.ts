/**
 * How many pictures below the screen are translated ahead while reading (auto-translate): enough
 * that the reader does not catch up with the model. A page is read in about `readMs`; the model
 * needs the recent pages' average; the queue ahead holds their ratio, within the bounds (memory, and
 * work for pages nobody may read — for an online model, money).
 */
export const AHEAD = { start: 3, min: 2, max: 6, readMs: 8000, recent: 5 } as const;

export function pagesAhead(recentMs: number[]): number {
  const last = recentMs.filter((ms) => Number.isFinite(ms) && ms > 0).slice(-AHEAD.recent);
  if (!last.length) return AHEAD.start;
  const avg = last.reduce((a, b) => a + b, 0) / last.length;
  return Math.max(AHEAD.min, Math.min(AHEAD.max, Math.ceil(avg / AHEAD.readMs)));
}
