// The neural text detector in the browser: «Скачать» in the settings downloads the model (here a
// tiny stand-in with the same inputs and outputs: pixel_values → logits + pred_boxes, always one
// text box and one bubble in the middle of the picture) with the ONNX Runtime .wasm, switches it on,
// and a page is translated with it. The stand-in was made with python onnx: a ReduceMean of the
// input times 0 added to constant logits / boxes (query 0: text_bubble at cx .5 cy .5 w .3 h .08;
// query 1: bubble at .5 .5 .6 .4; the rest −10).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e detector: ${name}::${String(detail).slice(0, 500)}`);
};

// The runtime the extension fetches from jsDelivr: served from node_modules (offline).
const ortDir = dirname(createRequire(join(ROOT, 'apps/extension/package.json')).resolve('onnxruntime-web'));
const ORT_VERSION = JSON.parse(readFileSync(join(ortDir, '../package.json'), 'utf8')).version;
const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`;
const wasmBytes = readFileSync(join(ortDir, 'ort-wasm-simd-threaded.jsep.wasm'));
const DETECTOR = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx';
const LAMA = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
const modelBytes = readFileSync(new URL('./fixtures/fake-detector.onnx', import.meta.url));

const ext = join(tmpdir(), 'ait-ext-detector');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// A bubble in the middle of the picture, where the stand-in model reports it.
const W = 600;
const H = 700;
let picture = null;
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Bubble</title><body style="margin:0"><img src="/page.png" width="${W}" height="${H}"></body>`);
  if (req.url === '/page.png' && picture) return res.writeHead(200, { 'content-type': 'image/png' }).end(picture);
  if (req.url === '/blank') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>b</title>');
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18161, '127.0.0.1', r));
// The model: one block with a loose box (much bigger than the lettering).
let visionCalls = 0;
const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const vision = JSON.stringify(j).includes('image_url');
    if (vision) visionCalls++;
    const box = [Math.round((150 / W) * 1000), Math.round((280 / H) * 1000), Math.round((450 / W) * 1000), Math.round((440 / H) * 1000)];
    const content = JSON.stringify({ blocks: vision ? [{ box, text: 'HELLO', translation: 'ПРИВЕТ', type: 'DIALOGUE', vertical: false }] : [], entities: [], summary: '' });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'mock' }));
  });
});
await new Promise((r) => llm.listen(18160, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1000 },
});
// The welcome tab opened on install would take the focus from the pages under test.
let keepWelcome = false;
const closeWelcome = async (t) => {
  if (keepWelcome || !t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

const waitFor = async (f, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
};

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18161/blank');
  const draw = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, 180, 140, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('HELLO', w / 2, h / 2 + 14);
    return c.toDataURL('image/png').split(',')[1];
  };
  picture = Buffer.from(await helper.evaluate(`(${draw})(${W}, ${H})`), 'base64');
  await helper.close();

  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
  const readSettings = () =>
    studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('kv').objectStore('kv').get('settings');
        g.onsuccess = () => res(g.result ?? {});
      });
    });
  const patchSettings = (patch) =>
    studio.evaluate(async (patch) => {
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
      for (const [k, v] of Object.entries(patch)) if (v === null) delete s[k];
      else s[k] = v;
      store.put(s, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
    }, patch);
  const inCache = (url) => studio.evaluate(async (u) => !!(await (await caches.open('ait-models')).match(u)), url);
  const stored = () =>
    studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('results').objectStore('results').getAll();
        g.onsuccess = () => res(g.result.map((r) => ({ key: r.key, page: r.page })));
      });
    });

  await patchSettings({
    providers: [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18160/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }],
    visionProviderId: 'mock',
    translationProviderId: null,
    privacy: 'local',
    pipeline: 'standalone',
    qaMode: 'off',
    twoStepTranslation: false,
    detectorMode: null,
  });

  // ---- «Скачать» in the settings ------------------------------------------------------------------
  const fetched = new Set();
  const serveModel = async (p) => {
    await p.setRequestInterception(true);
    p.on('request', (r) => {
      const body = r.url() === ORT_WASM_URL ? wasmBytes : r.url().startsWith('https://huggingface.co/') ? modelBytes : null;
      if (body) fetched.add(r.url() === ORT_WASM_URL ? 'wasm' : r.url());
      if (body) void r.respond({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-length': String(body.length) }, contentType: 'application/octet-stream', body });
      else void r.continue();
    });
  };
  const sp = await browser.newPage();
  await serveModel(sp);
  await sp.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await sp.waitForSelector('[data-testid=detector]', { timeout: 15000 });
  const texts = await sp.$eval('[data-testid=detector]', (e) => e.textContent);
  check('the settings offer «Точный поиск текста»', texts.includes('Точный поиск текста (нейросеть ~45 МБ)') && texts.includes('меньше сдвинутого текста'), texts);
  check('before the download it is off', !(await readSettings()).detectorMode);
  await sp.waitForSelector('[data-testid=detector-download] button', { timeout: 15000 });
  await sp.$eval('[data-testid=detector-download] button', (b) => b.click());
  const on = await sp.waitForSelector('[data-testid=detector-switch]', { timeout: 30000 }).catch(() => null);
  const s1 = await readSettings();
  check('«Скачать» downloads the model and switches the detector on', !!on && s1.detectorMode === 'browser' && (await inCache(DETECTOR)) && (await inCache(ORT_WASM_URL)), `mode ${s1.detectorMode}`);
  check('the int8 model and the ONNX Runtime .wasm are what is downloaded', fetched.has(DETECTOR) && fetched.has('wasm'), [...fetched].join(', '));

  // ---- A page translated with the detector ------------------------------------------------------
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  await tab.goto('http://127.0.0.1:18161/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 600));
  const translate = () =>
    studio.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18161/' });
      await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
    });
  await translate();
  await tab.bringToFront();
  const done = await waitFor(async () => (await stored()).find((r) => r.page?.blocks?.length), 40000);
  await tab.screenshot({ path: join(OUT, 'detector.png') });
  check('the page is translated with the detector on', !!done && done.page.blocks[0].translatedText === 'ПРИВЕТ', done ? JSON.stringify(done.page.blocks.map((b) => b.translatedText)) : 'no result');
  check('the detector ran (its time is in the page timings)', typeof done?.page?.timings?.detectorMs === 'number', JSON.stringify(done?.page?.timings ?? {}));
  // The stand-in's text box: x 210–390, y 322–378 of the 600×700 picture; the model said 150–450 × 280–440.
  const bb = done?.page?.blocks?.[0]?.bbox ?? [0, 0, 0, 0];
  check("the model's loose box snapped onto the detector's text box", bb[0] >= 200 && bb[1] >= 312 && bb[0] + bb[2] <= 400 && bb[1] + bb[3] <= 388, JSON.stringify(bb));
  check('the bubble was found', !!done?.page?.blocks?.[0]?.bubble, JSON.stringify(done?.page?.blocks?.[0]?.bubble ?? null));
  check('no errors on the page', !errors.length, errors.join(' | '));
  const status = await sp.evaluate(() => document.body.innerText.includes('Не удалось'));
  check('no download error shown', !status);

  // ---- «Освободить память» releases the session; the next page loads it again --------------------
  // (The page's «Освободить и повторить» goes through the background, which passes it on like this.)
  const freed = await (await sw.worker()).evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'free-memory' }));
  check('«free-memory» releases the detector in the worker', !!freed?.ok, JSON.stringify(freed));
  await studio.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    const tx = db.transaction('results', 'readwrite');
    tx.objectStore('results').clear();
    await new Promise((r) => (tx.oncomplete = r));
  });
  await tab.reload();
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 600));
  await translate();
  await tab.bringToFront();
  const again = await waitFor(async () => (await stored()).find((r) => r.page?.blocks?.length), 40000);
  check('after that the next page loads the detector again', typeof again?.page?.timings?.detectorMs === 'number', JSON.stringify(again?.page?.timings ?? {}));

  // ---- Off: the detector is not used ------------------------------------------------------------
  await sp.$eval('[data-testid=detector-switch] input', (b) => b.click());
  check('the switch turns it off', !!(await waitFor(async () => (await readSettings()).detectorMode === 'off')));

  // ---- «Удалить»: the runtime stays while LaMa needs it ------------------------------------------
  await studio.evaluate(async (u, m) => (await caches.open('ait-models')).put(u, new Response(Uint8Array.from(atob(m), (c) => c.charCodeAt(0)))), LAMA, modelBytes.toString('base64'));
  await sp.$eval('[data-testid=detector-remove]', (b) => b.click());
  await sp.waitForSelector('[data-testid=detector-download] button', { timeout: 10000 });
  check('«Удалить» removes the model, keeps the runtime LaMa uses', !(await inCache(DETECTOR)) && (await inCache(ORT_WASM_URL)) && (await readSettings()).detectorMode === 'off');
  await studio.evaluate(async (u) => (await caches.open('ait-models')).delete(u), LAMA);

  // ---- Welcome: the optional step downloads it (the runtime is fetched again only if missing) -----
  fetched.clear();
  keepWelcome = true;
  const wp = await browser.newPage();
  await serveModel(wp);
  await wp.goto(`chrome-extension://${extId}/studio.html?view=welcome`);
  await wp.waitForSelector('[data-testid=welcome-detector] button', { timeout: 15000 });
  await wp.click('[data-testid=welcome-detector] button');
  const ready = await wp.waitForFunction(() => document.querySelector('[data-testid=welcome-detector]')?.textContent.includes('Готово'), { timeout: 30000 }).catch(() => null);
  const s2 = await readSettings();
  check('the welcome step downloads the detector and switches it on', !!ready && s2.detectorMode === 'browser' && (await inCache(DETECTOR)), `mode ${s2.detectorMode}`);
  check('the runtime already there is not downloaded again', !fetched.has('wasm'), [...fetched].join(', '));
  await wp.close();
  keepWelcome = false;
  void visionCalls;
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-detector.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
