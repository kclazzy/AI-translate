// LaMa in the browser: with «Дорисовка фона — в браузере» and the model in the cache, text written
// over artwork is redrawn by the model (here a tiny stand-in model that paints the hole grey).
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e lama: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-lama');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

let picture = null;
let picture2 = null;
const W = 600;
const H = 800;
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Art</title><body style="margin:0"><img src="/art.png" width="600" height="800"></body>');
  if (req.url === '/art.png' && picture) return res.writeHead(200, { 'content-type': 'image/png' }).end(picture);
  if (req.url === '/two') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Art 2</title><body style="margin:0"><img src="/art2.png" width="600" height="800"></body>');
  if (req.url === '/art2.png' && picture2) return res.writeHead(200, { 'content-type': 'image/png' }).end(picture2);
  if (req.url === '/blank') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>b</title>');
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18151, '127.0.0.1', r));
// The model: one line of text written straight over the art.
const llm = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const box = [Math.round((195 / W) * 1000), Math.round((175 / H) * 1000), Math.round((345 / W) * 1000), Math.round((235 / H) * 1000)];
    const content = JSON.stringify({ blocks: JSON.stringify(j).includes('image_url') ? [{ box, text: 'DOOM', translation: 'БУМ', type: 'DIALOGUE', vertical: false }] : [], entities: [], summary: '' });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'mock' }));
  });
});
await new Promise((r) => llm.listen(18150, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1000 },
});
// The welcome tab opened on install would take the focus from the pages under test.
let keepWelcome = false;
const closeWelcome = async (t) => {
  if (keepWelcome || !t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  // The picture: white letters with a black outline over coloured stripes.
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18151/blank');
  const draw = (w, h, shift) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    for (let x = -shift; x < w; x += 10) {
      ctx.fillStyle = `hsl(${x % 360}, 60%, 50%)`;
      ctx.fillRect(x, 0, 10, h);
    }
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 4;
    ctx.font = 'bold 48px sans-serif';
    ctx.strokeText('DOOM', 200, 220);
    ctx.fillText('DOOM', 200, 220);
    return c.toDataURL('image/png').split(',')[1];
  };
  const b64 = await helper.evaluate(`(${draw})(${W}, ${H}, 0)`);
  picture = Buffer.from(b64, 'base64');
  // A second picture (another page, not in the cache) for the offer checks.
  picture2 = Buffer.from(await helper.evaluate(`(${draw})(${W}, ${H}, 5)`), 'base64');
  await helper.close();

  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=history`);
  const model = readFileSync(new URL('./fixtures/fake-lama.onnx', import.meta.url)).toString('base64');
  await studio.evaluate(async (m) => {
    const bytes = Uint8Array.from(atob(m), (c) => c.charCodeAt(0));
    await (await caches.open('ait-models')).put('https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx', new Response(bytes));
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
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18150/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
    s.visionProviderId = 'mock';
    s.translationProviderId = null;
    s.privacy = 'local';
    s.pipeline = 'standalone';
    s.qaMode = 'off';
    s.twoStepTranslation = false;
    s.lamaMode = 'browser';
    store.put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  }, model);

  const tab = await browser.newPage();
  await tab.goto('http://127.0.0.1:18151/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 600));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18151/' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await tab.bringToFront();
  let grey = -1;
  for (let i = 0; i < 60 && grey < 0; i++) {
    await new Promise((r) => setTimeout(r, 500));
    grey = await studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      const all = await new Promise((res) => {
        const g = db.transaction('results').objectStore('results').getAll();
        g.onsuccess = () => res(g.result);
      });
      if (!all.length) return -1;
      const r = all[0];
      const bmp = await createImageBitmap(new Blob([r.cleaned[0].bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(200, 180, 140, 45).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 127) < 6 && Math.abs(d[i + 1] - 127) < 6 && Math.abs(d[i + 2] - 127) < 6) n++;
      return n;
    });
  }
  await tab.screenshot({ path: join(OUT, 'lama.png') });
  check('text over the art is redrawn by LaMa running in the browser', grey > 300, `grey pixels where the letters were: ${grey}`);

  // ---- LaMa is off and not downloaded: the program offers it ----------------------------------------
  const modelBytes = readFileSync(new URL('./fixtures/fake-lama.onnx', import.meta.url));
  const LAMA = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
  const readSettings = () =>
    studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('kv').objectStore('kv').get('settings');
        g.onsuccess = () => res(g.result ?? {});
      });
    });
  const patchSettings = (patch) =>
    studio.evaluate(async (patch) => {
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
      for (const [k, v] of Object.entries(patch)) if (v === null) delete s[k];
      else s[k] = v;
      store.put(s, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
    }, patch);
  const modelCached = () => studio.evaluate(async (u) => !!(await (await caches.open('ait-models')).match(u)), LAMA);
  const dropModel = () => studio.evaluate(async (u) => (await caches.open('ait-models')).delete(u), LAMA);
  /** Texts and labels on a page, closed shadow roots included (our page UI lives there). */
  const pageTexts = async (p) => {
    const c = await p.target().createCDPSession();
    const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3 && n.nodeValue?.trim()) out.push(n.nodeValue.trim());
      for (let i = 0; i < (n.attributes ?? []).length; i += 2) if (n.attributes[i] === 'aria-label') out.push(n.attributes[i + 1]);
      (n.children ?? []).forEach(walk);
      (n.shadowRoots ?? []).forEach(walk);
    };
    walk(root);
    await c.detach();
    return out;
  };
  /** Click a button (found by its text) inside a closed shadow root. */
  const clickText = async (p, text) => {
    const c = await p.target().createCDPSession();
    const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
    let found = null;
    const walk = (n) => {
      if (found) return;
      if (n.nodeName === 'BUTTON' && (n.children ?? []).some((k) => k.nodeType === 3 && k.nodeValue.trim() === text)) found = n;
      (n.children ?? []).forEach(walk);
      (n.shadowRoots ?? []).forEach(walk);
    };
    walk(root);
    if (found) {
      const { object } = await c.send('DOM.resolveNode', { backendNodeId: found.backendNodeId });
      await c.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' });
    }
    await c.detach();
    return !!found;
  };
  /** The model download is answered with the stand-in model. */
  const serveModel = async (p) => {
    await p.setRequestInterception(true);
    p.on('request', (r) => {
      if (r.url().startsWith('https://huggingface.co/')) void r.respond({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-length': String(modelBytes.length) }, contentType: 'application/octet-stream', body: modelBytes });
      else void r.continue();
    });
  };
  const waitFor = async (f, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await f().catch(() => null);
      if (v || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  await dropModel();
  await patchSettings({ lamaMode: 'off', lamaOfferDismissed: null });
  const tab2 = await browser.newPage();
  await tab2.goto('http://127.0.0.1:18151/two');
  await tab2.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 600));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18151/two' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await tab2.bringToFront();
  const offerText = 'Фон под текстом на рисунке закрашен упрощённо';
  const offered = await waitFor(async () => (await pageTexts(tab2)).some((t) => t.includes(offerText)), 30000);
  check('after the page the program offers LaMa once', !!offered);
  const texts2 = await pageTexts(tab2);
  check('ⓘ says the text over the art has no LaMa background', texts2.some((t) => /Текст поверх рисунка: \d+ — фон без LaMa/.test(t)), texts2.flatMap((t) => t.split('\n')).filter((t) => t.includes('поверх')).join(' | '));
  const plainKey = await studio.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    const all = await new Promise((res) => {
      const g = db.transaction('results').objectStore('results').getAll();
      g.onsuccess = () => res(g.result);
    });
    const r = all.find((x) => x.page?.artText > 0 && x.page.artRedrawn === false);
    return r?.key ?? null;
  });
  check('the page result knows the art was painted over simply', !!plainKey);

  // «Не предлагать» is remembered.
  check('«Не предлагать» closes the offer', await clickText(tab2, 'Не предлагать'));
  check('«Не предлагать» is saved in the settings', !!(await waitFor(async () => (await readSettings()).lamaOfferDismissed === true)));

  // The editor of that page: ◍ is a simple fill and the sidebar offers LaMa.
  if (plainKey) {
    const ed = await browser.newPage();
    await ed.goto(`chrome-extension://${extId}/studio.html?key=${encodeURIComponent(plainKey)}`);
    await ed.waitForSelector('[data-testid=palette]', { timeout: 15000 });
    check('the editor offers LaMa for the art under text', !!(await ed.waitForSelector('[data-testid=lama-hint]', { timeout: 8000 }).catch(() => null)));
    check('without the model ◍ is «Заливка фона»', !!(await ed.$('button[aria-label="Заливка фона"]')));
    await ed.close();
  }

  // «Включить» opens the settings with LaMa in view; «Скачать и включить» downloads and switches it on.
  await patchSettings({ lamaOfferDismissed: null });
  await tab2.reload();
  await tab2.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await waitFor(async () => (await pageTexts(tab2)).some((t) => t.includes(offerText)), 20000);
  const settingsTab = browser.waitForTarget((t) => t.url().includes('offer=lama'), { timeout: 15000 });
  check('«Включить» on the page opens the settings', await clickText(tab2, 'Включить'));
  const sp = await (await settingsTab).page();
  await serveModel(sp);
  await sp.waitForSelector('[data-testid=lama].ait-offer', { timeout: 15000 });
  check('the LaMa setting is highlighted', !!(await sp.$('[data-testid=lama].ait-offer')));
  await sp.click('[data-testid=lama-offer] button');
  const ready = await sp.waitForSelector('[data-testid=lama-ready]', { timeout: 30000 }).catch(() => null);
  const s1 = await readSettings();
  check('«Скачать и включить» downloads the model and sets LaMa to the browser', !!ready && s1.lamaMode === 'browser' && (await modelCached()), `mode ${s1.lamaMode}`);
  await sp.close();

  // Welcome: the optional step downloads LaMa too.
  await dropModel();
  await patchSettings({ lamaMode: 'off' });
  keepWelcome = true;
  const wp = await browser.newPage();
  await serveModel(wp);
  await wp.goto(`chrome-extension://${extId}/studio.html?view=welcome`);
  await wp.waitForSelector('[data-testid=welcome-lama] button', { timeout: 15000 });
  await wp.click('[data-testid=welcome-lama] button');
  const done = await wp.waitForFunction(() => document.querySelector('[data-testid=welcome-lama]')?.textContent.includes('Готово'), { timeout: 30000 }).catch(() => null);
  const s2 = await readSettings();
  check('the welcome step downloads LaMa and switches it on', !!done && s2.lamaMode === 'browser' && (await modelCached()), `mode ${s2.lamaMode}`);
  await wp.close();
  keepWelcome = false;

  // The editor: ◍ now redraws the stroke with LaMa (the stand-in model paints it grey).
  if (plainKey) {
    const ed = await browser.newPage();
    await ed.goto(`chrome-extension://${extId}/studio.html?key=${encodeURIComponent(plainKey)}`);
    await ed.waitForSelector('button[aria-label="Дорисовать фон (LaMa)"]', { timeout: 15000 });
    check('with the model ◍ is «Дорисовать фон (LaMa)» and the hint is gone', !(await ed.$('[data-testid=lama-hint]')));
    await ed.click('button[aria-label="Дорисовать фон (LaMa)"]');
    const at = (px, py) =>
      ed.evaluate(
        (px, py, w) => {
          const r = document.querySelector('.ait-stage-inner').getBoundingClientRect();
          const z = r.width / w;
          return [r.left + px * z, r.top + py * z];
        },
        px,
        py,
        W,
      );
    const greyAt = () =>
      ed.evaluate(() => {
        const c = document.querySelector('.ait-stage-inner canvas');
        const d = c.getContext('2d').getImageData(70, 560, 40, 6).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 127) < 8 && Math.abs(d[i + 1] - 127) < 8 && Math.abs(d[i + 2] - 127) < 8) n++;
        return n;
      });
    const before = await greyAt();
    const [x0, y0] = await at(60, 563);
    const [x1] = await at(120, 563);
    await ed.mouse.move(x0, y0);
    await ed.mouse.down();
    for (let i = 1; i <= 10; i++) await ed.mouse.move(x0 + ((x1 - x0) * i) / 10, y0);
    await ed.mouse.up();
    const after = await waitFor(async () => {
      if (await ed.$('[data-testid=lama-busy]')) return null;
      const n = await greyAt();
      return n > before + 100 ? n : null;
    }, 20000);
    check('◍ with LaMa redraws the stroke', !!after, `grey before ${before}, after ${after ?? (await greyAt())}`);
    await ed.screenshot({ path: join(OUT, 'lama-editor.png') });
    await ed.close();
  }
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-lama.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
