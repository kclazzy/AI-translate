import { useSyncExternalStore } from 'react';
import { autoOptimal, type AppSettings } from '@ait/core';

/**
 * The settings brought by the last switch of model (see autoOptimal in the core): shown in the
 * settings with «Вернуть как было», kept outside the components (the saved settings re-create them).
 */
export interface AutoTuned {
  changes: string[];
  before: Partial<AppSettings>;
}

let last: AutoTuned | null = null;
const subs = new Set<() => void>();
const set = (v: AutoTuned | null) => {
  last = v;
  for (const f of subs) f();
};

export function useAutoTuned(): AutoTuned | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => last,
  );
}

export const clearAutoTuned = () => set(null);

/** The patch with the settings that suit the model it switches to (unchanged when it switches none). */
export function withAutoOptimal(prev: AppSettings, patch: Partial<AppSettings>): { patch: Partial<AppSettings>; tuned: AutoTuned | null } {
  const a = autoOptimal(prev, patch);
  if (!a) return { patch, tuned: null };
  const tuned = { changes: a.changes, before: a.before };
  set(tuned);
  return { patch: { ...patch, ...a.patch }, tuned };
}
