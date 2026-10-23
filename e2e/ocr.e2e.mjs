// AI mode «Распознавание»: the text detector finds the text, PaddleOCR reads it right in the browser
// (no Python, no model that reads pictures) and a text model translates it. The settings card
// downloads the recognition models (served here from local copies: OCR_MODELS=folder with
// PP-OCRv6_det_small.onnx and PP-OCRv6_rec_small.onnx; without them the test is skipped).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const MODELS = process.env.OCR_MODELS ?? '';
mkdirSync(OUT, { recursive: true });
if (!MODELS || !existsSync(join(MODELS, 'PP-OCRv6_rec_small.onnx'))) {
  console.log('OCR models not at hand (OCR_MODELS): skipped');
  process.exit(0);
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e ocr: ${name}::${String(detail).slice(0, 500)}`);
};

const ortDir = dirname(createRequire(join(ROOT, 'apps/extension/package.json')).resolve('onnxruntime-web'));
const ORT_VERSION = JSON.parse(readFileSync(join(ortDir, '../package.json'), 'utf8')).version;
const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`;
const files = {
  [ORT_WASM_URL]: readFileSync(join(ortDir, 'ort-wasm-simd-threaded.jsep.wasm')),
  'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx': readFileSync(new URL('./fixtures/fake-detector.onnx', import.meta.url)),
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx': readFileSync(join(MODELS, 'PP-OCRv6_det_small.onnx')),
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx': readFileSync(join(MODELS, 'PP-OCRv6_rec_small.onnx')),
};
// Manga OCR (Japanese) when its files are in the same folder (from the models-1 release).
const MANGA = ['manga-ocr-encoder-int8.onnx', 'manga-ocr-decoder-int8.onnx', 'manga-ocr-vocab.txt'];
const haveManga = MANGA.every((f) => existsSync(join(MODELS, f)));
if (haveManga) for (const f of MANGA) files[`https://github.com/kclazzy/AI-translate/releases/download/models-1/${f}`] = readFileSync(join(MODELS, f));

const ext = join(tmpdir(), 'ait-ext-ocr');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// A bubble with one line where the stand-in detector reports text (the middle of the picture).
const W = 600;
const H = 700;
let picture = null;
let pictureJa = null;
const site = createServer((req, res) => {
  if (req.url.startsWith('/models/')) {
    const body = files[decodeURIComponent(req.url.slice(8))];
    if (body) return res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream', 'content-length': String(body.length) }).end(body);
  }
  if (req.url === '/ja') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Bubble</title><body style="margin:0"><img src="/page-ja.png" width="${W}" height="${H}"></body>`);
  if (req.url === '/page-ja.png' && pictureJa) return res.writeHead(200, { 'content-type': 'image/png' }).end(pictureJa);
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Bubble</title><body style="margin:0"><img src="/page.png" width="${W}" height="${H}"></body>`);
  if (req.url === '/page.png' && picture) return res.writeHead(200, { 'content-type': 'image/png' }).end(picture);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18171, '127.0.0.1', r));
const asked = [];
let images = 0;
const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method === 'GET') return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'text-model' }] }));
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    if (JSON.stringify(j).includes('image_url')) images++;
    const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(j.messages?.at(-1)?.content ?? '')?.[1] ?? '[]');
    for (const b of blocks) asked.push(b.text);
    const content = JSON.stringify({ translations: blocks.map((b) => ({ id: b.id, text: 'Где ты?' })), entities: [], summary: '' });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'text-model' }));
  });
});
await new Promise((r) => llm.listen(18170, '127.0.0.1', r));

const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1000 },
});
browser.on('targetcreated', async (t) => {
  if (t.url().includes('view=welcome')) (await t.page().catch(() => null))?.close().catch(() => {});
});

