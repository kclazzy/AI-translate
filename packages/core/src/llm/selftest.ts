import { toAppError } from '../errors';
import type { ImageBackend } from '../image/backend';
import { languageName } from '../languages';
import { bytesToBase64 } from '../util/bytes';
import { createProvider } from './presets';
import type { FetchLike, ProviderConfig } from './types';

/** Result of "Проверить модель": shown in settings and in the popup. */
export interface ModelCheck {
  /** ok: read the test picture; partial: answers but misread it; fail: no usable answer. */
  level: 'ok' | 'partial' | 'fail';
  model: string;
  baseUrl: string;
  /** What the model read and how it translated it. */
  read?: string;
  translation?: string;
  ms: number;
  /** Generation speed if the server reports it. */
  tokensPerSecond?: number;
  message: string;
  at: string;
}

export const SELFTEST_TEXT = 'こんにちは';

/** Key for remembering the last check of a provider + model. */
export function modelCheckKey(cfg: Pick<ProviderConfig, 'baseUrl' | 'model'>): string {
  return `${cfg.baseUrl}|${cfg.model}`;
}

/** Draw a small manga-like test picture: one speech bubble with Japanese text. */
export async function selfTestImage(backend: ImageBackend): Promise<Uint8Array> {
  const w = 480;
  const h = 320;
  const c = backend.createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, 200, 110, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 60px "Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(SELFTEST_TEXT, w / 2, h / 2);
  return backend.encode(c, 'image/png');
}

function pickJson(text: string): { text?: string; translation?: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as Record<string, unknown>;
      return { text: typeof j.text === 'string' ? j.text : undefined, translation: typeof j.translation === 'string' ? j.translation : undefined };
    } catch {
      /* fall through */
    }
  }
  return { text: text.trim().slice(0, 200) };
}

const norm = (s: string) => s.replace(/[\s「」『』！!。、.,?？~〜ー-]/g, '');

/**
 * Send the test picture to the model and check it reads the text back.
 * This exercises exactly what a page translation needs: image input, JSON answer, speed.
 */
export async function checkVisionModel(cfg: ProviderConfig, opts: { backend: ImageBackend; targetLang?: string; fetchImpl?: FetchLike; signal?: AbortSignal }): Promise<ModelCheck> {
  const base = { model: cfg.model, baseUrl: cfg.baseUrl, at: new Date().toISOString() };
  const t0 = Date.now();
  const lang = languageName(opts.targetLang ?? 'ru');
  try {
    const png = await selfTestImage(opts.backend);
    const provider = createProvider(cfg, opts.fetchImpl);
    const res = await provider.complete({
      system: 'You read text on images precisely. Answer with JSON only.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mime: 'image/png', base64: bytesToBase64(png) },
            { type: 'text', text: `Read the Japanese text in the speech bubble and translate it into ${lang}. Answer only JSON: {"text": "<text exactly as written>", "translation": "<translation>"}` },
          ],
        },
      ],
      json: true,
      maxTokens: 300,
      signal: opts.signal,
    });
    const ms = Date.now() - t0;
    const got = pickJson(res.text);
    const read = got.text ?? '';
    if (norm(read).includes(SELFTEST_TEXT)) {
      const slow = ms > 60_000 ? ' Но отвечает медленно: страница может занимать несколько минут — попробуйте модель полегче.' : '';
      const tps = res.tokensPerSecond ? ` Скорость ответа ${Math.round(res.tokensPerSecond)} токенов/с.` : '';
      return { ...base, level: 'ok', read, translation: got.translation, ms, tokensPerSecond: res.tokensPerSecond, message: `Модель работает: прочитала текст на картинке за ${(ms / 1000).toFixed(1)} с.${tps}${slow}` };
    }
    return {
      ...base,
      level: 'partial',
      read,
      translation: got.translation,
      ms,
      message: read
        ? `Модель отвечает, но прочитала картинку неверно («${read.slice(0, 40)}» вместо «${SELFTEST_TEXT}»). Переводы будут с ошибками — возьмите модель побольше.`
        : 'Модель отвечает, но не видит текст на картинке. Возможно, она не умеет читать изображения.',
    };
  } catch (e) {
    const err = toAppError(e);
    return { ...base, level: 'fail', ms: Date.now() - t0, message: `${err.detail ?? err.message}`.trim() };
  }
}
