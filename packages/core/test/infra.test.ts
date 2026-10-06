import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { AppError, errorMessage } from '../src/errors';
import { AnthropicProvider } from '../src/llm/anthropic';
import { OpenAICompatibleProvider } from '../src/llm/openai';
import { configFromPreset } from '../src/llm/presets';
import { assertPrivacy, isLocalUrl } from '../src/llm/privacy';
import { parseSse } from '../src/pipeline/engine';
import { exportProjectZip, importProjectZip, newProject, readArchiveImages, ARCHIVE_LIMITS } from '../src/project/format';
import { sniffImageMime } from '../src/util/bytes';
import { mapLimit, TaskQueue } from '../src/util/queue';
import { withRetry } from '../src/util/retry';
import { jsonResponse, makeMangaPage } from './helpers';

describe('privacy', () => {
  it('classifies URLs by host, not by flags', () => {
    expect(isLocalUrl('http://localhost:1234/v1')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:8765')).toBe(true);
    expect(isLocalUrl('http://[::1]:8000')).toBe(true);
    expect(isLocalUrl('https://api.anthropic.com/v1')).toBe(false);
    expect(isLocalUrl('https://localhost.evil.com/v1')).toBe(false);
    expect(isLocalUrl('http://8.8.8.8')).toBe(false);
  });

  it('blocks cloud vision in local and hybrid mode but allows text in hybrid', () => {
    const cloud = configFromPreset('anthropic', 'a');
    const local = configFromPreset('ollama', 'o');
    expect(() => assertPrivacy('local', cloud, 'text')).toThrow(AppError);
    expect(() => assertPrivacy('hybrid', cloud, 'image')).toThrow(AppError);
    expect(() => assertPrivacy('hybrid', cloud, 'text')).not.toThrow();
    expect(() => assertPrivacy('local', local, 'image')).not.toThrow();
  });
});

describe('providers', () => {
  it('sends images in OpenAI format and maps 401 to INVALID_API_KEY', async () => {
    let body: any;
    const p = new OpenAICompatibleProvider({ ...configFromPreset('openai', 'x'), apiKey: 'sk-test' }, async (_u, init) => {
      body = JSON.parse(String(init!.body));
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
      return jsonResponse({ error: 'bad key' }, 401);
    });
    await expect(p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/png', base64: 'AAA' }, { type: 'text', text: 'hi' }] }] })).rejects.toMatchObject({ code: 'INVALID_API_KEY', retryable: false });
    expect(body.messages[1].content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  });

  it('maps 429 with Retry-After to RATE_LIMITED', async () => {
    const p = new OpenAICompatibleProvider(configFromPreset('lmstudio', 'x'), async () => jsonResponse({}, 429, { 'retry-after': '2' }));
    await expect(p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2000 });
  });

  it('maps network failures to PROVIDER_UNAVAILABLE', async () => {
    const p = new OpenAICompatibleProvider(configFromPreset('lmstudio', 'x'), async () => {
      throw new TypeError('fetch failed');
    });
    await expect(p.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('calls Anthropic with browser-access header, base64 images and JSON prefill', async () => {
    let headers: Record<string, string> = {};
    let body: any;
    const p = new AnthropicProvider({ ...configFromPreset('anthropic', 'a'), apiKey: 'k' }, async (_u, init) => {
      headers = init!.headers as Record<string, string>;
      body = JSON.parse(String(init!.body));
      return jsonResponse({ content: [{ type: 'text', text: '"ok":true}' }], usage: { input_tokens: 5, output_tokens: 3 } });
    });
    const r = await p.complete({ system: 'sys', json: true, messages: [{ role: 'user', content: [{ type: 'image', mime: 'image/jpeg', base64: 'BBB' }] }] });
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(body.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'BBB' });
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: '{' });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
  });

  it('shows human error messages', () => {
    expect(errorMessage(new AppError('OCR_FAILED'))).toBe('Не удалось распознать текст. Попробовать ещё раз?');
  });
});

describe('queue and retry', () => {
  it('limits concurrency, dedupes keys and honours priority', async () => {
    const q = new TaskQueue(2);
    let running = 0;
    let peak = 0;
    const order: string[] = [];
    const job = (k: string) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      order.push(k);
      running--;
      return k;
    };
    const ps = ['a', 'b', 'c', 'd'].map((k, i) => q.add({ key: k, priority: i === 3 ? 10 : 0, run: job(k) }));
    const dup = q.add({ key: 'a', priority: 0, run: job('a2') });
    expect(await dup).toBe('a');
    await Promise.all(ps);
    expect(peak).toBe(2);
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'));
  });

  it('cancels queued tasks', async () => {
    const q = new TaskQueue(1);
    const first = q.add({ key: '1', priority: 0, run: () => new Promise((r) => setTimeout(() => r(1), 20)) });
    const second = q.add({ key: '2', priority: 0, run: async () => 2 });
    q.cancel('2');
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await first).toBe(1);
  });

  it('retries retryable errors with backoff and stops on fatal ones', async () => {
    let n = 0;
    const v = await withRetry(async () => {
      if (++n < 3) throw new AppError('PROVIDER_UNAVAILABLE');
      return 'ok';
    }, { baseMs: 1 });
    expect(v).toBe('ok');
    let m = 0;
    await expect(withRetry(async () => {
      m++;
      throw new AppError('INVALID_API_KEY');
    }, { baseMs: 1 })).rejects.toMatchObject({ code: 'INVALID_API_KEY' });
    expect(m).toBe(1);
  });

  it('mapLimit keeps order', async () => {
    expect(await mapLimit([3, 1, 2], 2, async (x) => x * 2)).toEqual([6, 2, 4]);
  });
});

