/**
 * Разговорник: recurring expressions of a source language with ways to say them in the target language.
 * Entries are hints for the model, never forced replacements (see phrasebook/match.ts).
 */
export type PhraseCategory =
  /** Reactions and exclamations (なるほど, 아이고, 哎呀, "Tsk"): only when the bubble is mostly this. */
  | 'interjection'
  /** Set phrases tied to a situation (いただきます, お疲れ様, 화이팅): the variant depends on the situation. */
  | 'situational'
  /** Slang with several meanings (やばい, 대박, "No way"): always several variants, never one default. */
  | 'slang'
  /** Forms of address (先輩, 오빠, 师兄, "senpai"): follows the profile's honorifics setting. */
  | 'address'
  /** Genre terms (cultivation, isekai): one steady translation; may go to the series glossary. */
  | 'term';

export interface PhraseVariant {
  /** The translation (target language). */
  text: string;
  /** When to use it — short, in Russian (shown to the model and in the Studio). */
  when: string;
  /** For 'address' entries: which honorifics policy the variant belongs to. */
  policy?: 'keep' | 'adapt';
}

export interface PhraseEntry {
  /** Stable id: '<lang>:<latin slug>', e.g. 'ja:itadakimasu'. */
  id: string;
  /** Spellings to look for in the original (kanji/kana variants, romanized forms for English scans…). */
  src: string[];
  cat: PhraseCategory;
  /** Only when the bubble consists (almost) only of this expression; inside a longer line it is skipped. */
  standalone?: boolean;
  /** The choice depends on who speaks / to whom (gender, age): reminds the model to check the speaker. */
  speaker?: boolean;
  /** 2–4 variants for slang/situational, 1+ for others. */
  variants: PhraseVariant[];
  /** One short caution for the model (Russian), e.g. «не переводить дословно „я получаю“». */
  note?: string;
}

export interface PhraseBook {
  /** Source language code (ja, ko, zh, en). */
  source: string;
  /** Target language code. */
  target: string;
  /** Optional genre set, switched on per series (e.g. 'cultivation'). */
  genre?: string;
  title: string;
  entries: PhraseEntry[];
}
