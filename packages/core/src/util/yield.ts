/**
 * Cooperative yielding for long work on the one JS thread (the extension's offscreen document,
 * a page): cleaning a tall strip takes seconds, and meanwhile other messages — the editor asking
 * for a stored result, a status poll — would wait. Long loops call `await yieldIfBusy()` between
 * steps; once about YIELD_EVERY_MS of work has gone by since the last pause it lets the event loop
 * run whatever is waiting, otherwise it costs next to nothing.
 */
export const YIELD_EVERY_MS = 30;

let sliceStart = Date.now();

/**
 * A new task at the back of the queue. Not setTimeout: timers in hidden documents (an offscreen
 * document, a background tab) are throttled to one a second or less; a message is not.
 */
const nextTask: () => Promise<void> = (() => {
  // Node (tests, scripts): setImmediate. A MessageChannel there would keep the process alive.
  const immediate = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;
  if (typeof immediate === 'function') return () => new Promise<void>((resolve) => void immediate(resolve));
  if (typeof MessageChannel !== 'undefined') {
    const channel = new MessageChannel();
    const waiting: (() => void)[] = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    return () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        channel.port2.postMessage(0);
      });
  }
  return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
})();

/** Let other work run when this thread has been busy for a while (see YIELD_EVERY_MS). */
export async function yieldIfBusy(): Promise<void> {
  if (Date.now() - sliceStart < YIELD_EVERY_MS) return;
  await nextTask();
  sliceStart = Date.now();
}
