import { link, lstat, mkdir, open, stat } from 'node:fs/promises';
import { writeExclusive, removeFile } from './files.ts';
import { dirname, join } from 'node:path';
import type { Config, Runtime } from './config.ts';
import { decide } from './decision.ts';
import { errorMessage, log, SkipError } from './log.ts';
import { isGenerated, isVideo, outputPath, prepareOutput, sourcePath } from './paths.ts';
import { probe, validateOutput } from './media.ts';
import { createPlan } from './planner.ts';
import { toneMappingEnvironment } from './tonemap.ts';
import { run } from './process.ts';
import { EncodingStallError } from './progress.ts';
import { Store, type Job } from './store.ts';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export async function publish(
  temp: string,
  output: string,
  stage: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await writeExclusive(stage, Bun.file(temp));
  signal.throwIfAborted();
  // Both names are on the destination filesystem. link is atomic and refuses to replace any existing entry.
  await link(stage, output);
  const dir = await open(dirname(output), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export class Worker {
  private controller = new AbortController();
  private active = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  constructor(
    private store: Store,
    private config: Config,
    private rt: Runtime,
  ) {}
  start(): void {
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }
  tick(): void {
    if (this.controller.signal.aborted) return;
    try {
      while (this.active.size < this.config.concurrency) {
        const job = this.store.claim();
        if (!job) break;
        const task = this.process(job)
          .catch((error) => log('worker.error', { id: job.id, error: errorMessage(error) }))
          .finally(() => {
            this.active.delete(task);
          });
        this.active.add(task);
      }
    } catch (error) {
      log('queue.error', { error: errorMessage(error) });
    }
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled(this.active);
  }
  private async process(job: Job): Promise<void> {
    const { config, rt, store } = this;
    const signal = this.controller.signal;
    const temp = join(rt.transcodeDir, `horadrictube-${job.id}.mkv`);
    let stage: string | undefined;
    let outputPrepared = false;
    try {
      log('job.started', { id: job.id, source: job.source, attempt: job.attempts });
      if (!isVideo(job.source) || isGenerated(job.source, config.suffix))
        throw new SkipError('Unsupported file or generated companion');
      const source = await sourcePath(job.source, rt);
      const before = await stat(source);
      if (!before.isFile()) throw new SkipError('Source is not a regular file');
      const media = await probe(source, rt, signal);
      const decision = await decide(job.profile, media, config, rt, signal);
      store.patch(job.id, { decision: JSON.stringify(decision) });
      const profile = config.profiles[decision.profile];
      if (!profile) throw new Error(`Profile no longer exists: ${decision.profile}`);
      const output = outputPath(job.source, config, rt, profile);
      stage = join(dirname(output), `.horadrictube-${job.id}.partial`);
      await prepareOutput(output, rt);
      outputPrepared = true;
      await removeFile(stage);
      store.patch(job.id, { output });
      if (await exists(output))
        throw new SkipError('Destination already exists; it was left untouched');
      const plan = await createPlan(media, profile, config, source, temp, rt, signal);
      log('job.decoder', { id: job.id, decoder: plan.decoder, reason: plan.decodeReason });
      if (plan.dolbyVision !== 'none')
        log('job.dolbyvision', { id: job.id, mode: plan.dolbyVision });
      await mkdir(rt.transcodeDir, { recursive: true });
      await removeFile(temp);
      const duration = Number(media.format.duration);
      const deadline = Date.now() + config.encodeTimeoutSeconds * 1000;
      const encode = async (args: string[], decoder: 'cpu' | 'vulkan') => {
        let lastProgress = 0;
        try {
          await run(rt.ffmpeg, args, {
            env: plan.vulkanFiltering ? await toneMappingEnvironment(rt) : undefined,
            signal,
            timeoutMs: Math.max(1, deadline - Date.now()),
            encodingProgress: {
              onAdvance: (outputTimeUs) => {
                if (Date.now() - lastProgress >= 1000 && duration > 0) {
                  const progress = (outputTimeUs / 1000000 / duration) * 100;
                  if (Number.isFinite(progress))
                    store.patch(job.id, { progress: Math.max(0, Math.min(99, progress)) });
                  lastProgress = Date.now();
                }
              },
              onWarning: (outputTimeUs) => {
                log('job.encode.warning', {
                  id: job.id,
                  decoder,
                  message: 'Output timestamp has not advanced for 2 minutes',
                  outputTimeSeconds: outputTimeUs / 1000000,
                });
              },
            },
          });
        } catch (error) {
          if (error instanceof EncodingStallError)
            log('job.encode.stalled', { id: job.id, decoder, error: error.message });
          throw error;
        }
        const encoded = await probe(temp, rt, signal);
        validateOutput(media, encoded, plan);
      };
      try {
        await encode(plan.args, plan.decoder);
      } catch (error) {
        signal.throwIfAborted();
        if (!plan.softwareArgs || Date.now() >= deadline) throw error;
        log('job.decoder.fallback', { id: job.id, error: errorMessage(error) });
        await removeFile(temp);
        store.patch(job.id, { progress: 0, message: 'Vulkan failed; restarted with CPU decoding' });
        await encode(plan.softwareArgs, 'cpu');
      }
      // Fully decode audio/video before publication; ffprobe alone cannot detect a truncated/corrupt packet stream.
      await run(
        rt.ffmpeg,
        [
          '-hide_banner',
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-i',
          temp,
          '-map',
          '0:v',
          '-map',
          '0:a?',
          '-f',
          'null',
          '-',
        ],
        { signal, timeoutMs: config.encodeTimeoutSeconds * 1000 },
      );
      const after = await stat(await sourcePath(job.source, rt));
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error('Source changed during encoding; output discarded');
      const size = (await stat(temp)).size;
      const savings = (1 - size / before.size) * 100;
      if (size === 0) throw new Error('Empty output');
      if (savings < config.minSavingsPercent)
        throw new SkipError(
          `Output saves ${savings.toFixed(1)}%; minimum is ${config.minSavingsPercent}%`,
        );
      await prepareOutput(output, rt);
      await publish(temp, output, stage, signal);
      store.patch(job.id, {
        status: 'completed',
        progress: 100,
        message: `Saved ${savings.toFixed(1)}% (${before.size - size} bytes)`,
      });
      log('job.completed', { id: job.id, output, savedBytes: before.size - size });
    } catch (error) {
      const message = errorMessage(error);
      if (signal.aborted)
        store.patch(job.id, {
          status: 'queued',
          attempts: Math.max(0, job.attempts - 1),
          progress: 0,
          message: 'Interrupted by shutdown; queued for restart',
          available: Date.now(),
        });
      else if (error instanceof SkipError || (error as NodeJS.ErrnoException).code === 'EEXIST')
        store.patch(job.id, { status: 'skipped', message });
      else if (job.attempts < config.maxAttempts)
        store.patch(job.id, {
          status: 'queued',
          message,
          available: Date.now() + config.retryDelaySeconds * 1000 * 2 ** (job.attempts - 1),
        });
      else store.patch(job.id, { status: 'failed', message });
      log('job.finished', { id: job.id, status: store.get(job.id)?.status, message });
    } finally {
      const results = await Promise.allSettled([
        removeFile(temp),
        ...(outputPrepared && stage ? [removeFile(stage)] : []),
      ]);
      for (const result of results)
        if (result.status === 'rejected')
          log('cleanup.error', { id: job.id, error: errorMessage(result.reason) });
    }
  }
}
