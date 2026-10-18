/** Minimal promise wrapper over IndexedDB, shared by the extension and the mobile app. */
export const STORES = ['results', 'history', 'projects', 'assets', 'contexts', 'kv', 'usage'] as const;
export type StoreName = (typeof STORES)[number];

export class IdbStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private name = 'ai-translate', private version = 1) {}

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(this.name, this.version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => {
          const db = req.result;
          // The browser may close the connection on its own (storage pressure, site data cleared, a
          // newer version opened elsewhere): forget it, so the next call opens a fresh one instead of
          // failing with «The database connection is closing» until the page reloads.
          const forget = () => {
            if (this.dbPromise === opening) this.dbPromise = null;
          };
          db.onclose = forget;
          db.onversionchange = () => {
            forget();
            db.close();
          };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new DOMException('The database is blocked by another tab', 'InvalidStateError'));
      });
      this.dbPromise = opening;
      opening.catch(() => {
        if (this.dbPromise === opening) this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }

  /**
   * Start a transaction; a connection that was closed under us is opened again once. Writes resolve
   * only when the transaction commits (a write aborted later, e.g. by the storage quota, is an error,
   * not a silent success).
   */
  private async run<T>(store: StoreName, mode: IDBTransactionMode, body: (t: IDBTransaction, done: (v: T) => void, fail: (e: unknown) => void) => void): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const db = await this.open();
      let t: IDBTransaction;
      try {
        t = db.transaction(store, mode);
      } catch (e) {
        if (attempt === 0 && (e as DOMException)?.name === 'InvalidStateError') {
          this.dbPromise = null;
          continue;
        }
        throw e;
      }
      return new Promise<T>((resolve, reject) => {
        let value: T;
        let have = false;
        const done = (v: T) => {
          value = v;
          have = true;
          if (mode === 'readonly') resolve(v);
        };
        t.oncomplete = () => {
          if (have) resolve(value);
        };
        t.onabort = () => reject(t.error ?? new DOMException('Transaction aborted', 'AbortError'));
        t.onerror = () => reject(t.error);
        body(t, done, reject);
      });
    }
  }

  private tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.run<T>(store, mode, (t, done, fail) => {
      const req = fn(t.objectStore(store));
      req.onsuccess = () => done(req.result);
      req.onerror = () => fail(req.error);
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

  /** Keys starting with `prefix` (an index range: nothing else is read). */
  keysWithPrefix(store: StoreName, prefix: string): Promise<string[]> {
    return this.tx(store, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`)) as IDBRequest<string[]>);
  }

  keys(store: StoreName): Promise<string[]> {
    return this.tx(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<string[]>);
  }

  entries<T>(store: StoreName): Promise<[string, T][]> {
    return this.run<[string, T][]>(store, 'readonly', (t, done, fail) => {
      const out: [string, T][] = [];
      const req = t.objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return done(out);
        out.push([String(c.key), c.value as T]);
        c.continue();
      };
      req.onerror = () => fail(req.error);
    });
  }

  clear(store: StoreName): Promise<undefined> {
    return this.tx(store, 'readwrite', (s) => s.clear() as IDBRequest<undefined>);
  }
}
