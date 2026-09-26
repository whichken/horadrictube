import type { Config, Profile, Runtime } from './config.ts';
import { makePlan, videoStream, type Crop, type Media } from './media.ts';
import { run } from './process.ts';
import { log } from './log.ts';
import { selectDecodePlan } from './decode.ts';

// Sample three points and use the enclosing rectangle of every detected active
// area. This favors retaining picture over aggressively removing black bars.
export async function detectCrop(
  media: Media,
  source: string,
  rt: Runtime,
  signal?: AbortSignal,
): Promise<Crop | undefined> {
  const video = videoStream(media);
  if (!video.width || !video.height) return undefined;
  const duration = Number(media.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const seconds = Math.min(10, duration);
  const starts = [
    ...new Set(
      [0.1, 0.5, 0.9].map((fraction) =>
        Math.max(0, Math.min(duration * fraction, duration - seconds)),
      ),
    ),
  ];
  const crops: Crop[] = [];
  for (const start of starts) {
    let pending = '',
      count = 0;
    const line = (text: string) => {
      for (const match of text.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) {
        const [width, height, x, y] = match.slice(1).map(Number) as [
          number,
          number,
          number,
          number,
        ];
        if (width >= 2 && height >= 2 && x + width <= video.width! && y + height <= video.height!) {
          crops.push({ width, height, x, y });
          count++;
        }
      }
    };
    await run(
      rt.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'info',
        '-ss',
        String(start),
        '-i',
        source,
        '-map',
        `0:${video.index}`,
        '-an',
        '-sn',
        '-t',
        String(seconds),
        '-vf',
        'cropdetect=limit=0.094117647:round=2:reset=0',
        '-f',
        'null',
        '-',
      ],
      {
        signal,
        timeoutMs: 120000,
        onStderr(text) {
          pending += text;
          const lines = pending.split(/[\r\n]/);
          pending = lines.pop()!;
          lines.forEach(line);
        },
      },
    );
    line(pending);
    if (!count) return undefined;
  }
  const x = Math.floor(Math.min(...crops.map((c) => c.x)) / 2) * 2,
    y = Math.floor(Math.min(...crops.map((c) => c.y)) / 2) * 2;
  const right = Math.min(
    video.width,
    Math.ceil(Math.max(...crops.map((c) => c.x + c.width)) / 2) * 2,
  );
  const bottom = Math.min(
    video.height,
    Math.ceil(Math.max(...crops.map((c) => c.y + c.height)) / 2) * 2,
  );
  return { x, y, width: right - x, height: bottom - y };
}
export async function createPlan(
  media: Media,
  profile: Profile,
  config: Config,
  source: string,
  temp: string,
  rt: Runtime,
  signal?: AbortSignal,
) {
  // Run skip/metadata checks before spending time decoding crop samples.
  const initial = makePlan(media, profile, config, source, temp, rt.toneMapBackend);
  if (!initial.needsCrop) return selectDecodePlan(initial, media, rt, signal);
  let crop: Crop | undefined;
  try {
    crop = await detectCrop(media, source, rt, signal);
  } catch (error) {
    signal?.throwIfAborted();
    log('crop.failed', { source, error: String(error) });
  }
  if (!crop) log('crop.undetected', { source, message: 'Keeping the full frame' });
  else log('crop.detected', { source, ...crop });
  const plan = makePlan(media, profile, config, source, temp, rt.toneMapBackend, crop);
  plan.needsCrop = false;
  return selectDecodePlan(plan, media, rt, signal);
}
