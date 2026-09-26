import { test, expect } from 'bun:test';
import legacy from '../fixtures/server-profiles.v1.json';
import { configSchema, normalizeConfig, usesToneMapping } from '../../src/config.ts';
import { makePlan, type Media, type Stream } from '../../src/media.ts';
import { facts, encoding } from '../../src/rules.ts';
import { outputPath, routingConfig, mapPath } from '../../src/paths.ts';
import { runtime } from '../../src/config.ts';

const config = configSchema.parse(normalizeConfig(legacy));
const video: Stream = {
  index: 0,
  codec_type: 'video',
  codec_name: 'h264',
  width: 3840,
  height: 1600,
};
const track = (
  index: number,
  codec: string,
  channels: number,
  language = 'eng',
  title = '',
  rate?: string,
): Stream => ({
  index,
  codec_type: 'audio',
  codec_name: codec,
  channels,
  tags: { language, title, ...(rate ? { 'BPS-eng': rate } : {}) },
});
const sub = (index: number, language: string, title = '', forced = false): Stream => ({
  index,
  codec_type: 'subtitle',
  codec_name: 'subrip',
  tags: { language, title },
  disposition: { forced: forced ? 1 : 0 },
});
const media: Media = {
  streams: [
    video,
    track(1, 'dts', 8, 'jpn'),
    track(2, 'truehd', 8),
    track(3, 'aac', 2, 'eng', 'Director COMMENTARY'),
    track(4, 'ac3', 6, 'fra'),
    sub(5, 'eng'),
    sub(6, 'eng', 'Forced', true),
    sub(7, 'fra', 'SDH'),
    sub(8, 'fra'),
  ],
  format: { duration: '10' },
};
const plan = (name: string, input = media, source = '/data/Film Remux-2160p Proper.mkv') =>
  makePlan(input, config.profiles[name]!, config, source, '/tmp/output.mkv');

test('actual server profiles load without losing ordered rules; invalid fields are rejected', () => {
  expect(Object.keys(config.profiles)).toEqual(['default', 'dual']);
  expect(config.skipHevc).toBe(false);
  expect(usesToneMapping(config.profiles.default!)).toBe(true);
  expect(config.profiles.default!.encoder![0]!.result.crf).toBe(23);
  expect(() =>
    configSchema.parse({
      ...config,
      profiles: { default: { encoder: [{ type: 'audio', result: { crop: true } }] } },
    }),
  ).toThrow();
  expect(() =>
    configSchema.parse({
      ...config,
      profiles: { default: { fileRenames: [{ regex: '[', substitution: '' }] } },
    }),
  ).toThrow();
});

test('default selects English plus commentary, forced plus English/SDH subs, and preserves audio intentions', () => {
  const p = plan('default');
  expect(p.expected.map((s) => s.index)).toEqual([0, 2, 3, 6, 5, 7]);
  expect(p.audio).toEqual([
    { codec: 'eac3', channels: 6, primary: true },
    { codec: 'aac', channels: 2, primary: false },
  ]);
  expect(p.args).toContain('384k');
  expect(p.args).toContain('96k');
  expect(p.args).toContain('default+forced');
  expect(p.args).toContain('23');
  expect(p.args).toContain('slow');
  expect(p.width).toBe(1920);
  expect(p.height).toBe(800);
  expect(p.needsCrop).toBe(true);
});

test('dual includes all matching non-English tracks; optional limit selects only the first', () => {
  const p = plan('dual');
  expect(p.expected.map((s) => s.index)).toEqual([0, 2, 1, 4, 6, 5, 7]);
  expect(p.audio.map((s) => s.codec)).toEqual(['ac3', 'ac3', 'ac3']);
  const profile = structuredClone(config.profiles.dual!);
  profile.selection!.audio!.secondary[0]!.limit = 1;
  expect(
    makePlan(media, profile, config, 'film.mkv', 'out.mkv')
      .expected.filter((s) => s.codec_type === 'audio')
      .map((s) => s.index),
  ).toEqual([2, 1]);
});

