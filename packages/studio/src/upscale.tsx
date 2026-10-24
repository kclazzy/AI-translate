import { useEffect, useState } from 'react';
import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';
import { Switch } from './ui';

/**
 * Settings: small scans made twice as big before reading (a network of ~5 MB in this browser) —
 * download, switch on or off, remove. Hidden where it cannot run.
 */
export function UpscaleChoice({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const platform = usePlatform();
  const [have, setHave] = useState<boolean | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    if (!platform.upscaler) setHave(false);
    else void platform.upscaler.downloaded().then((v) => !off && setHave(v), () => !off && setHave(false));
    return () => {
      off = true;
    };
  }, [platform]);
  if (!platform.upscaler || s.pipeline === 'engine') return null;
  const on = s.upscaleMode === 'browser';
  const get = async () => {
    setErr(null);
    setPct(0);
    try {
      await platform.upscaler!.download(setPct);
      setHave(true);
      update({ upscaleMode: 'browser' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPct(null);
    }
  };
  return (
    <div style={{ display: 'grid', gap: 6 }} data-testid="upscale">
      <span className="ait-set-label">{tr('Увеличивать маленькие сканы (нейросеть ~5 МБ)')}</span>
      <small className="ait-muted ait-set-hint">{tr('Картинки меньше 1000 пикселей увеличиваются вдвое до распознавания: мелкие буквы читаются точнее, перевод выглядит чётче. Страница переводится немного дольше.')}</small>
      {have ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span data-testid="upscale-switch">
            <Switch checked={on} onChange={(v) => update({ upscaleMode: v ? 'browser' : 'off' })} label={on ? tr('Включено') : tr('Выключено')} />
          </span>
          <button
            className="ait-btn small danger"
            onClick={async () => {
              await platform.upscaler!.remove();
              setHave(false);
              update({ upscaleMode: 'off' });
            }}
          >
            {tr('Удалить')}
          </button>
        </span>
      ) : have === false ? (
        pct !== null ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание нейросети увеличения')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ width: `${Math.round(pct * 100)}%` }} />
            </span>
            <small className="ait-muted">{Math.round(pct * 100)}%</small>
          </span>
        ) : (
          <span>
            <button className="ait-btn small" data-testid="upscale-download" onClick={() => void get()}>{tr('Скачать')}</button>
          </span>
        )
      ) : null}
      {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
    </div>
  );
}
