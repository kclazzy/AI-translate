// The browser can close an IndexedDB connection on its own; the store must open a new one instead of
// failing every later call with «The database connection is closing».
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbStore } from '../src/storage/idb';

describe('IndexedDB store', () => {
  it('opens a new connection after the old one was closed', async () => {
    const db = new IdbStore('t1');
    await db.put('kv', 'a', 1);
    const conn = await (db as any).dbPromise as IDBDatabase;
    conn.close();
    await db.put('kv', 'b', 2);
    expect(await db.get('kv', 'a')).toBe(1);
    expect(await db.get('kv', 'b')).toBe(2);
    expect((await db.entries('kv')).map(([k]) => k).sort()).toEqual(['a', 'b']);
  });

  it('a write resolves only once it is committed', async () => {
    const db = new IdbStore('t2');
    await db.put('kv', 'x', { n: 1 });
    expect(await db.get('kv', 'x')).toEqual({ n: 1 });
    await db.delete('kv', 'x');
    expect(await db.get('kv', 'x')).toBeUndefined();
  });
});