test('later copy rules override conversion without carrying bitrate/channel flags into copies', () => {
  for (const [profileName, codec, channels, rate, expected] of [
    ['default', 'ac3', 6, '384000', 'copy'],
    ['default', 'eac3', 6, '256000', 'copy'],
    ['default', 'eac3', 6, '640000', 'eac3'],
    ['default', 'aac', 2, '320000', 'copy'],
    ['default', 'aac', 1, '64000', 'aac'],
    ['default', 'dts', 2, '768000', 'aac'],
    ['dual', 'ac3', 6, '384000', 'copy'],
    ['dual', 'ac3', 6, '256000', 'ac3'],
    ['dual', 'eac3', 6, '384000', 'ac3'],
    ['dual', 'aac', 2, '320000', 'copy'],
  ] as const) {
    const input = {
      streams: [video, track(1, codec, channels, 'eng', '', rate)],
      format: { duration: '10' },
    };
    const p = plan(profileName, input);
    const index = p.args.indexOf('-c:a:0');
    expect(p.args[index + 1]).toBe(expected);
    expect(p.args.includes('-b:a:0')).toBe(expected !== 'copy');
    expect(p.args.includes('-ac:a:0')).toBe(expected !== 'copy');
  }
});

test('missing metadata is conservative; audio falls back to first; no forced subtitle gets no default', () => {
  const audio = track(1, 'ac3', 6, 'und');
  const p = plan('default', { streams: [video, audio, sub(2, 'eng')], format: { duration: '10' } });
  expect(p.audio[0]!.codec).toBe('eac3');
  expect(p.audio[0]!.primary).toBe(true);
  expect(p.subtitles[0]!.primary).toBe(false);
  expect(
    facts({ ...audio, bit_rate: 'N/A', tags: { 'BPS-eng': '384000' } }, 'a.mkv', false, true)
      .bitrate,
  ).toBe(384000);
});

test('filename rules run in order on the stem, retain HEVC guard, and reject path escapes', () => {
  const rt = runtime({ DATA_DIR: '/Television' });
  const profile = config.profiles.default!;
  expect(outputPath('/Television/Series/Film Remux-2160p Proper.mkv', config, rt, profile)).toBe(
    '/Television/Series/Film Bluray-1080p HEVC.mkv',
  );
  expect(outputPath('/Television/Film DVD.mkv', config, rt, profile)).toBe(
    '/Television/Film DVD HEVC.mkv',
  );
  expect(outputPath('/Television/Film.mkv', config, rt, profile)).toBe('/Television/Film HEVC.mkv');
  expect(
    mapPath(
      '/media/Series/Film.mkv',
      routingConfig(config, 'dual'),
      runtime({ DATA_DIR: '/data' }),
    ),
  ).toBe('/data/Television/Series/Film.mkv');
  expect(() =>
    outputPath('/Television/Film.mkv', config, rt, {
      ...profile,
      fileRenames: [{ regex: '.*', substitution: '../escape' }],
    }),
  ).toThrow(/filename/);
});

test('width limit, crop before scale, no upscaling, and HDR rules respect source facts', () => {
  const p = makePlan(
    media,
    config.profiles.default!,
    config,
    'Film Remux-2160p.mkv',
    'out',
    'gpu',
    { width: 3840, height: 1440, x: 0, y: 80 },
  );
  expect(p.height).toBe(720);
  expect(p.width).toBe(1920);
  expect(p.args[p.args.indexOf('-filter:v:0') + 1]).toStartWith(
    'crop=3840:1440:0:80,scale=1920:720',
  );
  const small = plan(
    'default',
    { streams: [{ ...video, width: 1280, height: 720 }], format: { duration: '10' } },
    'Film 720p.mkv',
  );
  expect(small.height).toBe(720);
  expect(small.width).toBe(1280);
  expect(small.needsCrop).toBe(false);
  const hdr = plan('default', {
    streams: [
      {
        ...video,
        codec_name: 'hevc',
        color_transfer: 'smpte2084',
        color_primaries: 'bt2020',
        color_space: 'bt2020nc',
      },
    ],
    format: { duration: '10' },
  });
  expect(hdr.hdr).toBe(true);
  expect(hdr.args.join(' ')).toContain('tonemapping=spline');
  const bounded = makePlan(
    { streams: [video], format: { duration: '10' } },
    { ...config.profiles.default!, encoder: undefined, maxWidth: 1920, maxHeight: 1080 },
    config,
    'a',
    'b',
  );
  expect([bounded.width, bounded.height]).toEqual([1920, 800]);
});
