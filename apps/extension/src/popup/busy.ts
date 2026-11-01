/**
 * What the popup shows as «N в работе». The badge counts the jobs the background has not heard
 * the end of; the page knows which of its pictures still wait. The page wins: a job whose end was
 * missed must not keep the popup saying «в работе» on a page that is all translated (`stale`).
 */
export function inWorkShown(badge: number, page: { inWork: number } | null): { shown: number; stale: boolean } {
  if (!page) return { shown: badge, stale: false };
  return { shown: page.inWork, stale: page.inWork === 0 && badge > 0 };
}
