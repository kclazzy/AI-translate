/**
 * Picture bytes of queued jobs, kept in the extension's own IndexedDB instead of in messages and
 * in memory: a chapter of a hundred waiting pages would otherwise hold all of them as base64 in the
 * offscreen document, and one big picture could pass the browser's 64 MiB message limit.
 * The background writes, the worker (offscreen document / Firefox background page) reads and deletes.
 */

interface JobBytes {
  bytes: Uint8Array;
  mime: string;
  at: number;
}

const DB_NAME = 'ait-jobs';
const STORE = 'bytes';
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    r.onsuccess = () => {
      const db = r.result;
      // Another context upgraded or deleted the database: open it again next time.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
  opening.catch(() => (opening = null));
  return opening;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putJobBytes(id: string, bytes: Uint8Array, mime: string): Promise<void> {
  await run('readwrite', (s) => s.put({ bytes, mime, at: Date.now() } satisfies JobBytes, id));
}

export async function getJobBytes(id: string): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const v = await run<JobBytes | undefined>('readonly', (s) => s.get(id));
  return v ? { bytes: v.bytes, mime: v.mime } : undefined;
}

export async function deleteJobBytes(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id)).catch(() => undefined);
}

/** Drop the bytes of jobs older than `maxAgeMs` (left over when the worker was closed mid-queue). */
export async function pruneJobBytes(maxAgeMs: number): Promise<void> {
  const db = await open();
  const limit = Date.now() - maxAgeMs;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const cur = tx.objectStore(STORE).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return;
      if (((c.value as JobBytes).at ?? 0) < limit) c.delete();
      c.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** SHA-256 of the bytes (hex, shortened): the identity of a picture for de-duplication. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  let s = '';
  for (let i = 0; i < 16; i++) s += d[i].toString(16).padStart(2, '0');
  return s;
}
