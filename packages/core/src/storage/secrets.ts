import { base64ToBytes, bytesToBase64 } from '../util/bytes';
import type { IdbStore } from './idb';

/**
 * API keys are encrypted with AES-GCM using a non-extractable key kept in IndexedDB.
 * This stops keys from appearing in plain text in synced storage, exports or logs.
 * It does not protect against malware running as the same user; an optional
 * passphrase can be added on top later.
 */
export class SecretStore {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private db: IdbStore) {}

  private key(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = (async () => {
        const existing = await this.db.get<CryptoKey>('kv', 'secret-key');
        if (existing) return existing;
        const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await this.db.put('kv', 'secret-key', key);
        return key;
      })();
    }
    return this.keyPromise;
  }

  async set(name: string, value: string): Promise<void> {
    if (!value) {
      await this.db.delete('kv', `secret:${name}`);
      return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.key(), new TextEncoder().encode(value)));
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv);
    packed.set(ct, iv.length);
    await this.db.put('kv', `secret:${name}`, bytesToBase64(packed));
  }

  async get(name: string): Promise<string | undefined> {
    const packed = await this.db.get<string>('kv', `secret:${name}`);
    if (!packed) return undefined;
    try {
      const bytes = base64ToBytes(packed);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await this.key(), bytes.slice(12));
      return new TextDecoder().decode(pt);
    } catch {
      return undefined;
    }
  }

  async delete(name: string): Promise<void> {
    await this.db.delete('kv', `secret:${name}`);
  }
}

export function maskKey(key: string | undefined): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
