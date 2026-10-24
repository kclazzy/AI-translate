/**
 * What this computer worked out for the last pictures — the detector's boxes and the recognition's
 * texts — kept for a few pages: ⟳ «перевести заново», the speed test and a stand-in translator
 * that takes over after the usual model did not answer need them again for the same picture, and
 * they do not change with the model or the translation settings. Kept per detector / reader (a
 * new one starts empty), in memory only, a few pages at most.
 */
const PAGES = 12;

class Lru<V> {
  private map = new Map<string, V>();
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > PAGES) this.map.delete(this.map.keys().next().value!);
  }
}

let memos = new WeakMap<object, Lru<unknown>>();

/** Forget everything kept (memory freed on request). */
export function forgetRemembered(): void {
  memos = new WeakMap();
}

/** The value for `key` worked out by `owner` (a detector, a reader) lately, or worked out now and kept. */
export async function remembered<V>(owner: object, key: string, make: () => Promise<V>): Promise<V> {
  let lru = memos.get(owner) as Lru<V> | undefined;
  if (!lru) memos.set(owner, (lru = new Lru<V>()));
  const hit = lru.get(key);
  if (hit !== undefined) return structuredClone(hit);
  const v = await make();
  lru.set(key, structuredClone(v));
  return v;
}
