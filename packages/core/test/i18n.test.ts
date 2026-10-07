import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { registerDictionary, resolveUiLang, setUiLang, t, UI_LANGS } from '../src/i18n';
import { QA_LABELS } from '../src/translate/qa';
import { errorMessage } from '../src/errors';
import { defaultTargetLang } from '../src/settings';

const dir = new URL('../src/i18n/locales/', import.meta.url);
const keys: string[] = JSON.parse(readFileSync(new URL('../src/i18n/keys.json', import.meta.url), 'utf8'));
const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(',');

describe('interface languages', () => {
  it('every language in the picker has a complete dictionary with the same placeholders', () => {
    const files = readdirSync(dir).map((f) => f.replace('.json', ''));
    for (const l of UI_LANGS) if (l.code !== 'ru') expect(files, l.code).toContain(l.code);
    for (const f of files) {
      const d: Record<string, string> = JSON.parse(readFileSync(new URL(`${f}.json`, dir), 'utf8'));
      for (const k of keys) {
        expect(d[k], `${f}: ${k}`).toBeTruthy();
        expect(placeholders(d[k]), `${f}: ${k}`).toBe(placeholders(k));
      }
    }
  });
  it('"as in the system" follows the browser / Windows language, unknown languages get English', () => {
    expect(resolveUiLang('auto', 'ru-RU')).toBe('ru');
    expect(resolveUiLang('auto', 'de-AT')).toBe('de');
    expect(resolveUiLang('auto', 'zh-CN')).toBe('zh');
    expect(resolveUiLang('auto', 'it-IT')).toBe('en');
    expect(resolveUiLang('uk', 'en-US')).toBe('uk');
  });
  it('a new user translates into the system language', () => {
    expect(defaultTargetLang('de-DE')).toBe('de');
    expect(defaultTargetLang('zh-TW')).toBe('zh-TW');
    expect(defaultTargetLang('ru-RU')).toBe('ru');
    expect(defaultTargetLang('xx')).toBe('ru');
  });
  it('translates strings, tables read at use time and error messages', () => {
    registerDictionary('en', JSON.parse(readFileSync(new URL('en.json', dir), 'utf8')));
    setUiLang('en', false);
    expect(t('Сохранить')).toBe('Save');
    expect(t('Нет такой строки {0}', 5)).toBe('Нет такой строки 5');
    expect(QA_LABELS.grammar).toBe(t('Грамматика'));
    expect(QA_LABELS.grammar).not.toMatch(/[А-Яа-я]/);
    expect(errorMessage({ code: 'TIMEOUT', retryable: true, message: '' })).not.toMatch(/[А-Яа-я]/);
    setUiLang('ru', false);
    expect(QA_LABELS.grammar).toBe('Грамматика');
    expect(errorMessage({ code: 'TIMEOUT', retryable: true, message: '' })).toMatch(/слишком долго/);
  });
});
