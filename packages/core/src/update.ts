import type { FetchLike } from './llm/types';

export const REPO = 'kclazzy/AI-translate';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes?: string;
}

/**
 * Latest version: the newest GitHub release if there is one, otherwise the version
 * in package.json on the main branch (the project publishes builds through Actions).
 */
export async function checkForUpdate(current: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<UpdateInfo> {
  let latest = '';
  let url = RELEASES_URL;
  let notes: string | undefined;
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (r.ok) {
      const j = (await r.json()) as { tag_name?: string; html_url?: string; body?: string };
      if (j.tag_name) {
        latest = j.tag_name.replace(/^v/, '');
        url = j.html_url ?? url;
        notes = j.body?.slice(0, 600);
      }
    }
  } catch {
    /* fall back below */
  }
  if (!latest) {
    const r = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
    latest = ((await r.json()) as { version: string }).version;
    url = `https://github.com/${REPO}`;
  }
  return { current, latest, available: compareVersions(latest, current) > 0, url, notes };
}
