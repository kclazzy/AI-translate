/**
 * The processor's share of the pages in work: one page's stretch of pixel work at a time (erasing,
 * typesetting, encoding), the page started first first. Two pages cleaning at once in the one
 * thread both finish late; one after the other the page the reader is on is ready sooner, and the
 * other no later. A stretch never waits for the model or the video card inside (those are other
 * lanes), so nothing waits on the processor that the processor waits on.
 */
type Waiter = { order: number; seq: number; go: () => void };

export class CpuLane {
  private busy = false;
  private seq = 0;
  private waiting: Waiter[] = [];

  async run<T>(order: number, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((go) => {
      this.waiting.push({ order, seq: this.seq++, go });
      this.next();
    });
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.next();
    }
  }

  private next(): void {
    if (this.busy || !this.waiting.length) return;
    this.waiting.sort((a, b) => a.order - b.order || a.seq - b.seq);
    const w = this.waiting.shift()!;
    this.busy = true;
    w.go();
  }

  /** Waiting or holding the processor now (tests). */
  get state(): { busy: boolean; waiting: number } {
    return { busy: this.busy, waiting: this.waiting.length };
  }
}
