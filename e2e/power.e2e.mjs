// The on/off switch: while AI Translate is off, no "Перевести" button appears over pictures;
// switching it back on brings the button back.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e power: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-power');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>P</title><img id="p" src="/page.png" width="800" height="1100">');
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18131, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1000, height: 1200 },
});

/** Is the floating "Перевести" button shown (it lives in a closed shadow root)? */
async function buttonShown(page) {
  const c = page.createCDPSession ? await page.createCDPSession() : await page.target().createCDPSession();
  const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
  let shown = false;
  const walk = (n) => {
    if (n.nodeName === 'BUTTON') {
      const a = n.attributes ?? [];
      const label = a[a.indexOf('aria-label') + 1] ?? '';
      const style = a.includes('style') ? a[a.indexOf('style') + 1] : '';
      if (/Перевести изображение/.test(label) && /display:\s*block/.test(style)) shown = true;
    }
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  await c.detach();
  return shown;
}

async function hover(page) {
  for (const [x, y] of [[300, 300], [420, 380], [500, 420]]) {
    await page.mouse.move(x, y);
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 300));
}

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const ctl = await browser.newPage();
  await ctl.goto(`chrome-extension://${extId}/popup.html`);
  const setEnabled = (on) => ctl.evaluate((v) => chrome.runtime.sendMessage({ type: 'set-enabled', enabled: v }), on);

  // Off before the page opens: the button never appears.
  await setEnabled(false);
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18131/');
  await page.waitForFunction(() => document.querySelector('#p')?.complete);
  await new Promise((r) => setTimeout(r, 1200));
  await hover(page);
  check('switched off: no "Перевести" button over pictures', !(await buttonShown(page)));

  // On again: the page learns it without a reload.
  await setEnabled(true);
  await new Promise((r) => setTimeout(r, 800));
  await hover(page);
  check('switched on: the button is back', await buttonShown(page));

  // Off while the page is open: hidden at once.
  await setEnabled(false);
  await new Promise((r) => setTimeout(r, 800));
  await hover(page);
  check('switched off on an open page: the button disappears', !(await buttonShown(page)));
  await setEnabled(true);
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-power.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
