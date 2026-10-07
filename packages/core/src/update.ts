import type { FetchLike } from './llm/types';
import { tr } from './i18n';

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

export interface ReleaseAsset {
  name: string;
  url: string;
  size?: number;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes?: string;
  /** Files of the GitHub release (empty when only package.json was found). */
  assets: ReleaseAsset[];
}

/** The release file for one edition: desktop zip, Android apk, iOS ipa. */
export function pickAsset(info: Pick<UpdateInfo, 'assets'>, kind: 'desktop' | 'android' | 'ios'): ReleaseAsset | undefined {
  const re = kind === 'desktop' ? /desktop.*\.zip$/i : kind === 'android' ? /\.apk$/i : /\.ipa$/i;
  return info.assets.find((a) => re.test(a.name)) ?? (kind === 'android' ? info.assets.find((a) => /android.*\.zip$/i.test(a.name)) : kind === 'ios' ? info.assets.find((a) => /ios.*\.zip$/i.test(a.name)) : undefined);
}

/** Download a file with progress (bytes so far, total if the server says). */
export async function downloadWithProgress(url: string, onProgress: (done: number, total?: number) => void, fetchImpl: FetchLike = (u, i) => fetch(u, i), signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetchImpl(url, { signal, cache: 'no-store' });
  if (res.status === 404) throw new Error(tr('Файл новой версии ещё собирается на GitHub (обычно 10–15 минут после выхода). Попробуйте чуть позже.'));
  if (!res.ok) throw new Error(tr('Не удалось скачать обновление: HTTP {0}', res.status));
  const total = Number(res.headers.get('content-length')) || undefined;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    onProgress(done, total);
  }
  const out = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Release files have fixed names, so their links can be built from the version alone.
 * Used when the GitHub API is unavailable (it allows 60 anonymous requests an hour per
 * address, which a VPN or a shared connection easily uses up).
 */
export function releaseAssets(version: string): ReleaseAsset[] {
  const v = version.replace(/^v/, '');
  const base = `https://github.com/${REPO}/releases/download/v${v}`;
  return [`ai-translate-desktop-v${v}.zip`, `ai-translate-android-v${v}.apk`, `ai-translate-ios-unsigned-v${v}.ipa`].map((name) => ({ name, url: `${base}/${name}` }));
}

/**
 * Latest version: the newest GitHub release (API, then the github.com "latest" redirect,
 * which has no rate limit), otherwise the version in package.json on the main branch.
 */
export async function checkForUpdate(current: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<UpdateInfo> {
  let latest = '';
  let url = RELEASES_URL;
  let notes: string | undefined;
  let assets: ReleaseAsset[] = [];
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (r.ok) {
      const j = (await r.json()) as { tag_name?: string; html_url?: string; body?: string; assets?: { name: string; browser_download_url: string; size?: number }[] };
      if (j.tag_name) {
        latest = j.tag_name.replace(/^v/, '');
        url = j.html_url ?? url;
        notes = j.body?.slice(0, 600);
        assets = (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
      }
    }
  } catch {
    /* fall back below */
  }
  if (!latest) {
    // github.com/…/releases/latest redirects to …/releases/tag/vX.Y.Z — no API, no rate limit.
    try {
      const r = await fetchImpl(`https://github.com/${REPO}/releases/latest`, { method: 'HEAD', redirect: 'follow', cache: 'no-store' });
      const m = /\/releases\/tag\/v?([\d.]+)/.exec(r.url ?? '');
      if (m) {
        latest = m[1];
        url = r.url;
        assets = releaseAssets(latest);
      }
    } catch {
      /* fall back below */
    }
  }
  if (!latest) {
    const r = await fetchImpl(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub HTTP ${r.status}`);
    latest = ((await r.json()) as { version: string }).version;
    url = `https://github.com/${REPO}/releases`;
    assets = releaseAssets(latest);
  }
  return { current, latest, available: compareVersions(latest, current) > 0, url, notes, assets };
}
