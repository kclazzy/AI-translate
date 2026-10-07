// Missing programs: Ollama is not running when the user starts a translation. The picture says
// what is missing with "Установить и запустить", the setup helper opens, waits for Ollama, downloads
// the model, checks it and continues the translation; the popup's ⇄ button names the languages.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e setup: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-setup');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const geometry = JSON.parse(readFileSync(new URL('./fixtures/geometry.json', import.meta.url)));
const TR = { 'たなかさん待って': 'Танака, подожди!', 'どこへ行くの': 'Куда ты идёшь?' };
const norm = (tb) => [Math.round((tb[0] / 800) * 1000), Math.round((tb[1] / 1100) * 1000), Math.round(((tb[0] + tb[2]) / 800) * 1000), Math.round(((tb[1] + tb[3]) / 1100) * 1000)];

const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Глава</title><img id="p1" src="/page.png" width="800" height="1100">');
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18101, '127.0.0.1', r));

// "Ollama", started later in the test.
const MODEL = 'qwen3.5:9b-q4_K_M';
let installed = false;
const pulls = [];
const ollama = createServer((req, res) => {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', async () => {
    const body = b ? JSON.parse(b) : {};
    if (req.url === '/api/tags') return json(200, { models: installed ? [{ name: MODEL, size: 6.6e9 }] : [] });
    if (req.url === '/api/ps') return json(200, { models: [] });
    if (req.url === '/api/show') return json(200, { capabilities: ['completion', 'vision'] });
    if (req.url === '/api/pull') {
      pulls.push(body.model);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (let i = 1; i <= 4; i++) {
        await new Promise((r) => setTimeout(r, 200));
        res.write(JSON.stringify({ status: 'pulling', total: 6.6e9, completed: (6.6e9 * i) / 4 }) + '\n');
      }
      installed = true;
      return res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    if (req.url === '/api/chat') {
      const text = body.messages?.at(-1)?.content ?? '';
      if (text.includes('Read the Japanese text in the speech bubble')) return json(200, { message: { content: JSON.stringify({ text: 'こんにちは', translation: 'Привет' }) } });
      // The translation step (text only, after reading the picture).
      const blocksIn = /<blocks>\s*([\s\S]*?)\s*<\/blocks>/.exec(text);
      if (blocksIn && !body.messages?.at(-1)?.images?.length) {
        const items = JSON.parse(blocksIn[1]);
        if (items[0]?.translation !== undefined) return json(200, { message: { content: JSON.stringify({ reviews: items.map((b) => ({ id: b.id, ok: true })) }) } });
        return json(200, { message: { content: JSON.stringify({ translations: items.map((b) => ({ id: b.id, text: TR[b.text] ?? b.text })), entities: [], summary: '' }) } });
      }
      const blocks = geometry.page.map((g) => ({ box: norm(g.textBox), text: g.text, translation: TR[g.text], type: 'DIALOGUE', vertical: true }));
      return json(200, { message: { content: JSON.stringify({ blocks, entities: [], summary: '' }) }, prompt_eval_count: 900, eval_count: 80 });
    }
    json(404, { error: 'not found' });
  });
});

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }, // the interface follows the browser language
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1100, height: 1300 },
});

async function overlayTexts(page) {
  const client = page.createCDPSession ? await page.createCDPSession() : await page.target().createCDPSession();
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3 && n.nodeValue?.trim()) out.push(n.nodeValue.trim());
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  await client.detach();
  return out;
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18101/');
  await page.waitForFunction(() => document.querySelector('#p1')?.complete);
  await new Promise((r) => setTimeout(r, 800));

  // Start a translation while Ollama is not running.
  const setupTab = browser.waitForTarget((t) => t.url().includes('setup=1'), { timeout: 15000 });
  await (await sw.worker()).evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18101/*' });
    await chrome.tabs.sendMessage(tab.id, { type: 'translate-src', src: 'http://127.0.0.1:18101/page.png' });
  });
  const helper = await (await setupTab).page();
  check('the setup helper opens by itself', !!helper && helper.url().includes('resume='));
  await new Promise((r) => setTimeout(r, 800));
  const texts = await overlayTexts(page);
  check('the picture says what is missing and offers to install', texts.some((t) => t.includes('не хватает программы')) && texts.some((t) => t.includes('Установить и запустить')), texts.filter((t) => /Ollama|программ|Установить/.test(t)).join(' | '));

  await helper.waitForFunction(() => document.body.innerText.includes('Скачать Ollama'), { timeout: 10000 });
  await helper.screenshot({ path: join(OUT, 'setup-1-missing.png') });
  check('helper offers to download Ollama and waits for it', (await helper.$eval('[data-testid="local-setup"]', (e) => e.innerText)).includes('Жду запуска Ollama'));

  // The user installs and starts Ollama: the helper notices without any click.
  await new Promise((r) => ollama.listen(11434, '127.0.0.1', r));
  await helper.waitForFunction(() => document.body.innerText.includes('Скачать qwen3.5'), { timeout: 10000 });
  check('helper notices Ollama and offers the model', true);
  await helper.evaluate(() => [...document.querySelectorAll('[data-testid="local-setup"] button')].find((b) => b.textContent.startsWith('Скачать qwen'))?.click());
  const resumed = await page.waitForFunction(async () => true, { timeout: 1000 }).then(() => true);
  void resumed;
  let entry = null;
  for (let i = 0; i < 60 && !entry; i++) {
    await new Promise((r) => setTimeout(r, 500));
    entry = await (await sw.worker()).evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('history').objectStore('history').getAll();
        g.onsuccess = () => res(g.result[0] ?? null);
      });
    });
  }
  let diag = '';
  if (entry?.status !== 'done') {
    const helperText = await helper.evaluate(() => document.querySelector('[data-testid="local-setup"]')?.innerText ?? '(helper closed)').catch(() => '(helper closed)');
    const log = await (await sw.worker()).evaluate(() => (globalThis.__aitLog ?? []).slice(-12).join(' | ')).catch(() => '');
    const overlay = (await overlayTexts(page)).filter((t) => t.length > 3).slice(-6).join(' | ');
    diag = ` helper: ${helperText.replace(/\s+/g, ' ').slice(0, 200)} | log: ${log.slice(0, 600)} | page: ${overlay.slice(0, 200)}`;
  }
  check('model downloaded, checked, and the translation continued on the page', pulls[0] === MODEL && entry?.status === 'done', `${JSON.stringify(pulls)} ${entry?.status ?? 'no translation'} ${entry?.error ?? ''}${diag}`);

  // The popup's ⇄ button names the page language and the translation language.
  const popup = await browser.newPage();
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await new Promise((r) => setTimeout(r, 1200));
  // A popup opened as a tab sees itself as the active tab; ask the content script directly instead.
  const langs = await (await sw.worker()).evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18101/*' });
    return chrome.tabs.sendMessage(tab.id, { type: 'get-langs' });
  });
  check('page language detected and target known', langs?.source === 'ja' && langs?.target === 'ru' && langs.translated === 1, JSON.stringify(langs));
  const btn = (await overlayTexts(page)).find((t) => t.startsWith('⇄'));
  check('the ⇄ button on the picture names the original language', btn === '⇄ 日本語', btn);
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  ollama.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-setup.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