try {
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18171/x');
  const drawBubble = async (text, font) => Buffer.from(
    await helper.evaluate(async (W, H, text, font) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#7a8aa0';
      g.fillRect(0, 0, W, H);
      g.beginPath();
      g.ellipse(W / 2, H / 2, 190, 110, 0, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.lineWidth = 4;
      g.stroke();
      g.fillStyle = '#000';
      g.font = font;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, W / 2, H / 2);
      return c.toDataURL('image/png').split(',')[1];
    }, W, H, text, font),
    'base64',
  );
  picture = await drawBubble('HELLO THERE', 'bold 22px sans-serif');
  pictureJa = await drawBubble('なにしてるの', '24px "Noto Sans CJK JP", sans-serif');
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  const fetched = new Set();
  await studio.setRequestInterception(true);
  studio.on('request', (r) => {
    const body = files[r.url()];
    if (body) {
      const name = r.url().split('/').pop();
      fetched.add(name);
      // Large files come from the local server (a body this size through the protocol stalls the browser).
      if (body.length > 20_000_000) void r.continue({ url: `http://127.0.0.1:18171/models/${encodeURIComponent(r.url())}` });
      else void r.respond({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-length': String(body.length) }, contentType: 'application/octet-stream', body });
    } else void r.continue();
  });
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('.ait-panel', { timeout: 15000 });
  await studio.evaluate(async () => {
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
    // A text model only (it cannot read pictures): enough for «Распознавание».
    s.providers = [{ id: 'mock', label: 'Text model', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18170/v1', model: 'text-model', vision: false, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.sourceLang = 'en';
    s.skipEmptyPages = false;
    s.onboarded = true;
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });
  await studio.reload();
  await studio.waitForSelector('[data-testid="ai-mode"] [data-mode="ocr"]', { timeout: 15000 });
  await studio.click('[data-testid="ai-mode"] [data-mode="ocr"]');
  await studio.waitForSelector('[data-testid="ocr-models"] button', { timeout: 15000 });
  await studio.click('[data-testid="ocr-models"] button');
  const ready = await studio.waitForSelector('[data-testid="ocr-ready"]', { timeout: 90000 }).catch(() => null);
  check('«Скачать» brings the detector and the recognition models', !!ready && fetched.has('PP-OCRv6_rec_small.onnx') && fetched.has('detector_int8.onnx'), [...fetched].join(', '));
  await studio.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' })).catch(() => undefined);

  const tab = await browser.newPage();
  await tab.goto('http://127.0.0.1:18171/');
  await tab.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth);
  await new Promise((r) => setTimeout(r, 800));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18171/' });
    await chrome.tabs.sendMessage(t.id, { type: 'translate-src', src: 'http://127.0.0.1:18171/page.png' });
  });
  await tab.bringToFront();
  for (let i = 0; i < 120 && !asked.length; i++) await new Promise((r) => setTimeout(r, 500));
  await new Promise((r) => setTimeout(r, 4000));
  check('the text is read in the browser and only the text goes to the model', asked.some((t) => /hello there/i.test(t)) && images === 0, `asked=${JSON.stringify(asked)} images=${images}`);
  const stored = await studio.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const g = db.transaction('results').objectStore('results').getAll();
      g.onsuccess = () => res(g.result.flatMap((x) => x.page.blocks.map((b) => b.translatedText)));
    });
  });
  const errors = await studio.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const g = db.transaction('kv').objectStore('kv').get('errors');
      g.onsuccess = () => res(g.result ?? []);
    });
  });
  check('the page gets the translation', stored.includes('Где ты?'), `${JSON.stringify(stored)} errors=${JSON.stringify(errors).slice(0, 400)}`);
  await tab.screenshot({ path: join(OUT, 'ocr.png') });

  if (haveManga) {
    // Japanese: the card offers Manga OCR, which then reads the bubble whole.
    await studio.bringToFront();
    await studio.evaluate(async () => {
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
      s.sourceLang = 'ja';
      store.put(s, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
    });
    await studio.reload();
    const offer = await studio.waitForSelector('[data-testid="manga-ocr"] button', { timeout: 15000 }).catch(() => null);
    check('for Japanese the card offers Manga OCR', !!offer);
    if (offer) {
      await offer.click();
      const got = await studio.waitForSelector('[data-testid="manga-ocr-ready"]', { timeout: 90000 }).catch(() => null);
      check('«Скачать Manga OCR» brings its files (checked)', !!got && fetched.has('manga-ocr-encoder-int8.onnx') && fetched.has('manga-ocr-vocab.txt'), [...fetched].join(', '));
      await studio.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' })).catch(() => undefined);
      asked.length = 0;
      const tabJa = await browser.newPage();
      await tabJa.goto('http://127.0.0.1:18171/ja');
      await tabJa.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth);
      await new Promise((r) => setTimeout(r, 800));
      await studio.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18171/ja' });
        await chrome.tabs.sendMessage(t.id, { type: 'translate-src', src: 'http://127.0.0.1:18171/page-ja.png' });
      });
      await tabJa.bringToFront();
      for (let i = 0; i < 120 && !asked.length; i++) await new Promise((r) => setTimeout(r, 500));
      check('Manga OCR reads the Japanese bubble', asked.some((t) => t.includes('なにしてる')), `asked=${JSON.stringify(asked)}`);
    }
  }
} catch (e) {
  check('no crash', false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  site.close();
  llm.close();
}
writeFileSync(join(OUT, 'e2e-ocr.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
