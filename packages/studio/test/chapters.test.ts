import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@ait/core';
import { groupHistory } from '../src/editor/chapters';

const e = (key: string, url: string | undefined, date: string, title = '', status: HistoryEntry['status'] = 'done'): HistoryEntry => ({ key, url, title, date, pages: 1, targetLang: 'ru', model: 'm', status });

describe('the editor\'s chapters: the history as folders, site → chapter → pages', () => {
  const list = [
    e('a2', 'https://manga.example/s/1#p2', '2026-10-01T10:02:00Z', 'Глава 1'),
    e('a1', 'https://manga.example/s/1', '2026-10-01T10:01:00Z', 'Глава 1'),
    e('b1', 'https://manga.example/s/2', '2026-10-02T09:00:00Z', 'Глава 2'),
    e('a1', 'https://manga.example/s/1', '2026-10-03T08:00:00Z', 'Глава 1'),
    e('c1', 'https://toon.example/ep/7', '2026-10-01T12:00:00Z'),
    e('x1', 'https://toon.example/ep/7', '2026-10-01T12:05:00Z', '', 'error'),
    e('u1', undefined, '2026-09-30T12:00:00Z', 'scan.png'),
  ];
  it('groups pages by site and chapter, newest first; pages in the order they were translated, each once', () => {
    const g = groupHistory(list);
    expect(g.map((s) => s.site)).toEqual(['manga.example', 'toon.example', '']);
    expect(g[0].chapters.map((c) => [c.title, c.keys])).toEqual([
      ['Глава 1', ['a1', 'a2']],
      ['Глава 2', ['b1']],
    ]);
  });
  it('a glued strip counts as all its pictures', () => {
    const g = groupHistory([{ ...e('s1', 'https://w.example/ep/1', '2026-10-01T10:00:00Z', 'Эпизод 1'), pages: 4 }, e('s2', 'https://w.example/ep/1', '2026-10-01T10:01:00Z')]);
    expect(g[0].chapters[0]).toMatchObject({ keys: ['s1', 's2'], pages: 5 });
  });
  it('a chapter without a title is named by its address; failed pages are left out; pictures opened in the studio have their own folder', () => {
    const g = groupHistory(list);
    expect(g[1].chapters).toEqual([expect.objectContaining({ title: 'toon.example/ep/7', keys: ['c1'] })]);
    expect(g[2].chapters[0]).toMatchObject({ title: 'scan.png', keys: ['u1'] });
  });
});
