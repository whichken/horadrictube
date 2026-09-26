import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema, defaultConfig, runtime, type Runtime } from '../src/config.ts';
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'horadrictube-test-'));
  const rt: Runtime = {
    ...runtime(),
    configDir: join(root, 'config'),
    dataDir: join(root, 'data'),
    outDir: join(root, 'data'),
    transcodeDir: join(root, 'scratch'),
    port: 0,
    host: '127.0.0.1',
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
  };
  await Promise.all([rt.configDir, rt.dataDir, rt.transcodeDir].map((path) => mkdir(path)));
  return {
    root,
    rt,
    config: configSchema.parse(structuredClone(defaultConfig)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
