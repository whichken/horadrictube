import { test, expect, afterEach } from 'bun:test';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, type Job } from '../../src/store.ts';
import { Worker, publish } from '../../src/worker.ts';
import { createApp } from '../../src/server.ts';
import { run } from '../../src/process.ts';
import { probe } from '../../src/media.ts';
import { fixture } from '../helpers.ts';
import { checkToneMapping } from '../../src/tonemap.ts';

test('configured Vulkan backend performs real Spline filtering and HEVC encoding', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const result = await checkToneMapping(f.rt);
  expect(result.backend).toBe(f.rt.toneMapBackend);
  expect(result.device.length).toBeGreaterThan(0);
}, 60000);

async function waitFor(store: Store, id: string): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const job = store.get(id)!;
    if (['completed', 'failed', 'skipped'].includes(job.status)) return job;
    await Bun.sleep(100);
  }
  throw new Error('Job did not finish within 30 seconds');
}

test('real webhook → durable queue → ffmpeg → validated HEVC sibling, preserving tracks and original', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.profiles.default!.preset = 'ultrafast';
  f.config.profiles.default!.maxHeight = 144;
  f.config.maxAttempts = 1;
  const source = join(f.rt.dataDir, "Movie 'quote' $(literal).mkv");
  const subtitle = join(f.root, 'subtitle.srt'),
    attachment = join(f.root, 'attachment.txt');
  await Bun.write(subtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello world\n');
  await Bun.write(attachment, 'Attached metadata');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-i',
      subtitle,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '1:a',
      '-map',
      '2:s',
      '-t',
      '2',
      '-c:v',
      'ffv1',
      '-c:a',
      'pcm_s16le',
      '-c:s',
      'srt',
      '-metadata:s:a:0',
      'language=eng',
      '-metadata:s:a:1',
      'title=Commentary',
      '-disposition:s:0',
      'forced',
      '-attach',
      attachment,
      '-metadata:s:t',
      'mimetype=text/plain',
      source,
    ],
    { timeoutMs: 15000 },
  );
  const originalHash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(source).bytes())
    .digest('hex');
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const app = createApp(f.config, f.rt, store);
  const worker = new Worker(store, f.config, f.rt);
  worker.start();
  cleanups.push(async () => {
    await app.stop();
    await worker.stop();
    store.close();
  });
  const base = `http://127.0.0.1:${app.server.port}`;
  const submit = await fetch(base + '/radarr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventType: 'Download', movieFile: { path: source } }),
  });
  expect(submit.status).toBe(202);
  const body = (await submit.json()) as { jobs: { id: string }[] };
  const job = await waitFor(store, body.jobs[0]!.id);
  expect(job.status).toBe('completed');
  const output = await probe(job.output!, f.rt);
  expect(output.streams.find((s) => s.codec_type === 'video')!.codec_name).toBe('hevc');
  expect(output.streams.find((s) => s.codec_type === 'video')!.height).toBe(144);
  expect(output.streams.filter((s) => s.codec_type === 'audio').length).toBe(2);
  expect(output.streams.find((s) => s.codec_type === 'subtitle')!.disposition!.forced).toBe(1);
  expect(output.streams.filter((s) => s.codec_type === 'attachment').length).toBe(1);
  expect(new Bun.CryptoHasher('sha256').update(await Bun.file(source).bytes()).digest('hex')).toBe(
    originalHash,
  );
  expect((await stat(job.output!)).size < (await stat(source)).size).toBeTruthy();
  expect(await readdir(f.rt.transcodeDir)).toEqual([]);
  expect(
    !(await readdir(f.rt.outDir)).some((name) => name.startsWith('.horadrictube-')),
  ).toBeTruthy();
  // A different profile would collide with the same output name; it must leave it untouched.
  const outputHash = new Bun.CryptoHasher('sha256')
    .update(await Bun.file(job.output!).bytes())
    .digest('hex');
  const [second] = store.enqueueMany(
    [{ source, profile: 'compact', fingerprint: 'other', delaySeconds: 0 }],
    10,
  );
  worker.tick();
  expect((await waitFor(store, second!.id)).status).toBe('skipped');
  expect(
    new Bun.CryptoHasher('sha256').update(await Bun.file(job.output!).bytes()).digest('hex'),
  ).toBe(outputHash);
});

test('atomic publication refuses an existing destination', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const temp = join(f.rt.transcodeDir, 'encoded'),
    output = join(f.rt.outDir, 'existing'),
    stage = join(f.rt.outDir, 'stage');
  await Bun.write(temp, 'new');
  await Bun.write(output, 'existing');
  await expect(publish(temp, output, stage, new AbortController().signal)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await Bun.file(output).text()).toBe('existing');
});

test('ffmpeg child processes are terminated on cancellation and timeout', async () => {
  const controller = new AbortController();
  const task = run(Bun.argv[0]!, ['-e', 'setInterval(() => {}, 1000)'], {
    signal: controller.signal,
    timeoutMs: 10000,
  });
  controller.abort();
  await expect(task).rejects.toThrow(/shutdown/);
  await expect(
    run(Bun.argv[0]!, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 }),
  ).rejects.toThrow(/timeout/);
});

