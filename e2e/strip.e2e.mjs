// A site that cuts one page into two pictures right through a speech bubble: the extension glues
// neighbouring pictures, the model sees the whole bubble once, and each picture gets its half of
// the translation. The chapter download still has one image per picture.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const DL = join(tmpdir(), 'ait-strip-downloads');
mkdirSync(OUT, { recursive: true });
if (existsSync(DL)) rmSync(DL, { recursive: true });
mkdirSync(DL, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e strip: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-strip');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const CUT = 260; // through the first bubble (its text runs from y=197 to y=323)
const parts = {};
const site = createServer((req, res) => {
  if (req.url === '/')
    return res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><meta charset="utf-8"><title>Лента</title><style>body{margin:0}img{display:block;width:800px}</style><div><img src="/a.png"><img src="/b.png"></div>`);
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  const p = parts[req.url];
  if (p) return res.writeHead(200, { 'content-type': 'image/png' }).end(p);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18141, '127.0.0.1', r));
const { server: llm, calls } = await startMockLlm(18140);

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1200 },
});

/** Cut and compare pictures with the browser's own canvas. */
async function withCanvas(page, fn, ...args) {
  return page.evaluate(fn, ...args);
}

const offLog = [];
const watchOff = async (t) => {
  if (t.type() !== 'background_page') return;
  const s = await t.createCDPSession();
  await s.send('Runtime.enable');
  s.on('Runtime.consoleAPICalled', (e) => offLog.push(e.type + ': ' + e.args.map((a) => a.value ?? a.description).join(' ')));
  s.on('Runtime.exceptionThrown', (e) => offLog.push('EXC ' + JSON.stringify(e.exceptionDetails).slice(0, 800)));
};
browser.on('targetcreated', watchOff);
for (const t of browser.targets()) await watchOff(t);
try {
  // Cut the fixture page into two pictures in the browser.
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18141/page.png');
  const [a, b] = await withCanvas(
    helper,
    async (cut) => {
      const img = await createImageBitmap(await (await fetch('/page.png')).blob());
      const piece = (y, h) => {
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = h;
        c.getContext('2d').drawImage(img, 0, -y);
        return c.toDataURL('image/png').split(',')[1];
      };
      return [piece(0, cut), piece(cut, img.height - cut)];
    },
    CUT,
  );
  parts['/a.png'] = Buffer.from(a, 'base64');
  parts['/b.png'] = Buffer.from(b, 'base64');

  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const client = await browser.target().createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  const names = [];
  client.on('Browser.downloadWillBegin', (e) => names.push(e.suggestedFilename));
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
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18140/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.autoSave = true;
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });
  await studio.evaluate(() => chrome.runtime.sendMessage({ type: 'settings-changed' })).catch(() => undefined);

  const tab = await browser.newPage();
  const pageLog = [];
  tab.on('pageerror', (e) => pageLog.push(String(e)));
  tab.on('console', (m) => pageLog.push(m.type() + ':' + m.text()));
  await tab.goto('http://127.0.0.1:18141/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 800));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18141/' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'download-chapter', format: 'zip', tabId: t.id });
  });
  await tab.bringToFront();
  let file = null;
  for (let i = 0; i < 120 && !file; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (process.env.DEBUG && i % 4 === 0) {
      const c3 = await tab.target().createCDPSession();
      const { root } = await c3.send('DOM.getDocument', { depth: -1, pierce: true });
      const tx = [];
      const walk = (n) => { if (n.nodeType === 3 && /Глава|Скачано|Собираю|Не удалось|Ни одна/.test(n.nodeValue ?? '')) tx.push(n.nodeValue.trim()); (n.children ?? []).forEach(walk); (n.shadowRoots ?? []).forEach(walk); };
      walk(root);
      await c3.detach();
      console.log('panel', i, tx.join(' | '));
    }
    if (process.env.DEBUG && [2, 6, 12, 30].includes(i)) await tab.screenshot({ path: join(OUT, `strip-${i}.png`) });
    file = readdirSync(DL).find((f) => !f.endsWith('.crdownload') && readFileSync(join(DL, f)).subarray(0, 2).toString() === 'PK');
  }
  await tab.screenshot({ path: join(OUT, 'strip-done.png') });
  if (!file || process.env.DEBUG) {
    const c2 = await tab.target().createCDPSession();
    const { root } = await c2.send('DOM.getDocument', { depth: -1, pierce: true });
    const texts = [];
    const walk = (n) => { if (n.nodeType === 3 && n.nodeValue?.trim()) texts.push(n.nodeValue.trim()); (n.children ?? []).forEach(walk); (n.shadowRoots ?? []).forEach(walk); };
    walk(root);
    console.log('UI: ' + texts.join(' | ') + ' FILES: ' + readdirSync(DL).join(','));
    const swNow = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 5000 }).catch(() => null);
    const log = swNow ? await (await swNow.worker()).evaluate(() => (globalThis.__aitLog ?? []).slice(-30).join('\n')).catch((e) => String(e)) : 'no sw';
    console.log('LOG:\n' + log);
    console.log('PAGE: ' + pageLog.slice(-20).join('\n'));
    const hist = await studio.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
      const all = (s) => new Promise((res) => { const g = db.transaction(s).objectStore(s).getAllKeys(); g.onsuccess = () => res(g.result); });
      return { history: await new Promise((res) => { const g = db.transaction('history').objectStore('history').getAll(); g.onsuccess = () => res(g.result.map((h) => `${h.status} ${h.error ?? ''}`)); }), results: await all('results') };
    });
    console.log('DB: ' + JSON.stringify(hist));
    console.log('OFF: ' + offLog.slice(-20).join('\n'));
  }
  const imageCalls = calls.filter((c) => JSON.stringify(c.messages ?? []).includes('image_url'));
  const sizes = imageCalls.map((c) => /The image is (\d+×\d+)/.exec(JSON.stringify(c.messages))?.[1]);
  check('the two pictures go to the model once, glued into the whole page', imageCalls.length === 1 && sizes[0] === '800×1100', `calls=${imageCalls.length} sizes=${sizes.join(',')}`);
  check('the chapter file is downloaded', !!file, file ?? 'none');
  if (process.env.DEBUG) {
    const swNow = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 5000 }).catch(() => null);
    console.log('SWLOG', swNow ? await (await swNow.worker()).evaluate(() => (globalThis.__aitLog ?? []).slice(-15).join('\n')).catch((e) => String(e)) : 'none');
  }
  const pngs = readdirSync(DL).filter((f) => { try { return readFileSync(join(DL, f)).subarray(1, 4).toString() === 'PNG'; } catch { return false; } });
  check('«Сохранять каждую картинку»: both translated pictures are saved', pngs.length === 2, `${pngs.length} PNG files ${names.join(', ')}`);
  if (file) {
    const dir = join(DL, 'x');
    mkdirSync(dir, { recursive: true });
    execFileSync('python3', ['-I', '-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(DL, file), dir]);
    const names = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    const pics = names.map((n) => readFileSync(join(dir, n)).toString('base64'));
    const info = await withCanvas(
      helper,
      async (pics, origB) => {
        const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const px = (img, x, y, w, h) => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(x, y, w, h).data;
        };
        const imgs = await Promise.all(pics.map(load));
        const orig = await load(origB);
        // The lower half of the cut bubble: the second picture's top rows changed (old text gone, translation in).
        const before = px(orig, 150, 0, 140, 70);
        const after = imgs[1] ? px(imgs[1], 150, 0, 140, 70) : before;
        let diff = 0;
        for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 90) diff++;
        return { sizes: imgs.map((i) => `${i.width}×${i.height}`), diff };
      },
      pics,
      b,
    );
    check('one image per picture in the download, at the pictures’ own sizes', info.sizes.join(',') === `800×${CUT},800×${1100 - CUT}`, info.sizes.join(','));
    check('the half of the bubble in the second picture is translated too', info.diff > 150, `changed pixels=${info.diff}`);
  }

  // Opened again: the translations from the cache are shown at once, without asking the model.
  const overlays = async () => {
    const c4 = await tab.target().createCDPSession();
    const { root } = await c4.send('DOM.getDocument', { depth: -1, pierce: true });
    let n = 0;
    const walk = (x) => { if (x.nodeType === 3 && /^⇄/.test(x.nodeValue?.trim() ?? '')) n++; (x.children ?? []).forEach(walk); (x.shadowRoots ?? []).forEach(walk); };
    walk(root);
    await c4.detach();
    return n;
  };
  const before = calls.length;
  await tab.reload();
  let shown = 0;
  for (let i = 0; i < 20 && shown < 2; i++) {
    await new Promise((r) => setTimeout(r, 300));
    shown = await overlays();
  }
  check('a page opened again shows its translations from the cache by itself', shown === 2 && calls.length === before, `overlays=${shown} new model calls=${calls.length - before}`);
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18141/' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'clear-page', tabId: t.id });
  });
  await new Promise((r) => setTimeout(r, 600));
  check('«Очистить всё» removes every translation from the page', (await overlays()) === 0, `overlays=${await overlays()}`);
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-strip.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
