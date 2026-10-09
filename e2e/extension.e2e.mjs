// End-to-end test of the browser extension in a real Chromium:
// load the unpacked build, configure a (mock) vision model, translate a manga page,
// and check the result on screen. Run under a display (xvfb-run on Linux CI).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { startMockLlm } from './mock-llm.mjs';

const MODE = process.env.MODE ?? 'standalone';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'apps/extension/dist');
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const geometry = JSON.parse(readFileSync(new URL('./fixtures/geometry.json', import.meta.url)));
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  // Shows up as an annotation on GitHub Actions.
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e: ${name.replace(/[:,\n]/g, ' ')}::${String(detail).replace(/\n/g, ' ').slice(0, 900)}`);
}

// Test copy of the extension (older test browsers do not know minimum_chrome_version 116).
const ext = join(tmpdir(), 'ait-ext-e2e');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(DIST, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Test site.
const pageHtml = `<!doctype html><meta charset="utf-8"><title>Глава 1</title>
<style>body{margin:0;background:#eee} img{display:block;margin:20px auto;width:800px}</style>
<img id="p1" src="/page.png" width="800" height="1100">`;
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pageHtml);
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18081, '127.0.0.1', r));
const { server: llm, calls } = await startMockLlm(18080);
let engineProc = null;
if (MODE === 'engine') {
  const dataDir = join(tmpdir(), `ait-engine-${Date.now()}`);
  engineProc = spawn(join(ROOT, 'engine/.venv/bin/python'), ['-m', 'app', '--port', '18765'], { cwd: join(ROOT, 'engine'), env: { ...process.env, AIT_DATA_DIR: dataDir, AIT_TOKEN: 'e2e-token' }, stdio: 'pipe' });
  engineProc.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://127.0.0.1:18765/v1/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log('engine started');
}

let browser;
try {
  // Chrome 137+ ignores --load-extension; current puppeteer loads extensions over CDP instead.
  const cdpExtensions = !!process.env.E2E_CDP_EXTENSIONS;
  browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }, // the interface follows the browser language
  executablePath: CHROME,
  headless: false,
  ...(cdpExtensions ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdpExtensions ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--window-size=1280,1300', '--disable-gpu'],
  defaultViewport: { width: 1200, height: 1200 },
  });
  // The welcome tab opened on install would take the focus from the pages under test.
  const closeWelcome = async (t) => {
    if (!t.url().includes('view=welcome')) return;
    const p = await t.page().catch(() => null);
    await p?.close().catch(() => {});
  };
  browser.on('targetcreated', (t) => void closeWelcome(t));
  browser.on('targetchanged', (t) => void closeWelcome(t));
} catch (e) {
  check('browser launches with the extension', false, String(e?.stack ?? e));
  writeFileSync(join(OUT, `e2e-extension-${MODE}.json`), JSON.stringify(results, null, 2));
  process.exit(1);
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  if (process.env.DEBUG) {
    const w = await sw.worker();
    w.on('console', (m) => console.log('[sw]', m.text()));
    browser.on('targetcreated', async (t) => {
      if (t.url().includes('offscreen')) {
        const p = await t.page().catch(() => null);
        const wk = p ?? (await t.worker().catch(() => null));
        console.log('[target]', t.type(), t.url());
        wk?.on?.('console', (m) => console.log('[off]', m.text()));
        p?.on('pageerror', (e) => console.log('[off-err]', String(e)));
      }
    });
  }
  check('service worker starts', !!extId, extId);

  // Configure: mock vision model on localhost, local-only privacy.
  const studio = await browser.newPage();
  const errors = [];
  studio.on('pageerror', (e) => errors.push(String(e)));
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('.ait-panel', { timeout: 15000 });
  check('studio page renders', true);
  await studio.evaluate((mode) => (window.__MODE = mode), MODE);
  await studio.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onupgradeneeded = () => ['results', 'history', 'projects', 'assets', 'contexts', 'kv', 'usage'].forEach((s) => r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    const cur = await new Promise((res) => {
      const g = store.get('settings');
      g.onsuccess = () => res(g.result);
    });
    const s = cur ?? {};
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18080/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = window.__MODE === 'engine' ? 'engine' : 'standalone';
    s.engine = { url: 'http://127.0.0.1:18765', token: 'e2e-token', options: { detector: 'classic', ocr: 'vision', inpainter: 'auto' } };
    s.debug = true;
    store.put(s, 'settings');
    await new Promise((res) => (tx.oncomplete = res));
  });
  await studio.reload();
  await studio.waitForSelector('.ait-panel');
  const settingsText = await studio.$eval('body', (b) => b.innerText);
  check('settings show the configured local model', settingsText.includes('Mock VL') && settingsText.includes('Локально'));

  // Translate the page through the popup command path.
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:18081/');
  await page.waitForFunction(() => document.querySelector('#p1')?.complete);
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: join(OUT, `e2e-${MODE}-before.png`) });
  await studio.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18081/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: tab.id });
  });
  await page.bringToFront();
  const t0 = Date.now();
  let entry = null;
  while (Date.now() - t0 < 60000) {
    entry = await studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('history').objectStore('history').getAll();
        g.onsuccess = () => res(g.result[0] ?? null);
      });
    });
    if (entry) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check('page translated (history entry)', entry?.status === 'done', entry ? `${entry.status} ${entry.error ?? ''} in ${Date.now() - t0} ms` : 'timeout');
  const work = calls.filter((c) => !String(c.messages?.[0]?.content ?? '').includes('editor-in-chief'));
  const reviews = calls.length - work.length;
  if (MODE === 'engine') check('engine path: OCR on crops + text translation', work.length === 2 && work[0].messages.at(-1).content.some((p) => p.type === 'text' && p.text.includes('cropped')), `calls=${work.length}`);
  // Read the picture, then translate the page as text in a separate step (more accurate wording).
  else check('vision model reads the image, then the page is translated in a text step', work.length === 2 && Array.isArray(work[0].messages.at(-1).content) && typeof work[1].messages.at(-1).content === 'string', `calls=${work.length}`);
  check('the translation was checked (one review request)', reviews === 1, `reviews=${reviews}`);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(OUT, `e2e-${MODE}-after.png`) });

  // Pixel check on the screenshots: Japanese glyphs gone, Russian text drawn in the bubbles.
  const before = PNG.sync.read(readFileSync(join(OUT, `e2e-${MODE}-before.png`)));
  const after = PNG.sync.read(readFileSync(join(OUT, `e2e-${MODE}-after.png`)));
  const imgRect = await page.$eval('#p1', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width };
  });
  const scale = imgRect.w / 800;
  const diffInside = (png, b) => {
    let dark = 0;
    for (let y = Math.floor(b.cy - b.ry * 0.8); y < b.cy + b.ry * 0.8; y++) {
      for (let x = Math.floor(b.cx - b.rx * 0.8); x < b.cx + b.rx * 0.8; x++) {
        const px = Math.round(imgRect.x + x * scale);
        const py = Math.round(imgRect.y + y * scale);
        if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
        const i = (py * png.width + px) * 4;
        if (png.data[i] < 90 && png.data[i + 1] < 90 && png.data[i + 2] < 90) dark++;
      }
    }
    return dark;
  };
  for (const [i, b] of geometry.page.entries()) {
    const d0 = diffInside(before, b);
    const d1 = diffInside(after, b);
    check(`bubble ${i + 1}: original text replaced`, d0 > 150 && d1 > 40 && Math.abs(d1 - d0) > 30, `dark px before=${d0}, after=${d1}`);
  }

  // Cached result opens in the editor.
  const key = entry?.key;
  if (key) {
    const ed = await browser.newPage();
    ed.on('pageerror', (e) => errors.push(String(e)));
    await ed.goto(`chrome-extension://${extId}/studio.html?key=${encodeURIComponent(key)}`);
    await ed.waitForSelector('.ait-stage canvas', { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 800));
    const txt = await ed.$eval('body', (b) => b.innerText);
    check('editor opens the translated page', txt.includes('Блоки (2)') && txt.includes('Танака, подожди!'));
    await ed.screenshot({ path: join(OUT, 'e2e-editor.png') });
    // Edit text and save: the page overlay should update through result-changed.
    await ed.click('.ait-blocklist button');
    await ed.$eval('.ait-props textarea', (el) => {
      el.focus();
      el.select();
    });
    await ed.keyboard.type('Танака, стой!');
    await ed.click('.ait-props input.ait-input'); // blur → history entry
    await ed.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Сохранить')?.click());
    await new Promise((r) => setTimeout(r, 1500));
    const saved = await studio.evaluate(async (k) => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('results').objectStore('results').get(k);
        g.onsuccess = () => res(g.result?.page.blocks.map((b) => b.translatedText));
      });
    }, key);
    check('editor saves edits to the cached page', saved?.includes('Танака, стой!'), JSON.stringify(saved));
  }

  // Popup renders.
  const popup = await browser.newPage();
  popup.on('pageerror', (e) => errors.push(String(e)));
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('.ait-bubble-btn');
  await popup.screenshot({ path: join(OUT, 'e2e-popup.png') });
  check('popup renders', true);

  // Screen-area translation path (capture → crop → pipeline): the job must finish and be recorded.
  const historyCount = () =>
    studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('history').objectStore('history').count();
        g.onsuccess = () => res(g.result);
      });
    });
  const h0 = await historyCount();
  await studio.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18081/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'select-area', tabId: tab.id });
  });
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 500));
  await page.mouse.move(250, 150);
  await page.mouse.down();
  await page.mouse.move(600, 500, { steps: 5 });
  await page.mouse.up();
  const t1 = Date.now();
  let h1 = h0;
  while (h1 === h0 && Date.now() - t1 < 30000) {
    await new Promise((r) => setTimeout(r, 400));
    h1 = await historyCount();
  }
  check('screen area: capture → crop → translate completes', h1 > h0, `history ${h0} → ${h1}`);

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  engineProc?.kill();
  llm.close();
  site.close();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, `e2e-extension-${MODE}.json`), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
