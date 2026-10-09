/* eslint-disable @typescript-eslint/no-explicit-any */
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { configFromPreset, DEFAULT_PROFILES, runStandalonePipeline } from '../src';
import { cleanBlock } from '../src/image/clean';
import { TiledImage } from '../src/image/tiled';
import { jsonResponse, napiBackend, toNorm } from './helpers';

/** Text written straight over a busy, colourful background (no bubble). */
async function overArt() {
  const c = createCanvas(600, 400);
  const ctx = c.getContext('2d') as any;
  for (let x = 0; x < 600; x += 10) {
    ctx.fillStyle = `hsl(${x % 360}, 60%, 50%)`;
    ctx.fillRect(x, 0, 10, 400);
  }
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 4;
  ctx.font = 'bold 48px TestSans';
  ctx.strokeText('DOOM', 200, 220);
  ctx.fillText('DOOM', 200, 220);
  return new Uint8Array(await c.encode('png'));
}

describe('erasing text over artwork', () => {
  it('a wider erase reaches further past the letters', async () => {
    const bytes = await overArt();
    const count = async (expand: number) => {
      const img = await TiledImage.fromBytes(napiBackend, bytes);
      const r = cleanBlock(img, [190, 170, 150, 60], { expand });
      let n = 0;
      for (const v of r.artMask?.mask ?? []) n += v;
      return n;
    };
    expect(await count(8)).toBeGreaterThan((await count(1)) * 1.3);
  });

  it('LaMa in the local engine redraws the smudged area; without the engine the page still works', async () => {
    const bytes = await overArt();
    const calls: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes('/v1/inpaint')) {
        // A fake LaMa: paints the whole area pure green.
        const form = init?.body as FormData;
        const img = await napiBackend.decode(new Uint8Array(await (form.get('image') as Blob).arrayBuffer()), 'image/png');
        const c = createCanvas(img.width, img.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(0, 0, img.width, img.height);
        return new Response(new Uint8Array(await c.encode('png')), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ blocks: [{ box: toNorm([195, 175, 150, 60], 600, 400), text: 'DOOM', translation: 'БУМ', type: 'DIALOGUE', vertical: false }], entities: [], summary: '' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    };
    const config: any = {
      mode: 'standalone', privacy: 'local', sourceLang: 'en', targetLang: 'ru', quality: 'balanced', profile: DEFAULT_PROFILES[0], glossary: [], translateSfx: true, sfxStyle: 'translated',
      vision: { ...configFromPreset('lmstudio', 'vlm'), vision: true }, translator: null, lamaEngine: true, engine: { url: 'http://127.0.0.1:8765', token: 't', options: {} },
    };
    const out = await runStandalonePipeline({ bytes, config }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    if (process.env.DEBUG) console.log(calls, out.page.blocks.map((b) => [b.bbox, b.textType, b.bubble]));
    expect(calls.some((u) => u.includes('/v1/inpaint'))).toBe(true);
    const d = out.cleaned.getRegion(190, 170, 160, 60).data;
    let green = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 240 && d[i] < 20 && d[i + 2] < 20) green++;
    expect(green).toBeGreaterThan(200);
    // A remote engine with privacy «local»: the picture is not sent.
    calls.length = 0;
    await runStandalonePipeline({ bytes, config: { ...config, engine: { url: 'https://example.com', token: 't', options: {} } } }, { backend: napiBackend, fetchImpl: fetchImpl as any });
    expect(calls.some((u) => u.includes('/v1/inpaint'))).toBe(false);
  });
});
