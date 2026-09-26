import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { probe, makePlan, validateOutput } from '../../src/media.ts';
import { toneMappingEnvironment } from '../../src/tonemap.ts';
import { run } from '../../src/process.ts';

// Optional external test assets: see test/fixtures/README.md. No copyrighted
// media is bundled or fetched implicitly during the ordinary test suite.
const samples = Bun.env.DOVI_SAMPLE_DIR;
for (const [filename, mode] of [
  ['p5.mp4', 'reshape'],
  ['p81.mp4', 'hdr10-base'],
] as const) {
  test.skipIf(!samples)(
    `Dolby Vision ${filename} becomes ordinary SDR HEVC`,
    async () => {
      const f = await fixture();
      try {
        const source = join(samples!, filename);
        const media = await probe(source, f.rt);
        const profile = {
          ...f.config.profiles.default!,
          hdr: 'tonemap' as const,
          preset: 'ultrafast' as const,
          maxHeight: 360,
        };
        f.config.skipHevc = false;
        const output = join(f.rt.outDir, 'SDR.mkv');
        const plan = makePlan(media, profile, f.config, source, output, f.rt.toneMapBackend);
        expect(plan.dolbyVision).toBe(mode);
        if (mode === 'reshape') expect(media.doviMetadataVerified).toBe(true);
        await run(f.rt.ffmpeg, plan.args, {
          env: await toneMappingEnvironment(f.rt),
          timeoutMs: 60000,
        });
        const result = await probe(output, f.rt);
        validateOutput(media, result, plan);
        await run(f.rt.ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], {
          timeoutMs: 60000,
        });
        expect(result.streams[0]!.color_transfer).toBe('bt709');
        expect(result.streams[0]!.color_space).toBe('bt709');
        expect(
          result.streams[0]!.side_data_list?.some((s) =>
            /dovi|dolby/i.test(String(s.side_data_type)),
          ) ?? false,
        ).toBe(false);
      } finally {
        await f.cleanup();
      }
    },
    60000,
  );
}
