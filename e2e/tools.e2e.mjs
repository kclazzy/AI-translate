// The chapter tools of the studio: chapters in 7z and TAR archives (and a ZIP named .cbr) open as
// projects; «Вычитка» shows every text of the chapter in one table, saves edits and replaces
// across pages; with UPSCALE_MODEL (the models-2 file) a small scan is translated twice as big.
// The archives are made from the synthetic test page (TAR here with libarchive for Node, 7z ready in fixtures/).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const UPSCALE_MODEL = process.env.UPSCALE_MODEL;
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e tools: ${name}::${String(detail).slice(0, 500)}`);
};

// ---- test files -------------------------------------------------------------------------------
const work = join(tmpdir(), 'ait-tools-e2e');
if (existsSync(work)) rmSync(work, { recursive: true });
mkdirSync(work, { recursive: true });
const page = readFileSync(join(ROOT, 'e2e/fixtures/page.png'));
const req = createRequire(join(ROOT, 'packages/studio/package.json'));
const JSZip = createRequire(join(ROOT, 'packages/core/package.json'))('jszip');
const libDir = dirname(req.resolve('libarchive.js'));
const { Archive } = await import(join(libDir, 'libarchive-node.mjs'));
async function archive(name, format, compression) {
  const files = [
    { file: new File([page], 'p10.png'), pathname: 'chapter/p10.png' },
    { file: new File([page], 'p2.png'), pathname: 'chapter/p2.png' },
    { file: new File([Buffer.from('notes')], 'readme.txt'), pathname: 'chapter/readme.txt' },
  ];
  const out = await Archive.write({ files, outputFileName: name, compression, format, passphrase: null });
  const path = join(work, name);
  writeFileSync(path, new Uint8Array(await out.arrayBuffer()));
  return path;
}
// 7z: a ready fixture (made with py7zr from the test page; libarchive's own 7z writer makes empty archives).
const cb7 = join(work, 'seven.cb7');
cpSync(join(ROOT, 'e2e/fixtures/chapter.cb7'), cb7);
const cbt = await archive('tarred.cbt', 'pax', 'gzip');
const zipAsCbr = join(work, 'zip-inside.cbr');
{
  const z = new JSZip();
  z.file('01.png', page);
  writeFileSync(zipAsCbr, await z.generateAsync({ type: 'uint8array' }));
}
// A small scan: the test page at half its size (the mock model knows the page's proportions).
const small = join(work, 'small.png');
{
  const src = PNG.sync.read(page);
  const dst = new PNG({ width: src.width / 2, height: src.height / 2 });
  for (let y = 0; y < dst.height; y++) for (let x = 0; x < dst.width; x++) for (let c = 0; c < 4; c++) dst.data[(y * dst.width + x) * 4 + c] = src.data[(y * 2 * src.width + x * 2) * 4 + c];
  writeFileSync(small, PNG.sync.write(dst));
}

// ---- the extension ----------------------------------------------------------------------------
const ext = join(tmpdir(), 'ait-ext-tools');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
const ortDir = dirname(createRequire(join(ROOT, 'apps/extension/package.json')).resolve('onnxruntime-web'));
const ORT_VERSION = JSON.parse(readFileSync(join(ortDir, '../package.json'), 'utf8')).version;

const { server: llm, calls } = await startMockLlm(18080);
const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1200, height: 1000 },
});
browser.on('targetcreated', async (t) => {
  if (t.url().includes('view=welcome')) (await t.page().catch(() => null))?.close().catch(() => {});
});

const setSettings = (p, patch) =>
  p.evaluate(async (patch) => {
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
    store.put({ ...s, ...patch }, 'settings');
    await new Promise((r) => (tx.oncomplete = r));
  }, patch);
const projects = (p) =>
  p.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate', 1);
      r.onsuccess = () => res(r.result);
    });
    const all = await new Promise((res) => {
      const g = db.transaction('projects').objectStore('projects').getAll();
      g.onsuccess = () => res(g.result ?? []);
    });
    return all.map((x) => ({ title: x.title, pages: x.pages.map((pg) => ({ name: pg.name, status: pg.status, width: pg.result?.width, texts: (pg.result?.blocks ?? []).map((b) => b.translatedText) })) }));
  });
const textOf = (p) => p.$eval('body', (b) => b.innerText);
const clickText = (p, text) => p.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t)?.click(), text);

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  const errors = [];
  studio.on('pageerror', (e) => errors.push(String(e)));
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('.ait-panel', { timeout: 15000 });
  await setSettings(studio, {
    providers: [{ id: 'mock', label: 'Mock VL', kind: 'openai-compatible', preset: 'custom', baseUrl: 'http://127.0.0.1:18080/v1', model: 'mock-vl', vision: true, jsonMode: 'json_object' }],
    visionProviderId: 'mock',
    translationProviderId: null,
    pipeline: 'standalone',
    readMode: 'vision',
    qaMode: 'off',
    twoStepTranslation: false,
    sourceLang: 'ja',
    targetLang: 'ru',
    onboarded: true,
    privacy: 'local',
    saveHistory: false,
    ...(UPSCALE_MODEL ? { upscaleMode: 'browser' } : {}),
  });
  if (UPSCALE_MODEL) {
    // The upscaler and the runtime as if downloaded (the files themselves, put into the extension's cache).
    const model = readFileSync(UPSCALE_MODEL).toString('base64');
    const wasm = readFileSync(join(ortDir, 'ort-wasm-simd-threaded.jsep.wasm')).toString('base64');
    await studio.evaluate(
      async (model, wasm, ver) => {
        const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const c = await caches.open('ait-models');
        await c.put('https://github.com/kclazzy/AI-translate/releases/download/models-2/upscale-art-2x.onnx', new Response(bytes(model)));
        await c.put(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/ort-wasm-simd-threaded.jsep.wasm`, new Response(bytes(wasm)));
      },
      model,
      wasm,
      ORT_VERSION,
    );
  }

  // The stand-in translator is offered in the settings.
  await studio.reload();
  await studio.waitForSelector('[data-testid="fallback"]', { timeout: 15000 });
  const fallbackOptions = await studio.$$eval('[data-testid="fallback"] option', (o) => o.map((x) => x.value));
  check('the settings offer a stand-in translator', fallbackOptions.includes('off') && fallbackOptions.includes(''), JSON.stringify(fallbackOptions));

  // «Облако» with no online model yet: the click offers to connect one right there.
  {
    const cloudBtn = await studio.$('[data-testid="ai-mode"] button[data-mode="cloud"]');
    const enabledBefore = cloudBtn ? await cloudBtn.evaluate((b) => !b.disabled) : false;
    await cloudBtn?.click();
    const form = await studio.waitForSelector('[data-testid="cloud-connect"]', { timeout: 5000 }).catch(() => null);
    let guide = null;
    if (form) {
      // Kimi: picked in the list, its guide (where the key is made) shows right in the form.
      await studio.select('[data-testid="cloud-connect"] select', 'kimi');
      guide = await studio.waitForSelector('[data-testid="cloud-connect"] [data-testid="guide-kimi"]', { timeout: 3000 }).then((g) => g.evaluate((d) => ({ href: d.querySelector('a')?.href, text: d.textContent }))).catch(() => null);
      check('the online-model form shows how to connect the chosen service (Kimi: where the key is made)', guide?.href === 'https://platform.kimi.ai/console/api-keys' && /platform\.kimi\.ai/.test(guide.text), JSON.stringify(guide));
      await studio.type('[data-testid="cloud-connect"] input', 'test-key-123');
      await studio.evaluate(() => [...document.querySelectorAll('[data-testid="cloud-connect"] button')].find((b) => b.textContent.includes('Подключить'))?.click());
      await new Promise((r) => setTimeout(r, 1200));
    }
    const s = await studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      return new Promise((res) => {
        const g = db.transaction('kv').objectStore('kv').get('settings');
        g.onsuccess = () => res(g.result);
      });
    });
    const v = s?.providers?.find((p) => p.id === s.visionProviderId);
    check('«Облако» without an online model: connect one in place, the mode switches and pictures may go out', enabledBefore && !!form && v && !/localhost|127\.0\.0\.1/.test(v.baseUrl) && v.preset === 'kimi' && v.baseUrl === 'https://api.moonshot.ai/v1' && s.privacy === 'cloud' && !JSON.stringify(s).includes('test-key-123'), JSON.stringify({ form: !!form, vision: v?.preset, privacy: s?.privacy }));
    // Back as it was for the rest of the test.
    await studio.evaluate(async () => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('ai-translate', 1);
        r.onsuccess = () => res(r.result);
      });
      const tx = db.transaction('kv', 'readwrite');
      const st = tx.objectStore('kv');
      const cur = await new Promise((res) => {
        const g = st.get('settings');
        g.onsuccess = () => res(g.result);
      });
      cur.providers = cur.providers.filter((p) => /localhost|127\.0\.0\.1/.test(p.baseUrl) || p.preset === 'browser');
      cur.visionProviderId = cur.providers.find((p) => p.vision)?.id ?? null;
      cur.privacy = 'local';
      st.put(cur, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
    });
  }

  // ---- archives → projects ----
  const open = async (file) => {
    await studio.goto(`chrome-extension://${extId}/studio.html?view=projects`);
    const input = await studio.waitForSelector('.ait-drop input[type="file"]', { timeout: 15000 });
    await input.uploadFile(file);
    await studio.waitForFunction(() => document.body.innerText.includes('← Проекты') || document.querySelector('.ait-error'), { timeout: 60000 });
    const err = await studio.$eval('.ait-error', (e) => e.innerText).catch(() => '');
    return err ? `ERROR: ${err}` : textOf(studio);
  };
  for (const [file, label] of [
    [cb7, '7z (.cb7)'],
    [cbt, 'TAR (.cbt)'],
    [zipAsCbr, 'a ZIP named .cbr'],
  ]) {
    const body = await open(file);
    const list = (await projects(studio)).find((p) => file.endsWith(`${p.title}.cbr`) || file.endsWith(`${p.title}.cb7`) || file.endsWith(`${p.title}.cbt`));
    const names = list?.pages.map((p) => p.name) ?? [];
    const want = file === zipAsCbr ? ['01.png'] : ['p2.png', 'p10.png'];
    check(`a chapter in ${label} opens, pages in order, other files left out`, JSON.stringify(names) === JSON.stringify(want), `${JSON.stringify(names)} ${body.startsWith('ERROR') ? body.slice(0, 300) : ''}`);
  }

  // ---- «Вычитка» on the 7z chapter ----
  await studio.goto(`chrome-extension://${extId}/studio.html?view=projects`);
  await studio.waitForSelector('.ait-table', { timeout: 15000 });
  await studio.evaluate(() => [...document.querySelectorAll('.ait-table button')].find((b) => b.textContent === 'seven')?.click());
  await studio.waitForFunction(() => document.body.innerText.includes('Перевести всё'), { timeout: 15000 });
  await clickText(studio, 'Перевести всё');
  await studio.waitForFunction(() => document.body.innerText.includes('2 из 2 готово'), { timeout: 90000 });
  await studio.click('[data-testid="tab-proofread"]');
  await studio.waitForSelector('[data-testid="proofread"] textarea', { timeout: 15000 });
  const rows = await studio.$$eval('[data-testid="proofread"] tbody tr', (r) => r.length);
  check('«Вычитка» lists every text of the chapter', rows === 4, `rows=${rows}`);
  // Edit the first line and replace a word on every page, then save.
  const first = await studio.$('[data-testid="proofread"] textarea');
  await first.evaluate((t) => t.select());
  await first.type('Стой, Танака!');
  await studio.type('[data-testid="proofread-replace"] input[aria-label="Найти в переводе"]', 'Куда');
  await studio.type('[data-testid="proofread-replace"] input[aria-label="Заменить на"]', 'Зачем');
  await studio.evaluate(() => [...document.querySelectorAll('[data-testid="proofread-replace"] button')].find((b) => b.textContent === 'Заменить везде')?.click());
  const pending = await studio.$eval('[data-testid="proofread-save"]', (b) => b.textContent);
  check('edits wait as drafts until saved', /Сохранить \(3\)/.test(pending), pending);
  await studio.click('[data-testid="proofread-save"]');
  await studio.waitForFunction(() => document.querySelector('[data-testid="proofread-save"]')?.textContent === 'Сохранено', { timeout: 60000 });
  const saved = (await projects(studio)).find((p) => p.title === 'seven');
  const texts = saved?.pages.flatMap((p) => p.texts) ?? [];
  check('saving draws the pages again with the edits and the replacement', texts[0] === 'Стой, Танака!' && texts.filter((t) => t.startsWith('Зачем')).length === 2 && !texts.some((t) => t.startsWith('Куда')), JSON.stringify(texts));
  await studio.screenshot({ path: join(OUT, 'tools-proofread.png'), fullPage: true });

  // ---- a small scan twice as big ----
  if (UPSCALE_MODEL) {
    const before = calls.length;
    await open(small);
    await clickText(studio, 'Перевести всё');
    await studio.waitForFunction(() => document.body.innerText.includes('1 из 1 готово') || document.querySelector('.ait-badge.err'), { timeout: 240000 });
    const p = (await projects(studio)).find((x) => x.title === 'small');
    const pg = p?.pages[0];
    check('a small scan is translated twice as big', pg?.status === 'done' && pg.width === 800 && pg.texts.length === 2 && calls.length > before, JSON.stringify(pg));
  } else {
    console.log('(upscaler: skipped without UPSCALE_MODEL)');
  }
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('no crash', false, String(e?.stack ?? e));
} finally {
  await browser.close().catch(() => {});
  llm.close();
}
writeFileSync(join(OUT, 'e2e-tools.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
