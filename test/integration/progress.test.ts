import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { run } from '../../src/process.ts';
import { EncodingStallError } from '../../src/progress.ts';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { Store } from '../../src/store.ts';
import { Worker } from '../../src/worker.ts';

afterEach(() => jest.useRealTimers());

test.each([false, true])(
  'watchdog terminates a real child (repeating timestamp=%s)',
  async (repeat) => {
    jest.useFakeTimers();
    const warnings: number[] = [];
    const advances: number[] = [];
    const ready = Promise.withResolvers<void>();
    const controller = new AbortController();
    const task = run(
      Bun.argv[0]!,
      [
        '-e',
        repeat
          ? "console.log(('out_time_us=1000000\\n').repeat(100)); setInterval(() => console.log('out_time_us=1000000'), 10)"
          : "console.error('ready'); setInterval(() => {}, 1000)",
      ],
      {
        signal: controller.signal,
        timeoutMs: 3600000,
        onStderr: () => {
          if (!repeat) ready.resolve();
        },
        encodingProgress: {
          onAdvance: (time) => {
            advances.push(time);
            ready.resolve();
          },
          onWarning: (time) => warnings.push(time),
        },
      },
    );
    const result = task.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await ready.promise;
      jest.advanceTimersByTime(120000);
      expect(warnings).toEqual([repeat ? 1000000 : 0]);
      jest.advanceTimersByTime(180000);
      const error = await result;
      expect(error).toBeInstanceOf(EncodingStallError);
      expect(advances).toEqual(repeat ? [1000000] : []);
      jest.advanceTimersByTime(600000);
      expect(warnings).toHaveLength(1);
    } finally {
      controller.abort();
      jest.advanceTimersByTime(5000);
      await result;
    }
  },
);

test('a child ignoring SIGTERM is forcibly killed five seconds after a stall', async () => {
  jest.useFakeTimers();
  const ready = Promise.withResolvers<void>();
  const term = Promise.withResolvers<void>();
  const controller = new AbortController();
  const task = run(
    Bun.argv[0]!,
    [
      '-e',
      `
process.on('SIGTERM', () => console.error('term'));
console.error('ready');
setInterval(() => {}, 1000);
`,
    ],
    {
      signal: controller.signal,
      timeoutMs: 3600000,
      onStderr: (text) => {
        if (text.includes('ready')) ready.resolve();
        if (text.includes('term')) term.resolve();
      },
      encodingProgress: { onAdvance: () => {}, onWarning: () => {} },
    },
  );
  let finished = false;
  const result = task
    .then(
      () => undefined,
      (error: unknown) => error,
    )
    .finally(() => {
      finished = true;
    });
  try {
    await ready.promise;
    jest.advanceTimersByTime(300000);
    await term.promise;
    jest.advanceTimersByTime(4999);
    expect(finished).toBe(false);
    jest.advanceTimersByTime(1);
    expect(await result).toBeInstanceOf(EncodingStallError);
  } finally {
    controller.abort();
    jest.advanceTimersByTime(5000);
    await result;
  }
});

test('successful exit and cancellation clear the watchdog', async () => {
  jest.useFakeTimers();
  const warnings: number[] = [];
  const encodingProgress = {
    onAdvance: () => {},
    onWarning: (time: number) => warnings.push(time),
  };
  await run(Bun.argv[0]!, ['-e', "console.log('out_time_us=1000000')"], {
    timeoutMs: 3600000,
    encodingProgress,
  });
  const ready = Promise.withResolvers<void>();
  const controller = new AbortController();
  const result = run(Bun.argv[0]!, ['-e', "console.error('ready'); setInterval(() => {}, 1000)"], {
    signal: controller.signal,
    timeoutMs: 3600000,
    encodingProgress,
    onStderr: () => ready.resolve(),
  }).catch((error: unknown) => error);
  await ready.promise;
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  jest.advanceTimersByTime(600000);
  expect(warnings).toEqual([]);
});

