/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, runStandalonePipeline, TiledImage } from '../src';
import { DEFAULT_PROFILES } from '../src/translate/profiles';
import { jsonResponse, makeMangaPage, napiBackend, toNorm } from './helpers';

// The cleaning runs while the translation is on its way (they meet before the typesetting).
function config(extra: Record<string, unknown> = {}): any {
  return { mode: 'standalone', privacy: 'cloud', sourceLang: 'ja', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated', vision: { ...configFromPreset('openai', 'gpt-4o'), apiKey: 'k', vision: true }, translator: null, twoStep: true, ...extra };
}

async function setup(translate: (ids: string[]) => { id: string; text: string; type?: string }[], delayMs: number) {
  const page = await makeMangaPage();
  const calls: string[] = [];
  const fetchImpl = async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const user = JSON.stringify(body.messages.at(-1).content);
    let content: string;
    if (user.includes('image_url')) {
      calls.push('read');
      content = JSON.stringify({ blocks: page.bubbles.map((b) => ({ box: toNorm(b.textBox, 800, 1100), text: b.text, type: 'DIALOGUE', vertical: true })), entities: [], summary: '' });
    } else {
      calls.push('translate');
      const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(body.messages.at(-1).content)?.[1] ?? '[]');
      await new Promise((r) => setTimeout(r, delayMs));
      content = JSON.stringify({ translations: translate(blocks.map((b: any) => b.id)), entities: [], summary: '' });
    }
    return jsonResponse({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 }, model: body.model });
  };
  return { page, calls, fetchImpl };
}

describe('the cleaning goes on while the model translates', () => {
  it('the two run at once: the page takes about the longer of them, not both', async () => {
    const { page, fetchImpl } = await setup((ids) => ids.map((id) => ({ id, text: `ПЕРЕВОД ${id}` })), 1500);
    const out = await runStandalonePipeline({ bytes: page.bytes, config: config(), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    const t = out.page.timings;
    expect(out.page.blocks.map((b) => b.translatedText)).toEqual(['ПЕРЕВОД b1', 'ПЕРЕВОД b2']);
    expect(t.overlapMs ?? 0).toBeGreaterThan(0);
    // One after the other it would take reading + translating + cleaning.
    const oneByOne = (t.decodeMs ?? 0) + (t.detectMs ?? 0) + (t.translateMs ?? 0) + (t.cleanMs ?? 0);
    console.log(`translate ${t.translateMs} ms, clean ${t.cleanMs} ms, at once ${t.overlapMs} ms, total ${t.totalMs} ms (one by one ${oneByOne} ms)`);
    expect(t.totalMs).toBeLessThan(oneByOne);
    // Both bubbles erased (the cleaning saw the blocks as read).
    expect(out.page.blocks.every((b) => b.bubble)).toBe(true);
  }, 60000);

  it('a «speech» the translator re-types as a sound effect kept as drawn gets its letters back', async () => {
    const { page, fetchImpl } = await setup((ids) => ids.map((id) => (id === 'b1' ? { id, text: 'ЗВУК', type: 'SFX' } : { id, text: `ПЕРЕВОД ${id}` })), 300);
    const out = await runStandalonePipeline({ bytes: page.bytes, config: config({ sfxStyle: 'original' }), noSkip: true }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    const b1 = out.page.blocks.find((b) => b.id === 'b1')!;
    expect(b1.textType).toBe('SFX');
    const original = await TiledImage.fromBytes(napiBackend, page.bytes);
    const [x, y, w, h] = b1.bbox;
    const a = original.getRegion(x, y, w, h).data;
    const c = out.cleaned.getRegion(x, y, w, h).data;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - c[i]);
    expect(diff).toBe(0);
    expect(out.page.debug?.steps?.some((s) => s.includes('letters put back'))).toBe(true);
    // The other one is erased as usual.
    const b2 = out.page.blocks.find((b) => b.id === 'b2')!;
    const [x2, y2, w2, h2] = b2.bbox;
    const a2 = original.getRegion(x2, y2, w2, h2).data;
    const c2 = out.cleaned.getRegion(x2, y2, w2, h2).data;
    let diff2 = 0;
    for (let i = 0; i < a2.length; i++) diff2 += Math.abs(a2[i] - c2[i]);
    expect(diff2).toBeGreaterThan(0);
  }, 60000);
});
