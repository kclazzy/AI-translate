import { tr } from '@ait/core/i18n';

/** What the open editor tells the rest of the studio: are there unsaved edits, and how to save them. */
export interface EditorGuard {
  dirty(): boolean;
  /** Save; resolves false when saving failed (the editor shows the error). */
  save(): Promise<boolean>;
}

let active: EditorGuard | null = null;

/** The editor registers itself while it is open (one editor at a time). */
export function setActiveEditor(g: EditorGuard | null, owner?: EditorGuard): void {
  if (g) active = g;
  else if (!owner || active === owner) active = null;
}

export function activeEditor(): EditorGuard | null {
  return active;
}

/**
 * Before the editor goes away (another page, another section, «Глава целиком»): offer to save the
 * edits first. Resolves true when it is fine to go on.
 */
export async function confirmLeave(g: EditorGuard | null = active): Promise<boolean> {
  if (!g || !g.dirty()) return true;
  if (confirm(tr('Есть несохранённые правки. Сохранить их и перейти?\n\nОК — сохранить и перейти. Отмена — другие варианты.'))) return g.save();
  return confirm(tr('Перейти без сохранения? Правки на этой странице будут потеряны.'));
}
