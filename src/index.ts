import { usesToneMapping } from './config.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runtime, loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { createApp } from './server.ts';
import { run } from './process.ts';
import { errorMessage, log } from './log.ts';
import { checkToneMapping } from './tonemap.ts';

async function main(): Promise<void> {
  const rt = runtime();
  if (Bun.argv.includes('--check-media')) {
    await run(rt.ffprobe, ['-version'], { timeoutMs: 10000 });
    log('media.check.passed', await checkToneMapping(rt));
    return;
  }
  const config = await loadConfig(rt);
  await Promise.all(
    [rt.dataDir, rt.outDir, rt.transcodeDir].map((path) => mkdir(path, { recursive: true })),
  );
  await run(rt.ffprobe, ['-version'], { timeoutMs: 10000 });
  const encoders = await run(rt.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10000 });
  if (!encoders.includes('libx265')) throw new Error('ffmpeg must include the libx265 encoder');
  if (Object.values(config.profiles).some(usesToneMapping))
    log('tonemap.ready', await checkToneMapping(rt));
  const store = new Store(join(rt.configDir, 'jobs.sqlite'));
  const worker = new Worker(store, config, rt);
  let app: ReturnType<typeof createApp>;
  try {
    app = createApp(config, rt, store);
  } catch (error) {
    store.close();
    throw error;
  }
  worker.start();
  log('service.started', {
    runtime: `bun ${Bun.version}`,
    port: app.server.port,
    concurrency: config.concurrency,
    defaultProfile: config.defaultProfile,
    ai: config.ai.enabled,
    authentication: Boolean(rt.apiKey),
    toneMapBackend: rt.toneMapBackend,
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log('service.stopping');
    void (async () => {
      const closed = app.stop();
      const timeout = setTimeout(() => {
        void app.server.stop(true);
      }, 10000);
      await worker.stop();
      await closed;
      clearTimeout(timeout);
      store.close();
      log('service.stopped');
    })().catch((error) => {
      log('shutdown.error', { error: errorMessage(error) });
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((error) => {
  log('startup.error', { error: errorMessage(error) });
  process.exitCode = 1;
});
