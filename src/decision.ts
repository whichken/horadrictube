import { z } from 'zod';
import type { Config, Runtime } from './config.ts';
import type { Media } from './media.ts';

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface Decision {
  profile: string;
  via: 'explicit' | 'default' | 'jev' | 'fallback';
  reason: string;
  confidence?: number;
}
export async function decide(
  requested: string,
  media: Media,
  config: Config,
  rt: Runtime,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch,
): Promise<Decision> {
  if (requested !== 'auto')
    return { profile: requested, via: 'explicit', reason: 'Profile selected by request' };
  const fallback = (reason: string): Decision => ({
    profile: config.defaultProfile,
    via: 'fallback',
    reason,
  });
  if (!config.ai.enabled)
    return { profile: config.defaultProfile, via: 'default', reason: 'AI is disabled' };
  if (!rt.typesafeKey) return fallback('TYPESAFE_API_KEY is missing');
  try {
    const criteria = Object.fromEntries(
      config.ai.candidates.map((name) => {
        const { description, crf, preset, maxHeight, maxWidth, audio, audioBitrate, hdr } =
          config.profiles[name]!;
        return [name, { description, crf, preset, maxHeight, maxWidth, audio, audioBitrate, hdr }];
      }),
    );
    const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rt.typesafeKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([
        AbortSignal.timeout(config.ai.timeoutSeconds * 1000),
        ...(signal ? [signal] : []),
      ]),
      body: JSON.stringify({
        model: config.ai.model,
        // Never send paths, filenames, titles, webhook bodies, or media bytes.
        state: {
          streams: media.streams.map(
            ({
              codec_type,
              codec_name,
              width,
              height,
              channels,
              color_transfer,
              color_primaries,
            }) => ({
              codec_type,
              codec_name,
              width,
              height,
              channels,
              color_transfer,
              color_primaries,
            }),
          ),
          duration: media.format.duration,
        },
        questions: {
          profile: {
            type: 'choice',
            instructions: config.ai.instructions,
            criteria: {
              ...criteria,
              __fallback:
                'Insufficient information or no suitable profile; use the configured default.',
            },
          },
        },
      }),
    });
    if (!response.ok) return fallback(`TypeSafe returned HTTP ${response.status}`);
    const result = z
      .object({
        answers: z.object({
          profile: z.object({
            type: z.literal('choice'),
            choice: z.string(),
            confidence: z.number().min(0).max(1),
          }),
        }),
      })
      .parse(await response.json());
    const answer = result.answers.profile;
    if (
      !config.ai.candidates.includes(answer.choice) ||
      answer.confidence < config.ai.minConfidence
    )
      return fallback('Uncertain or unsupported profile selection');
    return {
      profile: answer.choice,
      via: 'jev',
      confidence: answer.confidence,
      reason: 'Jev selected an allowed profile',
    };
  } catch {
    signal?.throwIfAborted();
    return fallback('TypeSafe request failed, timed out, or returned an invalid response');
  }
}
