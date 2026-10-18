import { isCommonEnglish } from './englishWords';
import type { ContextEntity } from './context';

/**
 * Names on a page, found without the model: words with a capital that are not common English
 * (after sentenceCase, a name keeps its capital: «Hi, Sarang!»). A small model translates such a
 * name as a word (Sarang → «люблю тебя») or declines a woman's name as a man's one; the names go
 * into the request as names, and their spelling and gender into the series' characters.
 */
export function namesIn(texts: string[], known: string[] = []): string[] {
  const out = new Set<string>();
  const knownLow = new Set(known.map((k) => k.toLowerCase()));
  const W = '([A-Z][a-z]{2,}(?:-[A-Z]?[a-z]+)?)';
  // Only where the sentence shows it is a name: an address («Hi, Mirae!», «Doyun, come here»), a
  // possessive (Mirae's), a title (Mr. Kang), a one-word question («Mirae?»), or «X and Y» with a known
  // name. An unknown word alone (Humiliating, Scallion) is not taken for a name.
  const patterns = [
    new RegExp(`(?:^|[,.!?…]\\s*|\\b(?:hi|hey|oh|yo|dear|sorry|thanks),?\\s+)${W}\\s*[!?.,…]`, 'g'),
    new RegExp(`(?:^|[.!?…]\\s+)${W},\\s`, 'g'),
    new RegExp(`${W}['’]s\\b`, 'g'),
    new RegExp(`\\b(?:Mr|Mrs|Ms|Miss|Dr|Sir|Lady|Master)\\.?\\s+${W}`, 'g'),
    // A full name with a short family name: «Mirae YU», «Doyun Kim».
    new RegExp(`${W}\\s+(?:[A-Z]{2,3}|[A-Z][a-z]{1,2})(?![\\p{L}])`, 'gu'),
  ];
  for (const t of texts) {
    for (const re of patterns) for (const m of t.matchAll(re)) if (!isCommonEnglish(m[1])) out.add(m[1]);
    for (const m of t.matchAll(new RegExp(`(?<![\\p{L}'’])${W}(?![\\p{L}'’])`, 'gu'))) {
      if (knownLow.has(m[1].toLowerCase())) out.add(m[1]);
    }
  }
  // «Mirae and Doyun»: the other one of a pair with a name.
  for (const t of texts) {
    for (const m of t.matchAll(new RegExp(`${W} and ${W}`, 'g'))) {
      if (out.has(m[1]) && !isCommonEnglish(m[2])) out.add(m[2]);
      if (out.has(m[2]) && !isCommonEnglish(m[1])) out.add(m[1]);
    }
  }
  return [...out];
}

const FEMALE = /\b(she|her|hers|herself|girl|sister|mom|mother|miss|mrs|ms|lady|queen|princess|daughter|aunt|unnie|noona|onee)\b/i;
const MALE = /\b(he|him|his|himself|boy|brother|dad|father|mr|sir|king|prince|son|uncle|hyung|oppa)\b/i;

/**
 * Gender of a name from the words next to it: a pronoun in the same line or the next one when only
 * that name is mentioned there («OF WHO? SARANG? WHAT'S SO SCARY ABOUT HER?» → female). Undecided
 * when both or neither appear.
 */
export function genderHints(texts: string[], names: string[]): Map<string, 'male' | 'female'> {
  const votes = new Map<string, { f: number; m: number }>();
  for (let i = 0; i < texts.length; i++) {
    const here = names.filter((n) => new RegExp(`(?<![\\p{L}])${n}(?![\\p{L}])`, 'u').test(texts[i]));
    if (here.length !== 1) continue;
    const n = here[0];
    const near = `${texts[i].replace(new RegExp(n, 'g'), ' ')} ${texts[i + 1] ?? ''}`;
    const f = FEMALE.test(near);
    const m = MALE.test(near);
    if (f === m) continue;
    const v = votes.get(n) ?? { f: 0, m: 0 };
    if (f) v.f++;
    else v.m++;
    votes.set(n, v);
  }
  const out = new Map<string, 'male' | 'female'>();
  for (const [n, v] of votes) if (v.f !== v.m) out.set(n, v.f > v.m ? 'female' : 'male');
  return out;
}

const TRANSLIT: [RegExp, string][] = [
  [/sh/g, 'ш'], [/ch/g, 'ч'], [/kh/g, 'х'], [/ts/g, 'ц'], [/yu/g, 'ю'], [/ya/g, 'я'], [/yo/g, 'ё'], [/ae/g, 'э'], [/eo/g, 'о'], [/eu/g, 'ы'], [/oo/g, 'у'], [/j/g, 'дж'],
];
const LETTERS: Record<string, string> = { a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'й', z: 'з' };

/** A rough Cyrillic spelling of a Latin name, only to find that name in the translation. */
export function roughCyrillic(name: string): string {
  let s = name.toLowerCase();
  for (const [re, to] of TRANSLIT) s = s.replace(re, to);
  return [...s].map((c) => LETTERS[c] ?? c).join('');
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * How the translation spells a name: the Cyrillic word closest to its rough spelling (declined forms
 * stripped of a case ending: «Саранга» → «Саранг»); null when no word is close enough.
 */
export function spellingIn(translation: string, name: string): string | null {
  const want = roughCyrillic(name);
  let best: { w: string; d: number } | null = null;
  for (const m of translation.matchAll(/\p{Script=Cyrillic}+(?:-\p{Script=Cyrillic}+)?/gu)) {
    const raw = m[0];
    const low = raw.toLowerCase();
    for (const cut of [low, low.replace(/(ом|ем|ой|ей|ою|у|ю|а|я|е|ы|и)$/, '')]) {
      if (cut.length < 2 || cut[0] !== want[0] && !(want.startsWith('дж') && cut.startsWith('дж'))) continue;
      const d = distance(cut, want);
      if (d <= Math.max(1, Math.floor(want.length / 3)) && (!best || d < best.d)) best = { w: cut, d };
    }
  }
  if (!best) return null;
  return best.w[0].toUpperCase() + best.w.slice(1);
}

/** Characters learned from this page: name, spelling in the translation, gender when the words tell it. */
export function learnCharacters(blocks: { text: string; translation?: string }[], known: ContextEntity[]): { source: string; target: string; kind: 'character'; gender?: 'male' | 'female' }[] {
  const texts = blocks.map((b) => b.text);
  const names = namesIn(texts, known.filter((e) => e.kind === 'character').map((e) => e.source));
  if (!names.length) return [];
  const genders = genderHints(texts, names);
  const out: { source: string; target: string; kind: 'character'; gender?: 'male' | 'female' }[] = [];
  for (const n of names) {
    const cur = known.find((e) => e.source.toLowerCase() === n.toLowerCase());
    const g = genders.get(n);
    if (cur) {
      // Known already: only a gender the card does not have yet.
      if (!cur.gender && g) out.push({ source: cur.source, target: cur.target, kind: 'character', gender: g });
      continue;
    }
    const b = blocks.find((x) => x.text.includes(n) && x.translation);
    const target = b ? spellingIn(b.translation!, n) : null;
    if (!target) continue;
    out.push({ source: n, target, kind: 'character', ...(g ? { gender: g } : {}) });
  }
  return out;
}
