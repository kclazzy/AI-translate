import type { UpscaleNet } from '@ait/core';
import { GPU_NETS, GpuTimeout, NETS_LOAD_LIMIT_MS, onGpu, releaseWhenIdle, withLimit } from './gpuLane';
import { cached, downloadChecked, loadOrt, MODELS_CACHE, ORT_WASM_URL, removeModel, UPSCALER, type Ort } from './ortRuntime';

/**
 * The upscaler for small scans (see core image/upscale.ts): waifu2x CUNet for art, 2×, ~5 MB, run
 * with the same ONNX Runtime as LaMa — on the video card when it can, else on the processor. Tiles
 * of one size, so the card compiles the network once.
 */
const OFFSET = 36;
const TILE = 256;

export async function upscalerDownloaded(): Promise<boolean> {
  return (await cached(UPSCALER.url)) && (await cached(ORT_WASM_URL));
}

export async function downloadUpscaler(progress: (share: number) => void, signal?: AbortSignal): Promise<void> {
  await downloadChecked([UPSCALER], progress, signal);
}

export async function deleteUpscaler(): Promise<void> {
  await releaseUpscaler();
  await removeModel([UPSCALER.url]);
}

let gpuBroken = false;
let session: Promise<{ ort: Ort; s: import('onnxruntime-web').InferenceSession; onGpu: boolean }> | null = null;

export async function releaseUpscaler(): Promise<void> {
  const s = session;
  session = null;
  const L = await s?.catch(() => null);
  await L?.s.release().catch(() => undefined);
}

function load() {
  session ??= (async () => {
    const hit = await (await caches.open(MODELS_CACHE)).match(UPSCALER.url);
    if (!hit) throw new Error('The upscaler is not downloaded');
    const ort = await loadOrt();
    const bytes = new Uint8Array(await hit.arrayBuffer());
    const gpu = !gpuBroken && typeof navigator !== 'undefined' && 'gpu' in navigator;
    try {
      return { ort, s: await ort.InferenceSession.create(bytes, { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'] }), onGpu: gpu };
    } catch {
      return { ort, s: await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }), onGpu: false };
    }
  })();
  session.catch(() => (session = null));
  return session;
}

async function runTile(rgb: Float32Array, h: number, w: number): Promise<Float32Array> {
  const { ort, s } = await load();
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', rgb, [1, 3, h, w]) });
  return out[s.outputNames[0]].data as Float32Array;
}

let chain: Promise<unknown> = Promise.resolve();
let cancelIdle: (() => void) | undefined;

/** One tile at a time, between the model's requests on the card; on the processor for good after a failure there. */
const run = (rgb: Float32Array, h: number, w: number): Promise<Float32Array> => {
  const job = chain.then(() =>
    (gpuBroken ? withLimit(() => runTile(rgb, h, w), NETS_LOAD_LIMIT_MS) : onGpu(GPU_NETS, () => runTile(rgb, h, w), { limitMs: NETS_LOAD_LIMIT_MS })).catch(async (e: unknown) => {
      if ((e as Error)?.name === 'AbortError') throw e;
      const L = await session?.catch(() => null);
      if (!(e instanceof GpuTimeout) && !L?.onGpu) throw e;
      gpuBroken = true;
      await releaseUpscaler();
      return withLimit(() => runTile(rgb, h, w), NETS_LOAD_LIMIT_MS);
    }),
  );
  chain = job.catch(() => undefined);
  void job.finally(() => {
    cancelIdle?.();
    cancelIdle = releaseWhenIdle(() => void releaseUpscaler());
  }).catch(() => undefined);
  return job;
};

export const upscaleNet: UpscaleNet = { run, offset: OFFSET, tile: TILE };
