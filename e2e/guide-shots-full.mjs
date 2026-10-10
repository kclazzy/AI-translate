// Screenshots for the full user guide: the buttons over a translated picture, ⓘ with «Сообщить о
// проблеме», the page progress, the editor (and its compare slider), LaMa / text detector settings,
// the speed benchmark, the phrasebook, the speed switches and the in-app update.
// Not a test; run by hand (the extension must be built: pnpm -r run build):
//   CHROME_PATH=… xvfb-run -a node e2e/guide-shots-full.mjs <out dir>
// A fake Ollama (port 11434) with the default model answers like a real local model, a bit slower
// than the bare mock so the timings look real; the page itself is read by the mock LLM.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startMockLlm } from './mock-llm.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.argv[2] ?? join(ROOT, '.test-output/guide-full');
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
mkdirSync(OUT, { recursive: true });
const shot = (name) => join(OUT, `${name}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ext = join(tmpdir(), 'ait-ext-guide-full');
if (existsSync(ext)) rmSync(ext, { recursive: true });
cpSync(join(ROOT, 'apps/extension/dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
delete manifest.minimum_chrome_version;
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

// ---- fake Ollama with the default model installed ------------------------------------------
const LLM_PORT = 18091;
const { server: llm } = await startMockLlm(LLM_PORT);
const MODEL = 'qwen3.5:9b-q4_K_M';
const ollama = createServer((req, res) => {
  const json = (code, body) => res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));
  const read = (fn) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => fn(b));
  };
  const url = req.url ?? '';
  if (url === '/api/tags') return json(200, { models: [{ name: MODEL, model: MODEL, size: 6.6e9, details: { family: 'qwen35', parameter_size: '9B', quantization_level: 'Q4_K_M' } }] });
  if (url === '/api/show') return read(() => json(200, { capabilities: ['completion', 'vision'] }));
  if (url === '/api/ps') return json(200, { models: [{ name: MODEL, model: MODEL, size_vram: 6.6e9, size: 6.6e9 }] });
  if (url === '/api/version') return json(200, { version: '0.12.0' });
  if (url === '/api/generate') return read(() => json(200, { done: true }));
  if (url.endsWith('/models')) return json(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
  if (req.method !== 'POST') return json(404, { error: 'not found' });
  const native = url === '/api/chat';
  return read((b) => {
    const body = JSON.parse(b || '{}');
    const reply = (content, usage, delay) =>
      setTimeout(
        () => json(200, native ? { model: MODEL, message: { role: 'assistant', content }, prompt_eval_count: usage[0], eval_count: usage[1], done: true } : { model: MODEL, choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: usage[0], completion_tokens: usage[1] } }),
        delay,
      );
    const system = String(body.messages?.[0]?.content ?? '');
    const text = JSON.stringify(body.messages ?? []);
    if (system.includes('editor-in-chief')) {
      // The check finds one small thing to fix, so the page shows 🔍 with a remark.
      const last = body.messages.at(-1);
      const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(typeof last.content === 'string' ? last.content : '')?.[1] ?? '[]');
      const reviews = blocks.map((x, i) =>
        i === 0 ? { id: x.id, ok: false, issues: [{ kind: 'punctuation', severity: 'minor', note: 'Обращение лучше отделить запятой и закончить восклицательным знаком' }], fix: 'Танака, подожди!' } : { id: x.id, ok: true },
      );
      return reply(JSON.stringify({ reviews }), [640, 60], 900);
    }
    // The model self-test reads a tiny picture; page translation goes to the mock that knows the fixture.
    if (!/manga|comic/i.test(text)) return reply(JSON.stringify({ text: 'こんにちは', translation: 'Привет' }), [900, 20], 300);
    const vision = /image/.test(text) && /The image is \d+×\d+/.test(text);
    const fwd = request({ host: '127.0.0.1', port: LLM_PORT, path: native ? '/api/chat' : '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (r) => {
      let out = '';
      r.on('data', (c) => (out += c));
      r.on('end', () => {
        const j = JSON.parse(out);
        if (j.model) j.model = MODEL;
        setTimeout(() => res.writeHead(r.statusCode, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(j)), vision ? 3200 : 1300);
      });
    });
    fwd.end(b);
  });
});
await new Promise((r) => ollama.listen(11434, '127.0.0.1', r));

// ---- a reader site with one manga page --------------------------------------------------------
const png = readFileSync(new URL('./fixtures/page.png', import.meta.url));
const SITE = 'http://127.0.0.1:18097';
const site = createServer((req, res) => {
  if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><meta charset="utf-8"><title>Глава 1 — читалка</title><style>body{margin:0;background:#222;font-family:sans-serif}header{color:#ddd;padding:12px 20px;font-size:18px}img{display:block;margin:0 auto 12px;width:520px}</style><header>Моя манга · Глава 1</header><img id="p1" src="/p1.png" width="520" height="715">`);
  if (req.url === '/p1.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(18097, '127.0.0.1', r));

const browser = await puppeteer.launch({
  env: { ...process.env, LANG: 'ru_RU.UTF-8', LANGUAGE: 'ru' },
  executablePath: CHROME,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-sandbox', '--lang=ru', '--no-first-run', '--disable-gpu', '--hide-scrollbars'],
  defaultViewport: { width: 1200, height: 860 },
});
// The welcome tab opened on install would take the focus from the pages being shot.
const closeWelcome = async (t) => {
  if (!t.url().includes('view=welcome')) return;
  const p = await t.page().catch(() => null);
  await p?.close().catch(() => {});
};
browser.on('targetcreated', (t) => void closeWelcome(t));
browser.on('targetchanged', (t) => void closeWelcome(t));

// ---- helpers ------------------------------------------------------------------------------------
/** Screenshot of a box in document coordinates, plus a margin. */
async function clipBox(page, box, name, pad = 12) {
  if (!box) throw new Error(`no element for ${name}`);
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  await page.screenshot({ path: shot(name), clip: { x, y, width: Math.ceil(box.w + pad * 2 + (box.x - pad - x)), height: Math.ceil(box.h + pad * 2 + (box.y - pad - y)) } });
  console.log('✓', name);
}
/** Document box that covers all elements matched by the selectors ("sel >> closest(.x)" / "sel >> parent" go up). */
const unionBox = (page, sels) =>
  page.evaluate((sels) => {
    const els = sels
      .map((s) => {
        const [sel, up] = s.split(' >> ');
        const el = document.querySelector(sel);
        if (!el || !up) return el;
        if (up === 'parent') return el.parentElement;
        return el.closest(/^closest\((.*)\)$/.exec(up)[1]);
      })
      .filter(Boolean);
    if (!els.length) return null;
    const rs = els.map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left));
    const y = Math.min(...rs.map((r) => r.top));
    return { x, y: y + scrollY, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y };
  }, sels);

