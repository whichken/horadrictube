import { test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import legacy from '../fixtures/server-profiles.v1.json';
import { configSchema, normalizeConfig } from '../../src/config.ts';
import { run } from '../../src/process.ts';
import { probe, validateOutput } from '../../src/media.ts';
import { createPlan, detectCrop } from '../../src/planner.ts';
import { Store } from '../../src/store.ts';
import { Worker } from '../../src/worker.ts';
import { createApp } from '../../src/server.ts';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

test.each(['default', 'dual'])(
  'server %s profile: webhook mapping → selection/crop → per-track codecs → renamed companion',
  async (name) => {
    const f = await fixture();
    cleanups.push(f.cleanup);
    const config = configSchema.parse(normalizeConfig(legacy));
    config.maxAttempts = 1;
    config.minSavingsPercent = 0;
    for (const profile of Object.values(config.profiles)) {
      profile.pathMappings = [{ from: '/media/', to: f.rt.dataDir }];
      profile.encoder!.push({ type: 'video', result: { preset: 'ultrafast' } });
    }
    const source = join(f.rt.dataDir, 'Film Remux-2160p Proper.mkv');
    const subs = join(f.root, 'subs.srt');
    await Bun.write(subs, '1\n00:00:00,000 --> 00:00:00,900\nExample subtitle\n');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x160:rate=12,pad=320:240:0:40:black',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=7.1',
        '-i',
        subs,
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-map',
        '1:a',
        '-map',
        '1:a',
        '-map',
        '1:a',
        '-map',
        '1:a',
        '-map',
        '2:s',
        '-map',
        '2:s',
        '-map',
        '2:s',
        '-map',
        '2:s',
        '-t',
        '1',
        '-c:v',
        'ffv1',
        '-c:a',
        'pcm_s16le',
        '-c:a:2',
        'aac',
        '-ac:a:2',
        '2',
        '-b:a:2',
        '192k',
        '-c:a:3',
        'ac3',
        '-ac:a:3',
        '6',
        '-b:a:3',
        '384k',
        '-c:s',
        'srt',
        '-metadata:s:a:0',
        'language=jpn',
        '-metadata:s:a:1',
        'language=eng',
        '-metadata:s:a:2',
        'language=eng',
        '-metadata:s:a:2',
        'title=Director Commentary',
        '-metadata:s:a:3',
        'language=fra',
        '-metadata:s:a:4',
        'language=eng',
        '-metadata:s:s:0',
        'language=eng',
        '-disposition:s:0',
        '0',
        '-metadata:s:s:1',
        'language=eng',
        '-disposition:s:1',
        'forced',
        '-metadata:s:s:2',
        'language=fra',
        '-metadata:s:s:2',
        'title=SDH',
        '-disposition:s:2',
        '0',
        '-metadata:s:s:3',
        'language=fra',
        '-disposition:s:3',
        '0',
        source,
      ],
      { timeoutMs: 15000 },
    );
    const originalHash = new Bun.CryptoHasher('sha256')
      .update(await Bun.file(source).bytes())
      .digest('hex');
    const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
    const worker = new Worker(store, config, f.rt);
    const app = createApp(config, f.rt, store);
    cleanups.push(async () => {
      await app.stop();
      await worker.stop();
      store.close();
    });
    const base = `http://127.0.0.1:${app.server.port}`;
    const preview = await fetch(`${base}/plan/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/media/Film Remux-2160p Proper.mkv' }),
    });
    const previewBody = (await preview.json()) as { output: string; ffmpeg: string[] };
    expect(preview.status).toBe(200);
    expect(previewBody.output).toBe(join(f.rt.dataDir, 'Film Bluray-1080p HEVC.mkv'));
    expect(previewBody.ffmpeg.join(' ')).toContain('crop=320:160:0:40');
    const response = await fetch(`${base}/sonarr/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'Download',
        episodeFile: { path: '/media/Film Remux-2160p Proper.mkv' },
      }),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobs: { id: string }[] };
    worker.start();
    let job = store.get(body.jobs[0]!.id)!;
    for (let i = 0; i < 200 && !['completed', 'failed', 'skipped'].includes(job.status); i++) {
      await Bun.sleep(100);
      job = store.get(job.id)!;
    }
    expect({ status: job.status, message: job.status === 'completed' ? '' : job.message }).toEqual({
      status: 'completed',
      message: '',
    });
    expect(job.output).toBe(previewBody.output);
    const output = await probe(job.output!, f.rt),
      input = await probe(source, f.rt);
    const video = output.streams.find((s) => s.codec_type === 'video')!;
    expect([video.width, video.height]).toEqual([320, 160]);
    const audio = output.streams.filter((s) => s.codec_type === 'audio');
    expect(audio.map((s) => s.tags!.language)).toEqual(
      name === 'default' ? ['eng', 'eng'] : ['eng', 'jpn', 'fra'],
    );
    expect(audio.map((s) => s.codec_name)).toEqual(
      name === 'default' ? ['eac3', 'aac'] : ['ac3', 'ac3', 'ac3'],
    );
    expect(audio.map((s) => s.channels)).toEqual(name === 'default' ? [6, 2] : [6, 6, 6]);
    expect(audio.map((s) => s.disposition!.default)).toEqual(
      name === 'default' ? [1, 0] : [1, 0, 0],
    );
    const subtitles = output.streams.filter((s) => s.codec_type === 'subtitle');
    expect(subtitles.map((s) => s.tags!.language)).toEqual(['eng', 'eng', 'fra']);
    expect(subtitles.map((s) => s.disposition!.default)).toEqual([1, 0, 0]);
    expect(subtitles[0]!.disposition!.forced).toBe(1);
    const plan = await createPlan(input, config.profiles[name]!, config, source, 'unused', f.rt);
    validateOutput(input, output, plan);
    if (name === 'dual') {
      // Compare encoded AC3 packet bytes to establish that the matching track was copied.
      const hash = (file: string, stream: string) =>
        run(
          'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            file,
            '-map',
            stream,
            '-c',
            'copy',
            '-f',
            'hash',
            '-hash',
            'sha256',
            '-',
          ],
          { timeoutMs: 10000 },
        );
      expect(await hash(job.output!, '0:a:2')).toBe(await hash(source, '0:a:3'));
    }
    expect(
      new Bun.CryptoHasher('sha256').update(await Bun.file(source).bytes()).digest('hex'),
    ).toBe(originalHash);
  },
  30000,
);

