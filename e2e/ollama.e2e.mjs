// Fresh install with no model: the popup offers the download, the settings tab downloads it
// through Ollama's API with progress and selects it. A fake Ollama runs on port 11434.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e ollama: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-ollama');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

let installed = false;
const pulls = [];
const origins = [];
// Same rule as real Ollama: no Origin, or a localhost/127.0.0.1/0.0.0.0 origin, unless OLLAMA_ORIGINS says otherwise.
const allowedOrigin = (o) => !o || /^(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?|app:\/\/|file:\/\/|tauri:\/\/|vscode-webview:\/\/)/.test(o);
const ollama = createServer((req, res) => {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  origins.push(`${req.method} ${req.url} ${req.headers.origin ?? '-'}`);
  if (!allowedOrigin(req.headers.origin)) return res.writeHead(403).end();
  if (req.url === '/api/tags') return json(200, { models: installed ? [{ name: 'qwen2.5vl:7b', size: 6e9 }] : [{ name: 'llama3.2:3b' }] });
  if (req.url === '/api/pull' && req.method === 'POST') {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      pulls.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      const total = 6_000_000_000;
      for (let i = 1; i <= 8; i++) {
        await new Promise((r) => setTimeout(r, 250));
        res.write(JSON.stringify({ status: 'pulling a1b2c3', total, completed: Math.round((total * i) / 8) }) + '\n');
      }
      installed = true;
      res.end(JSON.stringify({ status: 'success' }) + '\n');
    });
    return;
  }
  json(404, { error: 'not found' });
});
await new Promise((r) => ollama.listen(11434, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1100, height: 1000 },
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.body.innerText.includes('не установлена'), { timeout: 15000 }).catch(() => {});
  const ptxt = await popup.$eval('body', (b) => b.innerText);
  check('popup reports the missing model and offers the download', ptxt.includes('qwen2.5vl:7b не установлена') && ptxt.includes('Скачать qwen2.5vl:7b'));
  await popup.setViewport({ width: 360, height: 820 });
  await popup.screenshot({ path: join(OUT, 'ollama-popup.png') });

  const tabPromise = browser.waitForTarget((t) => t.url().includes('studio.html?view=settings&pull=1'), { timeout: 10000 });
  await popup.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Скачать qwen'))?.click());
  const tab = await (await tabPromise).page();
  check('download opens the settings tab', !!tab);
  await tab.waitForFunction(() => document.body.innerText.includes('ГБ из'), { timeout: 15000 });
  await tab.screenshot({ path: join(OUT, 'ollama-progress.png') });
  check('progress is shown while downloading', true);
  await tab.waitForFunction(() => document.body.innerText.includes('установлена и выбрана'), { timeout: 20000 });
  check('POST requests reach Ollama without OLLAMA_ORIGINS', !origins.some((o) => o.includes('chrome-extension')), origins.filter((o) => o.startsWith('POST')).join(' | '));
  check('model selected after download', pulls.length === 1 && pulls[0].model === 'qwen2.5vl:7b', JSON.stringify(pulls));
  const saved = await tab.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => {
        const s = g.result;
        const p = s.providers.find((x) => x.id === s.visionProviderId);
        res({ model: p?.model, vision: p?.vision, base: p?.baseUrl });
      };
    });
  });
  check('settings saved: reads images with qwen2.5vl:7b via Ollama', saved.model === 'qwen2.5vl:7b' && saved.vision === true && saved.base.includes('11434'), JSON.stringify(saved));
  const popup2 = await browser.newPage();
  await popup2.goto(`chrome-extension://${extId}/popup.html`);
  await new Promise((r) => setTimeout(r, 1500));
  check('popup is quiet once the model is installed', !(await popup2.$eval('body', (b) => b.innerText)).includes('не установлена'));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  ollama.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-ollama.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
