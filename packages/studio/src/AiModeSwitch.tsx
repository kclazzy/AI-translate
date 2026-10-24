import { aiModeOf, aiModesAvailable, applyAiMode, applyOcrTranslator, BROWSER_TRANSLATOR_ID, ocrTranslators, type AiMode, type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { OcrModelsCard } from './ocr';

const MODES: AiMode[] = ['ollama', 'cloud', 'ocr'];

function label(m: AiMode): string {
  return m === 'ollama' ? tr('Ollama на ПК') : m === 'cloud' ? tr('Облако') : m === 'ocr' ? tr('Распознавание') : tr('Движок');
}

export function aiModeHint(m: AiMode): string {
  return m === 'ollama'
    ? tr('Модель на этом компьютере читает и переводит картинку. Без интернета, нужна видеокарта.')
    : m === 'cloud'
      ? tr('Картинку читает и переводит онлайн-модель (Gemini, OpenAI, Claude…); поиск текста и LaMa — на этом компьютере. Несколько страниц одновременно.')
      : m === 'ocr'
        ? tr('Текст распознаётся прямо в браузере (PaddleOCR), переводит встроенный переводчик браузера — без Ollama и интернета — или любая текстовая модель (лучше учитывает контекст). Быстро, но рисованные надписи читает хуже.')
        : tr('Движок AI Translate на ПК сам находит и распознаёт текст, текстовая модель переводит. Быстрее на простых страницах, хуже на стилизованных надписях.');
}

/**
 * One click between the three ways to work (see core aiMode.ts). A mode without a model server is
 * shown greyed out with what it needs. The settings page (`force`) also offers the separate Python
 * engine, as an option for advanced users.
 */
export function AiModeSwitch({ settings: s, update, compact, force, ocrHere = true }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; compact?: boolean; force?: boolean; ocrHere?: boolean }) {
  const now = aiModeOf(s);
  const can = { ...aiModesAvailable(s), ...(ocrHere ? {} : { ocr: false }) };
  const need = (m: AiMode) => (m === 'engine' ? tr('Укажите адрес движка в настройках') : m === 'cloud' ? tr('Добавьте онлайн-сервер с моделью, читающей картинки') : m === 'ocr' ? (ocrHere ? tr('Нужен Chrome 138 или новее (встроенный переводчик) либо сервер с моделью для перевода') : tr('Распознавание в браузере доступно в расширении для ПК')) : tr('Добавьте Ollama или LM Studio'));
  return (
    <div data-testid="ai-mode" style={{ display: 'grid', gap: 6 }}>
      <div className="ait-seg" role="group" aria-label={tr('Режим работы ИИ')}>
        {MODES.map((m) => {
          const enabled = can[m];
          return (
            <button
              key={m}
              type="button"
              data-mode={m}
              aria-pressed={now === m}
              disabled={!enabled}
              title={enabled ? aiModeHint(m) : need(m)}
              onClick={() => {
                const patch = applyAiMode(s, m) ?? (m === 'engine' ? { pipeline: 'engine' as const } : null);
                if (patch) update(patch);
              }}
            >
              {label(m)}
            </button>
          );
        })}
      </div>
      {compact ? null : <small className="ait-muted ait-set-hint">{aiModeHint(now)}</small>}
      {now === 'ocr' ? <OcrTranslatorPick settings={s} update={update} /> : null}
      {now === 'ocr' && !compact ? <OcrModelsCard settings={s} /> : null}
      {force ? (
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={now === 'engine'} onChange={(e) => update(e.target.checked ? (applyAiMode(s, 'engine') ?? { pipeline: 'engine' }) : (applyAiMode(s, 'ollama') ?? applyAiMode(s, 'cloud') ?? applyAiMode(s, 'ocr') ?? { pipeline: 'standalone' }))} />
          <small>{tr('Отдельная программа AI Translate Engine (Python) — для опытных')}</small>
        </label>
      ) : null}
    </div>
  );
}

/** What translates the recognised text: the browser's own translator or one of the model servers. */
function OcrTranslatorPick({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const list = ocrTranslators(s);
  if (!list.length) return null;
  const now = s.visionProviderId ?? '';
  return (
    <label className="ait-field" data-testid="ocr-translator">
      <span>{tr('Чем переводить')}</span>
      <select className="ait-select" value={now} onChange={(e) => update(applyOcrTranslator(s, e.target.value))}>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === BROWSER_TRANSLATOR_ID ? tr('Встроенный переводчик браузера — без Ollama и интернета') : `${p.label} — ${p.model}`}
          </option>
        ))}
      </select>
    </label>
  );
}
