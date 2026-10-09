import { AppError } from '../errors';
import { tr } from '../i18n';
import { languageName } from '../languages';
import { isLocalUrl } from '../llm/privacy';
import type { FetchLike, LlmProvider, ProviderConfig } from '../llm/types';
import type { TextBlock, Usage } from '../types';
import { usageFrom } from './translator';
import { extractJson } from './parse';

/**
 * «Сверка»: the page's translation is compared with other translators — machine translation
 * services (DeepL, Google, Yandex, LibreTranslate) and/or other language models. A judge model
 * (optional) reads the original, our translation and the references and says where ours is wrong.
 */

export type CheckerKind = 'deepl' | 'google' | 'yandex' | 'libre' | 'llm';

export interface CheckerConfig {
  id: string;
  kind: CheckerKind;
  enabled: boolean;
  /** LibreTranslate server address. */
  url?: string;
  /** Yandex Cloud folder (needed with an IAM token, not with an API key). */
  folderId?: string;
  /** A language model from the providers list used as one more translator. */
  providerId?: string;
}

export interface CrossCheckSettings {
  enabled: boolean;
  checkers: CheckerConfig[];
  /** Who compares: 'none' = only show the references, 'main' = the model that translated, or a provider id. */
  judge: string;
  /** Show the differences, or also take the judge's better wording. */
  mode: 'report' | 'fix';
}

export interface BlockCheck {
  refs: { by: string; text: string }[];
  verdict?: 'ok' | 'differs';
  note?: string;
  /** The judge's wording when ours is wrong. */
  better?: string;
  /** Our translation before «fix» replaced it. */
  before?: string;
  /** Closest similarity to a reference (0–1, letters only). */
  score?: number;
}

export const CHECKER_LABELS: Record<CheckerKind, string> = { deepl: 'DeepL', google: 'Google Translate', yandex: 'Yandex Translate', libre: 'LibreTranslate', llm: 'LLM' };

/** Where each service takes its key, for the settings. */
export const CHECKER_KEY_URL: Partial<Record<CheckerKind, string>> = {
  deepl: 'https://www.deepl.com/your-account/keys',
  google: 'https://console.cloud.google.com/apis/credentials',
  yandex: 'https://console.yandex.cloud/',
};

/** Does this checker send the text outside the computer? */
export function checkerIsCloud(c: CheckerConfig, provider?: ProviderConfig): boolean {
  if (c.kind === 'libre') return !c.url || !isLocalUrl(c.url);
  if (c.kind === 'llm') return provider ? !isLocalUrl(provider.baseUrl) : true;
  return true;
}

const base = (lang: string) => lang.split('-')[0].toLowerCase();

function deeplLang(lang: string, target: boolean): string {
  const l = lang.toLowerCase();
  if (target) {
    if (l === 'en') return 'EN-US';
    if (l === 'pt') return 'PT-BR';
    if (l === 'zh' || l === 'zh-cn') return 'ZH-HANS';
    if (l === 'zh-tw') return 'ZH-HANT';
  }
  return base(lang).toUpperCase();
}

function googleLang(lang: string): string {
  const l = lang.toLowerCase();
  if (l === 'zh' || l === 'zh-cn') return 'zh-CN';
  if (l === 'zh-tw') return 'zh-TW';
  return base(lang);
}

async function asJson(res: Response, label: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = await res.text();
  if (!res.ok) {
    const code = res.status === 401 || res.status === 403 ? 'INVALID_API_KEY' : res.status === 429 || res.status === 456 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE';
    throw new AppError(code, { retryable: res.status >= 500, detail: `${label}: HTTP ${res.status} ${text.slice(0, 160)}` });
  }
  return JSON.parse(text);
}

