import { useEffect, useState } from 'react';
import {
  configFromPreset,
  createProvider,
  EngineClient,
  isLocalProvider,
  LANGUAGES,
  listOpenAiModels,
  maskKey,
  PROVIDER_PRESETS,
  shortId,
  type AppSettings,
  type PromptProfile,
  type ProviderConfig,
} from '@ait/core';
import { ModelPicker, RecommendedModelCard, UpdateCheck } from '../ModelPicker';
import { usePlatform } from '../platform';
import { ErrorBox, Field, Segmented, Switch, toast, useAction } from '../ui';

export interface SettingsProps {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}

function ProviderEditor({ cfg, onChange, onRemove }: { cfg: ProviderConfig; onChange: (c: ProviderConfig) => void; onRemove: () => void }) {
  const platform = usePlatform();
  const [key, setKey] = useState('');
  const [stored, setStored] = useState<string | undefined>();
  const [models, setModels] = useState<string[]>([]);
  const preset = PROVIDER_PRESETS.find((p) => p.preset === cfg.preset);

  useEffect(() => {
    void platform.secrets.get(`provider:${cfg.id}`).then(setStored);
  }, [platform, cfg.id]);

  const test = useAction(async () => {
    const apiKey = key || stored;
    if (cfg.kind === 'openai-compatible') {
      try {
        const list = await listOpenAiModels(cfg.baseUrl, apiKey);
        setModels(list.slice(0, 200));
        toast(`Подключено: ${list.length} моделей`);
        return;
      } catch {
        /* some endpoints have no /models; fall back to a tiny completion */
      }
    }
    const p = createProvider({ ...cfg, apiKey, maxOutputTokens: 16 });
    await p.complete({ system: 'Reply with OK.', messages: [{ role: 'user', content: 'ping' }] });
    toast('Подключено');
  });

  const saveKey = async () => {
    await platform.secrets.set(`provider:${cfg.id}`, key.trim());
    setStored(key.trim() || undefined);
    setKey('');
    toast(key.trim() ? 'Ключ сохранён в зашифрованном виде' : 'Ключ удалён');
  };

  return (
    <div className="ait-panel">
      <div className="ait-row" style={{ alignItems: 'center' }}>
        <strong style={{ flex: '1 1 auto' }}>{cfg.label}</strong>
        <span className={`ait-badge ${isLocalProvider(cfg) ? 'local' : ''}`} style={{ flex: '0 0 auto' }}>
          {isLocalProvider(cfg) ? 'на устройстве / в сети' : 'облако'}
        </span>
        <button className="ait-btn small danger" style={{ flex: '0 0 auto' }} onClick={onRemove}>
          Удалить
        </button>
      </div>
      {preset?.hint ? <p className="ait-hint">{preset.hint}</p> : null}
      <div className="ait-grid2" style={{ marginTop: 12 }}>
        <Field label="Название">
          <input className="ait-input" value={cfg.label} onChange={(e) => onChange({ ...cfg, label: e.target.value })} />
        </Field>
        <Field label="Адрес API (base URL)">
          <input className="ait-input" value={cfg.baseUrl} onChange={(e) => onChange({ ...cfg, baseUrl: e.target.value.trim() })} />
        </Field>
        <Field label="Модель" hint="⟳ — получить список моделей с сервера">
          <ModelPicker cfg={cfg} getKey={async () => key || stored} onPick={(model, vision) => onChange({ ...cfg, model, vision: vision ?? cfg.vision })} />
          <input className="ait-input" value={cfg.model} onChange={(e) => onChange({ ...cfg, model: e.target.value.trim() })} aria-label="Имя модели вручную" placeholder="или введите имя вручную" />
        </Field>
        <Field label="Ключ API" hint={stored ? `Сохранён: ${maskKey(stored)}` : preset?.needsKey ? 'Нужен для этого сервиса' : 'Не нужен для локальных серверов'}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="ait-input" type="password" autoComplete="off" placeholder={stored ? '••••••••' : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="ait-btn" onClick={saveKey}>Сохранить</button>
          </div>
        </Field>
      </div>
      <div className="ait-row" style={{ marginTop: 12, alignItems: 'center' }}>
        <Switch checked={cfg.vision} onChange={(v) => onChange({ ...cfg, vision: v })} label="Модель понимает изображения (vision)" />
        <Switch checked={cfg.jsonMode === 'json_object'} onChange={(v) => onChange({ ...cfg, jsonMode: v ? 'json_object' : 'none' })} label="JSON-режим" />
        <button className="ait-btn" style={{ flex: '0 0 auto' }} onClick={() => void test.run()} disabled={test.busy}>
          {test.busy ? 'Проверка…' : 'Проверить подключение'}
        </button>
      </div>
      <div className="ait-grid2" style={{ marginTop: 10 }}>
        <Field label="Цена ввода, $ за 1M токенов" hint="Для оценки стоимости в отладке">
          <input className="ait-input" type="number" min={0} step="0.01" value={cfg.priceInput ?? ''} onChange={(e) => onChange({ ...cfg, priceInput: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
        <Field label="Ждать ответ, секунд" hint="Большим локальным моделям нужно больше времени">
          <input className="ait-input" type="number" min={10} max={3600} placeholder={isLocalProvider(cfg) ? '600' : '120'} value={cfg.timeoutMs ? Math.round(cfg.timeoutMs / 1000) : ''} onChange={(e) => onChange({ ...cfg, timeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined })} />
        </Field>
        <Field label="Режим размышлений">
          <select className="ait-select" value={cfg.noThinking === undefined ? 'auto' : cfg.noThinking ? 'off' : 'on'} onChange={(e) => onChange({ ...cfg, noThinking: e.target.value === 'auto' ? undefined : e.target.value === 'off' })}>
            <option value="auto">Авто (выключен для локальных)</option>
            <option value="off">Выключить (быстрее)</option>
            <option value="on">Оставить</option>
          </select>
        </Field>
        <Field label="Цена вывода, $ за 1M токенов">
          <input className="ait-input" type="number" min={0} step="0.01" value={cfg.priceOutput ?? ''} onChange={(e) => onChange({ ...cfg, priceOutput: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </Field>
      </div>
      <ErrorBox error={test.error} />
    </div>
  );
}

function ProfileEditor({ p, onChange }: { p: PromptProfile; onChange: (p: PromptProfile) => void }) {
  return (
    <div className="ait-grid2">
      <Field label="Название профиля">
        <input className="ait-input" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} />
      </Field>
      <Field label="Honorifics (-сан, -кун)">
        <select className="ait-select" value={p.honorifics} onChange={(e) => onChange({ ...p, honorifics: e.target.value as PromptProfile['honorifics'] })}>
          <option value="keep">Сохранять</option>
          <option value="adapt">Адаптировать</option>
          <option value="drop">Убирать</option>
        </select>
      </Field>
      <Field label="Имена">
        <select className="ait-select" value={p.names} onChange={(e) => onChange({ ...p, names: e.target.value as PromptProfile['names'] })}>
          <option value="transliterate">Транслитерировать</option>
          <option value="keep-original">Оставлять латиницей</option>
          <option value="adapt">Адаптировать</option>
        </select>
      </Field>
      <Field label="Тон">
        <input className="ait-input" placeholder="например: дерзкий, подростковый сленг" value={p.tone} onChange={(e) => onChange({ ...p, tone: e.target.value })} />
      </Field>
      <div style={{ gridColumn: '1 / -1' }}>
        <Field label="Инструкции для модели">
          <textarea className="ait-textarea" value={p.customPrompt} onChange={(e) => onChange({ ...p, customPrompt: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

export function SettingsPanel({ settings: s, update }: SettingsProps) {
  const platform = usePlatform();
  const [addPreset, setAddPreset] = useState('anthropic');
  const [profileId, setProfileId] = useState(s.activeProfileId);
  const [siteKey, setSiteKey] = useState('');
  const engineTest = useAction(async () => {
    const h = await new EngineClient(s.engine.url, s.engine.token).health();
    toast(h.status === 'ok' && (h as { paired?: boolean }).paired !== false ? `Движок ${h.version}: ${h.device}${h.gpu ? `, ${h.gpu}` : ''}` : 'Движок отвечает, но код сопряжения не подошёл');
  });

  const setProvider = (c: ProviderConfig) => update({ providers: s.providers.map((p) => (p.id === c.id ? c : p)) });
  const removeProvider = (id: string) =>
    update({
      providers: s.providers.filter((p) => p.id !== id),
      visionProviderId: s.visionProviderId === id ? null : s.visionProviderId,
      translationProviderId: s.translationProviderId === id ? null : s.translationProviderId,
    });
  const profile = s.profiles.find((p) => p.id === profileId) ?? s.profiles[0];
  const visionCandidates = s.providers.filter((p) => p.vision);

  return (
    <div>
      {s.pipeline === 'standalone' ? <RecommendedModelCard settings={s} update={update} autoStart={new URLSearchParams(location.search).get('pull') === '1'} /> : null}
      <div className="ait-panel">
        <h2>Как переводить</h2>
        <div className="ait-grid2">
          <Field label="Исходный язык">
            <select className="ait-select" value={s.sourceLang} onChange={(e) => update({ sourceLang: e.target.value })}>
              <option value="auto">Определять автоматически</option>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
            </select>
          </Field>
          <Field label="Язык перевода">
            <select className="ait-select" value={s.targetLang} onChange={(e) => update({ targetLang: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native}</option>)}
            </select>
          </Field>
          <Field label="Качество" hint="Чем выше, тем крупнее картинка уходит модели и дольше ответ">
            <Segmented label="Качество" value={s.quality} onChange={(quality) => update({ quality })} options={[{ value: 'fast', label: 'Быстро' }, { value: 'balanced', label: 'Баланс' }, { value: 'best', label: 'Максимум' }]} />
          </Field>
          <Field label="Звуки (SFX)">
            <div style={{ display: 'grid', gap: 8 }}>
              <Switch checked={s.translateSfx} onChange={(translateSfx) => update({ translateSfx })} label="Переводить звуковые эффекты" />
              <select className="ait-select" value={s.sfxStyle} onChange={(e) => update({ sfxStyle: e.target.value as AppSettings['sfxStyle'] })}>
                <option value="translated">Перевод</option>
                <option value="original">Оставить оригинал</option>
                <option value="small">Мелкий</option>
                <option value="large">Крупный</option>
                <option value="artistic">Художественный</option>
              </select>
            </div>
          </Field>
        </div>
      </div>

      <div className="ait-panel">
        <h2>Где обрабатывать</h2>
        <Segmented
          label="Режим обработки"
          value={s.pipeline}
          onChange={(pipeline) => update({ pipeline })}
          options={[
            { value: 'standalone', label: 'Здесь (через модель)' },
            { value: 'engine', label: 'Локальный движок' },
          ]}
        />
        <p className="ait-hint">
          {s.pipeline === 'standalone'
            ? 'Изображение читает vision-модель, очистка и вёрстка выполняются прямо здесь. Работает без установки движка, в том числе на телефоне.'
            : 'Поиск текста, OCR и очистку делает движок на ПК (GPU). Телефон может подключиться к нему по Wi-Fi.'}
        </p>
        {s.pipeline === 'engine' ? (
          <div className="ait-grid2" style={{ marginTop: 12 }}>
            <Field label="Адрес движка" hint="На ПК: http://127.0.0.1:8765. С телефона: LAN-адрес из окна движка.">
              <input className="ait-input" value={s.engine.url} onChange={(e) => update({ engine: { ...s.engine, url: e.target.value.trim() } })} />
            </Field>
            <Field label="Код сопряжения" hint="Показывается в окне движка при запуске">
              <input className="ait-input" value={s.engine.token} onChange={(e) => update({ engine: { ...s.engine, token: e.target.value.trim() } })} />
            </Field>
            <Field label="Поиск текста">
              <select className="ait-select" value={s.engine.options.detector} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, detector: e.target.value as AppSettings['engine']['options']['detector'] } } })}>
                <option value="auto">Авто (баблы, иначе vision)</option>
                <option value="classic">Только баблы (без модели)</option>
                <option value="vision">Vision-модель</option>
              </select>
            </Field>
            <Field label="Распознавание (OCR)">
              <select className="ait-select" value={s.engine.options.ocr} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, ocr: e.target.value as AppSettings['engine']['options']['ocr'] } } })}>
                <option value="auto">Авто</option>
                <option value="manga-ocr">manga-ocr (японский)</option>
                <option value="paddle">PaddleOCR (корейский, китайский)</option>
                <option value="vision">Vision-модель</option>
              </select>
            </Field>
            <Field label="Очистка">
              <select className="ait-select" value={s.engine.options.inpainter} onChange={(e) => update({ engine: { ...s.engine, options: { ...s.engine.options, inpainter: e.target.value as AppSettings['engine']['options']['inpainter'] } } })}>
                <option value="auto">Авто</option>
                <option value="fill">Заливка цветом бабла</option>
                <option value="telea">OpenCV</option>
                <option value="lama">LaMa (нужна модель)</option>
              </select>
            </Field>
            <div style={{ alignSelf: 'end' }}>
              <button className="ait-btn" onClick={() => void engineTest.run()} disabled={engineTest.busy}>
                Проверить движок
              </button>
            </div>
          </div>
        ) : null}
        <ErrorBox error={engineTest.error} />
      </div>

      <div className="ait-panel">
        <h2>Модели</h2>
        <div className="ait-grid2">
          <Field label="Читает изображение" hint="Нужна модель с поддержкой изображений">
            <select className="ait-select" value={s.visionProviderId ?? ''} onChange={(e) => update({ visionProviderId: e.target.value || null })}>
              <option value="">— не выбрано —</option>
              {visionCandidates.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}
            </select>
          </Field>
          <Field label="Переводит текст" hint="Пусто — переводит та же модель за один запрос">
            <select className="ait-select" value={s.translationProviderId ?? ''} onChange={(e) => update({ translationProviderId: e.target.value || null })}>
              <option value="">Та же модель</option>
              {s.providers.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.model}</option>)}
            </select>
          </Field>
          <Field label="Приватность">
            <select className="ait-select" value={s.privacy} onChange={(e) => update({ privacy: e.target.value as AppSettings['privacy'] })}>
              <option value="local">Только локально — ничего не уходит наружу</option>
              <option value="hybrid">Гибрид — наружу уходит только текст</option>
              <option value="cloud">Облако — изображения могут уходить провайдеру</option>
            </select>
          </Field>
          <Field label="Параллельных страниц">
            <input className="ait-input" type="number" min={1} max={8} value={s.concurrency} onChange={(e) => update({ concurrency: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })} />
          </Field>
        </div>
      </div>

      {s.providers.map((p) => (
        <ProviderEditor key={p.id} cfg={p} onChange={setProvider} onRemove={() => removeProvider(p.id)} />
      ))}
      <div className="ait-panel">
        <div className="ait-row">
          <Field label="Добавить провайдера">
            <select className="ait-select" value={addPreset} onChange={(e) => setAddPreset(e.target.value)}>
              {PROVIDER_PRESETS.map((p) => <option key={p.preset} value={p.preset}>{p.label}</option>)}
            </select>
          </Field>
          <div style={{ flex: '0 0 auto' }}>
            <button className="ait-btn" onClick={() => update({ providers: [...s.providers, configFromPreset(addPreset, shortId(addPreset + '-'))] })}>
              Добавить
            </button>
          </div>
        </div>
      </div>

      <div className="ait-panel">
        <h2>Профили перевода</h2>
        <div className="ait-row" style={{ marginBottom: 12 }}>
          <Field label="Профиль">
            <select className="ait-select" value={profile.id} onChange={(e) => setProfileId(e.target.value)}>
              {s.profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <div style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
            <button className="ait-btn" onClick={() => update({ activeProfileId: profile.id })} disabled={s.activeProfileId === profile.id}>
              {s.activeProfileId === profile.id ? 'Используется по умолчанию' : 'Сделать основным'}
            </button>
            <button
              className="ait-btn"
              onClick={() => {
                const id = shortId('prof');
                update({ profiles: [...s.profiles, { ...profile, id, name: `${profile.name} (копия)` }] });
                setProfileId(id);
              }}
            >
              Копировать
            </button>
          </div>
        </div>
        <ProfileEditor p={profile} onChange={(np) => update({ profiles: s.profiles.map((x) => (x.id === np.id ? np : x)) })} />
        <h3>Профиль для конкретного сайта или серии</h3>
        <div className="ait-row">
          <Field label="Сайт или серия" hint="Например: mangadex.org/title/abc">
            <input className="ait-input" value={siteKey} onChange={(e) => setSiteKey(e.target.value.trim())} />
          </Field>
          <div style={{ flex: '0 0 auto' }}>
            <button className="ait-btn" disabled={!siteKey} onClick={() => { update({ seriesProfiles: { ...s.seriesProfiles, [siteKey]: profile.id } }); setSiteKey(''); }}>
              Привязать «{profile.name}»
            </button>
          </div>
        </div>
        {Object.entries(s.seriesProfiles).length ? (
          <table className="ait-table" style={{ marginTop: 10 }}>
            <tbody>
              {Object.entries(s.seriesProfiles).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{s.profiles.find((p) => p.id === v)?.name ?? v}</td>
                  <td style={{ width: 1 }}>
                    <button className="ait-btn small ghost" onClick={() => { const next = { ...s.seriesProfiles }; delete next[k]; update({ seriesProfiles: next }); }}>Убрать</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="ait-panel">
        <h2>Интерфейс и данные</h2>
        <div className="ait-grid2">
          <Field label="Тема">
            <Segmented label="Тема" value={s.theme} onChange={(theme) => update({ theme })} options={[{ value: 'system', label: 'Как в системе' }, { value: 'light', label: 'Светлая' }, { value: 'dark', label: 'Тёмная' }]} />
          </Field>
          <Field label="Режим работы">
            <Segmented label="Режим" value={s.uiMode} onChange={(uiMode) => update({ uiMode })} options={[{ value: 'reader', label: 'Читатель' }, { value: 'advanced', label: 'Продвинутый' }, { value: 'scanlator', label: 'Сканлейтер' }]} />
          </Field>
          <Field label="Хранить кэш, дней">
            <input className="ait-input" type="number" min={1} max={365} value={s.cacheDays} onChange={(e) => update({ cacheDays: Math.max(1, Number(e.target.value) || 14) })} />
          </Field>
          <Field label="Минимальный размер картинки, px">
            <input className="ait-input" type="number" min={50} max={2000} value={s.minImageSize} onChange={(e) => update({ minImageSize: Math.max(50, Number(e.target.value) || 200) })} />
          </Field>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <Switch checked={s.saveHistory} onChange={(saveHistory) => update({ saveHistory })} label="Сохранять историю переводов" />
          <Switch checked={s.debug} onChange={(debug) => update({ debug })} label="Показывать отладку (время этапов, токены, стоимость)" />
        </div>
        <div style={{ marginTop: 14 }}>
          <UpdateCheck current={platform.version} />
        </div>
      </div>
    </div>
  );
}
