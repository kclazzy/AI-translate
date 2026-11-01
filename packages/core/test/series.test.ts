import { describe, expect, it } from 'vitest';
import { chapterPlace, seriesKeyFromUrl } from '../src/series';

const W1 = 'https://www.webtoons.com/en/action/mirror-world-god-tier-revenge/episode-1/viewer?title_no=9674&episode_no=1';
const W2 = 'https://www.webtoons.com/en/action/mirror-world-god-tier-revenge/episode-2/viewer?title_no=9674&episode_no=2';
const OTHER = 'https://www.webtoons.com/en/action/another-hero/episode-5/viewer?title_no=1111&episode_no=5';

describe('series and chapter from the page address', () => {
  it('Webtoons: the series is the title, not the genre (two action series are not one)', () => {
    expect(seriesKeyFromUrl(W1)).toBe(seriesKeyFromUrl(W2));
    expect(seriesKeyFromUrl(W1)).not.toBe(seriesKeyFromUrl(OTHER));
  });
  it('the usual /manga/<slug>/chapter-N address keeps the key it had (the series context is not lost)', () => {
    expect(seriesKeyFromUrl('https://read.example/manga/star-swordsman/chapter-131')).toBe('read.example/manga/star-swordsman');
  });
  it('the chapter\'s number and the series\' name: from the address, or the title', () => {
    expect(chapterPlace(W2, 'Mirror World: God-Tier Revenge - Episode 2 | WEBTOON')).toMatchObject({ number: 2, name: 'Mirror World: God-Tier Revenge' });
    expect(chapterPlace(W2, '')).toMatchObject({ number: 2, name: 'Mirror World God Tier Revenge' });
    expect(chapterPlace('https://read.example/manga/star-swordsman/chapter-131', 'Звёздный мечник — глава 131')).toMatchObject({ number: 131, name: 'Звёздный мечник' });
    expect(chapterPlace('https://read.example/read/12345', 'Some Manga Ch. 12.5')).toMatchObject({ number: 12.5, name: 'Some Manga' });
    expect(chapterPlace('https://read.example/read/12345', 'Cover')).toMatchObject({ number: undefined });
  });
});