/** Translate texts with a machine translation service. */
export async function machineTranslate(c: CheckerConfig, apiKey: string | undefined, texts: string[], source: string, target: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const src = source && source !== 'auto' ? source : '';
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  switch (c.kind) {
    case 'deepl': {
      if (!apiKey) throw new AppError('INVALID_API_KEY', { retryable: false, detail: tr('Нет ключа {0}', 'DeepL') });
      const host = apiKey.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
      const j = await asJson(await post(`${host}/v2/translate`, { text: texts, target_lang: deeplLang(target, true), ...(src ? { source_lang: deeplLang(src, false) } : {}) }, { authorization: `DeepL-Auth-Key ${apiKey}` }), 'DeepL');
      return (j.translations ?? []).map((t: { text: string }) => t.text);
    }
    case 'google': {
      if (!apiKey) throw new AppError('INVALID_API_KEY', { retryable: false, detail: tr('Нет ключа {0}', 'Google') });
      const j = await asJson(await post(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`, { q: texts, target: googleLang(target), format: 'text', ...(src ? { source: googleLang(src) } : {}) }), 'Google');
      return (j.data?.translations ?? []).map((t: { translatedText: string }) => t.translatedText);
    }
    case 'yandex': {
      if (!apiKey) throw new AppError('INVALID_API_KEY', { retryable: false, detail: tr('Нет ключа {0}', 'Yandex') });
      const auth = apiKey.startsWith('t1.') || apiKey.startsWith('Bearer ') ? `Bearer ${apiKey.replace(/^Bearer /, '')}` : `Api-Key ${apiKey}`;
      const j = await asJson(
        await post('https://translate.api.cloud.yandex.net/translate/v2/translate', { texts, targetLanguageCode: base(target), ...(src ? { sourceLanguageCode: base(src) } : {}), ...(c.folderId ? { folderId: c.folderId } : {}) }, { authorization: auth }),
        'Yandex',
      );
      return (j.translations ?? []).map((t: { text: string }) => t.text);
    }
    case 'libre': {
      const url = (c.url || 'http://127.0.0.1:5000').replace(/\/+$/, '');
      const j = await asJson(await post(`${url}/translate`, { q: texts, source: src ? base(src) : 'auto', target: base(target), format: 'text', ...(apiKey ? { api_key: apiKey } : {}) }), 'LibreTranslate');
      const out = j.translatedText;
      return Array.isArray(out) ? out : [out];
    }
    default:
      throw new AppError('UNKNOWN', { retryable: false, detail: c.kind });
  }
}

/** Letters-only trigram similarity (0–1): how close two translations are, without the model. */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 2; i++) m.set(t.slice(i, i + 3), (m.get(t.slice(i, i + 3)) ?? 0) + 1);
    return m;
  };
  const x = grams(a);
  const y = grams(b);
  let common = 0;
  let total = 0;
  for (const [g, n] of x) {
    common += Math.min(n, y.get(g) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * common) / total : 0;
}

export interface Reference {
  label: string;
  translate: (texts: string[]) => Promise<string[]>;
}

function judgePrompt(targetLang: string): string {
  return [
    `You are an editor checking a ${languageName(targetLang)} translation of comic speech bubbles.`,
    'For every block you get the original, OUR translation and translations of the same line by other translators.',
    'The others are only references: machine translators are often literal and miss context, speakers and tone.',
    'Decide whether OUR translation conveys the meaning of the original correctly (meaning, who does what, negation, numbers, names, tense).',
    'Do not flag style or wording that is merely different. Flag only real mistakes in OUR translation.',
    `Answer JSON: {"checks":[{"id":"…","ok":true|false,"note":"short reason in ${languageName(targetLang)} if not ok","better":"corrected translation if not ok, same length and style as ours"}]}`,
  ].join('\n');
}

/**
 * Compare the page's translations with the references. Every checked block gets `check`; with a
 * judge, blocks where ours is wrong are marked (and with mode «fix» get the judge's wording).
 * Never fails the page: a translator that does not answer is simply left out.
 */
export async function crossCheckPage(
  blocks: TextBlock[],
  opts: { references: Reference[]; judge: LlmProvider | null; mode: 'report' | 'fix'; targetLang: string; signal?: AbortSignal; onError?: (label: string, e: unknown) => void },
): Promise<Usage[]> {
  const todo = blocks.filter((b) => b.translate && b.originalText.trim() && b.translatedText.trim());
  if (!todo.length || !opts.references.length) return [];
  const texts = todo.map((b) => b.originalText.replace(/\s*\n\s*/g, ' '));
  const results = await Promise.all(
    opts.references.map(async (r) => {
      try {
        const out = await r.translate(texts);
        return out.length === texts.length ? { label: r.label, out } : null;
      } catch (e) {
        if ((e as { code?: string }).code === 'CANCELLED') throw e;
        opts.onError?.(r.label, e);
        return null;
      }
    }),
  );
  const got = results.filter((x): x is { label: string; out: string[] } => !!x);
  if (!got.length) return [];
  for (const [i, b] of todo.entries()) {
    const refs = got.map((g) => ({ by: g.label, text: (g.out[i] ?? '').trim() })).filter((r) => r.text);
    const score = refs.length ? Math.max(...refs.map((r) => similarity(r.text, b.translatedText))) : undefined;
    b.check = { refs, score };
    // Without a judge: a translation that shares almost nothing with every reference is worth a look.
    if (!opts.judge && score !== undefined) {
      b.check.verdict = score < 0.22 ? 'differs' : 'ok';
      if (b.check.verdict === 'differs') b.check.note = tr('Сильно отличается от других переводчиков — проверьте смысл.');
    }
  }
  if (!opts.judge) return [];
  const payload = todo.map((b) => ({ id: b.id, original: b.originalText, ours: b.translatedText, others: Object.fromEntries((b.check?.refs ?? []).map((r) => [r.by, r.text])) }));
  let res;
  try {
    res = await opts.judge.complete({ system: judgePrompt(opts.targetLang), messages: [{ role: 'user', content: `<blocks>\n${JSON.stringify(payload)}\n</blocks>` }], json: true, signal: opts.signal, maxTokens: Math.min(6000, 300 + todo.length * 160) });
  } catch (e) {
    if ((e as { code?: string }).code === 'CANCELLED') throw e;
    opts.onError?.(tr('Судья'), e);
    return [];
  }
  const usage = [usageFrom(opts.judge, res.model, res.inputTokens, res.outputTokens)];
  let checks: { id?: string; ok?: boolean; note?: string; better?: string }[] = [];
  try {
    const j = extractJson(res.text) as { checks?: typeof checks } | typeof checks;
    checks = Array.isArray(j) ? j : j.checks ?? [];
  } catch {
    return usage;
  }
  const byId = new Map(checks.filter((c) => c && typeof c.id === 'string').map((c) => [c.id!, c]));
  for (const b of todo) {
    const c = byId.get(b.id);
    if (!c || !b.check) continue;
    b.check.verdict = c.ok === false ? 'differs' : 'ok';
    if (c.ok === false) {
      b.check.note = typeof c.note === 'string' ? c.note.slice(0, 300) : undefined;
      const better = typeof c.better === 'string' ? c.better.trim() : '';
      if (better && better !== b.translatedText) {
        b.check.better = better;
        if (opts.mode === 'fix' && [...better].length <= [...b.translatedText].length * 1.6 + 20) {
          b.check.before = b.translatedText;
          b.translatedText = better;
        }
      }
    }
  }
  return usage;
}
