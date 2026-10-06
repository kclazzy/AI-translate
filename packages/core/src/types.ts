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
  overflow?: boolean;
  /** Set when the user edited this block by hand. */
  edited?: boolean;
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
  createdAt: string;
}

export type JobStage = 'queued' | 'fetching' | 'decoding' | 'detecting' | 'ocr' | 'translating' | 'cleaning' | 'rendering' | 'done' | 'error';

export interface StageEvent {
  stage: JobStage;
  progress?: number;
  message?: string;
}
