/**
 * Ready instructions for the profile («Инструкции для модели»), one per target language, written for
 * small local models (Qwen 7–14B, Gemma, Llama): short English rules — such models follow English
 * instructions best — with examples in the target language. They add to the built-in rules
 * (honorifics, names, sound effects, grammar), they do not repeat them.
 */

const COMMON = [
  'Write natural spoken language, the way a professional scanlation team would; translate the meaning, not word by word.',
  'Keep each character\'s voice: short rough lines in fights and threats, soft ones in tender scenes; no bookish words in speech.',
  'Never add quotation marks, explanations, notes or translator comments that are not in the original.',
  'One bubble = one translation: never merge two bubbles, never move text between bubbles, never translate a line twice.',
  'A line cut off mid-sentence stays cut off; do not invent the rest.',
  'Game/system windows (status, skills, quests): short labels, numbers unchanged.',
];

interface LangPrompt {
  /** Rules for this language. */
  rules: string[];
}

const LANG: Record<string, LangPrompt> = {
  ru: {
    rules: [
      'Target reader: Russian manga/manhwa readers. Idioms by meaning ("playing dead" → «притворяешься мёртвым», "comrades in arms" → «боевые товарищи»).',
      'Past tense and adjectives agree with the speaker\'s gender: «я пришёл / я пришла». A woman\'s name ending in a consonant is not declined («у Саранг»).',
      'Address: friends and peers — «ты»; strangers, elders, nobles, a servant to a lord — «вы» (and «господин», «госпожа»).',
      'Punctuation: «ёлочки» for quotes, an em dash «—» in speech, «…» as one character; ё where it matters (всё, её).',
      'Sound effects: short real onomatopoeia (БАХ, ГРОХОТ, ХРЯСЬ, ЧМОК, ТОП), never a verb (not «ТОПАЙ») and never a made-up word.',
      'Panting "HAH… HAH…" is breathing «Ха… ха…», not laughter. "Huh?" → «А?», "Tch" → «Тц».',
    ],
  },
  uk: {
    rules: [
      'Target reader: Ukrainian manga/manhwa readers. Write real Ukrainian, not Russian words in Ukrainian spelling (не «приймати участь», а «брати участь»).',
      'Past tense agrees with the speaker\'s gender: «я прийшов / я прийшла». Use the vocative for names and address: «Олено!», «пане», «пані».',
      'Address: peers — «ти»; strangers, elders, nobles — «ви».',
      'Punctuation: «ялинки» for quotes, an em dash «—» in speech.',
      'Sound effects: short Ukrainian onomatopoeia (БАХ, ГУП, ТРІСЬ, ЦМОК), never a verb or a made-up word.',
    ],
  },
  be: {
    rules: [
      'Target reader: Belarusian readers. Write real Belarusian (тарашкевіца only if the glossary uses it), not Russian words.',
      'Past tense agrees with the speaker\'s gender: «я прыйшоў / я прыйшла». Address: peers — «ты», elders — «вы».',
      'Sound effects: short Belarusian onomatopoeia (БАХ, ГРУК, ЦМОК), never a verb.',
    ],
  },
  en: {
    rules: [
      'Target reader: English-speaking webtoon readers. Natural modern English; contractions in speech ("I\'m", "don\'t").',
      'Translate set phrases by meaning (お疲れ様 → "Good work today", 화이팅 → "You got this!"), not literally.',
      'Keep honorifics only if the profile says so; otherwise use names and natural address ("my lord", "ma\'am").',
      'Sound effects: English onomatopoeia (BAM, THUD, CRACK, SMOOCH, STOMP).',
      'Use American spelling unless the glossary uses British.',
    ],
  },
  es: {
    rules: [
      'Target reader: Spanish-speaking readers; neutral Latin American Spanish unless the glossary says Spain (no "vosotros" in neutral).',
      'Questions and exclamations open with ¿ and ¡: "¿En serio?", "¡Basta!". Dialogue dashes are fine inside a bubble: no quotes around a line.',
      'Address: peers — tú; elders, strangers, nobles — usted (and "mi señor", "mi señora").',
      'Adjectives and participles agree with gender: "estoy cansado / estoy cansada".',
      'Sound effects: Spanish onomatopoeia (¡PUM!, ¡ZAS!, ¡CRAC!, MUAC for a kiss), never a verb.',
    ],
  },
  pt: {
    rules: [
      'Target reader: Brazilian Portuguese readers (use European Portuguese only if the glossary does). Natural spoken Brazilian: "você", "a gente".',
      'Adjectives and participles agree with gender: "estou cansado / estou cansada", "obrigado / obrigada" by the speaker.',
      'Address: peers — você; elders, nobles — "o senhor", "a senhora", "meu senhor".',
      'Sound effects: Portuguese onomatopoeia (POW, CRAC, TUM, SMACK for a kiss), never a verb.',
    ],
  },
  de: {
    rules: [
      'Target reader: German readers. Natural spoken German, not stiff written German.',
      'Address: friends, family, peers — du; strangers, elders, nobles, a servant to a lord — Sie (and "mein Herr", "Mylady").',
      'Quotes „so“; keep sentences short enough for the bubble — German runs longer, prefer short words.',
      'Nouns capitalised, ß and umlauts correct (ä ö ü).',
      'Sound effects: German comic onomatopoeia (BUMM, KRACH, KNACK, SCHMATZ for a kiss, STAPF for stomping), never a full verb.',
    ],
  },
  fr: {
    rules: [
      'Target reader: French readers. Natural spoken French ("t\'inquiète", "c\'est pas grave" in casual speech).',
      'Address: peers — tu; strangers, elders, nobles — vous (and "monseigneur", "madame").',
      'Typography: a thin space before ! ? : ; and « guillemets » with spaces inside.',
      'Adjectives and participles agree with gender: "je suis prêt / je suis prête".',
      'Sound effects: French onomatopoeia (BAM, CRAC, BOUM, SMACK for a kiss, TAP TAP for steps), never a verb.',
    ],
  },
  it: {
    rules: [
      'Target reader: Italian readers. Natural spoken Italian.',
      'Address: peers — tu; strangers, elders, nobles — Lei (and "mio signore", "signora").',
      'Adjectives and participles agree with gender: "sono stanco / sono stanca".',
      'Sound effects: Italian comic onomatopoeia (BAM, CRAC, SMACK, TUMP), never a verb.',
    ],
  },
  pl: {
    rules: [
      'Target reader: Polish readers. Natural spoken Polish.',
      'Past tense agrees with gender: "zrobiłem / zrobiłam". Vocative for names and address: "Kasiu!", "panie", "pani".',
      'Address: peers — ty; strangers, elders, nobles — pan / pani (third person).',
      'Quotes „tak”, an em dash in speech.',
      'Sound effects: Polish onomatopoeia (BUM, TRZASK, CMOK, TUP), never a verb.',
    ],
  },
  tr: {
    rules: [
      'Target reader: Turkish readers. Natural spoken Turkish, vowel harmony correct.',
      'Address: peers — sen; strangers, elders, nobles — siz (and "efendim", "hanımefendi").',
      'Keep sentences short: Turkish verbs come last, so split a long line rather than cramming it.',
      'Sound effects: Turkish onomatopoeia (GÜM, ÇAT, ŞAP, MUCK for a kiss), never a verb.',
    ],
  },
  ja: {
    rules: [
      'Target reader: Japanese readers. Natural Japanese manga dialogue, not textbook Japanese.',
      'Choose pronouns and sentence endings by character: rough boys 俺/だろ, polite speakers 私/です・ます, nobles and servants keigo (でございます, 様).',
      'Write in kana/kanji only; no romaji, no Latin letters except brand names.',
      'Sound effects: Japanese onomatopoeia in katakana (ドン, バキッ, チュッ, ドスドス), never a verb.',
    ],
  },
  ko: {
    rules: [
      'Target reader: Korean readers. Natural Korean webtoon dialogue.',
      'Speech level by relationship: 반말 between friends and to younger people, 존댓말 (-요/-습니다) to elders, strangers and nobles (님).',
      'Write in Hangul; no romanisation.',
      'Sound effects: Korean onomatopoeia (쾅, 퍽, 쪽, 쿵쿵), never a verb.',
    ],
  },
  zh: {
    rules: [
      'Target reader: Mainland Chinese readers: Simplified characters, natural modern spoken Chinese (not classical unless the original is archaic).',
      'Address: peers — 你; elders, nobles — 您 and titles (大人, 殿下, 小姐).',
      'Full-width punctuation (，。！？「」 or “ ”); no spaces between characters.',
      'Sound effects: Chinese onomatopoeia (砰, 咔嚓, 啵, 咚咚), never a verb.',
    ],
  },
  'zh-TW': {
    rules: [
      'Target reader: Taiwan readers: Traditional characters and Taiwan wording (不要 / 沒關係 / 欸).',
      'Address: peers — 你; elders, nobles — 您 and titles (大人, 殿下, 小姐).',
      'Full-width punctuation and 「」 quotes.',
      'Sound effects: Chinese onomatopoeia (砰, 喀嚓, 啵, 咚咚), never a verb.',
    ],
  },
  id: {
    rules: [
      'Target reader: Indonesian readers. Natural casual Indonesian in speech (gue/lo only for street talk, aku/kamu otherwise).',
      'Address: elders and nobles — Anda / Tuan / Nyonya.',
      'Sound effects: Indonesian onomatopoeia (BRAK, DUAR, CUP for a kiss), never a verb.',
    ],
  },
  vi: {
    rules: [
      'Target reader: Vietnamese readers. Choose pronouns by relationship and age (tao/mày for rough speech, anh/em, cô/cậu, ngài for nobles), keep them consistent for each pair of characters.',
      'All diacritics correct.',
      'Sound effects: Vietnamese onomatopoeia (RẦM, BỐP, CHỤT), never a verb.',
    ],
  },
  th: {
    rules: [
      'Target reader: Thai readers. Polite particles by speaker gender (ครับ for men, ค่ะ/คะ for women) when the line is polite.',
      'Pronouns by relationship (กู/มึง rough, ฉัน/เธอ, ผม for men, ท่าน for nobles).',
      'Sound effects: Thai onomatopoeia (ปัง, เพล้ง, จุ๊บ), never a verb.',
    ],
  },
  ar: {
    rules: [
      'Target reader: Arabic readers. Modern Standard Arabic, simple and spoken in tone; no dialect unless the glossary asks.',
      'Verbs and adjectives agree with the gender of speaker and listener (أنتَ / أنتِ).',
      'Sound effects: Arabic onomatopoeia (بووم, طاخ), never a verb.',
    ],
  },
  kk: {
    rules: [
      'Target reader: Kazakh readers. Natural spoken Kazakh in Cyrillic script, vowel harmony correct.',
      'Address: peers — сен; elders, strangers, nobles — сіз (and «мырза», «ханым»).',
      'Sound effects: short Kazakh onomatopoeia (ГҮРС, ТАРС, ШОП), never a verb.',
    ],
  },
};

