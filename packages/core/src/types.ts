/**
 * Domain types shared by the extension, the mobile app and (mirrored in Python) the engine.
 * PageResult is the central contract: cache, editor, project files and export all use it.
 */

export type TextType = 'DIALOGUE' | 'NARRATION' | 'SFX' | 'SIGN' | 'OTHER';
export const TEXT_TYPES: TextType[] = ['DIALOGUE', 'NARRATION', 'SFX', 'SIGN', 'OTHER'];

export type WritingDirection = 'ltr' | 'ttb-rl';

/** [x, y, width, height] in page pixels. */
export type Box = [number, number, number, number];
export type Point = [number, number];

export type Alignment = 'left' | 'center' | 'right';

export interface TextStyle {
  fontFamily: string;
  /** null = fit automatically into the safe area. */
  fontSize: number | null;
  color: string;
  strokeColor: string | null;
  strokeWidth: number;
  alignment: Alignment;
  vertical: boolean;
  opacity: number;
  /** Degrees, clockwise. */
  rotation: number;
  bold: boolean;
  italic: boolean;
  shadow: boolean;
  lineHeight: number;
  /** Write the translation in capitals (the original lettering is all caps). */
  uppercase?: boolean;
  /** Glow around the letters: its colour (null = none) and size in px at an 18 px font. */
  glow?: string | null;
  glowSize?: number;
  /** Second colour: letters go from `color` at the top to this at the bottom. */
  gradient?: string | null;
  /** Extra space between letters, as a share of the font size (0.05 = 5 %). */
  letterSpacing?: number;
}

export interface BubbleInfo {
  /** Bubble bounding box. */
  box: Box;
  /** Background colour of the bubble as #rrggbb. */
  fill: string;
  /** Area where translated text may be placed. */
  safeArea: Box;
  /** 'ellipse' lets the typesetter follow a rounded bubble. */
  shape: 'ellipse' | 'rect';
  /**
   * The real inside of the bubble, row by row (any shape: spiky, cloud, rounded box): free span
   * [l[i], r[i]] in page pixels for the row y + i·step. The translation follows it.
   */
  rows?: BubbleRows;
}

export interface BubbleRows {
  y: number;
  step: number;
  l: number[];
  r: number[];
}

export interface TextBlock {
  id: string;
  textType: TextType;
  originalText: string;
  translatedText: string;
  confidence: number;
  language: string;
  bbox: Box;
  polygon: Point[];
  orientation: number;
  writingDirection: WritingDirection;
  fontSizeEstimate: number;
  bubble: BubbleInfo | null;
  /** false = keep the original (e.g. SFX with translation off). */
  translate: boolean;
  /** Where the translated text is drawn; defaults to bubble.safeArea or bbox. */
  textBox?: Box;
  style?: Partial<TextStyle>;
  lowConfidence?: boolean;
  /** Who says it (from the picture) and their gender: verbs and adjectives must agree in many languages. */
  speaker?: string;
  speakerGender?: 'male' | 'female' | 'unknown';
  /** Result of the translation check (linguistic + semantic QA). */
  qa?: import('./translate/qa').BlockQa;
  /** «Сверка»: the translation compared with other translators. */
  check?: import('./translate/crosscheck').BlockCheck;
  overflow?: boolean;
  /** Set when the user edited this block by hand. */
  edited?: boolean;
  /**
   * A picture cut out of a glued strip: this block belongs to a neighbouring picture and is only
   * repeated here because its text crosses the seam (see image/strip.ts pageForSpan). Skip it when
   * gluing the pictures back together or counting blocks.
   */
  continued?: boolean;
}

export interface Usage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface PageTimings {
  decodeMs?: number;
  detectMs?: number;
  ocrMs?: number;
  translateMs?: number;
  cleanMs?: number;
  renderMs?: number;
  totalMs?: number;
}

export interface PageResult {
  pageId: string;
  width: number;
  height: number;
  source: { lang: string; detectedBy: string };
  targetLang: string;
  blocks: TextBlock[];
  timings: PageTimings;
  usage: Usage[];
  pipeline: { version: 1; hash: string; mode: 'engine' | 'standalone' };
  /** Short summary of the page produced by the model, used for chapter context. */
  summary?: string;
  /** A picture cut out of a glued strip: the language of the whole strip (its own part may have no text). */
  stripLang?: string;
  /** Places where text stood over artwork (not a bubble): the background there was painted over simply. */
  artText?: number;
  /** LaMa redrew those places (in the engine or in the browser). */
  artRedrawn?: boolean;
  createdAt: string;
}

export type JobStage = 'queued' | 'fetching' | 'decoding' | 'detecting' | 'ocr' | 'translating' | 'checking' | 'cleaning' | 'rendering' | 'done' | 'error';

export interface StageEvent {
  stage: JobStage;
  progress?: number;
  message?: string;
}
