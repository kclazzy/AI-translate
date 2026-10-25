import type { ActivitySession, IdleReason } from '@ait/core';
import { GPU_MODEL, GPU_NETS, GPU_REVIEW, gpuState, onlineInFlight, setOllamaListener, type OllamaTimes } from './gpuLane';

/**
 * Where the time of a chapter goes — for finding the idle time («простой»): while pictures are in
 * the queue, every quarter of a second is counted as the model working (a local one holding the
 * video card, or an online one answering), the networks on the card, the check of pages already
 * shown, or idle — and then why: a picture still being read or downloaded, prepared on the
 * processor, waiting for the series context, being erased / typeset, held back by memory. Ollama's
 * own times (loading the model, reading the prompt, writing) are added up beside it.
 *
 * A session starts when work appears after a minute without any and ends after a minute without
 * any; the last sessions are kept (a few, small) for the analysis pack and the settings.
 */

export type { ActivitySession, IdleReason };

const TICK_MS = 250;
const GAP_MS = 60_000;
/** Sessions kept (small records). */
export const KEEP_SESSIONS = 5;
/** Ollama spent this long loading the model for one request: it was not in video memory. */
const LOAD_MS = 1_000;

const empty = (): ActivitySession => ({
  startedAt: new Date().toISOString(),
  workMs: 0,
  modelMs: 0,
  netsMs: 0,
  reviewMs: 0,
  idleMs: 0,
  idle: { picture: 0, prep: 0, context: 0, finish: 0, memory: 0, other: 0 },
  pages: 0,
  ollama: { calls: 0, loads: 0, loadMs: 0, promptMs: 0, genMs: 0 },
});

export interface ActivityHooks {
  /** Pictures waiting or in work. */
  hasWork: () => boolean;
  /** Why nothing runs on the model now although work is there. */
  idleReason: () => IdleReason;
  /** Store the sessions (the last KEEP_SESSIONS). */
  save: (sessions: ActivitySession[]) => Promise<void>;
  load: () => Promise<ActivitySession[] | undefined>;
}

let current: ActivitySession | null = null;
let lastWork = 0;
let localTicks = 0;
let onlineTicks = 0;
let timer: ReturnType<typeof setInterval> | null = null;
/** Ticks since the session in progress was last written (it is written every few seconds too). */
let unsaved = 0;
const SAVE_TICKS = 20;
let hooks: ActivityHooks | null = null;

function onOllama(t: OllamaTimes): void {
  if (!current) return;
  const o = current.ollama;
  o.calls++;
  o.loadMs += t.loadMs;
  o.promptMs += t.promptMs;
  o.genMs += t.genMs;
  if (t.loadMs >= LOAD_MS) o.loads++;
}

/** One tick: what the time went on. */
export function tick(now = Date.now(), dt = TICK_MS): void {
  if (!hooks) return;
  if (!hooks.hasWork()) {
    if (current && now - lastWork > GAP_MS) void finish();
    return;
  }
  lastWork = now;
  current ??= empty();
  const s = current;
  s.workMs += dt;
  const { holder } = gpuState();
  if (holder === GPU_MODEL || onlineInFlight() > 0) {
    s.modelMs += dt;
    if (holder === GPU_MODEL) localTicks++;
    else onlineTicks++;
  } else if (holder === GPU_NETS) s.netsMs += dt;
  else if (holder === GPU_REVIEW) s.reviewMs += dt;
  else {
    s.idleMs += dt;
    s.idle[hooks.idleReason()] += dt;
  }
  // The session in progress is stored every few seconds as well: the settings and the analysis
  // pack see it while the chapter is still being translated (or if the document is closed).
  if (++unsaved >= SAVE_TICKS) {
    unsaved = 0;
    void persist();
  }
}

/** Store the finished sessions with the one in progress (the in-progress one replaces itself). */
async function persist(): Promise<void> {
  if (!hooks) return;
  const had = ((await hooks.load().catch(() => undefined)) ?? []).filter((x) => x.startedAt !== current?.startedAt);
  const all = current ? [...had, { ...current, local: localTicks >= onlineTicks }] : had;
  await hooks.save(all.slice(-KEEP_SESSIONS)).catch(() => undefined);
}

/** A picture was finished (translated or failed). */
export function pageDone(): void {
  if (current) current.pages++;
}

async function finish(): Promise<void> {
  const s = current;
  current = null;
  if (!s || !hooks) return;
  s.endedAt = new Date().toISOString();
  s.local = localTicks >= onlineTicks;
  localTicks = onlineTicks = 0;
  unsaved = 0;
  const had = ((await hooks.load().catch(() => undefined)) ?? []).filter((x) => x.startedAt !== s.startedAt);
  await hooks.save([...had, s].slice(-KEEP_SESSIONS)).catch(() => undefined);
}

/** The finished sessions and the one in progress (newest last). */
export async function activitySessions(): Promise<ActivitySession[]> {
  const had = ((await hooks?.load().catch(() => undefined)) ?? []).filter((x) => x.startedAt !== current?.startedAt);
  return current ? [...had, { ...current, local: localTicks >= onlineTicks }] : had;
}

/** Start counting (once, in the document that runs the queue). */
export function startActivity(h: ActivityHooks): void {
  hooks = h;
  setOllamaListener(onOllama);
  timer ??= setInterval(() => tick(), TICK_MS);
}

/** For tests: forget everything. */
export function resetActivity(): void {
  current = null;
  lastWork = 0;
  localTicks = onlineTicks = 0;
  unsaved = 0;
  if (timer) clearInterval(timer);
  timer = null;
  hooks = null;
}
