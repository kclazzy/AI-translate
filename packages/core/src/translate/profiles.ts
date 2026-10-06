export type HonorificsPolicy = 'keep' | 'adapt' | 'drop';
export type NamePolicy = 'transliterate' | 'keep-original' | 'adapt';
export type SfxPolicy = 'translate' | 'keep';
export type SfxStyle = 'original' | 'translated' | 'small' | 'large' | 'artistic';

export interface PromptProfile {
  id: string;
  name: string;
  /** Free-form instructions from the user. */
  customPrompt: string;
  honorifics: HonorificsPolicy;
  names: NamePolicy;
  sfx: SfxPolicy;
  sfxStyle: SfxStyle;
  tone: string;
}

export const DEFAULT_PROFILES: PromptProfile[] = [
  {
    id: 'natural',
    name: 'Естественный перевод',
    customPrompt: 'Переводи максимально естественно, как в профессиональном сканлейте. Короткие фразы для баблов.',
    honorifics: 'adapt',
    names: 'transliterate',
    sfx: 'translate',
    sfxStyle: 'translated',
    tone: '',
  },
  {
    id: 'honorifics',
    name: 'С японскими honorifics',
    customPrompt: 'Сохраняй японские honorifics (-сан, -кун, -сэмпай). Не переводи имена собственные, только транслитерируй.',
    honorifics: 'keep',
    names: 'transliterate',
    sfx: 'translate',
    sfxStyle: 'translated',
    tone: '',
  },
  {
    id: 'adapted',
    name: 'Полная адаптация',
    customPrompt: 'Полностью адаптируй текст для русскоязычного читателя, включая обращения и шутки.',
    honorifics: 'drop',
    names: 'adapt',
    sfx: 'translate',
    sfxStyle: 'artistic',
    tone: '',
  },
];
