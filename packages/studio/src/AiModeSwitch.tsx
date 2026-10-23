import { aiModeOf, aiModesAvailable, applyAiMode, type AiMode, type AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';

const MODES: AiMode[] = ['ollama', 'cloud', 'engine'];

function label(m: AiMode): string {
  return m === 'ollama' ? tr('Ollama на ПК') : m === 'cloud' ? tr('Облако') : tr('Движок');
}

export function aiModeHint(m: AiMode): string {
  return m === 'ollama'
    ? tr('Модель на этом компьютере читает и переводит картинку. Без интернета, нужна видеокарта.')
    : m === 'cloud'
      ? tr('Картинку читает и переводит онлайн-модель (Gemini, OpenAI, Claude…); поиск текста и LaMa — на этом компьютере. Несколько страниц одновременно.')
      : tr('Движок AI Translate на ПК сам находит и распознаёт текст, текстовая модель переводит. Быстрее на простых страницах, хуже на стилизованных надписях.');
}

/**
 * One click between the three ways to work (see core aiMode.ts). A mode without a model server
 * (or engine address) is shown greyed out with what it needs; `force` lets the settings page pick
 * the engine before its address is filled in.
 */
export function AiModeSwitch({ settings: s, update, compact, force }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; compact?: boolean; force?: boolean }) {
  const now = aiModeOf(s);
  const can = aiModesAvailable(s);
  const need = (m: AiMode) => (m === 'engine' ? tr('Укажите адрес движка в настройках') : m === 'cloud' ? tr('Добавьте онлайн-сервер с моделью, читающей картинки') : tr('Добавьте Ollama или LM Studio'));
  return (
    <div data-testid="ai-mode" style={{ display: 'grid', gap: 6 }}>
      <div className="ait-seg" role="group" aria-label={tr('Режим работы ИИ')}>
        {MODES.map((m) => {
          const enabled = can[m] || (force && m === 'engine');
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
    </div>
  );
}
