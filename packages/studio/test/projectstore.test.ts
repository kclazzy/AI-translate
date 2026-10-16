/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { newProject } from '@ait/core';
import { ProjectStore } from '../src/projects';

function memoryDb(): any {
  const m = new Map<string, unknown>();
  return {
    get: async (s: string, k: string) => structuredClone(m.get(`${s}/${k}`)),
    put: async (s: string, k: string, v: unknown) => void m.set(`${s}/${k}`, structuredClone(v)),
    delete: async (s: string, k: string) => void m.delete(`${s}/${k}`),
    entries: async (s: string) => [...m].filter(([k]) => k.startsWith(`${s}/`)).map(([k, v]) => [k.slice(s.length + 1), v]),
  };
}

describe('project changes during «Перевести всё»', () => {
  it('a page result written from an old copy keeps an edit, a new page and a glossary change made meanwhile', async () => {
    const store = new ProjectStore(memoryDb());
    const p = newProject('x', 'Глава', { sourceLang: 'en', targetLang: 'ru' });
    p.pages = [{ id: 'a', name: '1', index: 0, status: 'new' }, { id: 'b', name: '2', index: 1, status: 'done', result: { blocks: [{ translatedText: 'старое' }] } as any }];
    await store.save(p);
    const old = (await store.get('x'))!;
    // Meanwhile: the editor saves page b, a page is added, the glossary changes.
    await store.updatePage('x', 'b', (pg) => ({ ...pg, result: { blocks: [{ translatedText: 'правка' }] } as any }));
    await store.update('x', (f) => ({ ...f, pages: [...f.pages, { id: 'c', name: '3', index: 2, status: 'new' }], glossary: [{ id: 'g' } as any] }));
    // The long run finishes page a, holding the old copy.
    await store.updatePage(old.id, 'a', (pg) => ({ ...pg, status: 'done' }));
    const now = (await store.get('x'))!;
    expect(now.pages.map((x) => [x.id, x.status])).toEqual([['a', 'done'], ['b', 'done'], ['c', 'new']]);
    expect((now.pages[1].result as any).blocks[0].translatedText).toBe('правка');
    expect(now.glossary).toHaveLength(1);
  });

  it('changes of one project run one at a time', async () => {
    const store = new ProjectStore(memoryDb());
    await store.save(newProject('y', 'Глава', { sourceLang: 'en', targetLang: 'ru' }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update('y', async (f) => {
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      return { ...f, pages: [...f.pages, { id: `p${i}`, name: `${i}`, index: i, status: 'new' as const }] };
    })));
    expect((await store.get('y'))!.pages).toHaveLength(20);
  });
});
