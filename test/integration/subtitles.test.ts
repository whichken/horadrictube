import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fixture } from '../helpers.ts';
import { makePlan, probe, validateOutput } from '../../src/media.ts';
import { run } from '../../src/process.ts';

test('real MP4 timed text becomes SRT in MKV with text, timing and track metadata preserved', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'source.mp4');
    const output = join(f.root, 'output.mkv');
    const subs = join(f.root, 'input.srt');
    const text =
      '1\n00:00:00,250 --> 00:00:01,250\nHello, café!\nSecond line.\n\n2\n00:00:02,000 --> 00:00:03,250\nAnother cue.\n\n';
    await Bun.write(subs, text);
    await run(
      f.rt.ffmpeg,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=12:duration=4',
        '-i',
        subs,
        '-map',
        '0:v',
        '-map',
        '1:s',
        '-map',
        '1:s',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '0',
        '-c:s',
        'mov_text',
        '-metadata:s:s:0',
        'language=eng',
        '-metadata:s:s:1',
        'language=fra',
        '-disposition:s:0',
        'default+forced',
        '-disposition:s:1',
        'hearing_impaired',
        source,
      ],
      { timeoutMs: 15000 },
    );
    const media = await probe(source, f.rt);
    expect(
      media.streams.filter((s) => s.codec_type === 'subtitle').map((s) => s.codec_name),
    ).toEqual(['mov_text', 'mov_text']);
    const profile = { ...f.config.profiles.default!, preset: 'ultrafast' as const };
    const plan = makePlan(media, profile, f.config, source, output);
    await run(f.rt.ffmpeg, plan.args, { timeoutMs: 30000 });
    const result = await probe(output, f.rt);
    validateOutput(media, result, plan);
    const before = media.streams.filter((s) => s.codec_type === 'subtitle');
    const after = result.streams.filter((s) => s.codec_type === 'subtitle');
    expect(after.map((s) => s.codec_name)).toEqual(['subrip', 'subrip']);
    expect(after.map((s) => s.tags?.language)).toEqual(['eng', 'fra']);
    for (let i = 0; i < 2; i++) {
      for (const flag of ['default', 'forced', 'hearing_impaired'])
        expect(after[i]!.disposition?.[flag]).toBe(before[i]!.disposition?.[flag]);
      const extracted = await run(
        f.rt.ffmpeg,
        ['-v', 'error', '-i', output, '-map', `0:s:${i}`, '-c:s', 'srt', '-f', 'srt', '-'],
        { timeoutMs: 10000 },
      );
      expect(extracted.replace(/\r\n/g, '\n')).toBe(text);
    }
  } finally {
    await f.cleanup();
  }
}, 60000);