/** Text of a node from DOM.getDocument (pierce). */
function textOf(n) {
  let t = '';
  const walk = (x) => {
    if (x.nodeType === 3) t += x.nodeValue;
    (x.children ?? []).forEach(walk);
    (x.shadowRoots ?? []).forEach(walk);
  };
  walk(n);
  return t.trim();
}
const attr = (n, name) => {
  const a = n.attributes ?? [];
  const i = a.indexOf(name);
  return i >= 0 && i % 2 === 0 ? a[i + 1] : undefined;
};
/** Viewport boxes of nodes (also inside closed shadow roots) that match. */
async function shadowBoxes(p, match) {
  const c = await p.target().createCDPSession();
  try {
    const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
    const all = [];
    const walk = (n) => {
      all.push(n);
      (n.children ?? []).forEach(walk);
      (n.shadowRoots ?? []).forEach(walk);
    };
    walk(root);
    const out = [];
    for (const n of all.filter(match)) {
      const m = await c.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId }).catch(() => null);
      if (!m) continue;
      const q = m.model.border;
      out.push({ x: q[0], y: q[1], w: q[4] - q[0], h: q[5] - q[1], text: textOf(n) });
    }
    return out;
  } finally {
    await c.detach();
  }
}
const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
const waitFor = async (fn, ms = 20000, step = 300) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return null;
};

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  const studioUrl = (q) => `chrome-extension://${extId}/studio.html?${q}`;

  // Settings page first: it also sends the «Перевести страницу» command.
  const studio = await browser.newPage();
  studio.on('dialog', (d) => void d.accept());
  await studio.setViewport({ width: 1200, height: 1000 });
  await studio.goto(studioUrl('view=settings'));
  await studio.waitForSelector('.ait-panel', { timeout: 15000 });

  // ---- the page: translate, progress, buttons, ⓘ --------------------------------------------
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 860 });
  await page.goto(`${SITE}/`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await sleep(600);
  await studio.evaluate(async (site) => {
    const [t] = await chrome.tabs.query({ url: `${site}/*` });
    await chrome.runtime.sendMessage({ type: 'popup-command', command: 'translate-page', tabId: t.id });
  }, SITE);
  await page.bringToFront();
  await page.mouse.move(40, 40);
  const isPanel = (n) => n.localName === 'div' && attr(n, 'class') === 'p' && attr(n, 'role') === 'status';
  const panel = await waitFor(async () => (await shadowBoxes(page, isPanel)).find((b) => b.text.includes('Затрачено времени') && b.text.includes('Готово')), 90000, 500);
  if (!panel) throw new Error('page translation did not finish');
  // The review redraws the picture once more: let it settle.
  await sleep(2500);
  const panelNow = (await shadowBoxes(page, isPanel)).find((b) => b.text.includes('Готово')) ?? panel;
  await clipBox(page, panelNow, '13-progress-done');
  // Close the panel so it does not cover the picture.
  const close = (await shadowBoxes(page, (n) => n.localName === 'button' && textOf(n) === 'Закрыть'))[0];
  if (close) await page.mouse.click(...center(close));
  await sleep(500);

  const img = await page.$eval('#p1', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height };
  });
  // The buttons are bright while the pointer is on their bar: rest it in the gap between two of them.
  const barButtons = async () => (await shadowBoxes(page, (n) => n.localName === 'button' && ['⇄', '◫', '✎', '⟳', 'ⓘ', '🔍'].some((s) => textOf(n).startsWith(s)))).sort((a, b) => a.x - b.x);
  const btns = await waitFor(async () => {
    const l = await barButtons();
    return l.length >= 6 ? l : null;
  }, 15000);
  if (!btns) console.log('warning: buttons', (await barButtons()).map((b) => b.text).join(' '));
  const bl = btns ?? (await barButtons());
  await page.mouse.move(img.x + img.w / 2, img.y + 200);
  // A plain move does not always repaint :hover here; a click on the bar's background (no button) does.
  await page.mouse.click(bl[0].x + bl[0].w + 2, bl[0].y + bl[0].h / 2);
  await sleep(900);
  // The pointer rests on the bar, but taking the screenshot can drop the :hover state; so the bar is
  // also held at its hover look (opacity 1) for the shot.
  await page.mouse.move(bl[0].x + bl[0].w + 1, bl[0].y + bl[0].h / 2 + 1);
  await page.mouse.move(bl[0].x + bl[0].w + 2, bl[0].y + bl[0].h / 2);
  await waitFor(async () => {
    const c = await page.target().createCDPSession();
    try {
      const { root } = await c.send('DOM.getDocument', { depth: -1, pierce: true });
      const all = [];
      const walk = (n) => (all.push(n), (n.children ?? []).forEach(walk), (n.shadowRoots ?? []).forEach(walk));
      walk(root);
      const bar = all.find((n) => attr(n, 'class') === 'bar');
      const { object } = await c.send('DOM.resolveNode', { backendNodeId: bar.backendNodeId });
      const r = await c.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){this.style.opacity="1";return getComputedStyle(this).opacity}', returnByValue: true });
      return r.result.value === '1';
    } finally {
      await c.detach();
    }
  }, 5000, 100);
  await sleep(250);
  await clipBox(page, img, '11-overlay-buttons');

  // ⓘ → page info with «Что не так?» and «Сообщить о проблеме».
  const info = bl.find((b) => b.text === 'ⓘ');
  await page.mouse.click(...center(info));
  await sleep(600);
  const infoPanel = (await shadowBoxes(page, (n) => n.localName === 'div' && attr(n, 'class') === 'info'))[0];
  await page.mouse.move(info.x + info.w / 2, info.y + info.h / 2);
  await sleep(300);
  {
    const bottom = infoPanel.y + infoPanel.h;
    const x = infoPanel.x - 150;
    await clipBox(page, { x, y: img.y, w: img.x + img.w - x, h: bottom - img.y + 8 }, '12-info-report', 12);
  }
  await page.mouse.click(...center(info)); // close it again

  // ---- the editor --------------------------------------------------------------------------------
  const key = await studio.evaluate(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('ai-translate');
      r.onsuccess = () => res(r.result);
    });
    return new Promise((res) => {
      const g = db.transaction('history').objectStore('history').getAll();
      g.onsuccess = () => res(g.result.find((h) => h.status === 'done')?.key ?? null);
    });
  });
  if (!key) throw new Error('no translated page in the history');
  const ed = await browser.newPage();
  await ed.setViewport({ width: 1200, height: 800 });
  await ed.goto(studioUrl(`key=${encodeURIComponent(key)}`));
  await ed.waitForSelector('.ait-stage canvas', { timeout: 15000 });
  // Let the «Сохранено» note go away, then select the first block on the picture.
  await sleep(4000);
  await ed.click('.ait-box');
  await sleep(600);
  await ed.evaluate(() => {
    scrollTo(0, 0);
    for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
  });
  await ed.mouse.move(5, 795);
  await sleep(400);
  await ed.screenshot({ path: shot('14-editor') });
  console.log('✓ 14-editor');
  await ed.click('[data-testid="compare"]');
  await ed.waitForSelector('.ait-compare-handle', { timeout: 5000 });
  await sleep(500);
  await ed.mouse.move(5, 795);
  await ed.screenshot({ path: shot('15-editor-compare') });
  console.log('✓ 15-editor-compare');

  // ---- settings ----------------------------------------------------------------------------------
  await studio.bringToFront();
  await studio.reload();
  await studio.waitForSelector('[data-testid="lama"] select', { timeout: 15000 });
  await studio.select('[data-testid="lama"] select', 'browser');
  // For this shot only, the column is two grid cells wide, so the long choice
  // «Прямо в браузере (видеокарта, модель ~200 МБ)» is not cut off in its field.
  await studio.addStyleTag({ content: '.ait-grid2 > :has([data-testid="lama"]) { grid-column: span 2; } [data-testid="lama"], [data-testid="detector"] { max-width: 460px; }' });
  await studio.waitForSelector('[data-testid="detector"] button', { timeout: 10000 }).catch(() => {});
  await sleep(600);
  await studio.evaluate(() => document.querySelector('[data-testid="lama"]').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await clipBox(studio, await unionBox(studio, ['[data-testid="lama"]', '[data-testid="detector"]']), '16-settings-lama-detector');
  await studio.reload();
  await studio.waitForSelector('[data-testid="skip-empty"]', { timeout: 15000 });
  await sleep(600);

  await studio.evaluate(() => document.querySelector('[data-testid="skip-empty"]').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await clipBox(studio, await unionBox(studio, ['[data-testid="skip-empty"]', '[data-testid="qa-batch"]', '[data-testid="self-check"]']), '19-settings-speed');

  await studio.evaluate(() => scrollTo(0, 0));
  await studio.evaluate(() => [...document.querySelectorAll('[data-testid="speed-benchmark"] button')].find((b) => b.textContent === 'Замерить скорость')?.click());
  await studio.waitForSelector('[data-testid="speed-result"]', { timeout: 60000 });
  await sleep(500);
  await studio.evaluate(() => document.querySelector('[data-testid="speed-benchmark"]').closest('.ait-panel').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await clipBox(studio, await unionBox(studio, ['[data-testid="speed-benchmark"] >> closest(.ait-panel)']), '17-speed-benchmark', 12);

  // ---- phrasebook ------------------------------------------------------------------------------
  await studio.setViewport({ width: 1200, height: 1400 });
  await studio.goto(studioUrl('view=glossary&tab=phrasebook'));
  await studio.waitForSelector('[data-testid="pb-row"]', { timeout: 15000 });
  await sleep(800);
  // From the tabs to the fourth expression of the Japanese list.
  const pb = await studio.evaluate(() => {
    const tabs = document.querySelector('[data-testid="glossary-tabs"]').getBoundingClientRect();
    const box = document.querySelector('[data-testid="phrasebook"]').getBoundingClientRect();
    const rows = [...document.querySelectorAll('[data-testid="pb-row"]')].slice(0, 4).map((r) => r.getBoundingClientRect());
    const list = document.querySelector('[data-testid="pb-row"]').closest('.ait-panel')?.getBoundingClientRect() ?? box;
    const x = Math.min(tabs.left, box.left, list.left);
    return { x, y: tabs.top + scrollY, w: Math.max(box.right, list.right) - x, h: rows.at(-1).bottom - 6 - tabs.top };
  });
  await clipBox(studio, pb, '18-phrasebook');

  // ---- update ------------------------------------------------------------------------------------
  const NEW = '1.1.0';
  const up = await browser.newPage();
  await up.setViewport({ width: 1200, height: 1000 });
  await up.setRequestInterception(true);
  up.on('request', (req) => {
    const u = req.url();
    const cors = { 'access-control-allow-origin': '*' };
    if (u.startsWith('https://api.github.com/')) {
      return req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ tag_name: `v${NEW}`, html_url: `https://github.com/kclazzy/AI-translate/releases/tag/v${NEW}`, body: 'notes', assets: [{ name: `ai-translate-desktop-v${NEW}.zip`, browser_download_url: `https://github.com/kclazzy/AI-translate/releases/download/v${NEW}/ai-translate-desktop-v${NEW}.zip`, size: 6e6 }] }) });
    }
    if (u === 'https://github.com/kclazzy/AI-translate/releases/latest') return req.respond({ status: 302, headers: { ...cors, location: `https://github.com/kclazzy/AI-translate/releases/tag/v${NEW}` }, body: '' });
    if (u.startsWith('https://github.com/')) return req.respond({ status: 200, contentType: 'text/html', headers: cors, body: '<html></html>' });
    return req.continue();
  });
  await up.goto(studioUrl('view=settings&update=1'));
  await up.bringToFront();
  await up.waitForFunction((v) => document.body.innerText.includes(`Есть версия ${v}`), { timeout: 20000 }, NEW);
  const now = await up.evaluateHandle(() => [...document.querySelectorAll('[data-testid="update-check"] button')].find((b) => b.textContent === 'Обновить сейчас'));
  await now.asElement().click();
  await up.waitForSelector('[data-testid="update-folder"]', { timeout: 10000 });
  await sleep(500);
  await up.evaluate(() => document.getElementById('ait-update').scrollIntoView({ block: 'center' }));
  await sleep(300);
  await clipBox(up, await unionBox(up, ['#ait-update >> parent']), '20-update');
  console.log('shots in', OUT);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  ollama.close();
  site.close();
  llm.close();
}
