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
    if (req.url.endsWith('/models'))
      return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-vl', type: 'vlm', state: 'loaded' }, { id: 'qwen3.8-27b-gsq-rco', type: 'vlm', state: 'not-loaded' }, { id: 'text-only-14b', type: 'llm', state: 'not-loaded' }] }));
    if (req.url === '/api/tags') return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'mock-vl', size: 5e9 }] }));
    if (req.method === 'GET') return res.writeHead(404, cors).end();
    // Ollama's native API answers in its own shape.
    const native = req.url === '/api/chat';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      calls.push(json);
      const last = json.messages?.at(-1);
      const system = json.messages?.[0]?.content ?? '';
      if (typeof system === 'string' && system.includes('editor-in-chief')) {
        // Translation check: everything is fine except nothing; answer per block.
        const blocks = JSON.parse(/<blocks>\n(.*)\n<\/blocks>/s.exec(last.content)?.[1] ?? '[]');
        const content = JSON.stringify({ reviews: blocks.map((b) => ({ id: b.id, ok: true })) });
        return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(native ? { model: json.model, message: { role: 'assistant', content } } : { choices: [{ message: { content } }], usage: { prompt_tokens: 200, completion_tokens: 20 }, model: json.model }));
      }
      const user = native && last?.images?.length ? [{ type: 'text', text: last.content }, ...last.images.map(() => ({ type: 'image_url' }))] : last?.content;
      const reply = (content, usage) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(native ? { model: json.model, message: { role: 'assistant', content }, prompt_eval_count: usage[0], eval_count: usage[1] } : { choices: [{ message: { content } }], usage: { prompt_tokens: usage[0], completion_tokens: usage[1] }, model: json.model }));
      let answer;
      if (Array.isArray(user)) {
        const text = user.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
        if (text.includes('cropped text region')) {
          // Engine OCR: crops arrive in reading order (b1 = first bubble).
          const ids = [...text.matchAll(/Crop (b\d+):/g)].map((x) => x[1]);
          const texts = ids.map((id) => ({ id, text: geometry.page[Number(id.slice(1)) - 1]?.text ?? '', type: 'DIALOGUE' }));
          return reply(JSON.stringify({ texts }), [300, 40]);
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
      reply(JSON.stringify(answer), [1200, 150]);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls })));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { calls } = await startMockLlm(Number(process.env.PORT ?? 18080));
  console.log('mock LLM on', process.env.PORT ?? 18080);
  setInterval(() => process.stdout.write(`\rcalls: ${calls.length}`), 2000);
}
