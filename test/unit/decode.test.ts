import { expect, test } from 'bun:test';
import { defaultConfig, runtime } from '../../src/config.ts';
import { makePlan, type Media } from '../../src/media.ts';
import { vulkanCandidate, decodeCheckArgs } from '../../src/decode.ts';

const media: Media = {
  streams: [
    {
      index: 1,
      codec_type: 'video',
      codec_name: 'hevc',
      pix_fmt: 'yuv420p10le',
      width: 3840,
      height: 2160,
      color_transfer: 'smpte2084',
    },
  ],
  format: { duration: '10' },
};
const rt = runtime({ DECODE_BACKEND: 'vulkan', TONEMAP_BACKEND: 'gpu', VULKAN_DEVICE: 'NVIDIA' });
const config = { ...defaultConfig, skipHevc: false };
const profile = { ...config.profiles.default!, hdr: 'tonemap' as const };
const plan = makePlan(media, profile, config, 'in', 'out', 'gpu', {
  width: 3840,
  height: 1600,
  x: 0,
  y: 280,
});

test('HDR hardware plan shares the device, crops on GPU and downloads only after Spline', () => {
  const hw = vulkanCandidate(plan, media, rt);
  expect(hw.decoder).toBe('vulkan');
  expect(hw.args).toContain('vulkan=decode:NVIDIA');
  expect(hw.args.indexOf('-hwaccel')).toBeLessThan(hw.args.indexOf('-i'));
  expect(hw.args[hw.args.indexOf('-c:1') + 1]).toBe('hevc');
  const filter = hw.args[hw.args.indexOf('-filter:v:0') + 1]!;
  expect(filter).toContain('libplacebo=crop_w=3840:crop_h=1600:crop_x=0:crop_y=280:');
  expect(filter).not.toContain('crop=');
  expect(filter).toContain('format=yuv420p10le,hwdownload,format=yuv420p10le');
  expect(filter.indexOf('hwdownload')).toBeGreaterThan(filter.indexOf('tonemapping=spline'));
  expect(hw.softwareArgs).toEqual(plan.args);
  expect(plan.args).not.toContain('-hwaccel');
  const check = decodeCheckArgs(hw, media);
  expect(check[check.indexOf('-map') + 1]).toBe('0:1');
  expect(check).not.toContain('libx265');
  expect(check).not.toContain('out');
});

test.each(['yuv420p', 'yuv420p10le'])('SDR %s preserves CPU filters and bit depth', (pix_fmt) => {
  const sdr: Media = {
    ...media,
    streams: [{ ...media.streams[0]!, pix_fmt, color_transfer: 'bt709' }],
  };
  const cpu = makePlan(sdr, profile, config, 'in', 'out', 'cpu');
  const hw = vulkanCandidate(cpu, sdr, { ...rt, toneMapBackend: 'cpu' });
  expect(hw.decoder).toBe('vulkan');
  const filter = hw.args[hw.args.indexOf('-filter:v:0') + 1]!;
  expect(filter).toStartWith(
    `hwdownload,format=${pix_fmt === 'yuv420p' ? 'nv12' : 'p010le'},format=${pix_fmt},`,
  );
  expect(filter).toEndWith(cpu.args[cpu.args.indexOf('-filter:v:0') + 1]!);
});

test('CPU default, unsupported formats and CPU HDR remain software decoded', () => {
  expect(runtime({}).decodeBackend).toBe('cpu');
  expect(() => runtime({ DECODE_BACKEND: 'typo' })).toThrow();
  expect(vulkanCandidate(plan, media, runtime({})).decoder).toBe('cpu');
  expect(vulkanCandidate(plan, media, { ...rt, toneMapBackend: 'cpu' }).decoder).toBe('cpu');
  for (const changes of [
    { codec_name: 'ffv1' },
    { pix_fmt: 'yuv422p10le' },
    { pix_fmt: 'yuv420p12le' },
  ]) {
    expect(
      vulkanCandidate(plan, { ...media, streams: [{ ...media.streams[0]!, ...changes }] }, rt)
        .decoder,
    ).toBe('cpu');
  }
});

test('Profile 5 retains CPU decoding and its configured tone mapping', () => {
  const source = { ...plan, dolbyVision: 'reshape' as const };
  const candidate = vulkanCandidate(source, media, rt);
  expect(candidate.decoder).toBe('cpu');
  expect(candidate.args).toEqual(source.args);
  expect(candidate.decodeReason).toContain('Profile 5');
});
