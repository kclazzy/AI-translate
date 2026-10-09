// LaMa in the browser: with «Дорисовка фона — в браузере» and the model in the cache, text written
// over artwork is redrawn by the model (here a tiny stand-in model that paints the hole grey).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e lama: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-lama');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

let picture = null;
const W = 600;
const H = 800;
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Art</title><body style="margin:0"><img src="/art.png" width="600" height="800"></body>');
  if (req.url === '/art.png' && picture) return res.writeHead(200, { 'content-type': 'image/png' }).end(picture);
  if (req.url === '/blank') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>b</title>');
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18151, '127.0.0.1', r));
// The model: one line of text written straight over the art.
const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const box = [Math.round((195 / W) * 1000), Math.round((175 / H) * 1000), Math.round((345 / W) * 1000), Math.round((235 / H) * 1000)];
    const content = JSON.stringify({ blocks: JSON.stringify(j).includes('image_url') ? [{ box, text: 'DOOM', translation: 'БУМ', type: 'DIALOGUE', vertical: false }] : [], entities: [], summary: '' });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'mock' }));
  });
});
await new Promise((r) => llm.listen(18150, '127.0.0.1', r));

const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1000 },
});
// The welcome tab opened on install would take the focus from the pages under test.
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  // The picture: white letters with a black outline over coloured stripes.
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18151/blank');
  const b64 = await helper.evaluate((w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    for (let x = 0; x < w; x += 10) {
      ctx.fillStyle = `hsl(${x % 360}, 60%, 50%)`;
      ctx.fillRect(x, 0, 10, h);
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.font = 'bold 48px sans-serif';
    ctx.strokeText('DOOM', 200, 220);
    ctx.fillText('DOOM', 200, 220);
    return c.toDataURL('image/png').split(',')[1];
  }, W, H);
  picture = Buffer.from(b64, 'base64');
  await helper.close();

  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
  const model = readFileSync(new URL('./fixtures/fake-lama.onnx', import.meta.url)).toString('base64');
  await studio.evaluate(async (m) => {
    const bytes = Uint8Array.from(atob(m), (c) => c.charCodeAt(0));
    await (await caches.open('ait-models')).put('https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx', new Response(bytes));
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    const s = await new Promise((res) => {
      const g = store.get('settings');
      g.onsuccess = () => res(g.result ?? {});
    });
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18150/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.qaMode = 'off';
    s.twoStepTranslation = false;
    s.lamaMode = 'browser';
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  }, model);

  const tab = await browser.newPage();
  await tab.goto('http://127.0.0.1:18151/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 600));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18151/' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await tab.bringToFront();
  let grey = -1;
  for (let i = 0; i < 60 && grey < 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    grey = await studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      const all = await new Promise((res) => {
        const g = db.transaction('results').objectStore('results').getAll();
        g.onsuccess = () => res(g.result);
      });
      if (!all.length) return -1;
      const r = all[0];
      const bmp = await createImageBitmap(new Blob([r.cleaned[0].bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(200, 180, 140, 45).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 127) < 6 && Math.abs(d[i + 1] - 127) < 6 && Math.abs(d[i + 2] - 127) < 6) n++;
      return n;
    });
  }
  await tab.screenshot({ path: join(OUT, 'lama.png') });
  check('text over the art is redrawn by LaMa running in the browser', grey > 300, `grey pixels where the letters were: ${grey}`);
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-lama.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
