import { test, expect } from 'bun:test';
import { runtime, defaultConfig, usesVulkanFiltering } from '../../src/config.ts';
import { makePlan, type Media } from '../../src/media.ts';
import { checkToneMapping, toneMappingEnvironment } from '../../src/tonemap.ts';

test('CPU and GPU plans share Spline and dimensions but only CPU imports a software device', () => {
  const media = {
    format: { duration: '10' },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'ffv1',
        width: 3840,
        height: 2160,
        color_transfer: 'smpte2084',
      },
    ],
  };
  const profile = { ...defaultConfig.profiles.default!, hdr: 'tonemap' as const };
  const cpu = makePlan(media, profile, defaultConfig, 'in', 'out', 'cpu');
  const gpu = makePlan(media, profile, defaultConfig, 'in', 'out', 'gpu');
  expect(cpu.args).toContain('vulkan=tonemap:llvmpipe');
  expect(gpu.args).not.toContain('-init_hw_device');
  const cpuFilter = cpu.args[cpu.args.indexOf('-filter:v:0') + 1]!;
  expect(gpu.args[gpu.args.indexOf('-filter:v:0') + 1]).toBe(cpuFilter);
  expect(cpuFilter).toContain('w=1920:h=1080');
  expect(cpuFilter).toContain('tonemapping=spline');
  expect(cpuFilter).toContain('downscaler=hermite');
  expect(cpuFilter).toContain('CONTENT_LIGHT_LEVEL');
  media.streams[0]!.height = 360;
  media.streams[0]!.width = 640;
  expect(makePlan(media, profile, defaultConfig, 'in', 'out').args.join(' ')).toContain(
    'w=640:h=360',
  );
  media.streams[0]!.color_transfer = 'bt709';
  const sdr = makePlan(media, profile, defaultConfig, 'in', 'out', 'cpu');
  expect(sdr.args).not.toContain('-init_hw_device');
  expect(sdr.args.join(' ')).not.toContain('libplacebo');
});

test('missing software driver fails with guidance, without changing process environment', async () => {
  const original = Bun.env.VK_DRIVER_FILES;
  const rt = runtime({ VULKAN_CPU_ICD: '/nonexistent/horadrictube-lvp.json' });
  await expect(toneMappingEnvironment(rt)).rejects.toThrow(/Lavapipe/);
  await expect(checkToneMapping(rt)).rejects.toThrow(/Spline cpu check failed/);
  expect(Bun.env.VK_DRIVER_FILES).toBe(original);
});

test('Dolby Vision chooses color-safe conversion from its profile and base compatibility', () => {
  const media: Media = {
    format: { duration: '10' },
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        width: 1920,
        height: 1080,
        side_data_list: [
          {
            side_data_type: 'DOVI configuration record',
            dv_profile: 5,
            bl_present_flag: 1,
            el_present_flag: 0,
            rpu_present_flag: 1,
            dv_bl_signal_compatibility_id: 0,
          },
        ],
      },
    ],
  };
  const profile = { ...defaultConfig.profiles.default!, hdr: 'tonemap' as const };
  const config = { ...defaultConfig, skipHevc: false };
  const plan = () => makePlan(media, profile, config, 'in', 'out');
  expect(plan).toThrow(/missing decoded RPU/);
  media.doviMetadataVerified = true;
  // Profile 5 deliberately has no conventional PQ/BT.2020 tags here.
  expect(plan().dolbyVision).toBe('reshape');
  expect(plan().args.join(' ')).toContain('apply_dolbyvision=1');
  const record = media.streams[0]!.side_data_list![0]!;
  record.dv_profile = 7;
  record.el_present_flag = 1;
  record.dv_bl_signal_compatibility_id = 6;
  expect(plan().dolbyVision).toBe('hdr10-base');
  expect(plan().args.join(' ')).toContain('apply_dolbyvision=0');
  record.dv_profile = 8;
  record.el_present_flag = 0;
  record.dv_bl_signal_compatibility_id = 1;
  expect(plan().dolbyVision).toBe('hdr10-base');
  record.dv_bl_signal_compatibility_id = 4;
  expect(plan().dolbyVision).toBe('hlg-base');
  expect(plan().args.join(' ')).toContain('color_trc=arib-std-b67');
  record.dv_bl_signal_compatibility_id = 0;
  expect(plan).toThrow(/Unsupported Dolby Vision/);
  record.dv_profile = 20;
  expect(plan).toThrow(/Unsupported Dolby Vision/);
});

test('SDR scaling uses the configured Vulkan backend, without forcing HDR color conversion', () => {
  const media: Media = {
    format: {},
    streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 3840, height: 2160 }],
  };
  const profile = defaultConfig.profiles.default!;
  for (const backend of ['cpu', 'gpu'] as const) {
    const plan = makePlan(media, profile, defaultConfig, 'in', 'out', backend);
    expect(plan.vulkanFiltering).toBe(true);
    expect(plan.hdr).toBe(false);
    expect(plan.args.includes('-init_hw_device')).toBe(backend === 'cpu');
    const filter = plan.args[plan.args.indexOf('-filter:v:0') + 1]!;
    expect(filter).toContain('libplacebo=w=1920:h=1080:downscaler=hermite');
    expect(filter).not.toMatch(/tonemapping=|color_trc=|colorspace=|range=/);
  }
  expect(usesVulkanFiltering(profile)).toBe(true);
  const unscaled = { ...profile, maxWidth: null, maxHeight: null };
  expect(usesVulkanFiltering(unscaled)).toBe(false);
  expect(
    usesVulkanFiltering({ ...unscaled, encoder: [{ type: 'video', result: { size: '1920:-2' } }] }),
  ).toBe(true);
});
