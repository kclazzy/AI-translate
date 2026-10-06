export interface LanguageInfo {
  code: string;
  name: string;
  native: string;
  /** Default writing direction when typesetting into this language. */
  vertical?: boolean;
  cjk?: boolean;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'en', name: 'English', native: 'English' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ja', name: 'Japanese', native: '日本語', cjk: true },
  { code: 'ko', name: 'Korean', native: '한국어', cjk: true },
  { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', cjk: true },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', cjk: true },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'kk', name: 'Kazakh', native: 'Қазақша' },
  { code: 'be', name: 'Belarusian', native: 'Беларуская' },
];

export function languageName(code: string): string {
  if (code === 'auto') return 'auto-detect';
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

export function isCjk(code: string): boolean {
  return LANGUAGES.find((l) => l.code === code)?.cjk ?? false;
}

/**
 * Guess the script of a text by character ranges. Good enough to route OCR
 * and decide default writing direction; not a full language detector.
 */
export function detectScript(text: string): 'ja' | 'ko' | 'zh' | 'latin' | 'cyrillic' | 'other' {
  let kana = 0, hangul = 0, han = 0, latin = 0, cyr = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff66 && c <= 0xff9f)) kana++;
    else if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) hangul++;
    else if (c >= 0x4e00 && c <= 0x9fff) han++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else if (c >= 0x400 && c <= 0x4ff) cyr++;
  }
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (han > 0) return 'zh';
  if (cyr > latin) return 'cyrillic';
  if (latin > 0) return 'latin';
  return 'other';
}
