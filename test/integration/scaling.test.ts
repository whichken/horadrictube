import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { makePlan, probe, validateOutput, videoStream } from '../../src/media.ts';
import { run } from '../../src/process.ts';
import { toneMappingEnvironment } from '../../src/tonemap.ts';

test.each([
  ['bt709', 'tv'],
  ['bt709', 'pc'],
  ['smpte170m', 'tv'],
])(
  'Hermite SDR resize preserves %s/%s colors and range after cropping',
  async (color, range) => {
    const f = await fixture();
    try {
      const source = join(f.root, 'source.mkv');
      const output = join(f.root, 'output.mkv');
      // Flat colored field: scaling should preserve these code values. This also
      // catches accidental full/limited-range conversion or BT.601→709 retagging.
      await run(
        f.rt.ffmpeg,
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `nullsrc=size=320x240:rate=4:duration=1,format=yuv420p10le,geq=lum=400:cb=450:cr=570,setparams=color_primaries=${color}:color_trc=${color}:colorspace=${color}:range=${range === 'pc' ? 'full' : 'limited'}`,
          '-c:v',
          'ffv1',
          '-color_primaries',
          color!,
          '-color_trc',
          color!,
          '-colorspace',
          color!,
          '-color_range',
          range!,
          source,
        ],
        { timeoutMs: 15000 },
      );
      const media = await probe(source, f.rt);
      const profile = {
        ...f.config.profiles.default!,
        maxHeight: 144,
        preset: 'ultrafast' as const,
      };
      const plan = makePlan(media, profile, f.config, source, output, f.rt.toneMapBackend, {
        width: 304,
        height: 224,
        x: 8,
        y: 8,
      });
      await run(f.rt.ffmpeg, plan.args, {
        timeoutMs: 30000,
        env: await toneMappingEnvironment(f.rt),
      });
      const result = await probe(output, f.rt);
      validateOutput(media, result, plan);
      const video = videoStream(result);
      expect([video.width, video.height]).toEqual([196, 144]);
      expect([
        video.color_space,
        video.color_primaries,
        video.color_transfer,
        video.color_range,
      ]).toEqual([color, color, color, range]);
      const pixels = join(f.root, 'pixels.raw');
      await run(
        f.rt.ffmpeg,
        [
          '-v',
          'error',
          '-i',
          output,
          '-vf',
          'crop=2:2',
          '-frames:v',
          '1',
          '-pix_fmt',
          'yuv444p10le',
          '-f',
          'rawvideo',
          pixels,
        ],
        { timeoutMs: 10000 },
      );
      const values = new Uint16Array(await Bun.file(pixels).arrayBuffer());
      expect(values.length).toBe(12);
      for (let i = 0; i < values.length; i++)
        expect(Math.abs(values[i]! - [400, 450, 570][Math.floor(i / 4)]!)).toBeLessThanOrEqual(6);
    } finally {
      await f.cleanup();
    }
  },
  60000,
);
