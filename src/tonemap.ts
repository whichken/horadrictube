import { resolve } from 'node:path';
import type { Runtime } from './config.ts';
import { run } from './process.ts';

export function toneMappingDeviceArgs(backend: Runtime['toneMapBackend']): string[] {
  // libplacebo's own device selection excludes software GPUs. Let it create the
  // GPU context: importing FFmpeg's context fails with some FFmpeg/driver pairs.
  return backend === 'gpu'
    ? []
    : ['-init_hw_device', 'vulkan=tonemap:llvmpipe', '-filter_hw_device', 'tonemap'];
}

export function splineFilter(width: number, height: number, applyDolbyVision = true): string {
  return [
    `libplacebo=w=${width}:h=${height}`,
    'downscaler=hermite',
    'tonemapping=spline',
    `apply_dolbyvision=${applyDolbyVision ? 1 : 0}`,
    'gamut_mode=perceptual',
    'peak_detect=1',
    'smoothing_period=20',
    'contrast_recovery=0',
    'colorspace=bt709',
    'color_primaries=bt709',
    'color_trc=bt709',
    'range=tv',
    'format=yuv420p10le',
  ].join(':');
}

export function scalingFilter(width: number, height: number): string {
  // Leave color space, transfer and range at their input values for SDR.
  return [
    `libplacebo=w=${width}:h=${height}`,
    'downscaler=hermite',
    'apply_dolbyvision=0',
    'peak_detect=0',
    'format=yuv420p10le',
  ].join(':');
}

export const stripHdrMetadata = [
  'MASTERING_DISPLAY_METADATA',
  'CONTENT_LIGHT_LEVEL',
  'DYNAMIC_HDR_PLUS',
  'DOVI_RPU_BUFFER',
  'DOVI_METADATA',
]
  .map((type) => `sidedata=mode=delete:type=${type}`)
  .join(',');

export async function toneMappingEnvironment(rt: Runtime): Promise<NodeJS.ProcessEnv> {
  if (rt.toneMapBackend === 'gpu') return { ...Bun.env };
  let icd = rt.vulkanCpuIcd;
  if (!icd) {
    for await (const path of new Bun.Glob('lvp_icd*.json').scan({
      cwd: '/usr/share/vulkan/icd.d',
      absolute: true,
      throwErrorOnBrokenSymlink: false,
    })) {
      icd = path;
      break;
    }
  }
  if (!icd || !(await Bun.file(icd).exists()))
    throw new Error(
      'CPU Vulkan filtering requires Mesa Lavapipe. Install mesa-vulkan-drivers (vulkan-swrast on Arch), or set VULKAN_CPU_ICD to its lvp_icd JSON.',
    );
  // Override inherited GPU selection only for the child doing CPU filtering.
  return {
    ...Bun.env,
    VK_DRIVER_FILES: resolve(icd),
    VK_ICD_FILENAMES: resolve(icd),
    LP_NUM_THREADS: String(rt.toneMapThreads),
  };
}

export async function checkToneMapping(rt: Runtime): Promise<{ backend: string; device: string }> {
  try {
    const env = await toneMappingEnvironment(rt);
    let diagnostics = '';
    await run(
      rt.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'verbose',
        ...toneMappingDeviceArgs(rt.toneMapBackend),
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=128x72:rate=2:duration=1,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc',
        '-vf',
        `${splineFilter(64, 36)},${stripHdrMetadata}`,
        '-frames:v',
        '2',
        '-c:v',
        'libx265',
        '-preset',
        'ultrafast',
        '-x265-params',
        'pools=1:frame-threads=1',
        '-pix_fmt',
        'yuv420p10le',
        '-f',
        'null',
        '-',
      ],
      {
        env,
        timeoutMs: 60000,
        onStderr: (text) => {
          diagnostics = (diagnostics + text).slice(-32000);
        },
      },
    );
    const device = /Device Name:\s*([^\r\n]+)/.exec(diagnostics)?.[1]?.trim();
    if (!device) throw new Error('libplacebo did not report the selected Vulkan device');
    if (rt.toneMapBackend === 'cpu' && !/llvmpipe/i.test(device))
      throw new Error(`Expected Lavapipe but selected ${device}`);
    if (rt.toneMapBackend === 'gpu' && /llvmpipe|lavapipe|swiftshader/i.test(device))
      throw new Error(`GPU mode selected a software device: ${device}`);
    return { backend: rt.toneMapBackend, device };
  } catch (error) {
    const hint =
      rt.toneMapBackend === 'gpu'
        ? 'Expose a supported Vulkan GPU and its driver/device permissions, or set TONEMAP_BACKEND=cpu.'
        : 'Use the supplied image with Mesa Lavapipe installed, or check VULKAN_CPU_ICD.';
    throw new Error(
      `libplacebo Spline ${rt.toneMapBackend} check failed. ${hint}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
