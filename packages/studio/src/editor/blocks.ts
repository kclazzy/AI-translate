import type { Box, TextBlock } from '@ait/core';

/** How far a copy goes from its original, px (down and to the right). */
const STEP = 16;

/**
 * «Дублировать»: copies of the chosen blocks a little lower and to the right (kept on the page),
 * after all the blocks, with new ids and the same text and style. Returns the new list and the copies' ids.
 */
export function duplicateBlocks(blocks: TextBlock[], ids: Set<string>, page: { width: number; height: number }, newId: () => string): { blocks: TextBlock[]; added: string[] } {
  const added: string[] = [];
  const copies = blocks
    .filter((b) => ids.has(b.id))
    .map((b) => {
      const dx = Math.min(STEP, Math.max(0, page.width - (b.bbox[0] + b.bbox[2])));
      const dy = Math.min(STEP, Math.max(0, page.height - (b.bbox[1] + b.bbox[3])));
      const move = (x: Box): Box => [x[0] + dx, x[1] + dy, x[2], x[3]];
      const id = newId();
      added.push(id);
      return {
        ...structuredClone(b),
        id,
        bbox: move(b.bbox),
        polygon: b.polygon.map(([x, y]) => [x + dx, y + dy] as [number, number]),
        ...(b.textBox ? { textBox: move(b.textBox) } : {}),
        bubble: b.bubble ? { ...b.bubble, box: move(b.bubble.box), safeArea: move(b.bubble.safeArea), rows: undefined } : null,
        edited: true,
      } as TextBlock;
    });
  return { blocks: [...blocks, ...copies], added };
}
