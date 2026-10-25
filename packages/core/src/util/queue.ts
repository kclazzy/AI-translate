import { AppError } from '../errors';

export interface QueueTask<T> {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
  /**
   * Work that can be done before the task's turn, while the queue is full (decode the next picture
   * while the model works on the current one, see TranslateService.prefetch). Called for the next
   * waiting task only, one at a time: at most one task is prepared ahead. Failures are ignored.
   */
  prepare?: (signal: AbortSignal) => Promise<void>;
  /** Memory the task takes while it runs, bytes (see gate; known later: setCost). */
  cost?: number;
}

interface Entry<T> extends QueueTask<T> {
  controller: AbortController;
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  started: boolean;
  seq: number;
  prepareStarted?: boolean;
}

export interface QueueStats {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

/**
 * Concurrency-limited task queue with de-duplication by key, priorities and cancellation.
 * Adding a task whose key is already queued or running returns the existing promise.
 */
export class TaskQueue {
  private entries = new Map<string, Entry<unknown>>();
  private running = 0;
  private seq = 0;
  private stats: QueueStats = { pending: 0, running: 0, done: 0, failed: 0 };
  private listeners = new Set<(s: QueueStats) => void>();
  private preparing = false;
  /** The next task waits for memory (the gate said no), not for a free place. */
  private held = false;

  /**
   * May the next task start while others run? (`inWork`: the costs of the running ones.) Asked only
   * when at least one task runs — one is always let in. Checked again whenever a task ends.
   */
  gate?: (inWork: (number | undefined)[], next: number | undefined) => boolean;

  constructor(public concurrency = 2) {}

  /** The memory a task takes is known now (its picture was read): the gate looks again. */
  setCost(key: string, cost: number): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.cost = cost;
    if (!e.started) this.pump();
  }

  /** Look again whether more tasks may start (more places, memory freed). */
  kick(): void {
    this.pump();
  }

  /** The next task waits for memory now. */
  get waitingForMemory(): boolean {
    return this.held;
  }

  add<T>(task: QueueTask<T>): Promise<T> {
    const existing = this.entries.get(task.key);
    if (existing) {
      if (task.priority > existing.priority && !existing.started) existing.priority = task.priority;
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry<T> = { ...task, controller: new AbortController(), promise, resolve, reject, started: false, seq: this.seq++ };
    this.entries.set(task.key, entry as Entry<unknown>);
    this.emit();
    this.pump();
    return promise;
  }

  /** Tasks waiting or running. */
  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  cancel(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    e.controller.abort();
    // Forget it at once, running or not: adding the same key again starts a fresh task instead of
    // handing back the promise that is about to reject with CANCELLED.
    this.entries.delete(key);
    if (!e.started) e.reject(new AppError('CANCELLED'));
    this.emit();
    return true;
  }

  cancelAll(): void {
    for (const key of [...this.entries.keys()]) this.cancel(key);
  }

  setPriority(key: string, priority: number): void {
    const e = this.entries.get(key);
    if (e && !e.started) e.priority = priority;
  }

  onChange(fn: (s: QueueStats) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Where a task is: running, waiting (with how many tasks will start before it) or unknown.
   * Unknown means the queue never saw it or already finished it.
   */
  position(key: string): { state: 'running' } | { state: 'pending'; ahead: number } | { state: 'unknown' } {
    const e = this.entries.get(key);
    if (!e) return { state: 'unknown' };
    if (e.started) return { state: 'running' };
    let ahead = 0;
    for (const o of this.entries.values()) {
      if (o === e) continue;
      if (o.started || o.priority > e.priority || (o.priority === e.priority && o.seq < e.seq)) ahead++;
    }
    return { state: 'pending', ahead };
  }

  getStats(): QueueStats {
    return { ...this.stats };
  }

  private emit() {
    let pending = 0;
    for (const e of this.entries.values()) if (!e.started) pending++;
    this.stats = { ...this.stats, pending, running: this.running };
    for (const l of this.listeners) l(this.getStats());
  }

  private next(): Entry<unknown> | undefined {
    let best: Entry<unknown> | undefined;
    for (const e of this.entries.values()) {
      if (e.started) continue;
      if (!best || e.priority > best.priority || (e.priority === best.priority && e.seq < best.seq)) best = e;
    }
    return best;
  }

  private pump() {
    this.held = false;
    while (this.running < this.concurrency) {
      const e = this.next();
      if (!e) break;
      if (this.running > 0 && this.gate) {
        const inWork = [...this.entries.values()].filter((o) => o.started).map((o) => o.cost);
        if (!this.gate(inWork, e.cost)) {
          this.held = true;
          break;
        }
      }
      e.started = true;
      this.running++;
      this.emit();
      Promise.resolve()
        .then(() => e.run(e.controller.signal))
        .then(
          (v) => {
            this.stats.done++;
            e.resolve(v);
          },
          (err) => {
            this.stats.failed++;
            e.reject(err);
          },
        )
        .finally(() => {
          this.running--;
          // A cancelled task may already have been replaced by a new one with the same key.
          if (this.entries.get(e.key) === e) this.entries.delete(e.key);
          this.emit();
          this.pump();
        });
    }
    this.lookahead();
  }

  /** The queue is full: prepare the task that starts next (one at a time). */
  private lookahead() {
    if (this.preparing || (this.running < this.concurrency && !this.held)) return;
    const e = this.next();
    if (!e?.prepare || e.prepareStarted) return;
    e.prepareStarted = true;
    this.preparing = true;
    Promise.resolve()
      .then(() => e.prepare!(e.controller.signal))
      .catch(() => undefined)
      .finally(() => {
        this.preparing = false;
        this.lookahead();
      });
  }
}

/**
 * Run async work over items with bounded parallelism, preserving order of results. After the first
 * failure no new item is started (each one may be a paid request); the failure is thrown.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length && !failed) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
