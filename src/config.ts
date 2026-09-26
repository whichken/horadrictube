import { mkdir } from 'node:fs/promises';
import { writeExclusive } from './files.ts';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { encoderRuleSchema, selectionSchema } from './rules.ts';

const pathMappingSchema = z.strictObject({ from: z.string().min(1), to: z.string().min(1) });
export const profileSchema = z.strictObject({
  extension: z.literal('mkv').default('mkv'),
  pathMappings: z.array(pathMappingSchema).optional(),
  fileRenames: z
    .array(
      z.strictObject({
        regex: z
          .string()
          .max(1000)
          .refine((value) => {
            try {
              new RegExp(value);
              return true;
            } catch {
              return false;
            }
          }, 'Invalid rename regex'),
        substitution: z.string().max(1000),
      }),
    )
    .optional(),
  selection: selectionSchema.optional(),
  encoder: z.array(encoderRuleSchema).optional(),
  maxWidth: z.number().int().min(2).max(16384).nullable().default(null),
  description: z.string().min(1).max(1000).default('General purpose HEVC encoding'),
  crf: z.number().int().min(0).max(40).default(24),
  preset: z
    .enum([
      'ultrafast',
      'superfast',
      'veryfast',
      'faster',
      'fast',
      'medium',
      'slow',
      'slower',
      'veryslow',
    ])
    .default('medium'),
  maxHeight: z.number().int().min(144).max(4320).nullable().default(null),
  audio: z.enum(['copy', 'aac']).default('copy'),
  audioBitrate: z.number().int().min(64).max(512).default(192),
  hdr: z.enum(['skip', 'tonemap']).default('skip'),
  delaySeconds: z.number().int().min(0).max(604800).default(0),
});
export const configSchema = z
  .strictObject({
    version: z.literal(2),
    concurrency: z.number().int().min(1).max(16).default(1),
    suffix: z
      .string()
      .regex(/^ [a-zA-Z0-9 _-]*HEVC$/)
      .max(64)
      .default(' HEVC'),
    defaultProfile: z.string().default('default'),
    pathMappings: z.array(pathMappingSchema).default([]),
    skipHevc: z.boolean().default(true),
    minSavingsPercent: z.number().min(0).max(99).default(5),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    retryDelaySeconds: z.number().int().min(1).max(86400).default(60),
    encodeTimeoutSeconds: z.number().int().min(1).max(604800).default(86400),
    maxQueuedJobs: z.number().int().min(1).max(100000).default(10000),
    profiles: z.record(z.string().regex(/^(?!auto$|skip$)[a-zA-Z0-9_-]+$/), profileSchema),
    ai: z
      .strictObject({
        enabled: z.boolean().default(false),
        model: z.string().min(1).default('jev-latest'),
        candidates: z.array(z.string()).min(1).max(254).default(['default']),
        minConfidence: z.number().min(0).max(1).default(0.8),
        timeoutSeconds: z.number().int().min(1).max(60).default(10),
        instructions: z
          .string()
          .min(1)
          .max(4000)
          .default(
            'Choose a profile that balances storage savings and visual quality for this media. Prefer preserving resolution when uncertain.',
          ),
      })
      .default({
        enabled: false,
        model: 'jev-latest',
        candidates: ['default'],
        minConfidence: 0.8,
        timeoutSeconds: 10,
        instructions:
          'Balance storage savings and visual quality. Prefer preserving resolution when uncertain.',
      }),
  })
  .superRefine((c, ctx) => {
    for (const name of [c.defaultProfile, ...c.ai.candidates]) {
      if (!Object.hasOwn(c.profiles, name))
        ctx.addIssue({ code: 'custom', message: `Unknown profile: ${name}`, path: ['profiles'] });
    }
  });
export type Config = z.infer<typeof configSchema>;
export type Profile = z.infer<typeof profileSchema>;
export const defaultConfig = configSchema.parse({
  version: 2,
  profiles: {
    default: {
      description:
        '1080p maximum, without upscaling; balanced quality and storage, retain all audio and subtitles.',
      maxHeight: 1080,
    },
    compact: {
      description: 'A smaller 720p SDR companion for everyday viewing.',
      crf: 26,
      maxHeight: 720,
      audio: 'aac',
      hdr: 'tonemap',
      preset: 'slow',
    },
  },
  ai: { candidates: ['default', 'compact'] },
});

