// Fresh install with no model: the popup offers the download, the settings tab downloads the
// model for the video card through Ollama's API with progress, selects it and proves it works
// with the self-test; then a model is deleted and a models folder is chosen.
// A fake Ollama runs on port 11434.
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

const MODEL = 'qwen3.5:9b-q4_K_M'; // headless Chrome has no known GPU → the 12 GB default tier
let installed = false;
let textModel = true;
const pulls = [];
const chats = [];
const deletes = [];
const loadedModels = new Set();
let spill = false; // the loaded model does not fit the video memory (part of it in RAM)
const unloads = [];
const origins = [];
// Same rule as real Ollama: no Origin, or a localhost/127.0.0.1/0.0.0.0 origin, unless OLLAMA_ORIGINS says otherwise.
const allowedOrigin = (o) => !o || /^(https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?|app:\/\/|file:\/\/|tauri:\/\/|vscode-webview:\/\/)/.test(o);
const ollama = createServer((req, res) => {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  origins.push(`${req.method} ${req.url} ${req.headers.origin ?? '-'}`);
  if (!allowedOrigin(req.headers.origin)) return res.writeHead(403).end();
  const read = (fn) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => fn(b ? JSON.parse(b) : {}));
  };
  if (req.url === '/api/tags') return json(200, { models: [...(installed ? [{ name: MODEL, size: 6.6e9 }] : []), ...(textModel ? [{ name: 'llama3.2:3b', size: 2e9 }] : [])] });
  if (req.url === '/api/show') return read((b) => json(200, { capabilities: b.model === MODEL ? ['completion', 'vision'] : ['completion'] }));
  if (req.url === '/api/delete' && req.method === 'DELETE') return read((b) => { deletes.push(b.model); if (b.model === 'llama3.2:3b') textModel = false; json(200, {}); });
  if (req.url === '/api/ps') return json(200, { models: [...loadedModels].map((name) => ({ name, size_vram: 6.6e9, size: spill ? 9.4e9 : 6.6e9 })) });
  if (req.url === '/api/generate' && req.method === 'POST') return read((b) => { if (b.keep_alive === 0) { unloads.push(b.model); loadedModels.delete(b.model); } json(200, { done: true }); });
  if (req.url === '/api/chat' && req.method === 'POST') {
    return read((b) => {
      if (b.keep_alive !== 0) loadedModels.add(b.model);
      chats.push({ model: b.model, think: b.think, images: b.messages?.at(-1)?.images?.length ?? 0, num_ctx: b.options?.num_ctx });
      setTimeout(() => json(200, { model: b.model, message: { role: 'assistant', content: JSON.stringify({ text: 'こんにちは', translation: 'Привет' }) }, prompt_eval_count: 900, eval_count: 20 }), 400);
    });
  }
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
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }, // the interface follows the browser language
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1100, height: 1000 },
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
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.body.innerText.includes('модель не скачана'), { timeout: 15000 }).catch(() => {});
  const ptxt = await popup.$eval('body', (b) => b.innerText);
  check('popup shows the model is not downloaded and offers the download', ptxt.includes(MODEL) && ptxt.includes('модель не скачана') && ptxt.includes('Скачать'), ptxt.slice(0, 300));
  await popup.setViewport({ width: 360, height: 820 });
  await popup.screenshot({ path: join(OUT, 'ollama-popup.png') });

  const tabPromise = browser.waitForTarget((t) => t.url().includes('studio.html?view=settings&pull=1'), { timeout: 10000 });
  await popup.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Скачать')?.click());
  const tab = await (await tabPromise).page();
  tab.on('dialog', (d) => void d.accept());
  check('download opens the settings tab', !!tab);
  await tab.waitForFunction(() => document.body.innerText.includes('ГБ из'), { timeout: 15000 });
  const tiers = await tab.$$eval('[data-testid^="tier-"]', (els) => els.map((e) => e.getAttribute('data-testid')));
  check('model choice for every video memory size is listed', tiers.length === 6 && tiers.includes('tier-qwen3.5:0.8b') && tiers.includes('tier-qwen3.5:9b-q8_0'), tiers.join(','));
  await tab.screenshot({ path: join(OUT, 'ollama-progress.png') });
  check('progress is shown while downloading', true);
  await tab.waitForFunction(() => document.body.innerText.includes('Модель работает'), { timeout: 30000 });
  check('after download the model is tested and shown as working', (await tab.$eval('body', (b) => b.innerText)).includes('Прочитала: «こんにちは» → «Привет»'));
  check('self-test uses the native API with thinking off and the picture attached', chats.length >= 1 && chats[0].model === MODEL && chats[0].think === false && chats[0].images === 1 && chats[0].num_ctx >= 8192, JSON.stringify(chats));
  check('POST requests reach Ollama without OLLAMA_ORIGINS', !origins.some((o) => o.includes('chrome-extension')), origins.filter((o) => !o.startsWith('GET')).join(' | '));
  check('model selected after download', pulls.length === 1 && pulls[0].model === MODEL, JSON.stringify(pulls));
  await tab.screenshot({ path: join(OUT, 'ollama-models.png'), fullPage: true });

  // Delete the text-only model.
  await tab.evaluate(() => [...document.querySelectorAll('[data-testid="installed-llama3.2:3b"] button')].find((b) => b.textContent === 'Удалить')?.click());
  await tab.waitForFunction(() => !document.querySelector('[data-testid="installed-llama3.2:3b"]'), { timeout: 10000 }).catch(() => {});
  check('a local model can be deleted', deletes.length === 1 && deletes[0] === 'llama3.2:3b' && !(await tab.$('[data-testid="installed-llama3.2:3b"]')), JSON.stringify(deletes));

  // Choose where models are stored.
  await tab.evaluate(() => {
    const d = document.querySelector('[data-testid="models-folder"]');
    d.open = true;
  });
  const input = await tab.$('[aria-label="Папка для моделей"]');
  await input.type('D:\\AI\\ollama-models');
  await tab.evaluate(() => [...document.querySelectorAll('[data-testid="models-folder"] button')].find((b) => b.textContent === 'Сохранить')?.click());
  await new Promise((r) => setTimeout(r, 600));
  const folderText = await tab.$eval('[data-testid="models-folder"]', (e) => e.innerText);
  check('models folder can be chosen and the exact command is shown', folderText.includes('setx OLLAMA_MODELS "D:\\AI\\ollama-models"'), folderText.slice(0, 300));

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
        res({ model: p?.model, vision: p?.vision, base: p?.baseUrl, dir: s.ollamaModelsDir, checks: Object.keys(s.modelChecks ?? {}) });
      };
    });
  });
  check('settings saved: model, folder and check result', saved.model === MODEL && saved.vision === true && saved.base.includes('11434') && saved.dir === 'D:\\AI\\ollama-models' && saved.checks.length === 1, JSON.stringify(saved));
  const popup2 = await browser.newPage();
  await popup2.goto(`chrome-extension://${extId}/popup.html`);
  await popup2.waitForFunction(() => document.body.innerText.includes('Работает'), { timeout: 8000 }).catch(() => {});
  const p2 = await popup2.$eval('body', (b) => b.innerText);
  check('popup shows the model works', p2.includes('Работает') && !p2.includes('не скачана'), p2.slice(0, 200));
  await popup2.setViewport({ width: 360, height: 820 });
  await popup2.waitForFunction(() => document.body.innerText.includes('Видеопамять: занято'), { timeout: 5000 }).catch(() => {});
  check('popup shows the model held in video memory', (await popup2.$eval('body', (b) => b.innerText)).includes(`Видеопамять: занято 6.6 ГБ (${MODEL})`));
  await popup2.screenshot({ path: join(OUT, 'ollama-popup-ok.png') });
  check('no video-memory warning while the model fits', !(await popup2.$('[data-testid="vram-spill"]')));

  // The model no longer fits the video card (part of it in system RAM): the popup says so.
  spill = true;
  await popup2.reload();
  await popup2.waitForSelector('[data-testid="vram-spill"]', { timeout: 8000 }).catch(() => {});
  const spillText = await popup2.$eval('[data-testid="vram-spill"]', (e) => e.innerText).catch(() => '');
  check('warns when the model spills out of video memory', spillText.includes('не помещается в видеопамять') && spillText.includes('70%'), spillText);
  await popup2.screenshot({ path: join(OUT, 'ollama-popup-spill.png') });
  spill = false;

  // Switch the extension off: work stops and the video memory is freed.
  await popup2.click('[data-testid="power"] input');
  await popup2.waitForFunction(() => document.body.innerText.includes('Выгружено из памяти'), { timeout: 8000 }).catch(() => {});
  const offText = await popup2.$eval('body', (b) => b.innerText);
  await popup2.screenshot({ path: join(OUT, 'ollama-popup-off.png') });
  check('switching off frees the video memory', unloads.includes(MODEL) && loadedModels.size === 0 && offText.includes('Выгружено из памяти'), `${JSON.stringify(unloads)} ${offText.slice(0, 200)}`);
  if (process.env.DEBUG) console.log((await (await sw.worker()).evaluate(() => globalThis.__aitLog.slice(-15).join('\n'))));
  const badge = await (await sw.worker()).evaluate(() => chrome.action.getBadgeText({}));
  check('the toolbar icon says OFF', badge === 'OFF', badge);
  const before = chats.length;
  const r = await (await sw.worker()).evaluate(async () => {
    const s = await new Promise((res) => {
      const q = indexedDB.open('ai-translate', 1);
      q.onsuccess = () => {
        const g = q.result.transaction('kv').objectStore('kv').get('settings');
        g.onsuccess = () => res(g.result);
      };
    });
    return s.enabled;
  });
  check('off state is saved', r === false && chats.length === before, String(r));
  await popup2.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Включить')?.click());
  await popup2.waitForFunction(() => document.body.innerText.includes('Перевести страницу'), { timeout: 8000 }).catch(() => {});
  check('switching back on restores the popup', (await popup2.$eval('body', (b) => b.innerText)).includes('Перевести страницу') && (await (await sw.worker()).evaluate(() => chrome.action.getBadgeText({}))) === '');
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
