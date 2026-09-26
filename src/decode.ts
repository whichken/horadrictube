import type { Runtime } from './config.ts';
import { videoStream, type Media, type Plan } from './media.ts';
import { run } from './process.ts';
import { errorMessage } from './log.ts';

// Use native parsers with Vulkan acceleration, not vendor-specific decoders.
// Restrict the initial implementation to ordinary 4:2:0 8/10-bit inputs.
export function vulkanCandidate(plan: Plan, media: Media, rt: Runtime): Plan {
  const cpu = (decodeReason: string): Plan => ({ ...plan, decodeReason });
  if (rt.decodeBackend !== 'vulkan') return cpu('CPU decoding configured');
  if (plan.dolbyVision === 'reshape')
    return cpu(
      'Dolby Vision Profile 5 uses CPU decoding pending stable Vulkan metadata validation',
    );
  const video = videoStream(media);
  if (!['h264', 'hevc', 'av1'].includes(video.codec_name ?? ''))
    return cpu('Codec is outside the Vulkan decoding candidates');
  if (!['yuv420p', 'yuv420p10le'].includes(video.pix_fmt ?? ''))
    return cpu('Pixel format is outside the Vulkan decoding candidates');
  if (plan.hdr && rt.toneMapBackend !== 'gpu')
    return cpu('HDR Vulkan decoding requires GPU tone mapping on the same device');

  const args = [...plan.args];
  const input = args.indexOf('-i');
  args.splice(
    input,
    0,
    '-init_hw_device',
    `vulkan=decode:${rt.vulkanDevice}`,
    '-filter_hw_device',
    'decode',
    '-hwaccel',
    'vulkan',
    '-hwaccel_device',
    'decode',
    '-hwaccel_output_format',
    'vulkan',
    // Allow decoder references and downstream filters to hold frames at once.
    // FFmpeg 7.1/NVIDIA can otherwise stall after its first downloaded frame.
    '-extra_hw_frames',
    '32',
    `-c:${video.index}`,
    video.codec_name!,
    '-xerror',
  );
  const filterIndex = args.indexOf('-filter:v:0') + 1;
  let filter = args[filterIndex]!;
  if (plan.hdr) {
    // libplacebo can crop the hardware frames directly before tone mapping.
    // Other preceding filters (sidedata/setparams) change metadata only.
    const crop = /^crop=(\d+):(\d+):(\d+):(\d+),/.exec(filter);
    if (crop) {
      filter = filter
        .slice(crop[0].length)
        .replace(
          'libplacebo=',
          `libplacebo=crop_w=${crop[1]}:crop_h=${crop[2]}:crop_x=${crop[3]}:crop_y=${crop[4]}:`,
        );
    }
    filter = filter.replace(
      'format=yuv420p10le,',
      'format=yuv420p10le,hwdownload,format=yuv420p10le,',
    );
  } else {
    // Download without losing bit depth; retain the existing CPU scaling/crop
    // algorithms so opting into decode doesn't change SDR image processing.
    const format = video.pix_fmt === 'yuv420p10le' ? 'p010le' : 'nv12';
    filter = `hwdownload,format=${format},format=${video.pix_fmt},${filter}`;
  }
  args[filterIndex] = filter;
  return {
    ...plan,
    args,
    decoder: 'vulkan',
    softwareArgs: plan.args,
    decodeReason: 'Vulkan candidate; requires a successful source preflight',
  };
}

export function decodeCheckArgs(plan: Plan, media: Media): string[] {
  const input = plan.args.indexOf('-i');
  return [
    ...plan.args.slice(0, input + 2),
    '-map',
    `0:${videoStream(media).index}`,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    plan.args[plan.args.indexOf('-filter:v:0') + 1]!,
    '-frames:v',
    '32',
    '-t',
    '3',
    '-f',
    'null',
    '-',
  ];
}

export async function selectDecodePlan(
  plan: Plan,
  media: Media,
  rt: Runtime,
  signal?: AbortSignal,
): Promise<Plan> {
  const candidate = vulkanCandidate(plan, media, rt);
  if (candidate.decoder === 'cpu') return candidate;
  try {
    // Exercise the actual codec, profile, dimensions, driver and filter graph.
    // A listed Vulkan hwaccel alone does not establish codec compatibility.
    await run(rt.ffmpeg, decodeCheckArgs(candidate, media), {
      signal,
      timeoutMs: 30000,
    });
    return { ...candidate, decodeReason: 'Vulkan source/filter preflight passed' };
  } catch (error) {
    signal?.throwIfAborted();
    return { ...plan, decodeReason: `Vulkan preflight failed; using CPU: ${errorMessage(error)}` };
  }
}
