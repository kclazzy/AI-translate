import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@ait/core';
import { groupHistory } from '../src/editor/chapters';

const e = (key: string, url: string | undefined, date: string, title = '', status: HistoryEntry['status'] = 'done', pages = 1): HistoryEntry => ({ key, url, title, date, pages, targetLang: 'ru', model: 'm', status });
const W = (n: number) => `https://www.webtoons.com/en/action/mirror-world-god-tier-revenge/episode-${n}/viewer?title_no=9674&episode_no=${n}`;

describe('the editor\'s «Главы»: one folder per series, its chapters by number', () => {
  const list = [
    e('w2a', W(2), '2026-10-02T10:00:00Z', 'Mirror World: God-Tier Revenge - Episode 2 | WEBTOON'),
    e('w1b', `${W(1)}#x`, '2026-10-01T10:02:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON'),
    e('w1a', W(1), '2026-10-01T10:01:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON'),
    e('w10', W(10), '2026-09-01T10:00:00Z', 'Mirror World: God-Tier Revenge - Episode 10 | WEBTOON', 'done', 4),
    e('s131', 'https://read.example/manga/star-swordsman/chapter-131', '2026-10-03T08:00:00Z', 'Звёздный мечник — глава 131'),
    e('x1', 'https://read.example/manga/star-swordsman/chapter-132', '2026-10-03T09:00:00Z', 'Звёздный мечник — глава 132', 'error'),
    e('u1', undefined, '2026-09-30T12:00:00Z', 'scan.png'),
  ];
  it('a series is one folder, newest first; its chapters go by number, not by date', () => {
    const g = groupHistory(list);
    expect(g.map((s) => s.name)).toEqual(['Звёздный мечник', 'Mirror World: God-Tier Revenge', 'Открытые в студии']);
    expect(g[1].chapters.map((c) => [c.number, c.keys, c.pages])).toEqual([
      [1, ['w1a', 'w1b'], 2],
      [2, ['w2a'], 1],
      [10, ['w10'], 4],
    ]);
    expect(g[1].site).toBe('www.webtoons.com');
  });
  it('failed pages are left out; pictures opened in the studio are a folder of their own', () => {
    const g = groupHistory(list);
    expect(g[0].chapters.map((c) => c.number)).toEqual([131]);
    expect(g[2].chapters[0]).toMatchObject({ title: 'scan.png', keys: ['u1'] });
  });
});

describe('«История» as folders: manga → chapter → pages', () => {
  const list = [
    e('w1a', W(1), '2026-10-01T10:01:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON'),
    e('w1b', W(1), '2026-10-01T10:02:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON'),
    e('w1a', W(1), '2026-10-03T10:00:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON'),
    e('w1c', W(1), '2026-10-01T10:03:00Z', 'Mirror World: God-Tier Revenge - Episode 1 | WEBTOON', 'error'),
    e('w2a', W(2), '2026-10-02T10:00:00Z', 'Mirror World: God-Tier Revenge - Episode 2 | WEBTOON', 'error'),
  ];
  it('each chapter lists its pages once, in reading order, with the latest record of each', () => {
    const g = groupHistory(list, { failed: true });
    const ep1 = g[0].chapters.find((c) => c.number === 1)!;
    expect(ep1.entries.map((x) => [x.key, x.date])).toEqual([
      ['w1a', '2026-10-03T10:00:00Z'],
      ['w1b', '2026-10-01T10:02:00Z'],
      ['w1c', '2026-10-01T10:03:00Z'],
    ]);
    expect(ep1.keys).toEqual(['w1a', 'w1b']);
  });
  it('with failed pages asked for, a chapter where everything failed still shows (to see the error)', () => {
    expect(groupHistory(list, { failed: true })[0].chapters.map((c) => c.number)).toEqual([1, 2]);
    expect(groupHistory(list)[0].chapters.map((c) => c.number)).toEqual([1]);
  });
});
