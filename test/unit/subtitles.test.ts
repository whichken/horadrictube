import { expect, test } from 'bun:test';
import { defaultConfig } from '../../src/config.ts';
import { makePlan, validateOutput, type Media } from '../../src/media.ts';

test('only MP4 timed text is converted, using output subtitle indexes', () => {
  const source: Media = {
    format: { duration: '4' },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240 },
      ...['ass', 'mov_text', 'hdmv_pgs_subtitle', 'subrip', 'mov_text'].map((codec_name, i) => ({
        index: i + 3,
        codec_type: 'subtitle',
        codec_name,
      })),
    ],
  };
  const plan = makePlan(source, defaultConfig.profiles.default!, defaultConfig, 'in', 'out');
  for (const index of [1, 4]) expect(plan.args[plan.args.indexOf(`-c:s:${index}`) + 1]).toBe('srt');
  for (const index of [0, 2, 3]) expect(plan.args).not.toContain(`-c:s:${index}`);
  expect(plan.args).not.toContain('-c:s');
  const output: Media = {
    format: source.format,
    streams: source.streams.map((s) => ({
      ...s,
      codec_name:
        s.codec_type === 'video' ? 'hevc' : s.codec_name === 'mov_text' ? 'subrip' : s.codec_name,
    })),
  };
  expect(() => validateOutput(source, output, plan)).not.toThrow();
  output.streams[2]!.codec_name = 'mov_text';
  expect(() => validateOutput(source, output, plan)).toThrow(/subtitle codec/);
});
