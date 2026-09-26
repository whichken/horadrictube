import { test, expect } from 'bun:test';
import { availableParallelism } from 'node:os';
import { configSchema, defaultConfig, normalizeConfig } from '../../src/config.ts';
import { makePlan } from '../../src/media.ts';

const media = {
  streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
  format: { duration: '1' },
};
test('queued encodes leave both pool and frame threading automatic', () => {
  const plan = makePlan(media, defaultConfig.profiles.default!, defaultConfig, 'in', 'out');
  expect(plan.args).not.toContain('-threads:v:0');
  expect(plan.args[plan.args.indexOf('-x265-params') + 1]).toBe(`pools=${availableParallelism()}`);
  expect(plan.args.join(' ')).not.toContain('frame-threads');
  expect(defaultConfig).not.toHaveProperty('threads');
  expect(defaultConfig).not.toHaveProperty('frameThreads');
});
test('loading old version 2 configs removes obsolete thread caps without rewriting input', () => {
  const input = { ...defaultConfig, threads: 2, frameThreads: 1 };
  const config = configSchema.parse(normalizeConfig(input));
  expect(config).not.toHaveProperty('threads');
  expect(config).not.toHaveProperty('frameThreads');
  expect(input.threads).toBe(2);
  expect(input.frameThreads).toBe(1);
  expect(() => configSchema.parse(normalizeConfig({ ...input, typo: true }))).toThrow();
});