test('an earlier overall timeout keeps its error and cancels the progress watchdog', async () => {
  jest.useFakeTimers();
  const ready = Promise.withResolvers<void>();
  const warnings: number[] = [];
  const result = run(Bun.argv[0]!, ['-e', "console.error('ready'); setInterval(() => {}, 1000)"], {
    timeoutMs: 60000,
    onStderr: () => ready.resolve(),
    encodingProgress: { onAdvance: () => {}, onWarning: (time) => warnings.push(time) },
  }).catch((error: unknown) => error);
  await ready.promise;
  jest.advanceTimersByTime(60000);
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(EncodingStallError);
  expect((error as Error).message).toContain('exceeded its timeout');
  jest.advanceTimersByTime(600000);
  expect(warnings).toEqual([]);
});

test.each([false, true])(
  'a Vulkan stall retries CPU with a fresh watchdog (CPU also stalls=%s)',
  async (cpuStalls) => {
    const f = await fixture();
    let worker: Worker | undefined;
    let store: Store | undefined;
    try {
      const source = join(f.rt.dataDir, 'source.mkv');
      await run(
        f.rt.ffmpeg,
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x240:rate=12:duration=1',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          '0',
          source,
        ],
        { timeoutMs: 10000 },
      );
      const wrapper = join(f.root, 'ffmpeg-wrapper');
      const cpuMarker = join(f.root, 'cpu-started');
      await Bun.write(
        wrapper,
        `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
const gpu = args.includes('-hwaccel');
if (gpu && args.at(-1) === '-') process.exit(0);
if (!gpu && args.includes('-progress')) await Bun.write(${JSON.stringify(cpuMarker)}, 'cpu');
if (args.includes('-progress') && (gpu || ${cpuStalls})) {
  await Bun.write(args.at(-1), 'invalid partial output');
  console.log('out_time_us=100000');
  setInterval(() => console.log('out_time_us=100000'), 10);
} else {
  process.exit(await Bun.spawn(['ffmpeg', ...args], { stdout: 'inherit', stderr: 'inherit' }).exited);
}
`,
      );
      await chmod(wrapper, 0o755);
      f.rt.ffmpeg = wrapper;
      f.rt.decodeBackend = 'vulkan';
      f.config.profiles.default!.preset = 'ultrafast';
      f.config.minSavingsPercent = 0;
      f.config.maxAttempts = 1;
      store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
      const [job] = store.enqueueMany(
        [{ source, profile: 'default', fingerprint: 'stall', delaySeconds: 0 }],
        10,
      );
      const id = job!.id;
      const gpuProgress = Promise.withResolvers<void>();
      const cpuProgress = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      let fallback = false;
      const patch = store.patch.bind(store);
      spyOn(store, 'patch').mockImplementation((jobId, changes) => {
        patch(jobId, changes);
        if (changes.message === 'Vulkan failed; restarted with CPU decoding') fallback = true;
        if (changes.progress === 10) (fallback ? cpuProgress : gpuProgress).resolve();
        if (changes.status === 'completed' || changes.status === 'failed') finished.resolve();
      });
      jest.useFakeTimers();
      worker = new Worker(store, f.config, f.rt);
      worker.start();
      await gpuProgress.promise;
      const updated = store.get(id)!.updated;
      jest.advanceTimersByTime(120000);
      expect(store.get(id)!.updated).toBe(updated);
      jest.advanceTimersByTime(180000);
      if (cpuStalls) {
        await cpuProgress.promise;
        jest.advanceTimersByTime(299999);
        expect(store.get(id)!.status).toBe('running');
        jest.advanceTimersByTime(1);
      }
      await finished.promise;
      await worker.stop();
      expect(await Bun.file(cpuMarker).exists()).toBe(true);
      const result = store.get(id)!;
      expect(result.status).toBe(cpuStalls ? 'failed' : 'completed');
      expect(result.attempts).toBe(1);
      if (cpuStalls) {
        expect(result.message).toContain('output timestamp did not advance for 5 minutes');
        expect(await Bun.file(result.output!).exists()).toBe(false);
      } else {
        expect(result.progress).toBe(100);
        expect(await Bun.file(result.output!).exists()).toBe(true);
      }
      expect(await Bun.file(join(f.rt.transcodeDir, `horadrictube-${id}.mkv`)).exists()).toBe(
        false,
      );
    } finally {
      jest.useRealTimers();
      await worker?.stop();
      store?.close();
      await f.cleanup();
    }
  },
  15000,
);
