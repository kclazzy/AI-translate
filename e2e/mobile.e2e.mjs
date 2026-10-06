// End-to-end test of the phone app (the same web build runs inside the Android/iOS shells):
// first-run setup → translate a picture on the device → open the editor.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'apps/mobile/dist');
const OUT = join(ROOT, '.test-output');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  // Shows up as an annotation on GitHub Actions.
  if (!ok && process.env.GITHUB_ACTIONS) console.log(`::error title=e2e: ${name.replace(/[:,\n]/g, ' ')}::${String(detail).replace(/\n/g, ' ').slice(0, 900)}`);
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.mjs': 'text/javascript' };
const app = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(DIST, path === '/' ? 'index.html' : path);
  try {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => app.listen(18082, '127.0.0.1', r));
const { server: llm, calls } = await startMockLlm(18080);
let browser;
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
} catch (e) {
  check('browser launches', false, String(e?.stack ?? e));
  writeFileSync(join(OUT, 'e2e-mobile.json'), JSON.stringify(results, null, 2));
  process.exit(1);
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
  await page.goto('http://127.0.0.1:18082/');
  await page.waitForSelector('input[name="setup"]', { timeout: 15000 });
  await page.screenshot({ path: join(OUT, 'mobile-setup.png') });
  check('first-run setup is shown', true);

  // Choose "model on my PC over Wi-Fi" and point it at the mock server.
  const radios = await page.$$('input[name="setup"]');
  await radios[1].click();
  const inputs = await page.$$('.ait-panel input.ait-input');
  for (const [el, value] of [[inputs[0], 'http://127.0.0.1:18080/v1'], [inputs[1], 'mock-vl']]) {
    await el.evaluate((node) => {
      node.focus();
      node.select();
    });
    await el.type(value);
  }
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Готово')?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Выбрать картинку'), { timeout: 15000 });
  const home = await page.$eval('body', (b) => b.innerText);
  check('setup finishes and opens the translate screen', home.includes('Перевести изображение') && home.includes('Локально'));

  // Translate a picture chosen from the "gallery".
  const fileInput = await page.waitForSelector('input[type="file"][accept="image/*"]', { timeout: 10000 });
  await fileInput.uploadFile(join(ROOT, 'e2e/fixtures/page.png'));
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Блоков: 2'), { timeout: 30000 });
  } catch (e) {
    await page.screenshot({ path: join(OUT, 'mobile-fail.png') });
    throw new Error(`translation did not finish: ${(await page.$eval('body', (b) => b.innerText)).slice(0, 400)}`);
  }
  check('picture translated on the phone without a PC engine', calls.length === 1, `model calls=${calls.length}`);
  await page.screenshot({ path: join(OUT, 'mobile-result.png'), fullPage: true });

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Править')?.click());
  await page.waitForSelector('.ait-stage canvas', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: join(OUT, 'mobile-editor.png') });
  const ed = await page.$eval('body', (b) => b.innerText);
  check('editor works on a phone screen', ed.includes('Блоки (2)'));

  // Navigation and settings render on a small screen.
  await page.evaluate(() => [...document.querySelectorAll('.ait-nav-btn')].find((b) => b.textContent.includes('Настройки'))?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Где обрабатывать'));
  await page.screenshot({ path: join(OUT, 'mobile-settings.png') });
  check('settings open from the bottom navigation', true);
  check('PWA manifest has a share target', JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8')).share_target?.method === 'POST');
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('unexpected failure', false, String(e?.stack ?? e));
} finally {
  await browser.close();
  llm.close();
  app.close();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(OUT, 'e2e-mobile.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
