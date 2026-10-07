// «Перевести и скачать»: a chapter page with ordinary pages, a picture that has not loaded yet
// (lazy, like Webtoons) and a long strip is translated completely and downloaded as one PDF,
// with the strip cut into book pages.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const DL = join(tmpdir(), 'ait-chapter-downloads');
mkdirSync(OUT, { recursive: true });
if (existsSync(DL)) rmSync(DL, { recursive: true });
mkdirSync(DL, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e chapter: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-chapter');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const page = readFileSync(new URL('./fixtures/page.png', import.meta.url));
// A 400×2400 strip: noisy panels with white gutters every 600 px.
function makeStrip() {
  const png = new PNG({ width: 400, height: 2400 });
  let seed = 9;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 2400; y++) {
    const gutter = y % 600 > 580 || y % 600 < 20;
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      const v = gutter ? 255 : Math.floor(((x >> 3) + (y >> 3)) % 2 ? 60 + rnd() * 60 : 160 + rnd() * 60);
      png.data[i] = png.data[i + 1] = png.data[i + 2] = v;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
const strip = makeStrip();
const BLANK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const variant = (n) => Buffer.concat([page, Buffer.from(`\n${n}`)]);
const html = `<!doctype html><meta charset="utf-8"><title>Звёздный мечник — глава 131</title><style>img{display:block;width:400px;margin:0 auto}</style>
<img src="/p1.png" width="400" height="550"><img src="/p2.png" width="400" height="550"><img src="/blank.png" data-url="/p3.png" width="400" height="550"><img src="/strip.png" width="400" height="2400">
<div style="height:2500px"></div>
<img id="late" data-x-later="/p5.png" style="width:400px">
<h3>Другие эпизоды</h3><img src="/p4.png" style="width:260px;height:357px;display:inline-block;margin:0" alt="thumb">
<script>
// A reader that inserts the last page only when the reader scrolls down to it (unknown attribute).
const late = document.getElementById('late');
new IntersectionObserver((e) => { if (e[0].isIntersecting && !late.src) late.src = late.dataset.xLater; }).observe(late);
</script>`;
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  if (req.url === '/blank.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(BLANK);
  if (req.url === '/strip.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(strip);
  const m = req.url.match(/^\/p(\d)\.png$/);
  if (m) return res.writeHead(200, { 'content-type': 'image/png' }).end(variant(m[1]));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18111, '127.0.0.1', r));
const { server: llm } = await startMockLlm(18110);

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }, // the interface follows the browser language
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1200 },
});

/** Texts on the page including closed shadow roots (our overlays and panels). */
async function pageTexts(p) {
  const c = p.createCDPSession ? await p.createCDPSession() : await p.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3 && n.nodeValue?.trim()) out.push(n.nodeValue.trim());
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  await c.detach();
  return out;
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const client = await browser.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
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
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18110/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });

  const tab = await browser.newPage();
  const pageErrors = [];
  tab.on('pageerror', (e) => pageErrors.push(String(e)));
  tab.on('console', (m) => pageErrors.push(m.type() + ':' + m.text()));
  await tab.goto('http://127.0.0.1:18111/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete));
  await new Promise((r) => setTimeout(r, 800));
  const t0 = Date.now();
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18111/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'download-chapter', format: 'pdf', tabId: t.id });
  });
  await tab.bringToFront();
  let file = null;
  for (let i = 0; i < 120 && !file; i++) {
    await new Promise((r) => setTimeout(r, 500));
    file = readdirSync(DL).find((f) => f.endsWith('.pdf'));
  }
  await tab.screenshot({ path: join(OUT, 'chapter-done.png') });
  if (!file || process.env.DEBUG) {
    await studio.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' })).catch(() => undefined);
    const swNow = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 5000 }).catch(() => null);
    const log = swNow ? await (await swNow.worker()).evaluate(() => (globalThis.__aitLog ?? []).slice(-25).join('\n')).catch((e) => String(e)) : 'no sw';
    const hist = await studio.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
      return new Promise((res) => { const g = db.transaction('history').objectStore('history').getAll(); g.onsuccess = () => res(g.result.map((h) => `${h.status} ${h.error ?? ''}`)); });
    });
    const c2 = await tab.target().createCDPSession();
    const { root } = await c2.send('DOM.getDocument', { depth: -1, pierce: true });
    const texts = [];
    const walk = (n) => { if (n.nodeType === 3 && n.nodeValue?.trim()) texts.push(n.nodeValue.trim()); (n.children ?? []).forEach(walk); (n.shadowRoots ?? []).forEach(walk); };
    walk(root);
    console.log('UI: ' + texts.join(' | '));
    console.log('LOG:\n' + log + '\nHISTORY: ' + JSON.stringify(hist) + '\nERRORS: ' + pageErrors.join(' | '));
  }
  // The test browser stores downloads under random names; the name the extension chose is shown in the panel.
  let panel = '';
  for (let i = 0; i < 10 && !panel.includes('Скачано'); i++) {
    panel = (await pageTexts(tab)).find((t) => t.startsWith('Скачано') || t.startsWith('Не удалось')) ?? '';
    if (!panel.includes('Скачано')) await new Promise((r) => setTimeout(r, 300));
  }
  check('the chapter is downloaded as one PDF named after the page', !!file && /(Звёздный мечник глава 131|Zvezdnyy mechnik glava 131)\.pdf/.test(panel), `${panel || 'no panel'} · ${file ?? 'no file'} in ${Date.now() - t0} ms`);
  if (file) {
    await new Promise((r) => setTimeout(r, 500));
    const pdf = readFileSync(join(DL, file)).toString('latin1');
    const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    // 3 ordinary pages (one of them was not loaded yet) + the 2400 px strip cut into 3 book pages
    // + the last page that appears only when scrolled to; the thumbnail of another episode is left out.
    const hist = await studio.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
      return new Promise((res) => { const g = db.transaction('history').objectStore('history').getAll(); g.onsuccess = () => res(g.result.filter((h) => h.status !== 'done').map((h) => `${h.title ?? ''} ${h.error ?? ''}`)); });
    });
    check('the whole chapter is in it (also the page that loads only on scroll), the strip is cut into pages, other episodes are not', pages === 7, `pages=${pages} ${JSON.stringify(hist)}`);
  }
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-chapter.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
