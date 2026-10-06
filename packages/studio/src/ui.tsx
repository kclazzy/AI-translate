import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@ait/core';

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="ait-field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="ait-switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ait-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div>
      {label ? <div className="ait-hint" style={{ marginBottom: 4 }}>{label}</div> : null}
      <div className="ait-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const detail = (error as { detail?: string })?.detail;
  return (
    <div className="ait-error" role="alert">
      <div>{errorMessage(error)}</div>
      {detail ? <div className="ait-muted" style={{ fontSize: 12, marginTop: 4 }}>{detail}</div> : null}
      {onRetry ? (
        <button className="ait-btn small" style={{ marginTop: 8 }} onClick={onRetry}>
          Повторить
        </button>
      ) : null}
    </div>
  );
}

let toastSetter: ((m: string | null) => void) | null = null;
export function toast(message: string) {
  toastSetter?.(message);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    toastSetter = (m) => {
      setMsg(m);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(null), 3500);
    };
    return () => {
      toastSetter = null;
    };
  }, []);
  return msg ? (
    <div className="ait-toast" role="status">
      {msg}
    </div>
  ) : null;
}

/** Run an async action with busy/error state. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async (...a: A) => {
      setBusy(true);
      setError(null);
      try {
        await fn(...a);
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, setError };
}

/** Object URL for bytes that is revoked when it changes. */
export function useObjectUrl(bytes: Uint8Array | undefined, mime = 'image/png'): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!bytes) {
      setUrl(undefined);
      return;
    }
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  return url;
}

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
export const Icon = {
  Book: () => (<svg viewBox="0 0 24 24" {...P}><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" /><path d="M8 7h6" /></svg>),
  Edit: () => (<svg viewBox="0 0 24 24" {...P}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></svg>),
  Gloss: () => (<svg viewBox="0 0 24 24" {...P}><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>),
  Gear: () => (<svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>),
  Lock: () => (<svg viewBox="0 0 24 24" {...P}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>),
  Clock: () => (<svg viewBox="0 0 24 24" {...P}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>),
};
