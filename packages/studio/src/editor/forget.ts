import { tr } from '@ait/core/i18n';
import type { usePlatform } from '../platform';
import { toast } from '../ui';

/**
 * Delete a translated chapter or a whole series (its pages, their strips and history) after asking.
 * `what` names it in the question («главу 3», «мангу «…»»). Resolves true when deleted.
 */
export async function forgetFolder(platform: ReturnType<typeof usePlatform>, keys: string[], what: string): Promise<boolean> {
  if (!keys.length || !confirm(tr('Удалить {0}? Переведённые страницы и их история будут удалены из программы. Это нельзя отменить.', what))) return false;
  const n = await platform.service.forgetPages(keys);
  toast(tr('Удалено страниц: {0}', n));
  return true;
}
