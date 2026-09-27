import { expect, test } from 'bun:test';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { makePlan, probe, validateOutput } from '../../src/media.ts';
import { selectDecodePlan, vulkanCandidate } from '../../src/decode.ts';
import { run } from '../../src/process.ts';
import { Worker } from '../../src/worker.ts';
import { Store } from '../../src/store.ts';
import { toneMappingEnvironment } from '../../src/tonemap.ts';

async function sample(path: string, hdr = false, crf = 0) {
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=24:duration=1',
      ...(hdr
        ? [
            '-vf',
            'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
          ]
        : []),
      '-c:v',
      hdr ? 'libx265' : 'libx264',
      '-preset',
      'ultrafast',
      ...(hdr ? ['-x265-params', 'pools=2:frame-threads=1'] : ['-crf', String(crf)]),
      path,
    ],
    { timeoutMs: 15000 },
  );
}

test.each([false, true])(
  'CPU decode fallback completes an encode (resize=%s)',
  async (resize) => {
    const f = await fixture();
    try {
      const source = join(f.rt.dataDir, 'source.mkv'),
        output = join(f.rt.outDir, 'output.mkv');
      await sample(source);
      const media = await probe(source, f.rt);
      const profile = {
        ...f.config.profiles.default!,
        preset: 'ultrafast' as const,
        maxHeight: resize ? 144 : 1080,
      };
      const cpu = makePlan(media, profile, f.config, source, output, f.rt.toneMapBackend);
      const plan = await selectDecodePlan(cpu, media, {
        ...f.rt,
        decodeBackend: 'vulkan',
        vulkanDevice: 'nonexistent-horadrictube-device',
      });
      expect(plan.decoder).toBe('cpu');
      const requiresCpuFiltering = resize && f.rt.toneMapBackend === 'cpu';
      expect(plan.decodeReason).toContain(
        requiresCpuFiltering ? 'same device' : 'preflight failed',
      );
      if (resize) expect(plan.args.join(' ')).toContain('downscaler=hermite');
      await run(f.rt.ffmpeg, plan.args, {
        timeoutMs: 30000,
        env: plan.vulkanFiltering ? await toneMappingEnvironment(f.rt) : undefined,
      });
      validateOutput(media, await probe(output, f.rt), plan);
      const controller = new AbortController();
      controller.abort();
      if (!requiresCpuFiltering)
        await expect(
          selectDecodePlan(cpu, media, { ...f.rt, decodeBackend: 'vulkan' }, controller.signal),
        ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  },
  30000,
);

test('a Vulkan failure after preflight discards partial output and retries CPU in the same job', async () => {
  const f = await fixture();
  let worker: Worker | undefined, store: Store | undefined;
  try {
    const source = join(f.rt.dataDir, 'source.mkv');
    await sample(source);
    const wrapper = join(f.root, 'ffmpeg-wrapper');
    const marker = join(f.root, 'attempted');
    // Simulate a device lost after a successful preflight, without requiring a GPU in CI.
    await Bun.write(
      wrapper,
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes('-hwaccel')) {
  if (args.at(-1) === '-') process.exit(0);
  await Bun.write(${JSON.stringify(marker)}, 'hardware attempted');
  await Bun.write(args.at(-1), 'invalid partial output');
  console.error('Simulated Vulkan device loss');
  process.exit(1);
}
process.exit(await Bun.spawn(['ffmpeg', ...args], {stdout:'inherit', stderr:'inherit'}).exited);
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
      [{ source, profile: 'default', fingerprint: 'fallback', delaySeconds: 0 }],
      10,
    );
    worker = new Worker(store, f.config, f.rt);
    worker.start();
    for (let i = 0; i < 200; i++) {
      if (['completed', 'failed', 'skipped'].includes(store.get(job!.id)!.status)) break;
      await Bun.sleep(100);
    }
    const result = store.get(job!.id)!;
    expect(await Bun.file(marker).text()).toBe('hardware attempted');
    expect(result.status).toBe('completed');
    expect(result.attempts).toBe(1);
    expect((await probe(result.output!, f.rt)).streams[0]!.codec_name).toBe('hevc');
    expect(await Bun.file(join(f.rt.transcodeDir, `horadrictube-${job!.id}.mkv`)).exists()).toBe(
      false,
    );
  } finally {
    await worker?.stop();
    store?.close();
    await f.cleanup();
  }
}, 30000);

// Explicit opt-in: this test MUST fail rather than silently pass via CPU fallback.
test.skipIf(Bun.env.VULKAN_DECODE_TEST !== '1')(
  'Vulkan HEVC pixels match CPU; HDR and H.264 SDR encode successfully',
  async () => {
    const f = await fixture();
    try {
      const source = join(f.rt.dataDir, 'hdr.mkv'),
        output = join(f.rt.outDir, 'sdr.mkv');
      await sample(source, true);
      const media = await probe(source, f.rt);
      f.config.skipHevc = false;
      const rt = { ...f.rt, decodeBackend: 'vulkan' as const, toneMapBackend: 'gpu' as const };
      const profile = {
        ...f.config.profiles.default!,
        preset: 'ultrafast' as const,
        hdr: 'tonemap' as const,
        maxHeight: 144,
      };
      const cpu = makePlan(media, profile, f.config, source, output, 'gpu', {
        width: 600,
        height: 300,
        x: 20,
        y: 30,
      });
      const hw = vulkanCandidate(cpu, media, rt);
      const inputArgs = hw.args.slice(0, hw.args.indexOf('-i') + 2);
      const hashes = async (hardware: boolean) => {
        const out = await run(
          rt.ffmpeg,
          [
            ...(hardware ? inputArgs : ['-v', 'error', '-i', source]),
            '-vf',
            hardware ? 'hwdownload,format=p010le,format=yuv420p10le' : 'format=yuv420p10le',
            '-frames:v',
            '16',
            '-f',
            'framemd5',
            '-',
          ],
          { timeoutMs: 20000 },
        );
        return out.split('\n').filter((line) => line && !line.startsWith('#'));
      };
      expect(await hashes(true)).toEqual(await hashes(false));
      const selected = await selectDecodePlan(cpu, media, rt);
      expect(selected.decoder).toBe('vulkan');
      await run(rt.ffmpeg, selected.args, { timeoutMs: 30000 });
      validateOutput(media, await probe(output, rt), selected);
      await run(rt.ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], {
        timeoutMs: 15000,
      });
      const sdrSource = join(f.rt.dataDir, 'h264.mkv');
      const sdrOutput = join(f.rt.outDir, 'h264-sdr.mkv');
      await sample(sdrSource, false, 18);
      const sdrMedia = await probe(sdrSource, rt);
      const sdrPlan = await selectDecodePlan(
        makePlan(sdrMedia, profile, f.config, sdrSource, sdrOutput, 'gpu'),
        sdrMedia,
        rt,
      );
      expect(sdrPlan.decoder).toBe('vulkan');
      await run(rt.ffmpeg, sdrPlan.args, { timeoutMs: 30000 });
      validateOutput(sdrMedia, await probe(sdrOutput, rt), sdrPlan);
    } finally {
      await f.cleanup();
    }
  },
  90000,
);
