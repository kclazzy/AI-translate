/**
 * Text of a game or status window: items one per line («Name: Aiden Walker», «HP: 480»,
 * «ATK +10%»). Unlike a bubble's lines (one sentence broken by the letterer), each line is an item
 * of its own: translated, kept and set line by line.
 */

/** «Label: value», or a label ending with a colon (a heading). */
const LABELLED = /^[^:：]{1,32}[:：](\s|$)/u;
/** A short stat: a few words and a number («ATK +10%», «Level +1», «+5 HP»). */
const STAT = /^(?=.*\d)[^.!?…]{1,32}$/u;

/** The lines of a list, or null when the text is speech or narration broken over lines. */
export function listLines(text: string): string[] | null {
  const lines = text
    .replace(/\\+[rn]/g, '\n')
    .split(/\s*\n\s*/)
    .filter(Boolean);
  if (lines.length < 2) return null;
  const items = lines.filter((l) => LABELLED.test(l) || (STAT.test(l) && l.split(/\s+/).length <= 4)).length;
  return items >= Math.max(2, Math.ceil(lines.length / 2)) ? lines : null;
}
