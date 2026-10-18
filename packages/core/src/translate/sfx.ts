/**
 * Common English sound effects and their Russian onomatopoeia. A small model «translates» a sound as
 * a verb (STOMP → «ТОПАЙ») or makes up a word (SMOOCH → «ЦЕЛУЙКА»); here the sound gets a real one,
 * the same on every page. Keys are written with no repeated letters (see sfxKey).
 */
const EN_RU: Record<string, string[]> = {
  STOMP: ['ТОП', 'ТОПОТ'], STEP: ['ТОП', 'ШАГ'], TAP: ['ТУК', 'ТЫК'], SMOCH: ['ЧМОК'], KIS: ['ЧМОК'], MWAH: ['ЧМОК'], CHU: ['ЧМОК'],
  THUD: ['БУХ', 'БАМ'], THUMP: ['БУХ', 'ТУК'], BAM: ['БАМ'], BANG: ['БАХ', 'БАБАХ'], BOM: ['БУМ', 'БАБАХ'], CRASH: ['ГРОХОТ', 'ТРАХ'],
  SLAM: ['ХЛОП', 'БАХ'], CLAP: ['ХЛОП'], SLAP: ['ШЛЁП', 'ХЛОП'], SMACK: ['ШЛЁП', 'ХРЯСЬ'], WHAM: ['БАЦ', 'БАМ'], POW: ['БАЦ'], PUNCH: ['БАЦ'],
  THWACK: ['ХРЯСЬ'], BONK: ['ТЮК', 'БОНЬК'], KNOCK: ['ТУК', 'ТУК-ТУК'], CREAK: ['СКРИП'], SQUEAK: ['ПИСК', 'СКРИП'], CLICK: ['ЩЁЛК', 'КЛАЦ'],
  CLACK: ['КЛАЦ'], SNAP: ['ЩЁЛК', 'ХРУСТ'], CRACK: ['ХРУСТ', 'ТРЕСК'], CRUNCH: ['ХРУМ', 'ХРУСТ'], RUMBLE: ['ГРОХОТ', 'ГУЛ'], RING: ['ДЗЫНЬ'],
  DING: ['ДЗИНЬ'], DONG: ['ДОН'], BEP: ['ПИП'], BUZ: ['БЖЖ', 'ЖУЖЖ'], VR: ['ВРРР'], VROM: ['ВРУМ'], SPLASH: ['ПЛЮХ', 'ПЛЕСК'], DRIP: ['КАП'],
  SPLAT: ['ШМЯК', 'ПЛЮХ'], PLOP: ['ПЛЮХ'], SWISH: ['ВЖУХ', 'ШУРХ'], WHOSH: ['ВЖУХ', 'ФЬЮТЬ'], ZOM: ['ВЖУХ'], ZIP: ['ВЖИК'], FWIP: ['ФЬЮТЬ'],
  SH: ['ТСС'], SIGH: ['ВЗДОХ', 'ЭХ'], GASP: ['АХ'], GULP: ['ГЛЫК', 'ГЛОТЬ'], SNIF: ['ШМЫГ'], SOB: ['ВСХЛИП'], GR: ['РРР', 'ГРР'], GROWL: ['РРР'],
  RIP: ['ТРЕСЬ'], THROB: ['ТУК-ТУК'], BADUMP: ['ТУК-ТУК'], FLAP: ['ХЛОП'], FLUTER: ['ПОРХ'], RUSTLE: ['ШУРХ', 'ШОРОХ'], SHUFLE: ['ШАРК'],
  SCRATCH: ['ЦАП', 'СКРЕБ'], GRAB: ['ХВАТЬ', 'ЦАП'], GRIP: ['СТИСК'], CLENCH: ['СТИСК'], POKE: ['ТЫК'], PAT: ['ХЛОП', 'ПОХЛОП'],
  SHAKE: ['ТРЯС'], TREMBLE: ['ДРОЖЬ'], TICK: ['ТИК'], TOCK: ['ТАК'], HONK: ['БИП'], POP: ['ЧПОК', 'ПОП'], SIZLE: ['ШШШ'], GIGLE: ['ХИ-ХИ'],
  CHUCKLE: ['ХЕ-ХЕ'], FWOSH: ['ФШШ'], WHIR: ['ЖЖЖ'], HUM: ['ГУЛ'], TWITCH: ['ДЁРГ'], JOLT: ['ДЁРГ'], FLINCH: ['ВЗДРОГ'], NOD: ['КИВ'],
  GLARE: ['ЗЫРК'], GLANCE: ['ЗЫРК'], STARE: ['ПЯЛ'], BLINK: ['МОРГ'], WAVE: ['МАХ'], HUG: ['ОБНИМ'], PUSH: ['ТОЛК'], SHOVE: ['ТОЛК'], DROP: ['БРЯК'],
  THROW: ['ШВЫРЬ'], TOSS: ['ШВЫРЬ'], CATCH: ['ХВАТЬ'], SLIDE: ['ВЖИК'], SLIP: ['СКОЛЬЗЬ'], TRIP: ['СПОТЫК'], SNEAK: ['КРАДЬ'], CREP: ['КРАДЬ'],
};

/** The key of a sound: capital letters only, no letter twice in a row (STOOOMP → STOMP, SHHH → SH). */
export function sfxKey(word: string): string {
  return word.toUpperCase().replace(/[^A-Z]/g, '').replace(/(.)\1+/g, '$1');
}

/** The Russian sounds for an English sound effect (one or a few same words: «STOMP STOMP»), or null. */
export function sfxVariants(text: string, targetLang: string): string[] | null {
  if (targetLang.split('-')[0] !== 'ru') return null;
  const words = text.split(/[\s.,!?…~\-—]+/).filter(Boolean);
  if (!words.length || words.length > 4) return null;
  const keys = words.map(sfxKey);
  if (keys.some((k) => k !== keys[0])) return null;
  const v = EN_RU[keys[0]];
  if (!v) return null;
  return words.length > 1 ? v.map((x) => Array(words.length).fill(x).join(' ')) : v;
}

// Drawn-out sounds count as the same (ТОООП = ТОП, БА-БАХ = БАБАХ).
const norm = (s: string) => s.toUpperCase().replace(/Ё/g, 'Е').replace(/[^А-ЯA-Z]/g, '').replace(/(.)\1+/g, '$1');

/**
 * The model's translation of a sound effect, checked against the list: one of the known sounds is
 * kept, anything else (a verb, a made-up word) becomes the first known one. Unknown sounds stay.
 */
export function fixSfx(original: string, translation: string, targetLang: string): string {
  const v = sfxVariants(original, targetLang);
  if (!v) return translation;
  const t = norm(translation);
  if (v.some((x) => norm(x) === t)) return translation;
  const bang = /[!?]+$/.exec(translation.trim())?.[0] ?? '';
  return v[0] + bang;
}
