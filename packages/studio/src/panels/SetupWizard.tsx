import { useState } from 'react';
import { configFromPreset, EngineClient, listOpenAiModels, shortId, type AppSettings } from '@ait/core';
import { usePlatform } from '../platform';
import { ErrorBox, Field, useAction } from '../ui';
import { tr } from '@ait/core/i18n';

type Choice = 'cloud' | 'lan-model' | 'engine';

/**
 * First run on a phone: the app works on its own, so the user picks where the AI runs.
 * Every option ends with a working configuration; nothing here is mandatory later.
 */
export function SetupWizard({ settings, update, onDone }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void; onDone: () => void }) {
  const platform = usePlatform();
  const [choice, setChoice] = useState<Choice>('cloud');
  const [preset, setPreset] = useState('gemini');
  const [key, setKey] = useState('');
  const [lanUrl, setLanUrl] = useState('http://192.168.1.10:11434/v1');
  const [lanModel, setLanModel] = useState('qwen3.5:9b-q4_K_M');
  const [engineUrl, setEngineUrl] = useState('http://192.168.1.10:8765');
  const [code, setCode] = useState('');

  const finish = useAction(async () => {
    if (choice === 'cloud') {
      if (!key.trim()) throw new Error(tr('Вставьте ключ API'));
      const cfg = { ...configFromPreset(preset, shortId(`${preset}-`)), vision: true };
      await platform.secrets.set(`provider:${cfg.id}`, key.trim());
      update({ providers: [...settings.providers, cfg], visionProviderId: cfg.id, translationProviderId: null, privacy: 'cloud', pipeline: 'standalone', onboarded: true });
    } else if (choice === 'lan-model') {
      const models = await listOpenAiModels(lanUrl.trim(), undefined).catch(() => {
        throw new Error(tr('Сервер моделей не отвечает. Проверьте адрес и что телефон в той же сети Wi-Fi.'));
      });
      const cfg = { ...configFromPreset(lanUrl.includes(':1234') ? 'lmstudio' : 'ollama', shortId('lan-')), baseUrl: lanUrl.trim(), model: lanModel.trim() || models[0] || 'model', vision: true, label: tr('Модель на ПК') };
      update({ providers: [...settings.providers, cfg], visionProviderId: cfg.id, translationProviderId: null, privacy: 'local', pipeline: 'standalone', onboarded: true });
    } else {
      const health = await new EngineClient(engineUrl.trim(), code.trim()).health().catch(() => {
        throw new Error(tr('Движок не отвечает. Запустите его на ПК с флагом --lan и проверьте адрес.'));
      });
      if ((health as { paired?: boolean }).paired === false) throw new Error(tr('Код сопряжения не подошёл'));
      const cfg = { ...configFromPreset('ollama', shortId('lan-')), baseUrl: lanUrl.trim(), model: lanModel.trim(), vision: true, label: tr('Модель на ПК') };
      update({ providers: [...settings.providers, cfg], visionProviderId: cfg.id, pipeline: 'engine', privacy: 'local', engine: { ...settings.engine, url: engineUrl.trim(), token: code.trim() }, onboarded: true });
    }
    onDone();
  });

  const option = (id: Choice, title: string, text: string) => (
    <label className="ait-panel" style={{ display: 'flex', gap: 12, cursor: 'pointer', borderColor: choice === id ? 'var(--magenta)' : undefined }}>
      <input type="radio" name="setup" checked={choice === id} onChange={() => setChoice(id)} style={{ marginTop: 4 }} />
      <span>
        <strong>{title}</strong>
        <br />
        <span className="ait-hint">{text}</span>
      </span>
    </label>
  );

  return (
    <div className="ait-content" style={{ maxWidth: 640, margin: '0 auto', paddingTop: 'calc(24px + env(safe-area-inset-top))' }}>
      <div className="ait-mark" style={{ padding: '8px 0 4px', fontSize: 28 }}>AI Translate</div>
      <p style={{ marginTop: 0 }}>{tr('Переводит мангу, манхву и комиксы на телефоне. Выберите, где будет работать модель — это можно поменять позже в настройках.')}</p>
      {option('cloud', tr('Облачная модель по ключу'), tr('Работает везде, без ПК. Картинка отправляется выбранному сервису (Gemini, Claude, OpenAI).'))}
      {option('lan-model', tr('Модель на моём ПК по Wi-Fi'), tr('Ollama или LM Studio на компьютере в той же сети. Ничего не уходит в интернет.'))}
      {option('engine', tr('Движок AI Translate на ПК'), tr('Лучшее качество очистки и OCR на видеокарте ПК. Нужен запущенный движок с флагом --lan.'))}

      <div className="ait-panel">
        {choice === 'cloud' ? (
          <div className="ait-grid2">
            <Field label={tr('Сервис')}>
              <select className="ait-select" value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="gemini">Google Gemini</option>
                <option value="anthropic">Anthropic Claude</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </Field>
            <Field label={tr('Ключ API')} hint={tr('Хранится на телефоне в зашифрованном виде')}>
              <input className="ait-input" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="ait-grid2">
            {choice === 'engine' ? (
              <>
                <Field label={tr('Адрес движка')} hint={tr('Показан в окне движка: строка LAN')}>
                  <input className="ait-input" inputMode="url" value={engineUrl} onChange={(e) => setEngineUrl(e.target.value)} />
                </Field>
                <Field label={tr('Код сопряжения')}>
                  <input className="ait-input" value={code} onChange={(e) => setCode(e.target.value)} />
                </Field>
              </>
            ) : null}
            <Field label={tr('Сервер моделей (Ollama/LM Studio)')} hint={tr('Адрес ПК в сети и порт: Ollama 11434, LM Studio 1234')}>
              <input className="ait-input" inputMode="url" value={lanUrl} onChange={(e) => setLanUrl(e.target.value)} />
            </Field>
            <Field label={tr('Модель с поддержкой изображений')}>
              <input className="ait-input" value={lanModel} onChange={(e) => setLanModel(e.target.value)} />
            </Field>
          </div>
        )}
        <ErrorBox error={finish.error} />
        <div className="ait-row" style={{ marginTop: 16 }}>
          <button className="ait-bubble-btn" style={{ flex: '0 0 auto' }} disabled={finish.busy} onClick={() => void finish.run()}>
            {finish.busy ? tr('Проверяю…') : tr('Готово')}
          </button>
          <button className="ait-btn ghost" style={{ flex: '0 0 auto' }} onClick={() => { update({ onboarded: true }); onDone(); }}>
            
            {tr('Настрою позже')}
          </button>
        </div>
      </div>
    </div>
  );
}