/** Languages with a ready instruction (base codes and zh-TW). */
export const LANG_PROMPT_CODES = Object.keys(LANG);

/** The rules every language gets (after its own). */
export const COMMON_RULES = COMMON;

/** Only the language's own rules (without the common ones). */
export function languageRules(targetLang: string): string[] {
  return (LANG[targetLang] ?? LANG[targetLang.split('-')[0]])?.rules ?? [];
}

/** The ready instruction for a target language, or a general one for a language without its own. */
export function languageInstruction(targetLang: string): string {
  const own = LANG[targetLang] ?? LANG[targetLang.split('-')[0]];
  const rules = [...(own?.rules ?? [`Target reader: native readers of the target language (${targetLang}). Use that language's own punctuation and forms of address.`]), ...COMMON];
  return rules.map((r) => `- ${r}`).join('\n');
}

/**
 * Another target language chosen: profiles whose instruction is still the ready one of the old
 * language get the new language's (a Russian-reader instruction would fight an English target).
 * Instructions the user wrote or edited stay as they are.
 */
export function profilesForLanguage<P extends { customPrompt: string }>(profiles: P[], from: string, to: string): P[] {
  if (from === to) return profiles;
  const old = languageInstruction(from);
  return profiles.map((p) => (p.customPrompt.trim() === old ? { ...p, customPrompt: languageInstruction(to) } : p));
}
