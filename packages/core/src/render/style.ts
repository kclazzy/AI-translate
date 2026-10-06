import type { SfxStyle } from '../translate/profiles';
import type { Box, TextBlock, TextStyle } from '../types';

export const FONT_STACKS = {
  dialogue: '"AIT Lettering", "AIT Comic", "Comic Neue", "Comic Sans MS", sans-serif',
  narration: '"AIT Narration", "PT Sans Narrow", "Arial Narrow", sans-serif',
  sfx: '"AIT SFX", "Impact", "Arial Black", sans-serif',
  cjk: '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Microsoft YaHei", sans-serif',
};

export interface StyleDefaults {
  dialogueFont: string;
  narrationFont: string;
  sfxFont: string;
  textColor: string;
  sfxStyle: SfxStyle;
  /** Target language; CJK targets may typeset vertically. */
  targetLang: string;
  verticalForCjk: boolean;
}

export const DEFAULT_STYLE_DEFAULTS: StyleDefaults = {
  dialogueFont: FONT_STACKS.dialogue,
  narrationFont: FONT_STACKS.narration,
  sfxFont: FONT_STACKS.sfx,
  textColor: '#111111',
  sfxStyle: 'translated',
  targetLang: 'ru',
  verticalForCjk: true,
};

function isLight(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 128;
}

/** Resolve the full style of a block: per-type defaults overridden by the block's own style. */
export function resolveStyle(block: TextBlock, d: StyleDefaults = DEFAULT_STYLE_DEFAULTS): TextStyle {
  const cjkTarget = ['ja', 'zh', 'zh-TW', 'ko'].includes(d.targetLang);
  const vertical = cjkTarget && d.verticalForCjk && block.writingDirection === 'ttb-rl' && d.targetLang !== 'ko';
  const onLight = block.bubble ? isLight(block.bubble.fill) : true;
  const inBubble = !!block.bubble && block.bubble.shape === 'ellipse';
  const base: TextStyle = {
    fontFamily: cjkTarget ? FONT_STACKS.cjk : d.dialogueFont,
    fontSize: null,
    color: onLight ? d.textColor : '#ffffff',
    strokeColor: inBubble ? null : onLight ? '#ffffff' : '#000000',
    strokeWidth: inBubble ? 0 : 3,
    alignment: 'center',
    vertical,
    opacity: 1,
    rotation: 0,
    bold: false,
    italic: false,
    shadow: false,
    lineHeight: 1.12,
  };
  if (block.textType === 'NARRATION') {
    base.fontFamily = cjkTarget ? FONT_STACKS.cjk : d.narrationFont;
  }
  if (block.textType === 'SFX') {
    base.fontFamily = cjkTarget ? FONT_STACKS.cjk : d.sfxFont;
    base.bold = true;
    base.strokeColor = onLight ? '#ffffff' : '#000000';
    base.strokeWidth = 4;
    base.rotation = block.orientation || 0;
    if (d.sfxStyle === 'artistic') {
      base.rotation = (block.orientation || 0) - 8;
      base.strokeWidth = 6;
      base.shadow = true;
    }
  }
  return { ...base, ...(block.style ?? {}) } as TextStyle;
}

/** Scale factor applied to the SFX target box for the small/large styles. */
export function sfxScale(style: SfxStyle): number {
  return style === 'small' ? 0.75 : style === 'large' ? 1.3 : 1;
}

/** The box the translation is drawn into. */
export function targetBox(block: TextBlock, d: StyleDefaults = DEFAULT_STYLE_DEFAULTS): Box {
  let box: Box = block.textBox ?? block.bubble?.safeArea ?? block.bbox;
  if (block.textType === 'SFX' && !block.textBox) {
    const k = sfxScale(d.sfxStyle);
    const [x, y, w, h] = block.bbox;
    box = [x + (w * (1 - k)) / 2, y + (h * (1 - k)) / 2, w * k, h * k];
  }
  return box;
}
