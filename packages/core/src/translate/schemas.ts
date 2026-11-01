/**
 * The shape of each kind of answer, as a JSON schema for servers that keep the model to it (Ollama:
 * `format`). Kept loose on purpose: only what the instruction shows is described and only what the
 * parser needs is required — a field demanded and not needed would be made up by the model and
 * lengthen the answer. The instructions (prompt.ts, qa.ts, selftest.ts) show the same shapes; the
 * tests check the two agree.
 */

export type AnswerKind = 'page' | 'pageRead' | 'collage' | 'collageRead' | 'translations' | 'reviews' | 'selftest';

type Schema = Record<string, unknown>;

const str: Schema = { type: 'string' };
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties, required });
const list = (items: Schema): Schema => ({ type: 'array', items });

const entities = list(obj({ source: str, target: str, kind: str, gender: str }, ['source', 'target']));

function blocks(byId: boolean, withTranslation: boolean): Schema {
  const where: Record<string, Schema> = byId ? { id: { type: 'integer' } } : { box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 } };
  const props: Record<string, Schema> = {
    ...where,
    text: str,
    ...(withTranslation ? { translation: str } : {}),
    type: str,
    ...(byId ? {} : { vertical: { type: 'boolean' }, speaker: str, gender: str }),
    s: str,
  };
  return list(obj(props, [...Object.keys(where), 'text', ...(withTranslation ? ['translation'] : []), 'type']));
}

const page = (byId: boolean, withTranslation: boolean): Schema =>
  withTranslation
    ? obj({ blocks: blocks(byId, true), entities, summary: str }, ['blocks', 'entities', 'summary'])
    : obj({ blocks: blocks(byId, false) }, ['blocks']);

const SCHEMAS: Record<AnswerKind, () => Schema> = {
  page: () => page(false, true),
  pageRead: () => page(false, false),
  collage: () => page(true, true),
  collageRead: () => page(true, false),
  translations: () => obj({ translations: list(obj({ id: str, text: str, type: str }, ['id', 'text'])), entities, summary: str }, ['translations']),
  reviews: () => obj({ reviews: list(obj({ id: str, ok: { type: 'boolean' }, issues: list(obj({ kind: str, severity: str, note: str }, ['kind'])), fix: str }, ['id', 'ok'])) }, ['reviews']),
  selftest: () => obj({ text: str, translation: str }, ['text', 'translation']),
};

export function answerSchema(kind: AnswerKind): Schema {
  return SCHEMAS[kind]();
}