test('real 2160p source becomes a 1080p companion using the default profile', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.profiles.default!.preset = 'ultrafast';
  f.config.maxAttempts = 1;
  const source = join(f.rt.dataDir, '4k.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=3840x2160:rate=5',
      '-t',
      '0.4',
      '-c:v',
      'ffv1',
      source,
    ],
    { timeoutMs: 15000 },
  );
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const worker = new Worker(store, f.config, f.rt);
  cleanups.push(async () => {
    await worker.stop();
    store.close();
  });
  const [job] = store.enqueueMany(
    [{ source, profile: 'default', fingerprint: '4k', delaySeconds: 0 }],
    10,
  );
  worker.start();
  const result = await waitFor(store, job!.id);
  expect(result.status).toBe('completed');
  const video = (await probe(result.output!, f.rt)).streams.find((s) => s.codec_type === 'video')!;
  expect(video.height).toBe(1080);
  expect(video.width).toBe(1920);
}, 30000);

test.each(['smpte2084', 'arib-std-b67'])(
  'HDR %s is skipped by default and Spline creates an SDR companion',
  async (transfer) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    f.config.profiles.compact!.preset = 'ultrafast';
    f.config.profiles.compact!.maxHeight = 144;
    f.config.maxAttempts = 1;
    const source = join(f.rt.dataDir, 'hdr.mkv');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=10',
        '-t',
        '1',
        '-vf',
        `format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`,
        '-c:v',
        'ffv1',
        source,
      ],
      { timeoutMs: 15000 },
    );
    const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
    const worker = new Worker(store, f.config, f.rt);
    cleanups.push(async () => {
      await worker.stop();
      store.close();
    });
    const [original] = store.enqueueMany(
      [{ source, profile: 'default', fingerprint: 'hdr', delaySeconds: 0 }],
      10,
    );
    worker.start();
    expect((await waitFor(store, original!.id)).status).toBe('skipped');
    const [converted] = store.enqueueMany(
      [{ source, profile: 'compact', fingerprint: 'hdr', delaySeconds: 0 }],
      10,
    );
    worker.tick();
    const result = await waitFor(store, converted!.id);
    expect(result.status).toBe('completed');
    const video = (await probe(result.output!, f.rt)).streams.find(
      (s) => s.codec_type === 'video',
    )!;
    expect(video.color_transfer).toBe('bt709');
    expect(video.color_primaries).toBe('bt709');
    expect(video.color_space).toBe('bt709');
    expect(video.color_range).toBe('tv');
    expect(video.pix_fmt).toBe('yuv420p10le');
    expect(video.width).toBe(192);
    expect(video.height).toBe(144);
  },
  30000,
);

test('processing failures retry to the configured limit and retain an actionable error', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.maxAttempts = 2;
  f.config.retryDelaySeconds = 1;
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const worker = new Worker(store, f.config, f.rt);
  cleanups.push(async () => {
    await worker.stop();
    store.close();
  });
  const [job] = store.enqueueMany(
    [
      {
        source: join(f.rt.dataDir, 'missing.mkv'),
        profile: 'default',
        fingerprint: 'missing',
        delaySeconds: 0,
      },
    ],
    10,
  );
  worker.start();
  const result = await waitFor(store, job!.id);
  expect(result.status).toBe('failed');
  expect(result.attempts).toBe(2);
  expect(result.message).toContain('ENOENT');
  expect(await readdir(f.rt.transcodeDir)).toEqual([]);
}, 10000);

test('insufficient savings discards the encode and preserves the source', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.minSavingsPercent = 99;
  f.config.profiles.default!.preset = 'ultrafast';
  f.config.maxAttempts = 1;
  const source = join(f.rt.dataDir, 'small.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=10',
      '-t',
      '0.5',
      '-c:v',
      'ffv1',
      source,
    ],
    { timeoutMs: 10000 },
  );
  const bytes = await Bun.file(source).bytes();
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const worker = new Worker(store, f.config, f.rt);
  cleanups.push(async () => {
    await worker.stop();
    store.close();
  });
  const [job] = store.enqueueMany(
    [{ source, profile: 'default', fingerprint: 'small', delaySeconds: 0 }],
    10,
  );
  worker.start();
  const result = await waitFor(store, job!.id);
  expect(result.status).toBe('skipped');
  expect(result.message).toContain('minimum is 99%');
  expect(await Bun.file(result.output!).exists()).toBe(false);
  expect(await Bun.file(source).bytes()).toEqual(bytes);
  expect(await readdir(f.rt.transcodeDir)).toEqual([]);
});

test('shutdown requeues an active encode and cleans scratch files', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.profiles.default!.preset = 'veryslow';
  const source = join(f.rt.dataDir, 'shutdown.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-t',
      '2',
      '-c:v',
      'ffv1',
      source,
    ],
    { timeoutMs: 10000 },
  );
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const worker = new Worker(store, f.config, f.rt);
  cleanups.push(async () => {
    await worker.stop();
    store.close();
  });
  const [job] = store.enqueueMany(
    [{ source, profile: 'default', fingerprint: 'shutdown', delaySeconds: 0 }],
    10,
  );
  worker.start();
  for (let i = 0; i < 100 && !store.get(job!.id)?.decision; i++) await Bun.sleep(10);
  expect(store.get(job!.id)!.status).toBe('running');
  await worker.stop();
  expect(store.get(job!.id)!.status).toBe('queued');
  expect(store.get(job!.id)!.attempts).toBe(0);
  expect(await readdir(f.rt.transcodeDir)).toEqual([]);
  expect(await Bun.file(join(f.rt.outDir, 'shutdown HEVC.mkv')).exists()).toBe(false);
}, 15000);
