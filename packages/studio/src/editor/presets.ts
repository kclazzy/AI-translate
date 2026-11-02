import type { TextStyle } from '@ait/core';

/** A named look for translated text, kept for every page and project («Наборы стилей»). */
export interface StylePreset {
  name: string;
  style: Partial<TextStyle>;
}

/** Where the presets are kept (the studio's key-value store). */
export const PRESETS_KEY = 'stylePresets';
const MAX = 50;

/**
 * What a preset keeps of a block's style: its look (font, colours, outline, glow, gradient, effects),
 * not what belongs to that one block — its size (each bubble fits its own), turn and alignment.
 */
export function presetStyle(style: Partial<TextStyle>): Partial<TextStyle> {
  const { fontSize: _size, rotation: _turn, alignment: _align, vertical: _vertical, ...look } = style;
  return look;
}

/** The list with `name` saved (one of the same name replaced), newest first; a blank name changes nothing. */
export function savePreset(list: StylePreset[], name: string, style: Partial<TextStyle>): StylePreset[] {
  const n = name.trim();
  if (!n) return list;
  return [{ name: n, style }, ...list.filter((p) => p.name !== n)].slice(0, MAX);
}

export function removePreset(list: StylePreset[], name: string): StylePreset[] {
  return list.filter((p) => p.name !== name);
}
