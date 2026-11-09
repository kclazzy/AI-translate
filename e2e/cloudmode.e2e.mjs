// «Облако» in the popup (the small window): switched there, the page is translated by the online
// model, as when switched in Settings. An online model here is the mock LLM under a name that is not
// this computer («mock.cloud», mapped to 127.0.0.1 by the browser).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e cloud mode: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-cloudmode');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Cloud</title><img src="/page.png" width="800" height="1100">');
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18131, '127.0.0.1', r));
const { server: llm, calls } = await startMockLlm(18130);

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--no-first-run', '--disable-gpu', '--host-resolver-rules=MAP mock.cloud 127.0.0.1'],
  defaultViewport: { width: 1200, height: 1400 },
});
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

/** The settings as stored (IndexedDB «ai-translate», kv «settings»), read or changed from an extension page. */
const settingsOf = (p) =>
  p.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ai-translate'); r.onsuccess = () => res(r.result); });
    return new Promise((res) => { const g = db.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => res(g.result); });
  });

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('[data-testid="ai-mode"]', { timeout: 15000 });

  // No online model yet (only Ollama, as on a fresh install): «Облако» in the popup is not a dead
  // button — the click opens Settings with the form that connects one, as the same click there does.
  {
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector('[data-testid="ai-mode"] [data-mode="cloud"]', { timeout: 10000 });
    const btn = await popup.$eval('[data-mode="cloud"]', (b) => ({ disabled: b.disabled, title: b.title }));
    const opened = browser.waitForTarget((t) => t.url().includes('studio.html') && t.url().includes('connect=cloud'), { timeout: 5000 }).catch(() => null);
    if (!btn.disabled) await popup.click('[data-mode="cloud"]');
    const target = btn.disabled ? null : await opened;
    const tab = await target?.page().catch(() => null);
    const el = await tab?.waitForSelector('[data-testid="cloud-connect"]', { timeout: 10000 }).catch(() => null);
    const form = !!el && (await el.isIntersectingViewport());
    if (tab) await tab.screenshot({ path: join(OUT, 'cloudmode-connect.png') });
    check('with no online model, «Облако» in the popup opens the form that connects one, in view', !btn.disabled && form, JSON.stringify({ ...btn, opened: target?.url() ?? null, form }));
    await tab?.close().catch(() => {});
    if (!popup.isClosed()) await popup.close().catch(() => {});
  }

  // An online model server (not this computer) that reads pictures, as if connected in Settings.
  await studio.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ai-translate'); r.onsuccess = () => res(r.result); });
    const stored = await new Promise((res) => { const g = db.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => res(g.result); });
    const s = { ...(stored ?? {}) };
    s.providers = [...(s.providers ?? []).filter((p) => p.id !== 'cloud1'), { id: 'cloud1', kind: 'openai-compatible', label: 'Mock cloud', baseUrl: 'http://mock.cloud:18130/v1', model: 'mock-vl', vision: true }];
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(s, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18131/');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));

  // The popup: «Облако» clicked there.
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('[data-testid="ai-mode"] [data-mode="cloud"]', { timeout: 10000 });
  const before = await popup.$eval('[data-mode="cloud"]', (b) => ({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }));
  await popup.click('[data-mode="cloud"]');
  await new Promise((r) => setTimeout(r, 1200));
  const after = await popup.$eval('[data-mode="cloud"]', (b) => ({ disabled: b.disabled, pressed: b.getAttribute('aria-pressed') }));
  const saved = await settingsOf(popup);
  await popup.screenshot({ path: join(OUT, 'cloudmode-popup.png') });
  check('«Облако» in the popup is switched on and saved', after.pressed === 'true' && saved.visionProviderId === 'cloud1' && saved.readMode !== 'ocr' && saved.privacy === 'cloud', JSON.stringify({ before, after, vision: saved.visionProviderId, privacy: saved.privacy, readMode: saved.readMode, pipeline: saved.pipeline }));

  // «Перевести страницу» from the popup: the online model translates the page.
  const from = calls.length;
  await popup.evaluate(async () => {
    const [t] = await chrome.tabs.query({ url: 'http://127.0.0.1:18131/*' });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  });
  await page.bringToFront();
  for (let i = 0; i < 80 && calls.length === from; i++) await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => setTimeout(r, 4000));
  const c = await page.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  await c.detach();
  const texts = [];
  let images = 0;
  const walk = (n) => {
    if (n.nodeType === 3 && n.nodeValue?.trim()) texts.push(n.nodeValue.trim());
    if (n.localName === 'img' && (n.attributes ?? []).some((a) => String(a).startsWith('blob:') || String(a).startsWith('data:'))) images++;
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  await page.screenshot({ path: join(OUT, 'cloudmode-page.png') });
  const errors = await settingsOf(studio).then(() => studio.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('ai-translate'); r.onsuccess = () => res(r.result); });
    return new Promise((res) => { const g = db.transaction('kv').objectStore('kv').get('errors'); g.onsuccess = () => res((g.result ?? []).slice(0, 3)); });
  }));
  check('the page is translated by the online model', calls.length > from && images > 0, JSON.stringify({ calls: calls.length - from, images, texts: texts.filter((t) => /ошиб|Ошиб|ключ|очеред|Перевод/i.test(t)).slice(0, 5), errors }));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
  llm.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-cloudmode.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
