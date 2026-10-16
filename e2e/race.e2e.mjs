// A reader swaps the picture under the same element while its translation is in flight
// (page 15 → page 16): <img> src, CSS background, canvas redraw. The result for page 15 must not
// stay over page 16 — the old overlay goes and page 16 gets its own request.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e race: ${name}::${String(detail).slice(0, 500)}`);
};
const SCRATCH = join(tmpdir(), `ait-race-${process.pid}`);
const DIST = join(ROOT, 'apps/extension/dist');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const DELAY = Number(process.env.DELAY ?? 3000);
const ext = join(SCRATCH, 'ext');
const profile = join(SCRATCH, 'profile');
for (const d of [ext, profile]) if (existsSync(d)) rmSync(d, { recursive: true });
cpSync(DIST, ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const A = readFileSync(join(ROOT, 'e2e/fixtures/page.png'));
// Page 16: another picture (other pixels, other bytes).
const B = readFileSync(join(ROOT, 'e2e/fixtures/tall.png'));
const html = {
  '/img': `<!doctype html><title>img</title><body style="margin:0"><img id="p" src="/a.png" width="800" height="1100" style="display:block;margin:20px auto">`,
  '/bg': `<!doctype html><title>bg</title><body style="margin:0"><div id="p" style="width:800px;height:1100px;margin:20px auto;background:url(/a.png) no-repeat;background-size:800px 1100px"></div>`,
  '/canvas': `<!doctype html><title>canvas</title><body style="margin:0"><canvas id="p" width="800" height="1100" style="display:block;margin:20px auto"></canvas>
<script>const im=new Image();im.onload=()=>document.getElementById('p').getContext('2d').drawImage(im,0,0);im.src='/a.png';</script>`,
};
const hits = {};
const site = createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1;
  if (html[req.url]) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html[req.url]);
  if (req.url.startsWith('/a.png')) return res.writeHead(200, { 'content-type': 'image/png' }).end(A);
  if (req.url.startsWith('/b.png')) return res.writeHead(200, { 'content-type': 'image/png' }).end(B);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18081, '127.0.0.1', r));
const { calls } = await startMockLlm(18090);
// Slow model: every request waits DELAY ms.
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () =>
    setTimeout(() => {
      const r = request({ host: '127.0.0.1', port: 18090, path: req.url, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      r.end(Buffer.concat(chunks));
    }, req.method === 'POST' ? DELAY : 0),
  );
});
await new Promise((r) => proxy.listen(18080, '127.0.0.1', r));

// Chrome 137+ ignores --load-extension: CI loads the extension over CDP (see ci.yml).
const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  headless: false,
  userDataDir: profile,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--window-size=1280,1300', '--disable-gpu'],
  defaultViewport: { width: 1200, height: 1200 },
});
browser.on('targetcreated', async (t) => {
  if (!t.url().includes('view=welcome')) return;
  (await t.page().catch(() => null))?.close().catch(() => {});
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 20000 });
const extId = new URL(sw.url()).host;
const studio = await browser.newPage();
await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
await studio.waitForSelector('.ait-panel', { timeout: 20000 });
await studio.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('ai-translate', 1);
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
  s.pipeline = 'standalone';
  s.onboarded = true;
  s.qa = 'off';
  store.put(s, 'settings');
  await new Promise((res) => (tx.oncomplete = res));
});
await studio.reload();
await studio.waitForSelector('.ait-panel');

async function overlayState(p) {
  const c = await p.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  await c.detach();
  const nodes = [];
  const walk = (n) => {
    nodes.push(n);
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  const texts = nodes.filter((n) => n.nodeType === 3 && n.nodeValue?.trim()).map((n) => n.nodeValue.trim());
  const tiles = nodes.filter((n) => (n.localName === 'img' || n.localName === 'canvas') && n.attributes?.join(' ').includes('data:image')).length;
  const imgsInShadow = nodes.filter((n) => n.localName === 'img' && (n.attributes ?? []).some((a) => String(a).startsWith('blob:') || String(a).startsWith('data:'))).length;
  return { tiles, imgsInShadow, texts: texts.filter((t) => /очеред|перевод|ошибк|Текст|следующ|\d:\d\d/i.test(t)).slice(0, 6) };
}

const visionCalls = () => calls.filter((c) => Array.isArray(c.messages?.at(-1)?.content)).length;
const report = [];
for (const kind of (process.env.KINDS ?? 'img,bg,canvas').split(',')) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:18081/${kind}`);
  await new Promise((r) => setTimeout(r, 1200));
  const before = visionCalls();
  await studio.evaluate(() => { window.__g = 0; window.__gn = 0; let last = performance.now(); clearInterval(window.__t); window.__t = setInterval(() => { const n = performance.now(); const d = n - last; window.__g = Math.max(window.__g, d); if (d > 100) window.__gn++; last = n; }, 10); });
  await studio.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:18081/*', active: true });
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:18081/*' });
    const t = tabs.at(-1);
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await page.bringToFront();
  // Wait until the model got the request for page «15».
  const t0 = Date.now();
  while (visionCalls() === before && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
  const started = visionCalls() > before;
  // Reader flips to page «16» in the same element.
  await page.evaluate((kind) => {
    const el = document.getElementById('p');
    if (kind === 'img') el.src = '/b.png';
    else if (kind === 'bg') el.style.backgroundImage = 'url(/b.png)';
    else {
      const im = new Image();
      im.onload = () => {
        const x = el.getContext('2d');
        x.fillStyle = '#fff';
        x.fillRect(0, 0, 800, 1100);
        // The top of the tall page at its own scale (squeezed, its lettering would be too small to find).
        x.drawImage(im, 0, 0, 800, 1100, 0, 0, 800, 1100);
      };
      im.src = '/b.png?16';
    }
  }, kind);
  const afterSwap = visionCalls();
  await new Promise((r) => setTimeout(r, DELAY * 2 + 6000));
  const st = await overlayState(page);
  await page.screenshot({ path: join(OUT, `race-${kind}.png`) });
  check(`${kind}: page 15 was sent to the model`, started);
  // Its own job: a model call, or the local check of the new picture saying it has no text.
  const ownJob = visionCalls() > afterSwap || st.texts.some((t) => /Текста не найдено|без текста/.test(t));
  check(`${kind}: page 16 got its own request after the swap`, ownJob, `vision calls ${afterSwap - before} → ${visionCalls() - before}, overlay ${JSON.stringify(st)}`);
  await page.close();
}
await browser.close();
site.close();
proxy.close();
rmSync(SCRATCH, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
