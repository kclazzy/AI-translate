// In-app update: "Проверить обновления" → "Обновить сейчас" downloads the release zip,
// writes the new extension files into the picked folder and reloads the extension.
// The folder is an origin-private directory standing in for the user's extension folder;
// GitHub is answered by request interception.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const JSZip = createRequire(join(ROOT, 'packages/studio/package.json'))('jszip');
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e update: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-update');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const zip = new JSZip();
zip.file('extension-chrome/manifest.json', JSON.stringify({ ...manifest, version: '9.9.9' }));
zip.file('extension-chrome/assets/new.js', 'console.log("new")');
zip.file('extension-chrome/studio.html', '<!doctype html><title>new</title>');
zip.file('engine/README.md', 'engine');
const zipBytes = Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
const ASSET = 'https://github.com/kclazzy/AI-translate/releases/download/v9.9.9/ai-translate-desktop-v9.9.9.zip';

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1100, height: 1000 },
});
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('https://api.github.com/repos/kclazzy/AI-translate/releases/latest')) {
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/kclazzy/AI-translate/releases/tag/v9.9.9', body: 'notes', assets: [{ name: 'ai-translate-desktop-v9.9.9.zip', browser_download_url: ASSET, size: zipBytes.length }, { name: 'ai-translate-android-v9.9.9.apk', browser_download_url: 'https://x/a.apk' }] }) });
    }
    if (u === ASSET) return req.respond({ status: 200, contentType: 'application/zip', headers: { 'access-control-allow-origin': '*', 'content-length': String(zipBytes.length) }, body: zipBytes });
    return req.continue();
  });
  await page.goto(`chrome-extension://${extId}/studio.html?view=settings&update=1`);
  // Stand-in for the user's extension folder: same manifest as the running extension, an old bundle and a user file.
  await page.evaluate(async (m) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('ext', { create: true });
    const put = async (d, name, text) => {
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    await put(dir, 'manifest.json', JSON.stringify(m));
    await put(await dir.getDirectoryHandle('assets', { create: true }), 'old.js', 'old');
    await put(dir, 'notes.txt', 'mine');
    window.showDirectoryPicker = async () => dir;
    window.__reloaded = false;
    chrome.runtime.reload = () => {
      window.__reloaded = true;
    };
  }, manifest);
  await page.waitForFunction(() => document.body.innerText.includes('Есть версия 9.9.9'), { timeout: 15000 });
  check('update check finds the new release', true);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Обновить сейчас')?.click());
  await page.waitForFunction(() => window.__reloaded === true, { timeout: 20000 }).catch(() => {});
  const state = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ext');
    const text = async (d, n) => (await (await d.getFileHandle(n)).getFile()).text().catch(() => null);
    const assets = await dir.getDirectoryHandle('assets');
    const names = [];
    for await (const k of assets.keys()) names.push(k);
    return {
      reloaded: window.__reloaded,
      version: JSON.parse(await text(dir, 'manifest.json')).version,
      studio: await text(dir, 'studio.html'),
      assets: names.sort(),
      notes: await text(dir, 'notes.txt'),
      engineCopied: await dir.getDirectoryHandle('engine').then(() => true, () => false),
      ui: document.querySelector('[data-testid="update-check"]')?.innerText,
    };
  });
  await page.screenshot({ path: join(OUT, 'update.png') });
  check('new files are written into the extension folder', state.version === '9.9.9' && state.studio?.includes('new'), JSON.stringify(state));
  check('old bundles are removed, the user’s own files are kept', state.assets.join() === 'new.js' && state.notes === 'mine' && !state.engineCopied, JSON.stringify(state.assets));
  check('the extension reloads itself after the update', state.reloaded === true, state.ui);

  // A folder of another extension is refused without writing anything.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('other', { create: true });
    const w = await (await dir.getFileHandle('manifest.json', { create: true })).createWritable();
    await w.write(JSON.stringify({ name: 'Something else', version: '1.0' }));
    await w.close();
    window.showDirectoryPicker = async () => dir;
    const req = indexedDB.open('ai-translate', 1);
    await new Promise((r) => (req.onsuccess = r));
    await new Promise((r) => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete('update-dir');
      tx.oncomplete = r;
    });
  });
  await page.reload();
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => navigator.storage.getDirectory().then((r) => r.getDirectoryHandle('other'));
  });
  await page.waitForFunction(() => document.body.innerText.includes('Есть версия 9.9.9'), { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Обновить сейчас')?.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="update-check"]')?.innerText.includes('нет расширения'), { timeout: 10000 }).catch(() => {});
  const err = await page.$eval('[data-testid="update-check"]', (e) => e.innerText);
  check('a wrong folder is refused with an explanation', err.includes('нет расширения'), err);
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-update.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
