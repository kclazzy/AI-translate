import { AppError } from '../errors';

export interface QueueTask<T> {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
}

interface Entry<T> extends QueueTask<T> {
  controller: AbortController;
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  started: boolean;
  seq: number;
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

  constructor(public concurrency = 2) {}

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

  has(key: string): boolean {
    return this.entries.has(key);
  }

  cancel(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    e.controller.abort();
    if (!e.started) {
      this.entries.delete(key);
      e.reject(new AppError('CANCELLED'));
      this.emit();
    }
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
    while (this.running < this.concurrency) {
      const e = this.next();
      if (!e) break;
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
          this.entries.delete(e.key);
          this.emit();
          this.pump();
        });
    }
  }
}

/** Run async work over items with bounded parallelism, preserving order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
