import { describe, expect, it } from 'vitest';
import { joinLetterBlocks, keepAsDrawn } from '../src/pipeline/asDrawn';
import type { Box, TextBlock } from '../src/types';

const blk = (id: string, text: string, bbox: Box, textType: TextBlock['textType'] = 'SIGN'): TextBlock => ({ id, textType, originalText: text, translatedText: '', confidence: 0.9, language: 'en', bbox, polygon: [], orientation: 0, writingDirection: 'ltr', fontSizeEstimate: 20, bubble: null, translate: true });

describe('text that stays as drawn', () => {
  it('joins a logo drawn letter by letter into one block and keeps it', () => {
    const xs = [30, 95, 150, 200, 250, 330, 390, 450];
    const ls = ['W', 'i', 'l', 'd', 'e', 'R', 'u', 'n'];
    const blocks = [blk('b0', 'Hello there!', [100, 100, 300, 60], 'DIALOGUE'), ...ls.map((l, i) => blk(`b${i + 1}`, l, [xs[i], 800, 48, 90]))];
    const { blocks: out, joined } = joinLetterBlocks(blocks);
    expect(joined).toHaveLength(1);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ originalText: 'Wilde Run', logo: true });
    expect(keepAsDrawn(out[1])).toBe('logo');
    expect(keepAsDrawn(out[1], { translateLogo: true })).toBeNull();
  });
  it('keeps credits and brand names, translates ordinary signs', () => {
    expect(keepAsDrawn(blk('a', 'Story Minjun', [0, 0, 100, 20], 'OTHER'))).toBe('credit');
    expect(keepAsDrawn(blk('a', 'Art dai', [0, 0, 100, 20], 'OTHER'))).toBe('credit');
    expect(keepAsDrawn(blk('a', 'Story Minjun Art dai', [0, 0, 100, 20], 'OTHER'))).toBe('credit');
    expect(keepAsDrawn(blk('a', 'ZELKOVO', [0, 0, 100, 20]))).toBe('brand');
    expect(keepAsDrawn(blk('a', 'EXIT', [0, 0, 100, 20]))).toBeNull();
    expect(keepAsDrawn(blk('a', 'Class Motto: be kind', [0, 0, 100, 20]))).toBeNull();
    expect(keepAsDrawn(blk('a', 'STORY TIME!', [0, 0, 100, 20], 'DIALOGUE'))).toBeNull();
  });
});

describe('series memory', () => {
  it('gives a sign seen before the same translation, also when read with a word different', async () => {
    const { emptyContext, mergeContext, rememberedTranslation } = await import('../src/translate/context');
    let ctx = emptyContext('s');
    ctx = mergeContext(ctx, { page: 'p1', memory: [{ src: 'Class Motto: Be kind to everyone.', dst: 'Девиз класса: будьте добры ко всем.', type: 'SIGN' }, { src: 'Hey.', dst: 'Эй.', type: 'DIALOGUE' }] });
    expect(rememberedTranslation(ctx, 'CLASS MOTTO: BE KIND TO EVERYONE.', 'SIGN')).toBe('Девиз класса: будьте добры ко всем.');
    expect(rememberedTranslation(ctx, 'Class Motto Be kind to everyone', 'SIGN')).toBe('Девиз класса: будьте добры ко всем.');
    expect(rememberedTranslation(ctx, 'Class Motto: Be kind to all of them', 'DIALOGUE')).toBeUndefined();
    expect(rememberedTranslation(ctx, 'Hey.', 'DIALOGUE')).toBeUndefined();
  });
});

describe('sound effects', () => {
  it('get a real Russian sound, the same every time', async () => {
    const { fixSfx, sfxVariants } = await import('../src/translate/sfx');
    expect(fixSfx('STOMP', 'ТОПАЙ', 'ru')).toBe('ТОП');
    expect(fixSfx('SMOOCH', 'ЦЕЛУЙКА!', 'ru')).toBe('ЧМОК!');
    expect(fixSfx('STOOOMP', 'ТОПОТ', 'ru')).toBe('ТОПОТ');
    expect(fixSfx('BANG!', 'БАХ!', 'ru')).toBe('БАХ!');
    expect(fixSfx('STOMP STOMP', 'ТОПАЙ ТОПАЙ', 'ru')).toBe('ТОП ТОП');
    expect(fixSfx('KABLOOEY', 'КАБУМ', 'ru')).toBe('КАБУМ');
    expect(fixSfx('STOMP', 'Stampf', 'de')).toBe('Stampf');
    expect(sfxVariants('SHHH', 'ru')).toEqual(['ТСС']);
  });
});
