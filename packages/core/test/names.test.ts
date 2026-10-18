import { describe, expect, it } from 'vitest';
import { sentenceCase, unshout } from '../src/translate/caseNorm';
import { genderHints, learnCharacters, namesIn, spellingIn } from '../src/translate/names';

describe('text lettered in capitals', () => {
  it('turns into normal case for the translator, names keep their capital', () => {
    expect(sentenceCase("WHY'S HE HERE? THIS GUY?")).toBe("Why's he here? This guy?");
    expect(sentenceCase('HI, MIRAE! PERFECT TIMING.')).toBe('Hi, Mirae! Perfect timing.');
    expect(sentenceCase("I DON'T KNOW. I'M SCARED OF HP LOSS")).toBe("I don't know. I'm scared of HP loss");
    expect(sentenceCase('...AND THEN...')).toBe('...And then...');
    expect(sentenceCase('Already normal.')).toBe('Already normal.');
    expect(sentenceCase('TAKE THE ORB, KAEL', (w) => w.toLowerCase() === 'orb')).toBe('Take the Orb, Kael');
  });
  it('a translation answered in capitals comes back in normal case', () => {
    expect(unshout('...НО СЛИШКОМ СПОКОЙНО, ДА? ХА-ХА-ХА!')).toBe('...Но слишком спокойно, да? Ха-ха-ха!');
    expect(unshout('ПРИВЕТ, МИРЭ!', ['Мирэ'])).toBe('Привет, Мирэ!');
    expect(unshout('Обычный текст.')).toBe('Обычный текст.');
  });
});

describe('names on a page', () => {
  it('finds names that are not common words and tells gender from the pronouns next to them', () => {
    const texts = ['Hi, Mirae!', 'Of who? Mirae? What is so scary about her?', 'Doyun, come here.', 'Why him again?'];
    expect(namesIn(texts).sort()).toEqual(['Doyun', 'Mirae']);
    expect(namesIn(['Hey...', '...Mirae YU.'])).toEqual(['Mirae']);
    expect(namesIn(['Take some Scallion Kimchi home with you.', 'You have to do something Humiliating?'])).toEqual([]);
    const g = genderHints(texts, ['Mirae', 'Doyun']);
    expect(g.get('Mirae')).toBe('female');
    expect(g.get('Doyun')).toBe('male');
  });
  it('finds the spelling in the translation, declined forms too', () => {
    expect(spellingIn('Кого? Мирэ? Чего в ней страшного?', 'Mirae')).toBe('Мирэ');
    expect(spellingIn('Я видел Доюна вчера.', 'Doyun')).toBe('Доюн');
    expect(spellingIn('Привет всем!', 'Doyun')).toBeNull();
    const learned = learnCharacters([{ text: 'Of who? Mirae? She looks harmless.', translation: 'Кого? Мирэ? Она безобидная.' }], []);
    expect(learned).toEqual([{ source: 'Mirae', target: 'Мирэ', kind: 'character', gender: 'female' }]);
  });
});
