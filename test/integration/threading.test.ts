import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import { fixture } from '../helpers.ts';
import { run } from '../../src/process.ts';
import { probe, makePlan, validateOutput } from '../../src/media.ts';

test('real x265 uses available CPUs for its pool and automatically selects frame threading', async () => {
  const f = await fixture();
  try {
    f.config.profiles.default!.preset = 'ultrafast';
    const source = join(f.root, 'source.mkv'),
      output = join(f.root, 'output.mkv');
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1920x1080:rate=24',
        '-frames:v',
        '12',
        '-c:v',
        'ffv1',
        source,
      ],
      { timeoutMs: 15000 },
    );
    const media = await probe(source, f.rt);
    const plan = makePlan(media, f.config.profiles.default!, f.config, source, output);
    // x265's thread initialization diagnostics follow FFmpeg's log level.
    plan.args[plan.args.indexOf('-v') + 1] = 'info';
    let diagnostics = '';
    await run('ffmpeg', plan.args, {
      timeoutMs: 30000,
      onStderr(text) {
        diagnostics = (diagnostics + text).slice(-32000);
      },
    });
    const workers = /Thread pool .*using (\d+) threads/.exec(diagnostics);
    expect(workers).not.toBeNull();
    expect(Number(workers![1])).toBeGreaterThan(0);
    expect(plan.args[plan.args.indexOf('-x265-params') + 1]).toBe(
      `pools=${availableParallelism()}`,
    );
    const frames = /frame threads\s*\/\s*pool features\s*:\s*(\d+)/i.exec(diagnostics);
    expect(frames).not.toBeNull();
    // Auto may legitimately choose one frame thread on a single-CPU machine.
    expect(Number(frames![1])).toBeGreaterThan(0);
    validateOutput(media, await probe(output, f.rt), plan);
  } finally {
    await f.cleanup();
  }
}, 45000);
