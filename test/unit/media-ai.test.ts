import { test, expect, afterEach } from 'bun:test';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { defaultConfig } from '../../src/config.ts';
import { makePlan, validateOutput, type Media } from '../../src/media.ts';
import { decide, type Fetcher } from '../../src/decision.ts';
import { fixture } from '../helpers.ts';
const media: Media = {
  format: { duration: '100' },
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', codec_name: 'h264', width: 3840, height: 2160 },
    { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6 },
    { index: 3, codec_type: 'subtitle', codec_name: 'subrip' },
    { index: 4, codec_type: 'attachment', codec_name: 'ttf' },
  ],
};

test('planner selects real video, targets 1080p and preserves audio/subtitles/attachments', () => {
  const plan = makePlan(
    media,
    defaultConfig.profiles.default!,
    defaultConfig,
    '/source $(touch pwn).mkv',
    '/temp.mkv',
  );
  expect(plan.height).toBe(1080);
  expect(plan.args.includes('0:1')).toBeTruthy();
  expect(!plan.args.includes('0:0')).toBeTruthy();
  expect(plan.args.some((arg) => arg.includes('scale=1920:1080'))).toBeTruthy();
  expect(plan.expected.length).toBe(4);
  const small = structuredClone(media);
  small.streams[1]!.height = 720;
  expect(
    !makePlan(small, defaultConfig.profiles.default!, defaultConfig, 'in', 'out').args.some((arg) =>
      arg.includes('scale='),
    ),
  ).toBeTruthy();
  const hdr = structuredClone(media);
  hdr.streams[1]!.color_transfer = 'smpte2084';
  expect(() => makePlan(hdr, defaultConfig.profiles.default!, defaultConfig, 'in', 'out')).toThrow(
    /HDR/,
  );
  expect(
    makePlan(hdr, defaultConfig.profiles.compact!, defaultConfig, 'in', 'out').args.some((arg) =>
      arg.includes('tonemapping=spline'),
    ),
  ).toBeTruthy();
  const hevc = structuredClone(media);
  hevc.streams[1]!.codec_name = 'hevc';
  expect(() => makePlan(hevc, defaultConfig.profiles.default!, defaultConfig, 'in', 'out')).toThrow(
    /already HEVC/,
  );
  const out: Media = {
    format: { duration: '100.1' },
    streams: plan.expected.map((s) =>
      s.codec_type === 'video' ? { ...s, codec_name: 'hevc', width: 1920, height: 1080 } : s,
    ),
  };
  validateOutput(media, out, plan);
  expect(() => validateOutput(media, { ...out, format: { duration: '40' } }, plan)).toThrow(
    /duration/,
  );
  expect(() =>
    validateOutput(
      media,
      { ...out, streams: out.streams.filter((s) => s.codec_type !== 'audio') },
      plan,
    ),
  ).toThrow(/lost audio/);
});

test('Jev selection is bounded, metadata-only, confidence-gated and gracefully falls back', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.ai.enabled = true;
  f.rt.typesafeKey = 'test-only-key';
  const privateMedia = structuredClone(media);
  privateMedia.streams[1]!.tags = { title: 'private movie title' };
  f.config.profiles.default!.pathMappings = [{ from: '/private-media', to: '/private-target' }];
  f.config.profiles.default!.fileRenames = [
    { regex: 'private-title', substitution: 'private-output' },
  ];
  let request = '';
  const mock =
    (choice: string, confidence: number): Fetcher =>
    async (_url, init) => {
      request = String(init?.body);
      return Response.json({ answers: { profile: { type: 'choice', choice, confidence } } });
    };
  expect(
    (await decide('auto', privateMedia, f.config, f.rt, undefined, mock('compact', 0.99))).profile,
  ).toBe('compact');
  expect(!request.includes('private movie title')).toBeTruthy();
  expect(!request.includes('test-only-key')).toBeTruthy();
  expect(request).not.toContain('private-media');
  expect(request).not.toContain('private-title');
  expect((await decide('auto', media, f.config, f.rt, undefined, mock('compact', 0.3))).via).toBe(
    'fallback',
  );
  expect((await decide('auto', media, f.config, f.rt, undefined, mock('--evil', 1))).via).toBe(
    'fallback',
  );
  expect(
    (
      await decide('auto', media, f.config, f.rt, undefined, async () => {
        throw new Error('offline');
      })
    ).profile,
  ).toBe('default');
  expect(
    (
      await decide(
        'auto',
        media,
        f.config,
        f.rt,
        undefined,
        async () => new Response('', { status: 429 }),
      )
    ).via,
  ).toBe('fallback');
  expect(
    (
      await decide('default', media, f.config, f.rt, undefined, async () => {
        throw new Error('must not call');
      })
    ).via,
  ).toBe('explicit');
});
