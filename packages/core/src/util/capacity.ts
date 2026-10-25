/**
 * How many pages may be in work at once on this computer, and whether one more fits in memory now.
 *
 * The number is picked from the processor cores and the memory the browser reports (Chrome:
 * navigator.deviceMemory, rounded and capped at 8 GB; Firefox says nothing, then cores only). On
 * top of it a memory gate holds the next page back while the pages in work would take more than a
 * share of the memory (each page is costed by its pixels) or the script heap is nearly full; it
 * lets it in once a page is done. A page that ran out of memory lowers the number for a while.
 */

export interface Hardware {
  /** Logical processor cores (navigator.hardwareConcurrency). */
  cores?: number;
  /** Device memory, GB (navigator.deviceMemory: 0.25…8). */
  memoryGb?: number;
  /** The script heap now (Chrome: performance.memory), bytes. */
  heap?: { used: number; limit: number };
}

/** What this browser tells about the computer. */
export function readHardware(): Hardware {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number; deviceMemory?: number } }).navigator;
  const mem = (globalThis as { performance?: { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } } }).performance?.memory;
  return {
    cores: nav?.hardwareConcurrency || undefined,
    memoryGb: nav?.deviceMemory || undefined,
    heap: mem?.usedJSHeapSize && mem.jsHeapSizeLimit ? { used: mem.usedJSHeapSize, limit: mem.jsHeapSizeLimit } : undefined,
  };
}

/** The most pages in work at once, whatever the computer. */
export const MAX_PAGES_IN_FLIGHT = 4;

export interface InFlight {
  n: number;
  /** Why this number (for the settings: «8 ядер, 8 ГБ»). */
  cores?: number;
  memoryGb?: number;
  /** Lowered after a page ran out of memory. */
  lowered?: boolean;
}

/**
 * Pages in work at once. `setting`: 'auto' or a number chosen by the user (1…4). A local model
 * answers one request at a time: more than 3 pages would only wait in memory for it.
 */
export function pagesInFlight(hw: Hardware, opts: { setting: 'auto' | number; local: boolean; lowered?: number }): InFlight {
  const lowered = opts.lowered ?? 0;
  if (opts.setting !== 'auto') return { n: Math.max(1, Math.min(MAX_PAGES_IN_FLIGHT, Math.round(opts.setting) - lowered)), cores: hw.cores, memoryGb: hw.memoryGb, ...(lowered ? { lowered: true } : {}) };
  const cores = hw.cores ?? 4;
  let n = cores >= 8 ? 4 : cores >= 6 ? 3 : 2;
  if (hw.memoryGb !== undefined) n = Math.min(n, hw.memoryGb <= 2 ? 1 : hw.memoryGb <= 4 ? 2 : hw.memoryGb < 8 ? 3 : 4);
  if (opts.local) n = Math.min(n, 3);
  n = Math.max(1, n - lowered);
  return { n, cores: hw.cores, memoryGb: hw.memoryGb, ...(lowered ? { lowered: true } : {}) };
}

/** Bytes a page of this size takes while in work: its pixels a few times (original, cleaned, copies for the threads, the drawn tiles). */
export function pageCost(width: number, height: number): number {
  return Math.round(width * height * 4 * 6);
}

/** A page whose size is not known yet: a manga page of about 1500 × 2100. */
export const TYPICAL_PAGE_COST = pageCost(1500, 2100);

/** Memory the pages in work may take together, bytes (a share of the computer's memory). */
export function memoryBudget(hw: Hardware): number {
  const gb = hw.memoryGb ?? 8;
  return Math.round(Math.max(0.3, Math.min(2, gb * 0.18)) * 1024 ** 3);
}

/** The script heap is this full: no more pages start until one is done. */
export const HEAP_FULL = 0.75;

/** May one more page start? (At least one page is always let in, see TaskQueue.) */
export function fitsInMemory(hw: Hardware, inWork: number[], next: number): boolean {
  if (hw.heap && hw.heap.used / hw.heap.limit > HEAP_FULL) return false;
  return inWork.reduce((a, b) => a + b, 0) + next <= memoryBudget(hw);
}

/** Width and height from the picture's header (PNG, JPEG, WebP, GIF, BMP), without decoding it. */
export function imageDims(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 26) return null;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const be32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + (b[i + 3] << 24 >>> 0);
  // PNG: IHDR right after the signature.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: be32(16), height: be32(20) };
  // GIF: logical screen size.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: le16(6), height: le16(8) };
  // BMP: BITMAPINFOHEADER (height may be negative: top-down).
  if (b[0] === 0x42 && b[1] === 0x4d) return { width: Math.abs(le32(18) | 0), height: Math.abs(le32(22) | 0) };
  // WebP: VP8 / VP8L / VP8X chunk.
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 && b.length >= 30) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const v = le32(21);
      return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  // JPEG: the first start-of-frame marker.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
  }
  return null;
}

/** The cost of a page from its bytes (the typical cost when the header says nothing). */
export function bytesCost(bytes: Uint8Array): number {
  const d = imageDims(bytes);
  return d && d.width > 0 && d.height > 0 ? pageCost(d.width, d.height) : TYPICAL_PAGE_COST;
}

/** Messages of errors that mean the browser ran out of memory (not the model's video memory). */
export function isMemoryError(e: unknown): boolean {
  const s = e instanceof Error ? `${e.name} ${e.message}` : String((e as { message?: string; detail?: string })?.detail ?? (e as { message?: string })?.message ?? e);
  return /RangeError|allocation failed|out of memory|Invalid typed array length|Array buffer allocation|could not allocate/i.test(s) && !/video memory|VRAM|CUDA/i.test(s);
}

/** Lowered for a while after the browser ran out of memory: one page fewer each time, back after ten minutes. */
export class MemoryBackoff {
  private until = 0;
  private steps = 0;
  constructor(private readonly holdMs = 10 * 60_000, private readonly now = () => Date.now()) {}
  hit(): void {
    this.steps = Math.min(MAX_PAGES_IN_FLIGHT - 1, (this.now() < this.until ? this.steps : 0) + 1);
    this.until = this.now() + this.holdMs;
  }
  get lowered(): number {
    if (this.now() >= this.until) this.steps = 0;
    return this.steps;
  }
}
