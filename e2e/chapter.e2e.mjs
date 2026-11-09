// «Перевести и скачать»: a chapter page with ordinary pages, a picture that has not loaded yet
// (lazy, like Webtoons) and a long strip is translated completely and downloaded as one PDF,
// with the strip cut into book pages.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const { server: llm, calls: llmCalls } = await startMockLlm(18110);

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' }, // the interface follows the browser language
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1200 },
});
// The welcome tab opened on install would take the focus from the pages under test.
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));


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
  check('the finished chapter shows the time it took', /Затрачено времени: \d+ (с|мин)/.test(panel), panel);
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
  // «Для анализа»: the same chapter (from the cache) as originals + the current look + a table of texts.
  await new Promise((r) => setTimeout(r, 1500));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18111/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'download-chapter', format: 'analysis', tabId: t.id });
  });
  await tab.bringToFront();
  let pack = null;
  for (let i = 0; i < 120 && !pack; i++) {
    await new Promise((r) => setTimeout(r, 500));
    pack = readdirSync(DL).find((f) => f.startsWith('ait-analysis') && f.endsWith('.zip'));
  }
  if (!pack) {
    // The test browser may keep a random name: the newest zip.
    pack = readdirSync(DL).filter((f) => !f.endsWith('.pdf') && !f.endsWith('.crdownload')).sort().pop() ?? null;
  }
  let packNames = [];
  let tsv = '';
  let activity = '';
  let info = '';
  if (pack) {
    await new Promise((r) => setTimeout(r, 500));
    const JSZip = createRequire(join(ROOT, 'packages/studio/package.json'))('jszip');
    const z = await JSZip.loadAsync(readFileSync(join(DL, pack)));
    packNames = Object.keys(z.files);
    tsv = (await z.file('texts.tsv')?.async('string')) ?? '';
    activity = (await z.file('activity.txt')?.async('string')) ?? '';
    info = (await z.file('info.txt')?.async('string')) ?? '';
  }
  // The page's pictures touch (0 px) or stand apart; the strip is glued: the pack says so.
  check('the pack says how the pictures stand on the site and how their seams were joined', /seams: glued \d+, repaired \d+, alone \d+/.test(info) && /gaps under the picture before \(px\): -?\d+ ×\d+/.test(info), info.split('\n').filter((l) => /seams|gaps/.test(l)).join(' | '));
  check('the pack says where the chapter time went: the model, its idle time and why', /Модель занята: \d+%/.test(activity) && /Простой модели: \d+%/.test(activity) && /страниц: [1-9]/.test(activity), activity.slice(0, 600));
  check('«Для анализа» downloads originals, the current translation and all texts in one table', packNames.includes('texts.tsv') && packNames.some((n) => /^001\/original\./.test(n)) && packNames.includes('001/result.jpg') && packNames.includes('001/page.json') && packNames.includes('journal.json') && tsv.includes('page\tblock\ttype'), `${pack} ${packNames.filter((n) => !n.startsWith("0")).join(', ')} rows=${tsv.split('\n').length}`);

  // «PSD (Photoshop)»: the same chapter as one layered PSD per picture, in a ZIP.
  {
    const before = new Set(readdirSync(DL));
    await studio.evaluate(async () => {
      const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18111/*' });
      await chrome.runtime.sendMessage({ type: 'popup-command', command: 'download-chapter', format: 'psd', tabId: t.id });
    });
    await tab.bringToFront();
    let file = null;
    for (let i = 0; i < 120 && !file; i++) {
      await new Promise((r) => setTimeout(r, 500));
      file = readdirSync(DL).find((f) => !before.has(f) && f.endsWith('.zip'));
    }
    let names = [];
    let layers = [];
    if (file) {
      await new Promise((r) => setTimeout(r, 500));
      const req = createRequire(join(ROOT, 'packages/studio/package.json'));
      const z = await req('jszip').loadAsync(readFileSync(join(DL, file)));
      names = Object.keys(z.files).sort();
      const { readPsd } = req('ag-psd');
      for (const n of names) {
        const psd = readPsd(await z.file(n).async('uint8array'), { skipCompositeImageData: true, skipThumbnail: true, skipLayerImageData: true });
        layers.push((psd.children ?? []).map((c) => `${c.name}:${c.children?.length ?? 0}`).join('/'));
      }
    }
    // (This chapter's pictures hold no text for the mock model: the text layers are checked in studio's psd.test.)
    check('«PSD (Photoshop)» downloads a ZIP with a layered PSD per picture: original, cleaned, the texts', names.length >= 3 && names.every((n) => /^\d{3}\.psd$/.test(n)) && layers.every((l) => /^Оригинал:0\/Очищено:0\/Перевод:\d+$/.test(l)), `${file} ${names.join(',')} ${layers.join(' ')}`);
  }

  // ---- The editor gets the whole chapter, also the pages the reader took out of the page -----------
  {
    const editKeys = async () => {
      const c = await tab.target().createCDPSession();
      const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
      const btns = [];
      const walk = (n) => {
        if (n.nodeName === 'BUTTON' && (n.attributes ?? []).join(' ').includes('Править в редакторе')) btns.push(n.backendNodeId);
        (n.children ?? []).forEach(walk);
        (n.shadowRoots ?? []).forEach(walk);
      };
      walk(root);
      if (!btns.length) return null;
      const opened = browser.waitForTarget((t) => t.url().includes('studio.html?key='), { timeout: 10000 }).catch(() => null);
      const { object } = await c.send('DOM.resolveNode', { backendNodeId: btns.at(-1) });
      await c.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
      await c.detach();
      const t = await opened;
      if (!t) return null;
      const keys = new URL(t.url()).searchParams.get('chapter')?.split(',').filter(Boolean) ?? [];
      await (await t.page())?.close().catch(() => {});
      return keys;
    };
    await tab.bringToFront();
    const before = await editKeys();
    // A reader takes the first page out of the page when it is far from the screen.
    await tab.evaluate(() => document.querySelector('img[src="/p1.png"]')?.remove());
    await new Promise((r) => setTimeout(r, 1500));
    const after = await editKeys();
    check('the editor gets every translated page of the chapter, also one the reader took out', !!before && before.length >= 3 && !!after && after.length === before.length && after.join() === before.join(), `before=${before?.length} after=${after?.length}`);
  }
  // ---- «История»: folders manga → chapter → pages, and a chapter opens whole in the editor ---------
  {
    await studio.bringToFront();
    await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
    await studio.waitForSelector('[data-testid="history-series"]', { timeout: 10000 }).catch(() => {});
    const tree = await studio.evaluate(() =>
      [...document.querySelectorAll('[data-testid="history-series"]')].map((s) => ({
        chapters: [...s.querySelectorAll('[data-testid="history-chapter"]')].map((c) => c.querySelectorAll('tbody tr').length),
      })),
    );
    await studio.screenshot({ path: join(OUT, 'history-folders.png'), fullPage: true });
    check('«История» groups pages into a manga folder with a chapter inside', tree.length >= 1 && tree[0].chapters.length >= 1 && tree[0].chapters[0] >= 1, JSON.stringify(tree));
    const errors = [];
    studio.on('pageerror', (e) => errors.push(String(e)));
    studio.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await studio.evaluate(() => {
      document.querySelector('[data-testid="history-chapter"] [data-testid="history-open-chapter"]')?.click();
    });
    await new Promise((r) => setTimeout(r, 3000));
    const shown = await studio.evaluate(() => ({ text: document.body.innerText.slice(0, 400), pages: document.querySelectorAll('[data-testid="chapters-panel"] [data-key], .ait-chapters li').length }));
    await studio.screenshot({ path: join(OUT, 'history-open-chapter.png') });
    check('«Открыть главу» in the history opens the editor with the chapter, no error', !/Что-то пошло не так/.test(shown.text) && /редакт|Редакт/i.test(shown.text), JSON.stringify({ shown, errors: errors.slice(0, 5) }));
    // The editor's brush as a shape: a rectangle drawn with the brush paints that area (one undo step).
    {
      await studio.keyboard.press('b');
      await studio.click('[data-testid="brush-shape"] button[aria-pressed="false"][title="Прямоугольник"]').catch(() => {});
      const box = await studio.$eval('.ait-stage-inner', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).catch(() => null);
      const undoBefore = await studio.$eval('button[aria-label="Отменить"]', (b) => b.disabled).catch(() => null);
      if (box) {
        await studio.mouse.move(box.x + box.w * 0.2, box.y + 40);
        await studio.mouse.down();
        await studio.mouse.move(box.x + box.w * 0.5, box.y + 120, { steps: 6 });
        await studio.mouse.up();
        await new Promise((r) => setTimeout(r, 600));
      }
      const undoAfter = await studio.$eval('button[aria-label="Отменить"]', (b) => b.disabled).catch(() => null);
      await studio.screenshot({ path: join(OUT, 'editor-rect-brush.png') });
      check('the brush as a rectangle paints its area in one step (undo becomes possible)', !!box && undoBefore === true && undoAfter === false, JSON.stringify({ box, undoBefore, undoAfter }));
      // Undone, and leaving the page without saving is allowed (the next steps open other pages here).
      await studio.keyboard.down('Control');
      await studio.keyboard.press('z');
      await studio.keyboard.up('Control');
      studio.on('dialog', (d) => void d.accept().catch(() => {}));
      // «⇅ Объединить через стык» on a seam of the whole chapter: the band around it goes to the model as one picture.
      const seams = await studio.$$eval('[data-testid="seam-merge"]', (b) => b.length).catch(() => 0);
      const from = llmCalls.length;
      await studio.$eval('[data-testid="seam-merge"]', (b) => b.scrollIntoView({ block: 'center' })).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await studio.screenshot({ path: join(OUT, 'editor-seam.png') });
      await studio.click('[data-testid="seam-merge"]').catch(() => {});
      const sizes = () => llmCalls.slice(from).map((c) => /The image is (\d+)×(\d+)/.exec(JSON.stringify(c.messages))?.slice(1).map(Number)).filter(Boolean);
      for (let i = 0; i < 60 && !sizes().length; i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1500));
      const text = await studio.evaluate(() => document.body.innerText);
      check('«⇅ Объединить через стык» in the whole chapter reads the band around that seam with the model', seams >= 1 && sizes().some(([, h]) => h !== 1100 && h < 1100) && !/Что-то пошло не так/.test(text), JSON.stringify({ seams, sizes: sizes() }));
    }
    // «Очистить кэш» removes the pictures but keeps the history: a chapter whose pages are gone
    // (some, then all) still opens, with what is left or a plain message — never the error screen.
    for (const all of [false, true]) {
      await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
      await studio.evaluate(async (all) => {
        const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
        const keys = await new Promise((res) => { const g = db.transaction('results').objectStore('results').getAllKeys(); g.onsuccess = () => res(g.result); });
        const tx = db.transaction('results', 'readwrite');
        for (const k of all ? keys : keys.slice(0, 1)) tx.objectStore('results').delete(k);
        await new Promise((r) => (tx.oncomplete = r));
      }, all);
      await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
      await studio.waitForSelector('[data-testid="history-chapter"]', { timeout: 10000 }).catch(() => {});
      const marked = await studio.evaluate(() => !!document.querySelector('[data-testid="history-gone"]'));
      await studio.evaluate(() => document.querySelector('[data-testid="history-chapter"] [data-testid="history-open-chapter"]')?.click());
      await new Promise((r) => setTimeout(r, 3000));
      const gone = await studio.evaluate(() => document.body.innerText.slice(0, 300));
      await studio.screenshot({ path: join(OUT, `history-open-chapter-cleared-${all ? 'all' : 'one'}.png`) });
      check(all ? 'a chapter whose pages were all cleared from the cache says so in the history, no error' : 'a chapter with a page cleared from the cache still opens', !/Что-то пошло не так/.test(gone) && marked === all, JSON.stringify({ marked, gone, errors: errors.slice(0, 5) }));
    }
  }
  // ---- «История»: a whole manga deleted (asked first): its pages and history are gone -----------------
  {
    const del = await browser.newPage();
    del.on('dialog', (d) => void d.accept());
    await del.goto(`chrome-extension://${extId}/studio.html?view=history`);
    await del.waitForSelector('[data-testid="history-forget-series"]', { timeout: 10000 }).catch(() => {});
    const before = await del.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
      // (The pictures were cleared from the cache above; the history of the chapter is still there.)
      return new Promise((res) => { const g = db.transaction('history').objectStore('history').count(); g.onsuccess = () => res(g.result); });
    });
    await del.click('[data-testid="history-forget-series"]').catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const after = await del.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
      const count = (s) => new Promise((res) => { const g = db.transaction(s).objectStore(s).count(); g.onsuccess = () => res(g.result); });
      return { results: await count('results'), history: await count('history'), folders: document.querySelectorAll('[data-testid="history-series"]').length };
    });
    check('«Удалить мангу» in the history removes its translated pages and their history', before > 0 && after.results === 0 && after.history === 0 && after.folders === 0, JSON.stringify({ before, after }));
    await del.close();
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