describe('project files and archives', () => {
  it('round-trips a project with images', async () => {
    const page = await makeMangaPage(200, 300, []);
    const p = newProject('p1', 'Глава 1', { sourceLang: 'ja', targetLang: 'ru', profileId: 'natural' });
    p.pages.push({ id: 'pg1', name: '001.png', index: 0, mime: 'image/png', status: 'done' });
    const zip = await exportProjectZip(p, async () => ({ original: { bytes: page.bytes, mime: 'image/png' }, cleaned: [{ y: 0, h: 300, bytes: page.bytes }] }));
    const back = await importProjectZip(zip);
    expect(back.project.title).toBe('Глава 1');
    expect(back.assets.get('pg1')!.original.bytes.length).toBe(page.bytes.length);
    expect(back.assets.get('pg1')!.cleaned).toHaveLength(1);
  });

  it('reads chapter archives in natural order', async () => {
    const page = await makeMangaPage(50, 50, []);
    const zip = new JSZip();
    zip.file('ch1/page10.png', page.bytes);
    zip.file('ch1/page2.png', page.bytes);
    zip.file('ch1/readme.txt', 'hi');
    const imgs = await readArchiveImages(await zip.generateAsync({ type: 'uint8array' }));
    expect(imgs.map((i) => i.name)).toEqual(['page2.png', 'page10.png']);
  });

  it('rejects zip bombs and unsafe paths', async () => {
    const bomb = new JSZip();
    bomb.file('a.png', new Uint8Array(ARCHIVE_LIMITS.maxEntryBytes + 1));
    await expect(readArchiveImages(await bomb.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    const evil = new JSZip();
    evil.file('../../etc/passwd.png', 'x');
    await expect(readArchiveImages(await evil.generateAsync({ type: 'uint8array' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  }, 30_000);

  it('sniffs image types from magic bytes', async () => {
    const page = await makeMangaPage(10, 10, []);
    expect(sniffImageMime(page.bytes)).toBe('image/png');
    expect(sniffImageMime(new TextEncoder().encode('<svg></svg>....'))).toBeNull();
  });
});

describe('SSE parsing', () => {
  it('parses events with JSON data', () => {
    expect(parseSse('event: stage\ndata: {"stage":"ocr"}')).toEqual({ event: 'stage', data: { stage: 'ocr' } });
    expect(parseSse(': keepalive')).toBeNull();
  });
});
