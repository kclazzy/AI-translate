// A long chapter: a translated picture far from the screen lets its tiles go (memory the video card
// shares with the model) and gets them back from the extension's store when the reader returns.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e far: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-far');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const PAGE = readFileSync(new URL('./fixtures/page.png', import.meta.url));
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Chapter 1</title><style>body{margin:0}img{display:block;width:800px}</style><img id="a" src="/a.png"><div style="height:12000px"></div>`);
  if (req.url.startsWith('/a.png')) return res.writeHead(200, { 'content-type': 'image/png' }).end(PAGE);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18161, '127.0.0.1', r));

const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method === 'GET') return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-vl' }] }));
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = JSON.parse(body || '{}');
    const last = json.messages?.at(-1);
    const parts = Array.isArray(last?.content) ? last.content : null;
    let answer;
    if (parts) {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
      const m = /The image is (\d+)×(\d+)/.exec(text);
      const h = Number(m?.[2] ?? 1100);
      answer = Number(m?.[1]) === 800 ? { blocks: [{ box: [380, Math.round((195 / h) * 1000), 620, Math.round((323 / h) * 1000)], text: 'たなかさん', translation: 'ТАНАКА', type: 'DIALOGUE' }], entities: [], summary: '' } : { blocks: [], entities: [], summary: '' };
    } else {
      const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(last?.content ?? '')?.[1] ?? '[]');
      answer = { translations: blocks.map((b) => ({ id: b.id, text: `RU ${b.text}` })), entities: [], summary: '' };
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'mock-vl' }));
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
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

/** Blob pictures inside the overlays of the page. */
async function overlayImages(p) {
  const c = await p.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  await c.detach();
  let n = 0;
  const walk = (x) => {
    if (x.localName === 'img' && (x.attributes ?? []).some((a) => String(a).startsWith('blob:'))) n++;
    (x.children ?? []).forEach(walk);
    (x.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  return n;
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
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
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18160/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.twoStepTranslation = false;
    s.skipEmptyPages = false;
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });
  await studio.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' })).catch(() => undefined);

  const tab = await browser.newPage();
  await tab.goto('http://127.0.0.1:18161/');
  await tab.waitForFunction(() => document.images[0].complete && document.images[0].naturalWidth);
  await new Promise((r) => setTimeout(r, 800));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18161/' });
    await chrome.tabs.sendMessage(t.id, { type: 'translate-src', src: 'http://127.0.0.1:18161/a.png' });
  });
  await tab.bringToFront();
  let shown = 0;
  for (let i = 0; i < 80 && !shown; i++) {
    await new Promise((r) => setTimeout(r, 500));
    shown = await overlayImages(tab);
  }
  check('the translation is shown', shown > 0, `images=${shown}`);
  await tab.evaluate(() => window.scrollTo(0, 9000));
  let gone = shown;
  for (let i = 0; i < 20 && gone; i++) {
    await new Promise((r) => setTimeout(r, 300));
    gone = await overlayImages(tab);
  }
  check('far from the screen its pictures are let go', gone === 0, `images=${gone}`);
  await tab.evaluate(() => window.scrollTo(0, 0));
  let back = 0;
  for (let i = 0; i < 30 && !back; i++) {
    await new Promise((r) => setTimeout(r, 300));
    back = await overlayImages(tab);
  }
  check('back on screen they are read again from the store', back === shown, `images=${back} (was ${shown})`);
  await tab.screenshot({ path: join(OUT, 'far-back.png') });
} catch (e) {
  check('no crash', false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  site.close();
  llm.close();
}
writeFileSync(join(OUT, 'e2e-far.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