export interface Runtime {
  configDir: string;
  dataDir: string;
  outDir: string;
  transcodeDir: string;
  port: number;
  host: string;
  ffmpeg: string;
  ffprobe: string;
  toneMapBackend: 'cpu' | 'gpu';
  toneMapThreads: number;
  decodeBackend: 'cpu' | 'vulkan';
  vulkanDevice: string;
  vulkanCpuIcd?: string;
  apiKey?: string;
  typesafeKey?: string;
}
export function runtime(env: NodeJS.ProcessEnv = Bun.env): Runtime {
  const dataDir = resolve(env.DATA_DIR || './data');
  return {
    configDir: resolve(env.CONFIG_DIR || './config'),
    dataDir,
    outDir: resolve(env.OUT_DIR || dataDir),
    transcodeDir: resolve(env.TRANSCODE_DIR || './transcode'),
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT || 5000),
    host: env.HOST || '0.0.0.0',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    toneMapBackend: z.enum(['cpu', 'gpu']).parse(env.TONEMAP_BACKEND || 'cpu'),
    decodeBackend: z.enum(['cpu', 'vulkan']).parse(env.DECODE_BACKEND || 'cpu'),
    vulkanDevice: env.VULKAN_DEVICE || '0',
    toneMapThreads: z.coerce
      .number()
      .int()
      .min(1)
      .max(64)
      .parse(env.TONEMAP_THREADS || 2),
    vulkanCpuIcd: env.VULKAN_CPU_ICD || undefined,
    apiKey: env.API_KEY || undefined,
    typesafeKey: env.TYPESAFE_API_KEY || undefined,
  };
}
export async function loadConfig(rt: Runtime, env: NodeJS.ProcessEnv = Bun.env): Promise<Config> {
  await mkdir(rt.configDir, { recursive: true });
  const file = join(rt.configDir, 'config.json');
  try {
    await writeExclusive(file, JSON.stringify(defaultConfig, null, 2) + '\n');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const raw = normalizeConfig(await Bun.file(file).json());
  if (env.CONCURRENCY) raw.concurrency = Number(env.CONCURRENCY);
  return configSchema.parse(raw);
}

// Legacy files are adapted in memory only; never rewrite a server's configuration.
export function normalizeConfig(input: unknown): Record<string, unknown> {
  const root = z.record(z.string(), z.unknown()).parse(input);
  if (root.version !== undefined) {
    // Retire the old encoder thread overrides on load. CPU availability now
    // determines pool sizing; x265 automatically chooses frame threading.
    const { threads: _threads, frameThreads: _frameThreads, ...config } = root;
    return config;
  }
  const legacy = z
    .strictObject({ profiles: z.record(z.string(), z.record(z.string(), z.unknown())) })
    .parse(root);
  if (!legacy.profiles.default) throw new Error('Legacy configuration requires a default profile');
  const profiles = Object.fromEntries(
    Object.entries(legacy.profiles).map(([name, value]) => {
      const { delay, ...profile } = value;
      const minutes = z
        .number()
        .min(0)
        .max(10080)
        .parse(delay ?? 0);
      // v1 joined mapping destinations under DATA_DIR even with a leading slash.
      const pathMappings =
        profile.pathMappings === undefined
          ? undefined
          : z
              .array(pathMappingSchema)
              .parse(profile.pathMappings)
              .map((mapping) => ({ ...mapping, to: mapping.to.replace(/^\/+/, '') || '.' }));
      return [
        name,
        {
          ...profile,
          ...(pathMappings ? { pathMappings } : {}),
          delaySeconds: Math.round(minutes * 60),
        },
      ];
    }),
  );
  return { version: 2, skipHevc: false, profiles };
}

export function usesToneMapping(profile: Profile): boolean {
  return (
    profile.hdr === 'tonemap' ||
    Boolean(profile.encoder?.some((rule) => rule.type === 'video' && rule.result.tonemap))
  );
}
