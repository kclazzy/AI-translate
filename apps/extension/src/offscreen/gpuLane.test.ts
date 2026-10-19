import { describe, expect, it } from 'vitest';
import { gpuFetch, GpuTimeout, gpuState, GPU_MODEL, GPU_NETS, onGpu, withLimit } from './gpuLane';

const never = () => new Promise<never>(() => undefined);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the video card lane', () => {
  it('a call that never answers gives the card up after its time; the next one runs', async () => {
    const stuck = onGpu(GPU_NETS, never, { limitMs: 50 });
    const after = onGpu(GPU_MODEL, async () => 'next');
    await expect(stuck).rejects.toBeInstanceOf(GpuTimeout);
    await expect(after).resolves.toBe('next');
    expect(gpuState()).toEqual({ busy: false, waiting: 0 });
  });

  it('one at a time, the model first', async () => {
    const order: string[] = [];
    const hold = onGpu(GPU_NETS, () => wait(30).then(() => order.push('first')));
    const nets = onGpu(GPU_NETS, async () => order.push('nets'));
    const model = onGpu(GPU_MODEL, async () => order.push('model'));
    await Promise.all([hold, nets, model]);
    expect(order).toEqual(['first', 'model', 'nets']);
  });

  it('a cancelled picture stops waiting for its turn', async () => {
    const hold = onGpu(GPU_MODEL, () => wait(80));
    const ctrl = new AbortController();
    const waiting = onGpu(GPU_NETS, async () => 'ran', { signal: ctrl.signal });
    ctrl.abort(new DOMException('stop', 'AbortError'));
    await expect(waiting).rejects.toThrow('stop');
    await hold;
    expect(gpuState()).toEqual({ busy: false, waiting: 0 });
  });

  it('a local server that does not answer: the request is stopped as a timeout and the card is free', async () => {
    let aborted = false;
    const base = ((_: string, init?: RequestInit) =>
      new Promise((_r, stop) => init?.signal?.addEventListener('abort', () => {
        aborted = true;
        stop(new DOMException('aborted', 'AbortError'));
      }))) as unknown as typeof fetch;
    const f = gpuFetch(base, 50);
    await expect(f('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(aborted).toBe(true);
    expect(gpuState()).toEqual({ busy: false, waiting: 0 });
  });

  it('a time limit without the card (work on the processor)', async () => {
    await expect(withLimit(never, 30)).rejects.toBeInstanceOf(GpuTimeout);
    await expect(withLimit(async () => 1, 30)).resolves.toBe(1);
  });
});
