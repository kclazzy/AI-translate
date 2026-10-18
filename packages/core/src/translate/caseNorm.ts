import { isCommonEnglish } from './englishWords';

/** Three letters or more, all capitals (comic lettering). */
export function isAllCaps(text: string): boolean {
  const letters = [...text].filter((c) => c.toLowerCase() !== c.toUpperCase());
  return letters.length >= 3 && letters.every((c) => c === c.toUpperCase());
}

/** Real two-letter words; any other two letters in capitals are an abbreviation (HP, MP, TV, OK stays a word). */
const TWO = new Set('a am an as at be by do go he hi if in is it me my no of oh ok on or so to up us we ya yo uh ah eh um hm ow ha ho oi ex mr ms ye'.split(' '));

const SENTENCE_END = /[.!?…]["»”')\]]*\s+$/;

/**
 * English lettered in capitals → normal case, for the translator: a small model translates
 * «Why's he here?» better than «WHY'S HE HERE?». A word that is not a common English word keeps its
 * capital (names, places: «HI, SARANG!» → «Hi, Sarang!»), a short unknown one stays in capitals
 * (HP, SP, TV), and so do the words given in `keep` (glossary, names of the series).
 */
export function sentenceCase(text: string, keep: (word: string) => boolean = () => false): string {
  if (!isAllCaps(text) || /[^\u0000-ɏ -⁯\s]/.test(text)) return text;
  let out = '';
  let start = true;
  for (const part of text.split(/([A-Za-z]+(?:['’][A-Za-z]+)?)/)) {
    if (!/^[A-Za-z]/.test(part)) {
      out += part;
      if (/[.!?…]/.test(part) && SENTENCE_END.test(part + ' ')) start = true;
      if (/[A-Za-z0-9]/.test(part)) start = false;
      continue;
    }
    const low = part.toLowerCase();
    let w: string;
    if (keep(part)) w = part[0] + part.slice(1).toLowerCase();
    else if (/^i(['’](m|ll|ve|d))?$/.test(low)) w = 'I' + low.slice(1);
    else if (isCommonEnglish(low) && (low.length !== 2 || TWO.has(low))) w = start ? low[0].toUpperCase() + low.slice(1) : low;
    else if (part.length <= 3) w = part;
    else w = part[0] + part.slice(1).toLowerCase();
    out += w;
    start = false;
  }
  return out;
}

/**
 * A translation the model answered in capitals (it copies the lettering): normal case again — the
 * picture still shows capitals when the original had them (the style). Words written with a capital
 * in `names` (the series' names in the target language) keep it.
 */
export function unshout(text: string, names: string[] = []): string {
  if (!isAllCaps(text)) return text;
  const known = new Map(names.flatMap((n) => n.split(/\s+/)).filter((n) => n.length > 1).map((n) => [n.toLowerCase().slice(0, Math.max(3, n.length - 2)), true]));
  let start = true;
  return text.replace(/\p{L}+|[^\p{L}]+/gu, (part) => {
    if (!/\p{L}/u.test(part)) {
      if (/[.!?…]\s*$/.test(part) || /[.!?…]["»”')\]]*\s+/.test(part)) start = true;
      else if (/[0-9]/.test(part)) start = false;
      return part;
    }
    const low = part.toLowerCase();
    const cap = start || [...known.keys()].some((k) => low.startsWith(k));
    start = false;
    return cap ? low[0].toUpperCase() + low.slice(1) : low;
  });
}
