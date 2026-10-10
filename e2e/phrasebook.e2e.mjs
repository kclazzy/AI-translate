// «Разговорник» in the Studio: the section renders with the built-in expressions, switching one off
// is saved (and still off after a reload), a genre set can be switched on and an own expression added.
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
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e phrasebook: ${name}::${String(detail).slice(0, 500)}`);
};

const ext = join(tmpdir(), 'ait-ext-phrasebook');
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
  defaultViewport: { width: 1100, height: 1300 },
});
// The welcome tab opened on install would take the focus from the pages under test.
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

/** The settings as saved by the Studio (the extension keeps them in IndexedDB). */
const stored = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ai-translate');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return new Promise((res) => {
      const g = db.transaction('kv').objectStore('kv').get('settings');
      g.onsuccess = () => res(g.result?.phrasebook ?? null);
      g.onerror = () => res(null);
    });
  });
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return v;
};

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studio = await browser.newPage();
  await studio.goto(`chrome-extension://${extId}/studio.html?view=glossary`);
  await studio.waitForSelector('[data-testid="glossary-tabs"]', { timeout: 15000 });
  // The tab «Разговорник» next to «Глоссарий и контекст».
  await studio.evaluate(() => [...document.querySelectorAll('[data-testid="glossary-tabs"] button')].find((b) => b.textContent === 'Разговорник')?.click());
  await studio.waitForSelector('[data-testid="phrasebook"]', { timeout: 10000 });
  const text = await studio.evaluate(() => document.body.innerText);
  check('the phrasebook section opens from the glossary page', text.includes('Подсказывать модели устойчивые выражения (разговорник)') && text.includes('Культивация (сянься, уся)') && text.includes('Свои выражения'));
  const rows = await studio.$$eval('[data-testid="pb-row"]', (r) => r.length);
  check('built-in expressions are listed (at most 200 at once)', rows > 50 && rows <= 200, String(rows));

  // Search, then switch なるほど off.
  await studio.type('[data-testid="pb-search"]', 'なるほど');
  await studio.waitForFunction(() => document.querySelector('[data-testid="pb-row"][data-id="ja:naruhodo"]'), { timeout: 5000 });
  const found = await studio.$$eval('[data-testid="pb-row"]', (r) => r.map((x) => x.dataset.id));
  check('search finds the expression', found.includes('ja:naruhodo') && found.length < 10, found.join(', '));
  await studio.click('[data-testid="pb-row"][data-id="ja:naruhodo"] input[type="checkbox"]');
  const saved = await waitFor(async () => ((await stored(studio))?.disabled ?? []).includes('ja:naruhodo'));
  check('switching an expression off is saved', !!saved, JSON.stringify(await stored(studio)));

  // A genre set on.
  await studio.evaluate(() => [...document.querySelectorAll('[data-testid="phrasebook"] label.ait-switch')].find((l) => l.textContent.includes('Культивация'))?.querySelector('input')?.click());
  const genre = await waitFor(async () => ((await stored(studio))?.genres ?? []).includes('cultivation'));
  check('the cultivation set can be switched on', !!genre);

  // An own expression.
  await studio.click('[data-testid="pb-add"]');
  await studio.type('[data-testid="pb-forms"]', 'へえ, ほう');
  await studio.type('[data-testid="pb-variant"]', 'Надо же');
  await studio.click('[data-testid="pb-save"]');
  const user = await waitFor(async () => (await stored(studio))?.user?.[0]);
  check('an own expression is added', user?.source === 'ja' && user.src.join('|') === 'へえ|ほう' && user.variants[0].text === 'Надо же', JSON.stringify(user));

  // After a reload everything is as it was left.
  await studio.goto(`chrome-extension://${extId}/studio.html?view=glossary&tab=phrasebook`);
  await studio.waitForSelector('[data-testid="pb-row"]', { timeout: 15000 });
  await studio.type('[data-testid="pb-search"]', 'なるほど');
  await studio.waitForFunction(() => document.querySelector('[data-testid="pb-row"][data-id="ja:naruhodo"]'), { timeout: 5000 });
  const off = await studio.$eval('[data-testid="pb-row"][data-id="ja:naruhodo"] input[type="checkbox"]', (i) => !i.checked);
  const userRows = await studio.$$eval('[data-testid="pb-user-row"]', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  check('after a reload the expression stays off and the own one is listed', off && userRows.length === 1 && userRows[0].includes('Надо же'), JSON.stringify(userRows));
  await studio.screenshot({ path: join(OUT, 'phrasebook.png'), fullPage: false });
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-phrasebook.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
