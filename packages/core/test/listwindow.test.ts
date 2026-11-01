import { describe, expect, it } from 'vitest';
import { listLines } from '../src/translate/listText';
import { parseTranslationAnswer } from '../src/translate/parse';
import { textTranslateInstruction } from '../src/translate/prompt';
import { layoutText, type Measurer } from '../src/typeset/layout';
import { resolveStyle } from '../src/render/style';
import type { TextBlock } from '../src/types';

// Every character as wide as half the font size.
const m: Measurer = { measure: (t, font) => t.length * (Number(/(\d+)px/.exec(font)?.[1] ?? 10) / 2) };

describe('lists of a game / status window («Trick Blade: / ATK Bonus: +110% / Time Remaining: 0s»)', () => {
  it('are told from speech broken over lines', () => {
    expect(listLines('Trick Blade:\nATK Bonus: +110%\nTime Remaining: 0s')).toEqual(['Trick Blade:', 'ATK Bonus: +110%', 'Time Remaining: 0s']);
    expect(listLines('Name: Aiden Walker\nRace: Human\nLevel: 6')).toHaveLength(3);
    expect(listLines('MP: 83/120\nATK +10%')).toHaveLength(2);
    // Speech or narration broken over lines is one sentence, not a list.
    expect(listLines('HM?\nI LEVELED UP?')).toBeNull();
    expect(listLines('THOSE WHO CAME INTO CONTACT\nWITH A DUNGEON WOULD GAIN A\nMYSTERIOUS POWER, A CLASS.')).toBeNull();
    expect(listLines('You have defeated the boss.\nDungeon cleared.')).toBeNull();
    expect(listLines('Level: 6')).toBeNull();
  });

  it('go to the translator line by line, asked to keep one line per line', () => {
    const msg = textTranslateInstruction([{ id: 'b1', type: 'NARRATION', text: 'Trick Blade:\nATK Bonus: +110%\nTime Remaining: 0s' }], {});
    const data = JSON.parse(/<blocks>\n([\s\S]*)\n<\/blocks>/.exec(msg)![1]);
    expect(data[0]).toMatchObject({ text: 'Trick Blade:\nATK Bonus: +110%\nTime Remaining: 0s', lines: 3 });
    expect(msg).toMatch(/"lines"/);
    // A bubble's lines stay one sentence for the translator.
    const speech = textTranslateInstruction([{ id: 'b1', type: 'DIALOGUE', text: 'HM?\nI LEVELED UP?' }], {});
    expect(JSON.parse(/<blocks>\n([\s\S]*)\n<\/blocks>/.exec(speech)![1])[0]).toEqual({ id: 'b1', type: 'DIALOGUE', text: 'HM? I LEVELED UP?' });
  });

  it('keep the line breaks of the translation (a bubble does not)', () => {
    const raw = JSON.stringify({ translations: [{ id: 'b1', text: 'Клинок-обманка:\nБонус к атаке: +110%\nОсталось времени: 0 с' }, { id: 'b2', text: 'Хм?\nЯ повысил уровень?' }] });
    const a = parseTranslationAnswer(raw, [{ id: 'b1', text: 'Trick Blade:\nATK Bonus: +110%\nTime Remaining: 0s' }, { id: 'b2', text: 'HM?\nI LEVELED UP?' }]);
    expect(a.translations.get('b1')!.text).toBe('Клинок-обманка:\nБонус к атаке: +110%\nОсталось времени: 0 с');
    expect(a.translations.get('b2')!.text).toBe('Хм? Я повысил уровень?');
  });

  it('are set one line per line, also when the box is wide enough for more', () => {
    const l = layoutText(m, { text: 'Клинок:\nБонус: +110%\nВремя: 0 с', box: [0, 0, 600, 300], shape: 'rect', fontFamily: 'X', alignment: 'left' });
    expect(l.lines.map((x) => x.text)).toEqual(['Клинок:', 'Бонус: +110%', 'Время: 0 с']);
    expect(new Set(l.lines.map((x) => x.x)).size).toBe(1);
  });

  it('are set flush left; speech stays centred', () => {
    const block = (translatedText: string, originalText: string) => ({ originalText, translatedText, textType: 'NARRATION', bubble: null }) as unknown as TextBlock;
    expect(resolveStyle(block('Клинок:\nБонус: +110%', 'Trick Blade:\nATK Bonus: +110%')).alignment).toBe('left');
    expect(resolveStyle(block('Хм? Я повысил уровень?', 'HM?\nI LEVELED UP?')).alignment).toBe('center');
  });
});

describe('a list block whose lines stand in separate groups (two panels of a window)', () => {
  it('gives each group its own whole lines, in order', async () => {
    const { splitByGroups } = await import('../src/pipeline/standalone');
    const b = { id: 'b6', textType: 'NARRATION', originalText: 'Name: Aiden Walker\nRace: Human\nLevel: 6\nClass: Chanter', translatedText: 'Имя: Эйден Уокер\nРаса: Человек\nУровень: 6\nКласс: Певчий', bbox: [130, 770, 400, 290], bubble: null } as unknown as TextBlock;
    const parts = splitByGroups(b, [[130, 770, 360, 140], [130, 917, 300, 140]], undefined, 900, 1280);
    expect(parts.map((p) => p.translatedText)).toEqual(['Имя: Эйден Уокер\nРаса: Человек', 'Уровень: 6\nКласс: Певчий']);
    expect(parts.map((p) => p.originalText)).toEqual(['Name: Aiden Walker\nRace: Human', 'Level: 6\nClass: Chanter']);
  });
});
