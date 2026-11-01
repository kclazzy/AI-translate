/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { configFromPreset, OpenAICompatibleProvider } from '../src';
import { answerSchema, type AnswerKind } from '../src/translate/schemas';
import { visionCollageInstruction, visionFullInstruction, visionOcrInstruction } from '../src/translate/prompt';
import { jsonResponse } from './helpers';
import { translateBlocks } from '../src/translate/translator';
import { DEFAULT_PROFILES } from '../src/translate/profiles';

const ask = (schema?: Record<string, unknown>) => ({ system: 's', messages: [{ role: 'user' as const, content: 'x' }], json: true, ...(schema ? { schema } : {}) });

describe('Ollama answers in the exact shape asked (JSON schema), with a way back', () => {
  it('the schema of the request goes to Ollama as its format; without one, plain JSON', async () => {
    const bodies: any[] = [];
    const f = async (_u: string, i?: RequestInit) => (bodies.push(JSON.parse(String(i?.body))), jsonResponse({ message: { content: '{"blocks":[]}' } }));
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), baseUrl: 'http://localhost:11434/v1' }, f);
    await p.complete(ask(answerSchema('translations')));
    await p.complete(ask());
    expect(bodies[0].format).toMatchObject({ type: 'object', required: ['translations'] });
    expect(bodies[1].format).toBe('json');
  });

  it('an Ollama that refuses the schema (an old version): asked again with plain JSON, and from then on', async () => {
    const formats: unknown[] = [];
    const f = async (_u: string, i?: RequestInit) => {
      const b = JSON.parse(String(i?.body));
      formats.push(b.format);
      return typeof b.format === 'object' ? new Response('{"error":"invalid format"}', { status: 400 }) : jsonResponse({ message: { content: '{"translations":[]}' } });
    };
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), baseUrl: 'http://127.0.0.1:11999/v1' }, f);
    expect((await p.complete(ask(answerSchema('translations')))).text).toContain('translations');
    await p.complete(ask(answerSchema('translations')));
    expect(formats).toEqual([expect.any(Object), 'json', 'json']);
  });

  it('other servers keep their JSON mode (the schema is not sent where it may not be understood)', async () => {
    let body: any;
    const f = async (_u: string, i?: RequestInit) => ((body = JSON.parse(String(i?.body))), jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    await new OpenAICompatibleProvider({ ...configFromPreset('openai', 'o'), apiKey: 'k' }, f).complete(ask(answerSchema('translations')));
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body)).not.toContain('"required"');
  });

  it('every schema asks for what its instruction shows (the two never drift apart)', () => {
    const example = (instruction: string) => JSON.parse(/(\{"blocks".*?\})\.?$/m.exec(instruction.split('\n').find((l) => l.includes('{"blocks"'))!.replace(/^.*?(\{"blocks")/, '$1').replace('[x0,y0,x1,y1]', '[0,0,0,0]'))![1]);
    const pairs: [AnswerKind, string][] = [
      ['page', visionFullInstruction(800, 1100)],
      ['pageRead', visionOcrInstruction(800, 1100)],
      ['collage', visionCollageInstruction(800, 1100, 3, 'ja', true)],
      ['collageRead', visionCollageInstruction(800, 1100, 3, 'ja', false)],
    ];
    for (const [kind, instruction] of pairs) {
      const ex = example(instruction);
      const s = answerSchema(kind) as any;
      for (const k of s.required) expect(ex, `${kind}: ${k}`).toHaveProperty(k);
      const block = s.properties.blocks.items;
      for (const k of block.required) expect(ex.blocks[0], `${kind}: blocks.${k}`).toHaveProperty(k);
      // Nothing the instruction does not show is demanded.
      for (const k of Object.keys(block.properties)) expect(ex.blocks[0], `${kind}: blocks.${k} shown`).toHaveProperty(k);
    }
  });

  it('a translation request to Ollama asks for the translations shape', async () => {
    const formats: any[] = [];
    const f = async (_u: string, i?: RequestInit) => {
      const b = JSON.parse(String(i?.body));
      formats.push(b.format);
      return jsonResponse({ message: { content: JSON.stringify({ translations: [{ id: 'b1', text: 'Привет' }] }) } });
    };
    const p = new OpenAICompatibleProvider({ ...configFromPreset('ollama', 'o'), baseUrl: 'http://localhost:11434/v1' }, f);
    const r = await translateBlocks(p, { sourceLang: 'en', targetLang: 'ru', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true }, [{ id: 'b1', type: 'DIALOGUE', text: 'Hello' }]);
    expect(r.translations.get('b1')?.text).toBe('Привет');
    expect(formats[0]).toMatchObject({ required: ['translations'] });
  });
});
