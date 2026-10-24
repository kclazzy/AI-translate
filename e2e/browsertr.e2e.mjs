// «Распознавание» without Ollama: with no model server at all the mode can be switched on, the
// browser's own translator is chosen, and its language pack is downloaded from the settings card.
// The browser's Translator API is stood in for on the page (test browsers have none).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e browsertr: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-browsertr');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1000 },
});
browser.on('targetcreated', async (t) => {
  if (t.url().includes('view=welcome')) (await t.page().catch(() => null))?.close().catch(() => {});
});

/** A stand-in for Chrome's Translator API: the pack is «downloadable» until created once. */
const fakeTranslator = () => {
  const have = new Set(JSON.parse(localStorage.getItem('fake-tr') ?? '[]'));
  globalThis.Translator = {
    async availability({ sourceLanguage: a, targetLanguage: b }) {
      return have.has(`${a}>${b}`) ? 'available' : 'downloadable';
    },
    async create({ sourceLanguage: a, targetLanguage: b, monitor }) {
      const ev = new EventTarget();
      monitor?.(ev);
      for (const loaded of [0.3, 0.7, 1]) {
        await new Promise((r) => setTimeout(r, 50));
        const e = new Event('downloadprogress');
        e.loaded = loaded;
        ev.dispatchEvent(e);
      }
      have.add(`${a}>${b}`);
      localStorage.setItem('fake-tr', JSON.stringify([...have]));
      return { translate: async (t) => `«${t}»` };
    },
  };
};

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  await studio.evaluateOnNewDocument(fakeTranslator);
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('.ait-panel', { timeout: 15000 });
  const setSettings = (patch) =>
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
      Object.assign(s, patch);
      store.put(s, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
    }, patch);
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
  // No model server at all: neither Ollama nor an online one.
  await setSettings({ providers: [], visionProviderId: null, translationProviderId: null, pipeline: 'standalone', readMode: 'vision', sourceLang: 'ja', targetLang: 'ru', onboarded: true, privacy: 'local' });
  await studio.reload();
  const btn = await studio.waitForSelector('[data-testid="ai-mode"] [data-mode="ocr"]', { timeout: 15000 });
  const enabled = await btn.evaluate((b) => !b.disabled);
  check('without any model server «Распознавание» can be switched on', enabled);
  await btn.click();
  await studio.waitForSelector('[data-testid="ocr-translator"] select', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  const s1 = await readSettings();
  check('the browser\'s own translator translates in it', s1.readMode === 'ocr' && s1.visionProviderId === 'browser-translator', `${s1.readMode} ${s1.visionProviderId}`);
  const label = await studio.$eval('[data-testid="ocr-translator"] select', (el) => el.selectedOptions[0]?.textContent ?? '');
  check('the choice is shown as the browser translator', /браузер/i.test(label), label);
  // The pack card: only after the recognition models (stand-in: the cache entries the card checks).
  const hasPackCard = await studio.waitForSelector('[data-testid="translator-pack"] button', { timeout: 15000 }).catch(() => null);
  check('the card offers the language pack ja → ru', !!hasPackCard);
  if (hasPackCard) {
    await hasPackCard.click();
    const ok = await studio.waitForSelector('[data-testid="translator-pack-ready"]', { timeout: 15000 }).catch(() => null);
    check('«Скачать языковой пакет» downloads it', !!ok);
  }
  await studio.screenshot({ path: join(OUT, 'browsertr.png') });
} catch (e) {
  check('no crash', false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
}
writeFileSync(join(OUT, 'e2e-browsertr.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
