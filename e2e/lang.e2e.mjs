// Interface language: "as in the system" follows the browser (Windows) language; choosing a
// language in Settings switches the studio, the popup, the page overlays and the context menu.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e lang: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-lang');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>P</title><img src="/page.png" width="800" height="1100">');
  if (req.url === '/page.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(readFileSync(new URL('./fixtures/page.png', import.meta.url)));
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18121, '127.0.0.1', r));

const cdp = !!process.env.E2E_CDP_EXTENSIONS;
// The "system" is German: with "as in the system" the interface must come up in German.
const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'de_DE.UTF-8', LANGUAGE: 'de' },
  executablePath: CHROME,
  headless: false,
  ...(cdp ? { pipe: true, enableExtensions: [ext] } : {}),
  args: [...(cdp ? [] : [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]), '--no-sandbox', '--lang=de', '--no-first-run', '--disable-gpu'],
  defaultViewport: { width: 1200, height: 1400 },
});
// The welcome tab opened on install would take the focus from the pages under test.
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));


const text = (p) => p.evaluate(() => document.body.innerText);
// Language names are written in their own language everywhere; ignore them when looking for Russian.
const NATIVE = /Русский|Українська|Беларуская|Қазақша|Српски|Български|Македонски|Монгол/g;
const russian = (s) => (s.replace(NATIVE, '').match(/[^\n]*[А-Яа-яЁё]{4}[^\n]*/g) ?? []).join(' | ').slice(0, 400);

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=settings`);
  await studio.waitForSelector('[data-testid="ui-lang"]', { timeout: 15000 });
  const de = await text(studio);
  await studio.screenshot({ path: join(OUT, 'lang-de-settings.png') });
  check('"as in the system" shows the interface in the system language (German)', de.includes('Einstellungen') && !de.includes('Настройки'), de.slice(0, 200));

  // Choose English: the page reloads in English.
  await Promise.all([studio.waitForNavigation({ timeout: 15000 }).catch(() => null), studio.select('[data-testid="ui-lang"]', 'en')]);
  await studio.waitForSelector('[data-testid="ui-lang"]', { timeout: 15000 });
  const en = await text(studio);
  await studio.screenshot({ path: join(OUT, 'lang-en-settings.png'), fullPage: true });
  check('choosing English switches the studio', en.includes('Settings') && en.includes('Interface language') && !russian(en), russian(en));

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => document.body.innerText.length > 40, { timeout: 10000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const p = await text(popup);
  await popup.screenshot({ path: join(OUT, 'lang-en-popup.png') });
  check('the popup follows', p.includes('Translate page') && !russian(p), russian(p));

  // The page overlay (content script) speaks English too.
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18121/');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await new Promise((r) => setTimeout(r, 800));
  await page.hover('img');
  await new Promise((r) => setTimeout(r, 500));
  const client = page.createCDPSession ? await page.createCDPSession() : await page.target().createCDPSession();
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const texts = [];
  const walk = (n) => {
    if (n.nodeType === 3 && n.nodeValue?.trim()) texts.push(n.nodeValue.trim());
    for (const a of n.attributes ?? []) texts.push(a);
    (n.children ?? []).forEach(walk);
    (n.shadowRoots ?? []).forEach(walk);
  };
  walk(root);
  check('the button on pictures follows', texts.includes('Translate') && !texts.some((x) => /^Перевести/.test(x)), texts.filter((x) => /Transl|Перев/.test(x)).join(' | '));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  site.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-lang.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
