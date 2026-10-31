import { describe, expect, it } from 'vitest';
import { CASCADE_LIMITS, cascadeRoute, type PieceRead } from '../src/pipeline/cascade';

const sure = (text: string, free = false, score = 0.97): PieceRead => ({ text, free, lines: [{ score }] });

describe('cascade: the text read in the browser is trusted, or the model looks at the picture', () => {
  it('every piece read clearly → the recognition reads the page (the model only translates)', () => {
    expect(cascadeRoute([sure('HELLO'), sure('GOODBYE')])).toEqual({ route: 'ocr', reason: expect.stringMatching(/2 piece/) });
  });
  it('the detector found no text on a page that has some → the model looks', () => {
    expect(cascadeRoute([]).route).toBe('vision');
  });
  it('a piece read as nothing → the model looks', () => {
    expect(cascadeRoute([sure('HELLO'), { text: '', free: false, lines: [] }])).toMatchObject({ route: 'vision', reason: expect.stringMatching(/nothing/) });
  });
  it('one unsure line is enough to ask the model', () => {
    expect(cascadeRoute([sure('HELLO'), sure('G00DBYE', false, CASCADE_LIMITS.line - 0.01)])).toMatchObject({ route: 'vision', reason: expect.stringMatching(/unsure/) });
  });
  it('text outside the bubbles (sounds, signs) must be read surer than speech', () => {
    const between = (CASCADE_LIMITS.line + CASCADE_LIMITS.free) / 2;
    expect(cascadeRoute([sure('HELLO', false, between), sure('BOOM', false, 0.99)]).route).toBe('ocr');
    expect(cascadeRoute([sure('HELLO'), sure('BOOM', true, between)]).route).toBe('vision');
  });
  it('a reading without a score is not trusted', () => {
    expect(cascadeRoute([{ text: 'HELLO', free: false, lines: [] }]).route).toBe('vision');
  });
});
