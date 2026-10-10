// End-to-end test of the browser extension in a real Chromium:
// load the unpacked build, configure a (mock) vision model, translate a manga page,
// and check the result on screen. Run under a display (xvfb-run on Linux CI).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
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

/** Text of a node from DOM.getDocument (pierce). */
function textOf(n) {
  let t = '';
  const walk = (x) => {
    if (x.nodeType === 3) t += x.nodeValue;
    (x.children ?? []).forEach(walk);
  };
  walk(n);
  return t.trim();
}

/** Nodes of the page including closed shadow roots (our overlays). */
async function shadowNodes(p) {
  const c = await p.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const walk = (n) => {
    out.push(n);
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  return { c, nodes: out };
}

async function shadowTexts(p) {
  const { c, nodes } = await shadowNodes(p);
  await c.detach();
  return nodes.filter((n) => n.nodeType === 3 && n.nodeValue?.trim()).map((n) => n.nodeValue.trim());
}

/** Click the first element (also inside closed shadow roots) that matches. */
async function clickInShadow(p, match) {
  const { c, nodes } = await shadowNodes(p);
  const n = nodes.find(match);
  if (!n) {
    await c.detach();
    throw new Error(`element not found; buttons: ${nodes.filter((x) => x.localName === 'button').map((x) => `${textOf(x)}[${x.attributes}]`).join(' | ')}`);
  }
  const { model } = await c.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
  await c.detach();
  const q = model.content;
  await p.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
}

/** Files of a zip (central directory; stored or deflated). */
function readZip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    p += 46 + nameLen + extra + comment;
  }
  return out;
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

  // ⓘ → «Сообщить о проблеме»: a zip for the developer is downloaded (page, model answers, no keys).
  {
    const DL = join(tmpdir(), `ait-ext-report-${MODE}`);
    if (existsSync(DL)) rmSync(DL, { recursive: true });
    mkdirSync(DL, { recursive: true });
    const bc = await browser.target().createCDPSession();
    await bc.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    await page.bringToFront();
    const r = await page.$eval('#p1', (el) => el.getBoundingClientRect().toJSON());
    await page.mouse.move(r.x + r.width / 2, r.y + 40);
    // The overlay may still be finishing (the review redraws it): wait for its ⓘ.
    for (let i = 0; i < 40; i++) {
      const ok = await clickInShadow(page, (n) => n.localName === 'button' && n.attributes?.includes('data-info')).then(() => true, () => false);
      if (ok) break;
      await new Promise((res) => setTimeout(res, 300));
    }
    await new Promise((res) => setTimeout(res, 300));
    await clickInShadow(page, (n) => n.localName === 'textarea');
    await page.keyboard.type('Пузырь пустой');
    await clickInShadow(page, (n) => n.localName === 'button' && textOf(n) === 'Сообщить о проблеме');
    let zipName = null;
    for (let i = 0; i < 60 && !zipName; i++) {
      await new Promise((res) => setTimeout(res, 300));
      zipName = readdirSync(DL).find((f) => f.endsWith('.zip'));
    }
    const files = zipName ? readZip(readFileSync(join(DL, zipName))) : {};
    const texts = await shadowTexts(page);
    const note = texts.find((t) => t.startsWith('Файл сохранён')) ?? '';
    if (!zipName) {
      await page.screenshot({ path: join(OUT, 'e2e-report-fail.png') });
      console.log('report UI:', texts.slice(-15).join(' | '));
    }
    check('ⓘ → «Сообщить о проблеме» downloads a zip with the page data', !!files['page.json'] && !!files['original.png'] && !!files['result.png'] && !!files['cleaned.png'], `${zipName ?? 'no zip'}: ${Object.keys(files).join(', ')}`);
    const pj = files['page.json'] ? JSON.parse(files['page.json'].toString('utf8')) : null;
    const info = files['info.txt']?.toString('utf8') ?? '';
    const settingsJson = files['settings.json']?.toString('utf8') ?? '';
    check('the report has the model answers, the comment, no keys and no page address', (MODE === 'engine' || pj?.debug?.answers?.length > 0) && info.includes('Пузырь пустой') && !info.includes('127.0.0.1:18081') && !settingsJson.includes('e2e-token') && /ait-problem-\d{8}-\d{4}-[0-9a-z]+\.zip/.test(note), `answers=${pj?.debug?.answers?.length} note=${note}`);
    await clickInShadow(page, (n) => n.localName === 'button' && n.attributes?.includes('data-info')).catch(() => undefined);
    await bc.detach();
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
    // Tools on the page: the eraser shows its outline, manual OCR shows the frame being stretched.
    await ed.click('[aria-label="Ластик"]');
    const stage = await ed.$('.ait-stage-inner');
    const sb = await stage.boundingBox();
    await ed.mouse.move(sb.x + 120, sb.y + 120);
    await ed.mouse.move(sb.x + 130, sb.y + 125);
    const eraserOutline = await ed.$('.ait-brush-cursor.eraser');
    check('the eraser shows its outline on the page', !!eraserOutline);
    // Hold the right button and pull: the eraser grows to the pointer.
    const sizeBefore = await ed.$eval('.ait-pal-range', (el) => Number(el.value));
    await ed.mouse.move(sb.x + 200, sb.y + 200);
    await ed.mouse.down({ button: 'right' });
    await ed.mouse.move(sb.x + 290, sb.y + 200, { steps: 6 });
    await ed.mouse.up({ button: 'right' });
    const sizeAfter = await ed.$eval('.ait-pal-range', (el) => Number(el.value));
    check('holding the right button and pulling makes the eraser bigger', sizeAfter > sizeBefore + 50, `${sizeBefore} → ${sizeAfter}`);
    await ed.click('[aria-label="Ручной OCR"]');
    await ed.mouse.move(sb.x + 60, sb.y + 60);
    await ed.mouse.down();
    await ed.mouse.move(sb.x + 160, sb.y + 140, { steps: 5 });
    const frame = await ed.$eval('[data-testid="ocr-frame"]', (el) => el.getBoundingClientRect().width).catch(() => 0);
    await ed.screenshot({ path: join(OUT, 'e2e-ocr-frame.png') });
    check('manual OCR shows the frame while it is stretched', frame > 80, `width=${frame}`);
    await ed.mouse.up();
    // Pipette: the brush takes the colour of the picture where it is clicked (grey screentone here).
    await new Promise((r) => setTimeout(r, 500));
    await ed.click('[aria-label^="Пипетка"]');
    await ed.mouse.click(sb.x + 20, sb.y + sb.height - 20);
    const picked = await ed.$eval('[data-testid="brush-color"]', (el) => el.value);
    const [pr, pg, pb] = [1, 3, 5].map((i) => parseInt(picked.slice(i, i + 2), 16));
    check('the pipette takes the brush colour from the picture', picked !== '#ffffff' && Math.abs(pr - pg) < 20 && Math.abs(pg - pb) < 20 && pr > 120 && pr < 235, picked);
    // Compare with the original (◫, a slider as on the page): the blocks stay editable meanwhile.
    await ed.click('[aria-label="Выбор"]');
    const cmpBtn = await ed.$eval('[data-testid="compare"]', (b) => ({ icon: b.textContent, title: b.title }));
    check('the editor compare button matches the page one', cmpBtn.icon === '◫' && cmpBtn.title === 'Сравнить с оригиналом', JSON.stringify(cmpBtn));
    await ed.click('[data-testid="compare"]');
    await ed.waitForSelector('.ait-compare-handle', { timeout: 3000 });
    const boxesInCompare = await ed.$$eval('.ait-box', (l) => l.length);
    check('blocks stay on the page while comparing', boxesInCompare === 2, `boxes=${boxesInCompare}`);
    const boxRect = () => ed.$eval('.ait-box', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const b0 = await boxRect();
    await ed.mouse.move(b0.x + b0.w / 2, b0.y + b0.h / 2);
    await ed.mouse.down();
    await ed.mouse.move(b0.x + b0.w / 2 + 40, b0.y + b0.h / 2 + 30, { steps: 6 });
    await ed.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
    const b1 = await boxRect();
    check('a block can be dragged while comparing', b1.x - b0.x > 25 && b1.y - b0.y > 15, `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
    await ed.click('.ait-blocklist button');
    await ed.$eval('.ait-props textarea', (el) => {
      el.focus();
      el.select();
    });
    await ed.keyboard.type('Сравниваю');
    const typed = await ed.$eval('.ait-props textarea', (el) => el.value);
    const stillComparing = !!(await ed.$('.ait-compare-handle'));
    check('text can be edited while comparing', typed === 'Сравниваю' && stillComparing, `${typed} comparing=${stillComparing}`);
    await ed.screenshot({ path: join(OUT, 'e2e-editor-compare.png') });
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

  // Settings → «Замерить скорость»: the sample page goes through the pipeline and a table of stages appears.
  if (MODE !== 'engine') {
    await studio.bringToFront();
    const before = calls.length;
    const clicked = await studio.evaluate(() => {
      const b = [...document.querySelectorAll('[data-testid=speed-benchmark] button')].find((x) => x.textContent.includes('Замерить скорость'));
      b?.click();
      return !!b;
    });
    const table = clicked ? await studio.waitForSelector('[data-testid=speed-result] table', { timeout: 30000 }).catch(() => null) : null;
    const benchText = table ? await studio.$eval('[data-testid=speed-result]', (e) => e.innerText) : await studio.$eval('[data-testid=speed-benchmark]', (e) => e.innerText).catch(() => '');
    check('«Замерить скорость» shows the stage table with «Всего»', !!table && /Всего\s+[\d,.]+\s*с/.test(benchText) && benchText.includes('Чтение картинки') && benchText.includes('Быстрее всего ускорит'), benchText.replace(/\s+/g, ' ').slice(0, 300));
    check('the benchmark skips the cache (asks the model again)', calls.length > before, `calls ${before} → ${calls.length}`);
    await studio.screenshot({ path: join(OUT, 'e2e-benchmark.png'), fullPage: false });
  }

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
