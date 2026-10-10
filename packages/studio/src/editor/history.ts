import type { Box, PixelData, TextBlock } from '@ait/core';

export type HistoryItem =
  | { kind: 'blocks'; before: TextBlock[]; after: TextBlock[] }
  | { kind: 'pixels'; box: Box; before: PixelData; after: PixelData; blocksBefore?: TextBlock[]; blocksAfter?: TextBlock[] };

export const MAX_HISTORY = 60;
/** Pixel steps of a long webtoon strip are big: the history keeps at most this many bytes. */
export const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

/** Memory held by one step (text steps share block objects and are tiny next to pixels). */
export function itemBytes(it: HistoryItem): number {
  return it.kind === 'pixels' ? it.before.data.byteLength + it.after.data.byteLength : 0;
}

/** Undo / redo stacks limited by the number of steps and by the memory they hold. */
export class EditHistory {
  private undoStack: HistoryItem[] = [];
  private redoStack: HistoryItem[] = [];
  private held = 0;

  constructor(
    readonly maxItems = MAX_HISTORY,
    readonly maxBytes = MAX_HISTORY_BYTES,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): number {
    return this.undoStack.length;
  }

  /** Bytes held by both stacks. */
  get bytes(): number {
    return this.held;
  }

  /** The newest step (the one Ctrl+Z undoes). */
  top(): HistoryItem | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  push(item: HistoryItem): void {
    for (const r of this.redoStack) this.held -= itemBytes(r);
    this.redoStack = [];
    this.undoStack.push(item);
    this.held += itemBytes(item);
    // The oldest steps go first; the newest one is always kept, even when it alone is too big.
    while (this.undoStack.length > 1 && (this.undoStack.length > this.maxItems || this.held > this.maxBytes)) {
      this.held -= itemBytes(this.undoStack.shift()!);
    }
  }

  undo(): HistoryItem | undefined {
    const it = this.undoStack.pop();
    if (it) this.redoStack.push(it);
    return it;
  }

  redo(): HistoryItem | undefined {
    const it = this.redoStack.pop();
    if (it) this.undoStack.push(it);
    return it;
  }
}
