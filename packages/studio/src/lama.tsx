import { useEffect, useState } from 'react';
import type { AppSettings } from '@ait/core';
import { tr } from '@ait/core/i18n';
import { usePlatform } from './platform';

/** LaMa mode as the pipeline reads it (old settings had only «lamaEngine»). */
export function lamaModeOf(s: AppSettings): 'off' | 'engine' | 'browser' {
  return s.lamaMode ?? (s.lamaEngine ? 'engine' : 'off');
}

/** Is the LaMa model in this browser's cache (null while checking, false without LaMa here)? */
export function useLamaDownloaded(): [boolean | null, (v: boolean) => void] {
  const platform = usePlatform();
  const [have, setHave] = useState<boolean | null>(null);
  useEffect(() => {
    let off = false;
    if (!platform.lama) setHave(false);
    else void platform.lama.downloaded().then((v) => !off && setHave(v), () => !off && setHave(false));
    return () => {
      off = true;
    };
  }, [platform]);
  return [have, setHave];
}

/**
 * «Скачать и включить»: downloads the LaMa model once (with progress) and switches the redraw to
 * this browser. With the model already there it only switches it on.
 */
export function LamaGetButton({ update, label, primary, small, downloaded, onDone, testId }: { update: (p: Partial<AppSettings>) => void; label: string; primary?: boolean; small?: boolean; downloaded?: boolean | null; onDone?: () => void; testId?: string }) {
  const platform = usePlatform();
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!platform.lama) return null;
  const run = async () => {
    setErr(null);
    try {
      if (!downloaded && !(await platform.lama!.downloaded())) {
        setPct(0);
        await platform.lama!.download(setPct);
      }
      update({ lamaMode: 'browser', lamaEngine: undefined });
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
          <span className="ait-progress" style={{ flex: 1, minWidth: 120 }} role="progressbar" aria-label={tr('Скачивание LaMa')} aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.round(pct * 100)}%` }} />
          </span>
          <small className="ait-muted">{Math.round(pct * 100)}%</small>
        </>
      ) : (
        <button className={primary ? 'ait-bubble-btn' : `ait-btn${small ? ' small' : ''}`} onClick={() => void run()}>
          {label}
        </button>
      )}
      {err ? <small style={{ color: 'var(--err)' }}>{tr('Не удалось скачать: {0}', err)}</small> : null}
    </span>
  );
}
