import { test, expect, afterEach } from 'bun:test';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { mkdir, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchema, loadConfig, runtime } from '../../src/config.ts';
import { collectFiles, mapPath, sourcePath, outputPath, prepareOutput } from '../../src/paths.ts';
import { fixture } from '../helpers.ts';

test('config defaults to 1080p, validates profiles and adapts valid legacy config without modifying it', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const config = await loadConfig(f.rt, {});
  expect(config.profiles.default!.maxHeight).toBe(1080);
  expect(config.concurrency).toBe(1);
  expect(() => configSchema.parse({ ...config, typo: true })).toThrow();
  expect(() => configSchema.parse({ ...config, concurrency: 0 })).toThrow();
  expect(() => configSchema.parse({ ...config, defaultProfile: 'missing' })).toThrow();
  expect(() => configSchema.parse({ ...config, suffix: '/../evil' })).toThrow();
  expect(() => runtime({ PORT: 'junk' })).toThrow();
  expect(runtime({}).toneMapBackend).toBe('cpu');
  expect(runtime({ TONEMAP_BACKEND: 'gpu', TONEMAP_THREADS: '4' }).toneMapThreads).toBe(4);
  expect(() => runtime({ TONEMAP_BACKEND: 'auto' })).toThrow();
  expect(() => runtime({ TONEMAP_THREADS: '0' })).toThrow();
  const legacy = JSON.stringify({
    profiles: {
      default: {
        extension: 'mkv',
        delay: 2,
        encoder: [{ type: 'video', result: { codec: 'libx265', crf: '23', preset: 'slow' } }],
      },
    },
  });
  await Bun.write(join(f.rt.configDir, 'config.json'), legacy);
  const migrated = await loadConfig(f.rt, {});
  expect(migrated.profiles.default!.delaySeconds).toBe(120);
  expect(migrated.skipHevc).toBe(false);
  expect(await Bun.file(join(f.rt.configDir, 'config.json')).text()).toBe(legacy);
  await Bun.write(join(f.rt.configDir, 'config.json'), '{"profiles":{}}');
  await expect(loadConfig(f.rt, {})).rejects.toThrow(/Legacy/);
  expect(await Bun.file(join(f.rt.configDir, 'config.json')).text()).toBe('{"profiles":{}}');
});

test('path mapping uses the longest component prefix once and contains all paths', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.config.pathMappings = [
    { from: '/media', to: '.' },
    { from: '/media/tv', to: 'TV' },
  ];
  expect(mapPath('/media/tv/series/a.mkv', f.config, f.rt)).toBe(
    join(f.rt.dataDir, 'TV/series/a.mkv'),
  );
  expect(() => mapPath('/media-other/a.mkv', f.config, f.rt)).toThrow(/outside/);
  expect(() => mapPath('../../secret.mp4', f.config, f.rt)).toThrow(/outside/);
  expect(() => mapPath('/media/../../secret.mp4', f.config, f.rt)).toThrow(/outside/);
  expect(outputPath(join(f.rt.dataDir, 'TV/a.mp4'), f.config, f.rt)).toBe(
    join(f.rt.dataDir, 'TV/a HEVC.mkv'),
  );
});

test('source and destination symlinks cannot escape their roots; recursive scans ignore companions', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await Bun.write(join(outside, 'secret.mkv'), 'secret');
  await symlink(outside, join(f.rt.dataDir, 'escape'));
  await expect(sourcePath(join(f.rt.dataDir, 'escape/secret.mkv'), f.rt)).rejects.toThrow(
    /escapes/,
  );
  await expect(prepareOutput(join(f.rt.outDir, 'escape/new/file.mkv'), f.rt)).rejects.toThrow(
    /escapes/,
  );
  await expect(access(join(outside, 'new'))).rejects.toThrow();
  await mkdir(join(f.rt.dataDir, 'nested'));
  await Bun.write(join(f.rt.dataDir, 'nested/a.mp4'), 'media');
  await Bun.write(join(f.rt.dataDir, 'nested/a HEVC.mkv'), 'media');
  await Bun.write(join(f.rt.dataDir, 'readme.txt'), 'text');
  expect(await collectFiles('.', f.config, f.rt)).toEqual([join(f.rt.dataDir, 'nested/a.mp4')]);
});
