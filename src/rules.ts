import { basename, extname } from 'node:path';
import { z } from 'zod';
import type { Stream } from './media.ts';

const clauseSchema = z.strictObject({
  property: z.enum([
    'language',
    'title',
    'forced',
    'default',
    'primary',
    'codec',
    'bitrate',
    'channels',
    'filename',
    'width',
    'height',
    'hdr',
  ]),
  operator: z.enum(['==', '!=', '>', '>=', '<', '<=', 'contains']),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
const ruleShape = {
  type: z.enum(['video', 'audio', 'subtitle']),
  description: z.string().max(1000).optional(),
  rules: z.array(clauseSchema).optional(),
};
const selectorSchema = z.strictObject({
  ...ruleShape,
  // Omitted means all matching secondary tracks, as in the original app.
  limit: z.number().int().min(1).max(100).optional(),
});
const trackSelectionSchema = z.strictObject({
  allowSecondary: z.boolean().default(false),
  primary: z.array(selectorSchema).default([]),
  secondary: z.array(selectorSchema).default([]),
});
export const selectionSchema = z.strictObject({
  audio: trackSelectionSchema.optional(),
  subtitle: trackSelectionSchema.optional(),
});
const preset = z.enum([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);
export const encoderRuleSchema = z
  .strictObject({
    ...ruleShape,
    result: z.strictObject({
      codec: z.enum(['libx265', 'copy', 'aac', 'ac3', 'eac3']).optional(),
      crf: z.coerce.number().int().min(0).max(40).optional(),
      preset: preset.optional(),
      crop: z.boolean().optional(),
      size: z
        .string()
        .regex(/^(?:[1-9]\d*:-2|-2:[1-9]\d*|[1-9]\d*:[1-9]\d*)$/)
        .optional(),
      tonemap: z.boolean().optional(),
      bitrate: z
        .string()
        .regex(/^[1-9]\d*(?:k|M)?$/)
        .optional(),
      channels: z.number().int().min(1).max(8).optional(),
    }),
  })
  .superRefine((rule, ctx) => {
    const allowed =
      rule.type === 'video'
        ? ['codec', 'crf', 'preset', 'crop', 'size', 'tonemap']
        : rule.type === 'audio'
          ? ['codec', 'bitrate', 'channels']
          : ['codec'];
    for (const key of Object.keys(rule.result))
      if (!allowed.includes(key))
        ctx.addIssue({
          code: 'custom',
          message: `${key} is not supported for ${rule.type}`,
          path: ['result', key],
        });
    const codecs =
      rule.type === 'video'
        ? ['libx265']
        : rule.type === 'audio'
          ? ['copy', 'aac', 'ac3', 'eac3']
          : ['copy'];
    if (rule.result.codec && !codecs.includes(rule.result.codec))
      ctx.addIssue({
        code: 'custom',
        message: `Unsupported ${rule.type} codec`,
        path: ['result', 'codec'],
      });
  });
export type EncoderSettings = z.infer<typeof encoderRuleSchema>['result'];
export type Selection = z.infer<typeof selectionSchema>;
type Rule = z.infer<typeof selectorSchema>;
export type Facts = Partial<
  Record<z.infer<typeof clauseSchema>['property'], string | number | boolean>
>;
export function facts(stream: Stream, source: string, hdr: boolean, primary: boolean): Facts {
  const tags = Object.fromEntries(
    Object.entries(stream.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const rate = [stream.bit_rate, tags.bps, tags['bps-eng']]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  return {
    language: tags.language?.toLowerCase(),
    title: tags.title,
    forced: stream.disposition?.forced === 1,
    default: stream.disposition?.default === 1,
    primary,
    codec: stream.codec_name,
    bitrate: rate,
    channels: stream.channels,
    width: stream.width,
    height: stream.height,
    hdr,
    filename: basename(source, extname(source)),
  };
}
export function matches(
  rule: Pick<Rule, 'type' | 'rules'>,
  stream: Stream,
  values: Facts,
): boolean {
  return (
    rule.type === stream.codec_type &&
    (rule.rules ?? []).every((clause) => {
      const actual = values[clause.property],
        expected = clause.value;
      // Unknown metadata must never qualify for a copy optimization or language rule.
      if (actual === undefined) return false;
      switch (clause.operator) {
        case '==':
          return actual === expected;
        case '!=':
          return actual !== expected;
        case 'contains':
          return (
            typeof actual === 'string' &&
            actual.toLowerCase().includes(String(expected).toLowerCase())
          );
        case '>':
          return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
        case '>=':
          return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
        case '<':
          return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
        case '<=':
          return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
      }
    })
  );
}
export function encoding(
  rules: z.infer<typeof encoderRuleSchema>[] | undefined,
  stream: Stream,
  values: Facts,
  initial: EncoderSettings,
): EncoderSettings {
  return (rules ?? []).reduce(
    (settings, rule) =>
      matches(rule, stream, values) ? { ...settings, ...rule.result } : settings,
    initial,
  );
}
export interface SelectedTrack {
  stream: Stream;
  primary?: boolean;
}
export function selectTracks(
  streams: Stream[],
  type: 'audio' | 'subtitle',
  selection: Selection | undefined,
  source: string,
): SelectedTrack[] {
  const candidates = streams.filter((s) => s.codec_type === type);
  const spec = selection?.[type];
  if (!spec) return candidates.map((stream) => ({ stream }));
  const primary =
    candidates.find((s) =>
      spec.primary.some((rule) => matches(rule, s, facts(s, source, false, false))),
    ) ?? (type === 'audio' ? candidates[0] : undefined);
  const secondary = new Set<number>();
  if (spec.allowSecondary)
    for (const rule of spec.secondary) {
      const matched = candidates.filter(
        (s) => s !== primary && matches(rule, s, facts(s, source, false, false)),
      );
      for (const s of matched.slice(0, rule.limit)) secondary.add(s.index);
    }
  return [
    ...(primary ? [{ stream: primary, primary: true }] : []),
    ...candidates
      .filter((s) => secondary.has(s.index))
      .map((stream) => ({ stream, primary: false })),
  ];
}