test('crop sampling keeps full-frame content', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const source = join(f.rt.dataDir, 'full.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=white:size=320x240:rate=10',
      '-t',
      '1',
      '-c:v',
      'ffv1',
      source,
    ],
    { timeoutMs: 10000 },
  );
  expect(await detectCrop(await probe(source, f.rt), source, f.rt)).toEqual({
    width: 320,
    height: 240,
    x: 0,
    y: 0,
  });
});

test('wide source is limited by width, and HDR crop runs before Spline tone mapping', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const config = configSchema.parse(normalizeConfig(legacy));
  const profile = config.profiles.default!;
  profile.encoder!.push({ type: 'video', result: { preset: 'ultrafast' } });
  const source = join(f.rt.dataDir, 'Wide 2160p.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=2560x1080:rate=5',
      '-t',
      '0.4',
      '-c:v',
      'ffv1',
      source,
    ],
    { timeoutMs: 15000 },
  );
  const media = await probe(source, f.rt),
    output = join(f.root, 'wide.mkv');
  const plan = await createPlan(media, profile, config, source, output, f.rt);
  await run('ffmpeg', plan.args, { timeoutMs: 15000 });
  const result = await probe(output, f.rt);
  validateOutput(media, result, plan);
  expect([result.streams[0]!.width, result.streams[0]!.height]).toEqual([1920, 810]);

  const hdr = join(f.rt.dataDir, 'HDR Remux-2160p.mkv'),
    sdr = join(f.root, 'sdr.mkv');
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x160:rate=10,pad=320:240:0:40:black,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
      '-t',
      '1',
      '-c:v',
      'ffv1',
      hdr,
    ],
    { timeoutMs: 15000 },
  );
  const hdrMedia = await probe(hdr, f.rt);
  const hdrPlan = await createPlan(hdrMedia, profile, config, hdr, sdr, f.rt);
  const { toneMappingEnvironment } = await import('../../src/tonemap.ts');
  await run('ffmpeg', hdrPlan.args, { timeoutMs: 60000, env: await toneMappingEnvironment(f.rt) });
  const sdrMedia = await probe(sdr, f.rt);
  validateOutput(hdrMedia, sdrMedia, hdrPlan);
  expect([sdrMedia.streams[0]!.width, sdrMedia.streams[0]!.height]).toEqual([320, 160]);
  expect(sdrMedia.streams[0]!.color_transfer).toBe('bt709');
}, 60000);
