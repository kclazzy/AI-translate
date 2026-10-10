// Screenshots for the user guide «первый запуск»: a fresh install with a fake Ollama (no model yet),
// the model download, the popup, and a translated page. Not a test; run by hand:
//   CHROME_PATH=… xvfb-run -a node e2e/guide-shots.mjs <out dir>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.argv[2] ?? join(ROOT, '.test-output/guide');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });
const shot = (name) => join(OUT, `${name}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = join(tmpdir(), 'AI-Translate', 'extension-chrome');
if (existsSync(ext)) rmSync(ext, { recursive: true });
mkdirSync(join(ext, '..'), { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const { server: llm } = await startMockLlm(18090);
const MODEL = 'qwen3.5:9b-q4_K_M';
let installed = false;
const ollama = createServer((req, res) => {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const read = (fn) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => fn(b));
  };
  if (req.url === '/api/tags') return json(200, { models: installed ? [{ name: MODEL, size: 6.6e9 }] : [] });
  if (req.url === '/api/show') return read(() => json(200, { capabilities: ['completion', 'vision'] }));
  if (req.url === '/api/ps') return json(200, { models: installed ? [{ name: MODEL, size_vram: 6.6e9, size: 6.6e9 }] : [] });
  if (req.url === '/api/version') return json(200, { version: '0.12.0' });
  if (req.url === '/api/generate') return read(() => json(200, { done: true }));
  if (req.url === '/api/chat') {
    return read((b) => {
      const body = JSON.parse(b || '{}');
      const text = JSON.stringify(body.messages ?? []);
      // The model self-test reads a tiny picture; page translation goes to the mock that knows the fixture.
      if (!/manga|comic/i.test(text)) return setTimeout(() => json(200, { model: MODEL, message: { role: 'assistant', content: JSON.stringify({ text: 'こんにちは', translation: 'Привет' }) }, prompt_eval_count: 900, eval_count: 20 }), 300);
      const fwd = request({ host: '127.0.0.1', port: 18090, path: '/api/chat', method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      fwd.end(b);
    });
  }
  if (req.url === '/api/pull') {
    return read(async () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const total = 6_600_000_000;
      for (let i = 1; i <= 10; i++) {
        await sleep(300);
        res.write(JSON.stringify({ status: 'pulling', total, completed: Math.round((total * i) / 10) }) + '\n');
      }
      installed = true;
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    });
  }
  json(404, { error: 'not found' });
});
await new Promise((r) => ollama.listen(11434, '127.0.0.1', r));

const png = readFileSync(new URL('./fixtures/page.png', import.meta.url));
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Глава 1 — читалка</title><style>body{margin:0;background:#222;font-family:sans-serif}header{color:#ddd;padding:12px 20px;font-size:18px}img{display:block;margin:0 auto 12px;width:520px}</style><header>Моя манга · Глава 1</header><img src="/p1.png" width="520" height="715">`);
  if (req.url === '/p1.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18095, '127.0.0.1', r));

const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1200, height: 860 },
});

