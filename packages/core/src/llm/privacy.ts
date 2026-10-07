import { AppError } from '../errors';
import type { ProviderConfig } from './types';
import { tr } from '../i18n';

export type PrivacyMode = 'local' | 'hybrid' | 'cloud';

/**
 * A URL counts as local only if it points at this machine or a private network.
 * The decision is made from the URL itself, never from a user-editable flag.
 */
export function isLocalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
    return false;
  }
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  return false;
}

export function isLocalProvider(cfg: ProviderConfig): boolean {
  return isLocalUrl(cfg.baseUrl);
}

/**
 * Enforce the privacy mode. In 'local' mode nothing may leave the device/LAN.
 * In 'hybrid' mode images stay local but text may go to a cloud provider.
 */
export function assertPrivacy(mode: PrivacyMode, cfg: ProviderConfig, sends: 'image' | 'text'): void {
  if (mode === 'cloud') return;
  if (isLocalProvider(cfg)) return;
  if (mode === 'hybrid' && sends === 'text') return;
  throw new AppError('PRIVACY_VIOLATION', {
    retryable: false,
    detail: `${cfg.label} (${cfg.baseUrl}) is not local; mode=${mode}, payload=${sends}`,
  });
}

export function describeRoute(mode: PrivacyMode, vision: ProviderConfig | undefined, text: ProviderConfig | undefined, engineUrl?: string): string[] {
  const lines: string[] = [];
  if (engineUrl) lines.push(tr('Изображение → движок {0} ({1})', engineUrl, isLocalUrl(engineUrl) ? tr('локально') : tr('удалённо')));
  else if (vision) lines.push(tr('Изображение → {0} ({1})', vision.label, isLocalProvider(vision) ? tr('локально') : tr('облако')));
  if (text && text.id !== vision?.id) lines.push(tr('Текст → {0} ({1})', text.label, isLocalProvider(text) ? tr('локально') : tr('облако')));
  lines.push(mode === 'local' ? tr('Локальный режим: данные не покидают устройство или локальную сеть.') : mode === 'hybrid' ? tr('Гибридный режим: изображения остаются локально, наружу уходит только текст.') : tr('Облачный режим: изображения могут отправляться провайдеру.'));
  return lines;
}
