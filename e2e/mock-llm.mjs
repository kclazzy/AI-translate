// A local OpenAI-compatible server used by the end-to-end tests. It answers vision requests
// for the synthetic manga fixture with the true text boxes, and text requests with translations.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const geometry = JSON.parse(readFileSync(new URL('./fixtures/geometry.json', import.meta.url)));
const TRANSLATIONS = { 'たなかさん待って': 'Танака, подожди!', 'どこへ行くの': 'Куда ты идёшь?' };

function norm(tb, w, h) {
  return [Math.round((tb[0] / w) * 1000), Math.round((tb[1] / h) * 1000), Math.round(((tb[0] + tb[2]) / w) * 1000), Math.round(((tb[1] + tb[3]) / h) * 1000)];
}

export function startMockLlm(port = 18080) {
  const calls = [];
  const server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    if (req.url.endsWith('/models')) return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-vl' }] }));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      calls.push(json);
      const user = json.messages?.at(-1)?.content;
      let answer;
      if (Array.isArray(user)) {
        const text = user.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
        if (text.includes('cropped text region')) {
          // Engine OCR: crops arrive in reading order (b1 = first bubble).
          const ids = [...text.matchAll(/Crop (b\d+):/g)].map((x) => x[1]);
          const texts = ids.map((id) => ({ id, text: geometry.page[Number(id.slice(1)) - 1]?.text ?? '', type: 'DIALOGUE' }));
          return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ texts }) } }], usage: { prompt_tokens: 300, completion_tokens: 40 }, model: json.model }));
        }
        const m = /The image is (\d+)×(\d+)/.exec(text);
        const w = Number(m?.[1] ?? 0);
        const h = Number(m?.[2] ?? 0);
        const isPage = w && Math.abs(w / h - 800 / 1100) < 0.02;
        const blocks = isPage
          ? geometry.page.map((b) => ({ box: norm(b.textBox, 800, 1100), text: b.text, translation: TRANSLATIONS[b.text], type: 'DIALOGUE', vertical: true }))
          : [];
        answer = { blocks, entities: [{ source: '田中', target: 'Танака', kind: 'character', gender: 'male' }], summary: 'Кто-то зовёт Танаку.' };
      } else {
        const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(user)?.[1] ?? '[]');
        answer = { translations: blocks.map((b) => ({ id: b.id, text: TRANSLATIONS[b.text] ?? `RU ${b.text}` })), entities: [], summary: '' };
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1200, completion_tokens: 150 }, model: json.model }),
      );
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { calls } = await startMockLlm(Number(process.env.PORT ?? 18080));
  console.log('mock LLM on', process.env.PORT ?? 18080);
  setInterval(() => process.stdout.write(`\rcalls: ${calls.length}`), 2000);
}
