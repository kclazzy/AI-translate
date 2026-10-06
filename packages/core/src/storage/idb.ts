/** Minimal promise wrapper over IndexedDB, shared by the extension and the mobile app. */
export const STORES = ['results', 'history', 'projects', 'assets', 'contexts', 'kv', 'usage'] as const;
export type StoreName = (typeof STORES)[number];

export class IdbStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private name = 'ai-translate', private version = 1) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.name, this.version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private async tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.tx(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  }

  put<T>(store: StoreName, key: string, value: T): Promise<IDBValidKey> {
    return this.tx(store, 'readwrite', (s) => s.put(value, key));
  }

  delete(store: StoreName, key: string): Promise<undefined> {
    return this.tx(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>);
  }

  keys(store: StoreName): Promise<string[]> {
    return this.tx(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<string[]>);
  }

  async entries<T>(store: StoreName): Promise<[string, T][]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const out: [string, T][] = [];
      const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push([String(c.key), c.value as T]);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  clear(store: StoreName): Promise<undefined> {
    return this.tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  }
}