/** Screenshot of one element (plus a margin), so the picture shows what the text talks about. */
async function clip(page, selectorFn, name, pad = 12) {
  const box = await page.evaluate(selectorFn);
  if (!box) throw new Error(`no element for ${name}`);
  await page.screenshot({ path: shot(name), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2 } });
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;

  // 1. chrome://extensions with developer mode on.
  const ex = await browser.newPage();
  await ex.goto('chrome://extensions');
  await sleep(1200);
  await ex.evaluate(() => {
    const t = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode');
    if (!t.checked) t.click();
  });
  await sleep(2500);
  await ex.mouse.click(700, 600);
  await sleep(800);
  await ex.screenshot({ path: shot('01-extensions') });

  // 2. Welcome tab (it opens by itself after installing).
  const welcomeTarget = (await browser.targets()).find((t) => t.url().includes('view=welcome'));
  const welcome = welcomeTarget ? await welcomeTarget.page() : await browser.newPage();
  if (!welcomeTarget) await welcome.goto(`chrome-extension://${extId}/studio.html?view=welcome`);
  await welcome.bringToFront();
  await welcome.setViewport({ width: 1200, height: 900 });
  await sleep(1500);
  await welcome.screenshot({ path: shot('02-welcome') });

  // 3. Popup on a fresh install: Ollama is running but the model is not downloaded.
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 1200 });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.body.innerText.includes('Скачать'), { timeout: 15000 }).catch(() => {});
  await sleep(500);
  await popup.screenshot({ path: shot('03-popup-download'), clip: { x: 0, y: 0, width: 400, height: 560 } });

  // 4. Settings: model list for the video card, download progress, then «Модель работает».
  const tabPromise = browser.waitForTarget((t) => t.url().includes('studio.html?view=settings'), { timeout: 10000 });
  await popup.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Скачать')?.click());
  const tab = await (await tabPromise).page();
  tab.on('dialog', (d) => void d.accept());
  await tab.setViewport({ width: 1200, height: 1000 });
  await tab.waitForFunction(() => document.body.innerText.includes('ГБ из'), { timeout: 15000 });
  await sleep(600);
  const pickerBox = () => {
    const tier = document.querySelector('[data-testid^="tier-"]');
    let el = tier;
    while (el && el.parentElement && el.getBoundingClientRect().height < 380) el = el.parentElement;
    const r = (el ?? tier).getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, w: r.width, h: Math.min(r.height, 900) };
  };
  await tab.evaluate(() => document.querySelector('[data-testid^="tier-"]')?.scrollIntoView({ block: 'center' }));
  await clip(tab, pickerBox, '04-download-progress');
  await tab.waitForFunction(() => document.body.innerText.includes('Модель работает'), { timeout: 40000 });
  await tab.evaluate(() => scrollTo(0, 0));
  await sleep(500);
  await clip(tab, () => {
    const el = [...document.querySelectorAll('section, .ait-card, div')].filter((d) => d.innerText?.startsWith('Модель для чтения картинок')).sort((a, b) => a.getBoundingClientRect().height - b.getBoundingClientRect().height).find((d) => d.getBoundingClientRect().height > 60);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, w: r.width, h: r.height };
  }, '05-model-works');

  // 5. Cloud variant: the cloud providers block opened.
  await tab.evaluate(() => {
    const d = [...document.querySelectorAll('details')].find((x) => x.innerText.startsWith('Облачные модели'));
    if (d) d.open = true;
    scrollTo(0, 0);
  });
  await sleep(600);
  await clip(tab, () => {
    const d = [...document.querySelectorAll('details')].find((x) => x.innerText.startsWith('Облачные модели'));
    const r = d.getBoundingClientRect(); // page scrolled to the top: viewport = document coordinates
    return { x: r.x, y: r.y + scrollY, w: r.width, h: Math.min(r.height, 700) };
  }, '06-cloud');

  // 6. The popup when everything is ready, and the translated page.
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 860 });
  await page.goto('http://127.0.0.1:18095/');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await sleep(800);
  await page.screenshot({ path: shot('08-before') });
  await popup.bringToFront();
  await popup.reload();
  await sleep(1500);
  await popup.screenshot({ path: shot('07-popup-ready'), clip: { x: 0, y: 0, width: 400, height: 640 } });
  await popup.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18095/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await page.bringToFront();
  await sleep(2500);
  await page.screenshot({ path: shot('09-progress') });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const done = await page.evaluate(() => {
      const walk = (n) => (n.shadowRoot ? [n.shadowRoot, ...n.shadowRoot.querySelectorAll('*')] : []).concat([...(n.children ?? [])].flatMap(walk));
      return document.documentElement.innerHTML.length > 0 && walk(document.body).some((x) => (x.textContent ?? '').includes('Готово'));
    }).catch(() => false);
    if (done) break;
  }
  await sleep(1500);
  // Hover the picture so the buttons ⇄ ✎ ⟳ ⓘ show.
  const img = await page.$('img');
  const b = await img.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 200);
  await sleep(800);
  await page.screenshot({ path: shot('10-after') });
  console.log('shots in', OUT);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  ollama.close();
  site.close();
  llm.close();
}
