// «Распознавание» without Ollama: with no model server at all the mode can be switched on, the
// browser's own translator is chosen, and its language pack is downloaded from the settings card.
// The browser's Translator API is stood in for on the page (test browsers have none).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
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

const ortDir = dirname(createRequire(join(ROOT, 'apps/extension/package.json')).resolve('onnxruntime-web'));
const ORT_VERSION = JSON.parse(readFileSync(join(ortDir, '../package.json'), 'utf8')).version;
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
  await setSettings({ providers: [], visionProviderId: null, translationProviderId: null, pipeline: 'standalone', readMode: 'vision', sourceLang: 'ja', targetLang: 'ru', onboarded: true, privacy: 'local', quality: 'best', qaMode: 'fix' });
  // The recognition models as if downloaded (only their presence is checked before a translation).
  await studio.evaluate(async (ver) => {
    const c = await caches.open('ait-models');
    const urls = [
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/ort-wasm-simd-threaded.jsep.wasm`,
      'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main/detector_int8.onnx',
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx',
      'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx',
      'https://github.com/kclazzy/AI-translate/releases/download/models-1/manga-ocr-encoder-int8.onnx',
      'https://github.com/kclazzy/AI-translate/releases/download/models-1/manga-ocr-decoder-int8.onnx',
      'https://github.com/kclazzy/AI-translate/releases/download/models-1/manga-ocr-vocab.txt',
    ];
    for (const u of urls) await c.put(u, new Response(new Uint8Array(4)));
  }, ORT_VERSION);
  await studio.reload();
  const btn = await studio.waitForSelector('[data-testid="ai-mode"] [data-mode="ocr"]', { timeout: 15000 });
  const enabled = await btn.evaluate((b) => !b.disabled);
  check('without any model server «Распознавание» can be switched on', enabled);
  await btn.click();
  await studio.waitForSelector('[data-testid="ocr-translator"] select', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  const s1 = await readSettings();
  check('the browser\'s own translator translates in it', s1.readMode === 'ocr' && s1.visionProviderId === 'browser-translator', `${s1.readMode} ${s1.visionProviderId}`);
  {
    // The switch of model brought the settings that suit the browser's translator, and says so.
    const note = await studio.waitForSelector('[data-testid="auto-tuned"]', { timeout: 5000 }).catch(() => null);
    check('the switch brings the settings that suit the new model at once', !!note && s1.quality === 'balanced' && s1.qaMode === 'rules', `${s1.quality} ${s1.qaMode} ${note ? 'note' : 'no note'}`);
  }
  const label = await studio.$eval('[data-testid="ocr-translator"] select', (el) => el.selectedOptions[0]?.textContent ?? '');
  check('the choice is shown as the browser translator', /браузер/i.test(label), label);
  // The models count as downloaded here (cache entries); choosing the mode gets the language packs
  // of the main languages at once, from the click.
  const ready = await studio.waitForSelector('[data-testid="ocr-ready"]', { timeout: 20000 }).catch(() => null);
  const packs = await studio.evaluate(() => JSON.parse(localStorage.getItem('fake-tr') ?? '[]'));
  check('choosing the mode downloads the language packs of the main languages', !!ready && packs.length >= 9 && packs.includes('ja>ru') && packs.includes('en>ru') && packs.includes('ko>ru'), JSON.stringify(packs));
  // The languages stand first in the settings, and ⇄ swaps them.
  {
    const pair = await studio.$('[data-testid="languages"] [data-testid="language-pair"]');
    await studio.select('[data-testid="languages"] select[aria-label="Исходный язык"]', 'ja');
    await studio.click('[data-testid="languages"] .ait-langpair-swap');
    await new Promise((r) => setTimeout(r, 500));
    const after = await readSettings();
    const first = await studio.evaluate(() => document.querySelector('.ait-panel')?.getAttribute('data-testid'));
    check('the languages are the first thing in the settings, and ⇄ swaps them', !!pair && first === 'languages' && after.sourceLang === 'ru' && after.targetLang === 'ja', `${first} ${after.sourceLang}→${after.targetLang}`);
    await setSettings({ sourceLang: 'ja', targetLang: 'ru' });
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
