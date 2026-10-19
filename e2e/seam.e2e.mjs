// A site that loads its pictures one by one (lazy): two neighbouring pictures of a strip are
// translated alone, and a speech bubble is cut by the seam between them. The extension sees the cut
// bubble on both sides and translates the band around the seam once: both pictures get the whole
// line, not two halves.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e seam: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-seam');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const CUT = 260; // through the first bubble of the fixture (its text runs from y=197 to y=323)
const parts = {};
const site = createServer((req, res) => {
  if (req.url === '/')
    // The second picture comes in later, as a lazy reader adds it: the two never go to the model together.
    return res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(`<!doctype html><meta charset="utf-8"><title>Chapter 8</title><style>body{margin:0}img{display:block;width:800px}</style><div id="c"><img src="/a.png"></div><script>window.addB=()=>{const i=new Image();i.src='/b.png';document.getElementById('c').appendChild(i)}</script>`);
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  const p = parts[req.url];
  if (p) return res.writeHead(200, { 'content-type': 'image/png' }).end(p);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18151, '127.0.0.1', r));

// The model: the upper picture shows the top of the bubble's text at its bottom edge, the lower one
// the rest at its top edge; the band around the seam shows the whole line.
const calls = [];
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
      const w = Number(m?.[1] ?? 0);
      const h = Number(m?.[2] ?? 0);
      // Crops the pipeline reads again (left-over lettering) are not pictures of the strip.
      if (w !== 800) {
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ blocks: [], entities: [], summary: '' }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'mock-vl' }));
        return;
      }
      calls.push({ h });
      const box = (y0, y1) => [380, Math.round((y0 / h) * 1000), 620, Math.round((y1 / h) * 1000)];
      const blocks =
        h === CUT ? [{ box: box(195, CUT), text: 'たなかさん', translation: 'ПОЛОВИНА СВЕРХУ', type: 'DIALOGUE' }]
        : h > 700 ? [{ box: box(0, 323 - CUT), text: '待って', translation: 'ПОЛОВИНА СНИЗУ', type: 'DIALOGUE' }]
        : [{ box: box(Math.round(h * 0.2), Math.round(h * 0.8)), text: 'たなかさん待って', translation: 'ЦЕЛАЯ РЕПЛИКА', type: 'DIALOGUE' }];
      answer = { blocks, entities: [], summary: '' };
    } else {
      const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(last?.content ?? '')?.[1] ?? '[]');
      answer = { translations: blocks.map((b) => ({ id: b.id, text: `RU ${b.text}` })), entities: [], summary: '' };
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 100, completion_tokens: 20 }, model: 'mock-vl' }));
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
  defaultViewport: { width: 1000, height: 1200 },
});
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

try {
  const helper = await browser.newPage();
  await helper.goto('http://127.0.0.1:18151/page.png');
  const [a, b] = await helper.evaluate(async (cut) => {
    const img = await createImageBitmap(await (await fetch('/page.png')).blob());
    const piece = (y, h) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, -y);
      return c.toDataURL('image/png').split(',')[1];
    };
    return [piece(0, cut), piece(cut, img.height - cut)];
  }, CUT);
  parts['/a.png'] = Buffer.from(a, 'base64');
  parts['/b.png'] = Buffer.from(b, 'base64');

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
    s.providers = [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18150/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }];
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
  await tab.goto('http://127.0.0.1:18151/');
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await new Promise((r) => setTimeout(r, 800));
  await studio.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18151/' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await tab.bringToFront();
  // The upper picture is read alone; then the lower one arrives.
  for (let i = 0; i < 60 && !calls.length; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 1500));
  await tab.evaluate(() => window.addB());
  for (let i = 0; i < 160 && calls.length < 3; i++) await new Promise((r) => setTimeout(r, 250));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const done = await studio.evaluate(async () => {
      const db = await new Promise((res) => { const r = indexedDB.open("ai-translate", 1); r.onsuccess = () => res(r.result); });
      return new Promise((res) => { const g = db.transaction("results").objectStore("results").getAll(); g.onsuccess = () => res(g.result.filter((r) => r.seams?.length).length); });
    });
    if (done >= 2) break;
  }
  const heights = calls.map((c) => c.h);
  check('the two pictures were read one by one', heights[0] === CUT && heights[1] > 700, `heights=${heights.join(',')}`);
  check('then the band around the seam was read once', heights.length === 3 && heights[2] > 0 && heights[2] < 700, `heights=${heights.join(',')}`);
  const shown = await studio.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ai-translate', 1); r.onsuccess = () => res(r.result); });
    const all = await new Promise((res) => { const g = db.transaction('results').objectStore('results').getAll(); g.onsuccess = () => res(g.result); });
    return all.map((r) => ({ h: r.page.height, texts: r.page.blocks.map((b) => b.translatedText), seams: r.seams?.length ?? 0 }));
  });
  const up = shown.find((r) => r.h === CUT);
  const lo = shown.find((r) => r.h > 700);
  check('both pictures now hold the whole line, no halves', !!up && !!lo && up.texts.join() === 'ЦЕЛАЯ РЕПЛИКА' && lo.texts.join() === 'ЦЕЛАЯ РЕПЛИКА', JSON.stringify(shown));
  check('the seam is marked done', up?.seams === 1 && lo?.seams === 1);
  await new Promise((r) => setTimeout(r, 1500));
  await tab.screenshot({ path: join(OUT, 'seam-done.png') });
} catch (e) {
  check('no crash', false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  site.close();
  llm.close();
}
writeFileSync(join(OUT, 'e2e-seam.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
