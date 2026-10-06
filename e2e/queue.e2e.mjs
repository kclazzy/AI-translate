// Queue visibility: with a slow local model and several pictures, the overlays must show the
// queue position and a running timer instead of a silent "В очереди"; when the worker forgets a
// job (offscreen document closed, extension restarted) the overlay must say so, not hang.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e queue: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-queue');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// Three different pictures (different bytes → no cache hits).
const png = readFileSync(new URL('./fixtures/page.png', import.meta.url));
const variant = (n) => Buffer.concat([png, Buffer.from(`\n${n}`)]);
const html = `<!doctype html><meta charset="utf-8"><title>Q</title><style>img{display:block;width:400px;margin:10px}</style>
<img src="/p1.png" width="400" height="550"><img src="/p2.png" width="400" height="550"><img id="lazy" src="/blank.png" data-url="/p3.png" width="400" height="550">`;
// 1×1 transparent PNG: the placeholder a lazy reader shows until you scroll (like Webtoons).
const BLANK = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  if (req.url === '/blank.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(BLANK);
  const m = req.url.match(/^\/p(\d)\.png$/);
  if (m) return res.writeHead(200, { 'content-type': 'image/png' }).end(variant(m[1]));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18091, '127.0.0.1', r));
const { server: llm } = await startMockLlm(18090);
// A slow "local model": forwards to the mock after a delay.
const DELAY = 6000;
const slow = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () =>
    setTimeout(() => {
      const fwd = request({ host: '127.0.0.1', port: 18090, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, { ...r.headers, 'access-control-allow-origin': '*' });
        r.pipe(res);
      });
      fwd.end(Buffer.concat(chunks));
    }, req.method === 'POST' ? DELAY : 0),
  );
});
await new Promise((r) => slow.listen(18092, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1800 },
});

/** Text inside the overlays (closed shadow roots are reachable through CDP with pierce). */
async function overlayTexts(page) {
  const client = page.createCDPSession ? await page.createCDPSession() : await page.target().createCDPSession();
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const walk = (n) => {
    if (n.nodeName === 'SPAN' && /pill/.test((n.attributes ?? []).join(' '))) {
      const t = [];
      const collect = (x) => {
        if (x.nodeType === 3) t.push(x.nodeValue);
        (x.children ?? []).forEach(collect);
      };
      collect(n);
      out.push(t.join(' '));
    }
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
  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
  await studio.waitForSelector('.ait-panel, .ait-topbar', { timeout: 15000 }).catch(() => {});
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
    s.providers = [{ id: 'slow', label: 'Slow local', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18092/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'slow';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.concurrency = 3; // a local model must still run one page at a time
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18091/');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await new Promise((r) => setTimeout(r, 800));
  await studio.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18091/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: tab.id });
  });
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 4500));
  const t1 = await overlayTexts(page);
  await page.screenshot({ path: join(OUT, 'queue-waiting.png') });
  check('the lazy picture (not loaded yet) is translated too', t1.length === 3, `overlays=${t1.length}`);
  check('waiting pictures show how many are ahead', t1.some((t) => /перед ней \d|следующая/.test(t)), JSON.stringify(t1));
  check('the running picture shows a timer', t1.some((t) => /\d:\d\d/.test(t)), JSON.stringify(t1));
  check('a local model runs one picture at a time', t1.filter((t) => /\d:\d\d/.test(t)).length === 1, JSON.stringify(t1));

  // Simulate the worker losing its jobs (offscreen document closed by the browser).
  await (await sw.worker()).evaluate(() => chrome.offscreen.closeDocument());
  await page.waitForFunction(() => true);
  let t2 = [];
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    t2 = await overlayTexts(page);
    if (t2.length && t2.every((t) => t.includes('Задача потерялась') || !/В очереди|Ищу|Распознаю|Открываю|Работаю/.test(t))) break;
  }
  await page.screenshot({ path: join(OUT, 'queue-lost.png') });
  check('lost jobs are reported instead of hanging in the queue', t2.some((t) => t.includes('Задача потерялась')) && !t2.some((t) => /В очереди/.test(t)), JSON.stringify(t2));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  slow.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-queue.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
