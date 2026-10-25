import { afterEach, describe, expect, it } from 'vitest';
import { activityLines, type ActivitySession } from '@ait/core';
import { activitySessions, pageDone, resetActivity, startActivity, tick } from './activity';
import { GPU_MODEL, GPU_NETS, gpuFetch, onGpu } from './gpuLane';

function setup(reason: () => 'picture' | 'prep' | 'context' | 'finish' | 'memory' | 'other' = () => 'prep') {
  let stored: ActivitySession[] = [];
  let work = true;
  startActivity({ hasWork: () => work, idleReason: reason, save: async (s) => void (stored = s), load: async () => stored });
  return { stop: () => (work = false), stored: () => stored };
}

afterEach(() => resetActivity());

describe('where the chapter time goes', () => {
  it('counts the model, the networks and idle time with its reason', async () => {
    const t = setup(() => 'context');
    let release!: () => void;
    const held = onGpu(GPU_MODEL, () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();
    tick(1000, 250);
    tick(1250, 250);
    release();
    await held;
    let releaseNets!: () => void;
    const nets = onGpu(GPU_NETS, () => new Promise<void>((r) => (releaseNets = r)));
    await Promise.resolve();
    tick(1500, 250);
    releaseNets();
    await nets;
    tick(1750, 250);
    pageDone();
    const [s] = await activitySessions();
    expect(s.workMs).toBe(1000);
    expect(s.modelMs).toBe(500);
    expect(s.netsMs).toBe(250);
    expect(s.idleMs).toBe(250);
    expect(s.idle.context).toBe(250);
    expect(s.pages).toBe(1);
    // A minute without work ends the session and stores it.
    t.stop();
    tick(70_000, 250);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.stored()).toHaveLength(1);
    expect(t.stored()[0].endedAt).toBeTruthy();
    const lines = activityLines(t.stored()[0]).join('\n');
    expect(lines).toContain('50%');
    expect(lines).toContain('ожидание контекста');
  });

  it('adds up Ollama\'s own times and counts the model loads', async () => {
    setup();
    tick(0, 250);
    const answer = (load: number) => async () => new Response(JSON.stringify({ message: { content: '{}' }, load_duration: load * 1e6, prompt_eval_duration: 2e9, eval_duration: 3e9 }), { headers: { 'content-type': 'application/json' } });
    for (const load of [5000, 20, 4000]) await gpuFetch(answer(load) as typeof fetch)('http://localhost:11434/api/chat', { method: 'POST', body: '{}' });
    const [s] = await activitySessions();
    expect(s.ollama).toMatchObject({ calls: 3, loads: 2, loadMs: 9020, promptMs: 6000, genMs: 9000 });
    expect(activityLines(s).join('\n')).toContain('загружалась 2×');
  });

  it('an online model answering counts as the model working', async () => {
    setup();
    let release!: (r: Response) => void;
    const req = gpuFetch((async () => new Promise<Response>((r) => (release = r))) as typeof fetch)('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
    tick(0, 250);
    release(new Response('{}'));
    await req;
    tick(250, 250);
    const [s] = await activitySessions();
    expect(s.modelMs).toBe(250);
    expect(s.idleMs).toBe(250);
  });
});
