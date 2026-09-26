import { z } from 'zod';
import { availableParallelism } from 'node:os';
import type { Config, Profile, Runtime } from './config.ts';
import { run } from './process.ts';
import { SkipError } from './log.ts';
import { encoding, facts, selectTracks, type EncoderSettings } from './rules.ts';
import { splineFilter, stripHdrMetadata, toneMappingDeviceArgs } from './tonemap.ts';

const streamSchema = z.object({
  index: z.number().int().nonnegative(),
  codec_type: z.string(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  pix_fmt: z.string().optional(),
  color_transfer: z.string().optional(),
  color_primaries: z.string().optional(),
  color_space: z.string().optional(),
  color_range: z.string().optional(),
  channels: z.number().optional(),
  bit_rate: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  disposition: z.record(z.string(), z.number()).optional(),
  side_data_list: z.array(z.record(z.string(), z.unknown())).optional(),
});
export const probeSchema = z.object({
  streams: z.array(streamSchema),
  format: z.object({ duration: z.string().optional(), size: z.string().optional() }),
  doviMetadataVerified: z.boolean().optional(),
});
export type Media = z.infer<typeof probeSchema>;
export type Stream = z.infer<typeof streamSchema>;
export async function probe(path: string, rt: Runtime, signal?: AbortSignal): Promise<Media> {
  const media = probeSchema.parse(
    JSON.parse(
      await run(rt.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], {
        signal,
        timeoutMs: 60000,
      }),
    ),
  );
  const video = videoStream(media);
  if (video.side_data_list?.some((s) => s.dv_profile === 5)) {
    // Profile 5 can have unspecified ordinary color tags. It is only safe to
    // interpret those pixels when the decoder supplies parsed Dolby metadata.
    const frames = z
      .object({
        frames: z.array(
          z.object({
            side_data_list: z.array(z.object({ side_data_type: z.string() })).optional(),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await run(
            rt.ffprobe,
            [
              '-v',
              'error',
              '-select_streams',
              String(video.index),
              '-read_intervals',
              '%+#32',
              '-show_frames',
              '-show_entries',
              'frame=side_data_list:frame_side_data=side_data_type',
              '-of',
              'json',
              path,
            ],
            { signal, timeoutMs: 60000 },
          ),
        ),
      );
    media.doviMetadataVerified =
      frames.frames.length > 0 &&
      frames.frames.every((frame) =>
        frame.side_data_list?.some((side) => side.side_data_type === 'Dolby Vision Metadata'),
      );
  }
  return media;
}

export type DolbyMode = 'none' | 'reshape' | 'hdr10-base' | 'hlg-base';
export function dolbyMode(video: Stream): DolbyMode {
  const records =
    video.side_data_list?.filter((s) => /dovi|dolby/i.test(String(s.side_data_type))) ?? [];
  if (!records.length) return 'none';
  const record = records.find((s) => typeof s.dv_profile === 'number');
  if (!record || video.codec_name !== 'hevc' || record.bl_present_flag !== 1)
    throw new SkipError('Dolby Vision configuration is missing or unsupported');
  const compatibility = record.dv_bl_signal_compatibility_id;
  if (
    record.dv_profile === 5 &&
    record.el_present_flag === 0 &&
    record.rpu_present_flag === 1 &&
    compatibility === 0
  )
    return 'reshape';
  // For SDR companions, use the standards-compatible base rather than trying
  // to reconstruct a Profile 7 enhancement layer or preserve Dolby rendering.
  if (record.dv_profile === 7 && compatibility === 6) return 'hdr10-base';
  if (record.dv_profile === 8 && record.el_present_flag === 0) {
    if (compatibility === 1) return 'hdr10-base';
    if (compatibility === 4) return 'hlg-base';
  }
  throw new SkipError(
    `Unsupported Dolby Vision profile/base compatibility: ${record.dv_profile}/${compatibility}`,
  );
}
export function videoStream(media: Media): Stream {
  const videos = media.streams.filter(
    (s) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  if (videos.length !== 1) throw new SkipError(`Expected one video stream; found ${videos.length}`);
  return videos[0]!;
}
export function isHdr(video: Stream): boolean {
  return (
    ['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '') ||
    video.color_primaries === 'bt2020' ||
    video.color_space?.startsWith('bt2020') === true ||
    Boolean(
      video.side_data_list?.some((s) =>
        /dovi|dolby|mastering display|content light/i.test(String(s.side_data_type)),
      ),
    )
  );
}
export interface Plan {
  args: string[];
  expected: Stream[];
  height?: number;
  width?: number;
  needsCrop: boolean;
  audio: { codec: string; channels?: number; primary?: boolean }[];
  subtitles: { primary?: boolean; forced: boolean }[];
  hdr: boolean;
  dolbyVision: DolbyMode;
}
export function makePlan(
  media: Media,
  profile: Profile,
  config: Config,
  source: string,
  temp: string,
  backend: Runtime['toneMapBackend'] = 'cpu',
  crop?: Crop,
): Plan {
  const video = videoStream(media);
  if (config.skipHevc && video.codec_name === 'hevc')
    throw new SkipError('Source video is already HEVC');
  const hdr = isHdr(video);
  const settings = videoSettings(media, profile, source);
  if (hdr && !settings.tonemap)
    throw new SkipError('HDR source: choose a tone-mapping profile explicitly');
  const dolbyVision = dolbyMode(video);
  if (dolbyVision === 'reshape' && !media.doviMetadataVerified)
    throw new SkipError(
      'Dolby Vision Profile 5 is missing decoded RPU metadata; refusing conversion with incorrect colors',
    );
  if (
    hdr &&
    dolbyVision === 'none' &&
    !['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '')
  )
    throw new SkipError('HDR transfer characteristics are missing or unsupported');
  const audio = selectTracks(media.streams, 'audio', profile.selection, source);
  const subtitles = selectTracks(media.streams, 'subtitle', profile.selection, source);
  const expected = [
    video,
    ...audio.map((t) => t.stream),
    ...subtitles.map((t) => t.stream),
    ...media.streams.filter((s) => s.codec_type === 'attachment'),
  ];
  const audioSettings = audio.map(({ stream, primary }) =>
    encoding(
      profile.encoder,
      stream,
      facts(stream, source, hdr, primary ?? stream.disposition?.default === 1),
      {
        codec: profile.audio,
        ...(profile.audio === 'aac' ? { bitrate: `${profile.audioBitrate}k`, channels: 2 } : {}),
      },
    ),
  );
  const args = [
    '-hide_banner',
    '-nostdin',
    '-v',
    'warning',
    '-n',
    ...(hdr ? toneMappingDeviceArgs(backend) : []),
    ...(dolbyVision === 'reshape' ? ['-xerror', '-err_detect', 'explode'] : []),
    '-i',
    source,
  ];
  for (const stream of expected) args.push('-map', `0:${stream.index}`);
  args.push(
    '-map_metadata',
    '0',
    '-map_chapters',
    '0',
    '-c',
    'copy',
    '-c:v:0',
    'libx265',
    '-crf:v:0',
    String(settings.crf),
    '-preset:v:0',
    settings.preset!,
    // x265's native NUMA detection can produce no pool inside Docker. Use
    // the process's available CPUs instead; keep frame-thread selection auto.
    '-x265-params',
    `pools=${availableParallelism()}`,
    '-pix_fmt:v:0',
    'yuv420p10le',
  );
  const filters: string[] = [];
  if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  const dimensions = outputDimensions(video, profile, settings, crop);
  if (hdr) {
    if (!dimensions.width || !dimensions.height)
      throw new Error('HDR source dimensions are missing');
    const baseLayer = dolbyVision === 'hdr10-base' || dolbyVision === 'hlg-base';
    if (baseLayer)
      filters.push(
        'sidedata=mode=delete:type=DOVI_RPU_BUFFER',
        'sidedata=mode=delete:type=DOVI_METADATA',
        `setparams=range=limited:color_primaries=bt2020:color_trc=${dolbyVision === 'hlg-base' ? 'arib-std-b67' : 'smpte2084'}:colorspace=bt2020nc`,
      );
    filters.push(splineFilter(dimensions.width, dimensions.height, !baseLayer), stripHdrMetadata);
  } else if (
    dimensions.width &&
    dimensions.height &&
    (dimensions.width !== Math.ceil((crop?.width ?? video.width ?? dimensions.width) / 2) * 2 ||
      dimensions.height !== Math.ceil((crop?.height ?? video.height ?? dimensions.height) / 2) * 2)
  )
    filters.push(`scale=${dimensions.width}:${dimensions.height}:flags=lanczos`);
  // x265 requires even dimensions. Pad instead of stretching odd-sized sources.
  filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  args.push('-filter:v:0', filters.join(','));
  if (hdr)
    args.push(
      '-color_primaries:v:0',
      'bt709',
      '-color_trc:v:0',
      'bt709',
      '-colorspace:v:0',
      'bt709',
      '-color_range:v:0',
      'tv',
    );
  for (const [i, { stream, primary }] of audio.entries()) {
    const settings = audioSettings[i]!;
    args.push(`-c:a:${i}`, settings.codec!);
    if (settings.codec !== 'copy') {
      if (settings.bitrate) args.push(`-b:a:${i}`, settings.bitrate);
      if (settings.channels) args.push(`-ac:a:${i}`, String(settings.channels));
    }
    if (primary !== undefined) args.push(`-disposition:a:${i}`, disposition(stream, primary));
  }
  for (const [i, { stream, primary }] of subtitles.entries())
    if (primary !== undefined) args.push(`-disposition:s:${i}`, disposition(stream, primary));
  args.push(
    '-max_muxing_queue_size',
    '4096',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'matroska',
    temp,
  );
  return {
    args,
    expected,
    ...dimensions,
    needsCrop: Boolean(settings.crop && !crop),
    audio: audio.map(({ stream, primary }, i) => ({
      codec: audioSettings[i]!.codec === 'copy' ? stream.codec_name! : audioSettings[i]!.codec!,
      channels:
        audioSettings[i]!.codec === 'copy'
          ? stream.channels
          : (audioSettings[i]!.channels ?? stream.channels),
      primary,
    })),
    subtitles: subtitles.map(({ stream, primary }) => ({
      primary,
      forced: stream.disposition?.forced === 1,
    })),
    hdr,
    dolbyVision,
  };
}
export function validateOutput(source: Media, output: Media, plan: Plan): void {
  const video = videoStream(output);
  if (plan.hdr && video.side_data_list?.some((s) => /dovi|dolby/i.test(String(s.side_data_type))))
    throw new Error('SDR output still advertises Dolby Vision metadata');
  if (
    plan.hdr &&
    (video.color_transfer !== 'bt709' ||
      video.color_primaries !== 'bt709' ||
      video.color_space !== 'bt709' ||
      video.color_range !== 'tv')
  )
    throw new Error('Tone-mapped output lacks SDR color metadata');
  if (video.codec_name !== 'hevc') throw new Error('Output is not HEVC');
  if (plan.height && (!video.height || Math.abs(video.height - plan.height) > 1))
    throw new Error('Output has unexpected dimensions');
  if (plan.width && video.width !== plan.width) throw new Error('Output has unexpected width');
  for (const [i, expected] of plan.audio.entries()) {
    const track = output.streams.filter((s) => s.codec_type === 'audio')[i];
    if (!track) throw new Error('Output lost audio streams');
    if (
      track.codec_name !== expected.codec ||
      (expected.channels && track.channels !== expected.channels)
    )
      throw new Error('Output audio does not match the planned codec/channels');
    if (expected.primary !== undefined && Boolean(track.disposition?.default) !== expected.primary)
      throw new Error('Output audio default disposition does not match selection');
  }
  for (const [i, expected] of plan.subtitles.entries()) {
    const track = output.streams.filter((s) => s.codec_type === 'subtitle')[i];
    if (
      !track ||
      Boolean(track.disposition?.forced) !== expected.forced ||
      (expected.primary !== undefined && Boolean(track.disposition?.default) !== expected.primary)
    )
      throw new Error('Output subtitle dispositions do not match selection');
  }
  const before = Number(source.format.duration),
    after = Number(output.format.duration);
  if (
    !Number.isFinite(before) ||
    before <= 0 ||
    !Number.isFinite(after) ||
    after <= 0 ||
    Math.abs(before - after) > Math.max(2, before * 0.01)
  )
    throw new Error('Output duration does not match source');
  for (const type of ['audio', 'subtitle', 'attachment']) {
    if (
      plan.expected.filter((s) => s.codec_type === type).length !==
      output.streams.filter((s) => s.codec_type === type).length
    )
      throw new Error(`Output lost ${type} streams`);
  }
}

export interface Crop {
  width: number;
  height: number;
  x: number;
  y: number;
}
export function videoSettings(media: Media, profile: Profile, source: string): EncoderSettings {
  const video = videoStream(media);
  return encoding(profile.encoder, video, facts(video, source, isHdr(video), true), {
    codec: 'libx265',
    crf: profile.crf,
    preset: profile.preset,
    tonemap: profile.hdr === 'tonemap',
  });
}
function outputDimensions(
  video: Stream,
  profile: Profile,
  settings: EncoderSettings,
  crop?: Crop,
): { width?: number; height?: number } {
  let width = crop?.width ?? video.width,
    height = crop?.height ?? video.height;
  if (!width || !height) return {};
  if (settings.size) {
    const [w, h] = settings.size.split(':').map(Number) as [number, number];
    if (w === -2) {
      width = Math.max(2, Math.round((width * h) / height / 2) * 2);
      height = h;
    } else if (h === -2) {
      height = Math.max(2, Math.round((height * w) / width / 2) * 2);
      width = w;
    } else {
      width = w;
      height = h;
    }
  }
  const ratio = Math.min(
    1,
    (profile.maxWidth ?? width) / width,
    (profile.maxHeight ?? height) / height,
  );
  return {
    width: ratio < 1 ? Math.max(2, Math.round((width * ratio) / 2) * 2) : Math.ceil(width / 2) * 2,
    height:
      ratio < 1 ? Math.max(2, Math.round((height * ratio) / 2) * 2) : Math.ceil(height / 2) * 2,
  };
}
function disposition(stream: Stream, primary: boolean): string {
  const flags = Object.entries(stream.disposition ?? {})
    .filter(([name, value]) => name !== 'default' && value === 1)
    .map(([name]) => name);
  if (primary) flags.unshift('default');
  return flags.join('+') || '0';
}
