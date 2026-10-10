import { useEffect, useState } from 'react';
import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';
import { Switch } from './ui';

/** Is the text detector's model in this browser's cache (null while checking, false without it here)? */
export function useDetectorDownloaded(): [boolean | null, (v: boolean) => void] {
  const platform = usePlatform();
  const [have, setHave] = useState<boolean | null>(null);
  useEffect(() => {
    let off = false;
    if (!platform.detector) setHave(false);
    else void platform.detector.downloaded().then((v) => !off && setHave(v), () => !off && setHave(false));
    return () => {
      off = true;
    };
  }, [platform]);
  return [have, setHave];
}

/** «Скачать»: downloads the detector once (with progress) and switches it on. */
export function DetectorGetButton({ update, label, primary, downloaded, onDone, testId }: { update: (p: Partial<AppSettings>) => void; label: string; primary?: boolean; downloaded?: boolean | null; onDone?: () => void; testId?: string }) {
  const platform = usePlatform();
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!platform.detector) return null;
  const run = async () => {
    setErr(null);
    try {
      if (!downloaded && !(await platform.detector!.downloaded())) {
        setPct(0);
        await platform.detector!.download(setPct);
      }
      update({ detectorMode: 'browser' });
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPct(null);
    }
  };
  return (
    <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} data-testid={testId}>
      {pct !== null ? (
        <>
          <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание нейросети поиска текста')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
          <small className="ait-muted">{Math.round(pct * 100)}%</small>
        </>
      ) : (
        <button className={primary ? 'ait-bubble-btn' : 'ait-btn small'} onClick={() => void run()}>
          {label}
        </button>
      )}
      {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
    </span>
  );
}

/** Settings: the neural text / bubble detector — download, switch on or off, remove. Hidden where it cannot run. */
export function DetectorChoice({ settings: s, update }: { settings: AppSettings; update: (p: Partial<AppSettings>) => void }) {
  const platform = usePlatform();
  const [have, setHave] = useDetectorDownloaded();
  if (!platform.detector) return null;
  const on = s.detectorMode === 'browser';
  return (
    <div style={{ display: 'grid', gap: 6 }} data-testid="detector">
      <span className="ait-set-label">{tr('Точный поиск текста (нейросеть ~45 МБ)')}</span>
      <small className="ait-muted ait-set-hint" title={tr('Нейросеть находит баблы и текст точнее модели-переводчика: меньше сдвинутого текста, пропусков и стёртого рисунка.')}>
        {tr('Нейросеть находит баблы и текст точнее модели-переводчика: меньше сдвинутого текста, пропусков и стёртого рисунка.')}
      </small>
      {have ? (
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span data-testid="detector-switch">
            <Switch checked={on} onChange={(v) => update({ detectorMode: v ? 'browser' : 'off' })} label={on ? tr('Включён') : tr('Выключен')} />
          </span>
          <button
            className="ait-btn small danger"
            data-testid="detector-remove"
            onClick={async () => {
              await platform.detector!.remove();
              setHave(false);
              update({ detectorMode: 'off' });
            }}
          >
            {tr('Удалить')}
          </button>
        </span>
      ) : have === false ? (
        <DetectorGetButton update={update} downloaded={have} label={tr('Скачать')} onDone={() => setHave(true)} testId="detector-download" />
      ) : null}
    </div>
  );
}
