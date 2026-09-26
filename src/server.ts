import { createPlan } from './planner.ts';
import { routingConfig } from './paths.ts';
import { timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config, Runtime } from './config.ts';
import { Store, type Submission } from './store.ts';
import { collectFiles, isGenerated, isVideo, mapPath, outputPath, sourcePath } from './paths.ts';
import { errorMessage, HttpError, log, SkipError } from './log.ts';
import { probe } from './media.ts';
import { decide } from './decision.ts';

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function body(req: Request): Promise<unknown> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'Content-Type must be application/json');
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}
function authorize(req: Request, key?: string): void {
  if (!key) return;
  let supplied = req.headers.get('x-api-key');
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) supplied = auth.slice(7);
  else if (auth?.startsWith('Basic ')) {
    try {
      const decoded = atob(auth.slice(6));
      const colon = decoded.indexOf(':');
      supplied = colon < 0 ? '' : decoded.slice(colon + 1);
    } catch {
      supplied = null;
    }
  }
  const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest();
  if (typeof supplied !== 'string' || !timingSafeEqual(hash(supplied), hash(key)))
    throw new HttpError(401, 'Invalid API key');
}
const pathString = z.string().min(1).max(4096);
export function webhookPath(
  kind: 'sonarr' | 'radarr',
  payload: unknown,
): { path?: string; test?: boolean } {
  const event = z.object({ eventType: z.string() }).parse(payload);
  if (event.eventType === 'Test') return { test: true };
  if (event.eventType !== 'Download') return {};
  const fileSchema = z.object({ path: pathString.optional(), relativePath: pathString.optional() });
  if (kind === 'sonarr') {
    const data = z
      .object({ episodeFile: fileSchema, series: z.object({ path: pathString }).optional() })
      .parse(payload);
    if (data.episodeFile.path) return { path: data.episodeFile.path };
    if (data.series && data.episodeFile.relativePath)
      return { path: join(data.series.path, data.episodeFile.relativePath) };
  } else {
    const data = z
      .object({
        movieFile: fileSchema,
        movie: z
          .object({ folderPath: pathString.optional(), path: pathString.optional() })
          .optional(),
      })
      .parse(payload);
    if (data.movieFile.path) return { path: data.movieFile.path };
    const folder = data.movie?.folderPath ?? data.movie?.path;
    if (folder && data.movieFile.relativePath)
      return { path: join(folder, data.movieFile.relativePath) };
  }
  throw new HttpError(400, 'Download event must include a file path');
}
export function createApp(config: Config, rt: Runtime, store: Store) {
  let stopping = false;
  const controller = new AbortController();
  const server = Bun.serve({
    port: rt.port,
    hostname: rt.host,
    maxRequestBodySize: 1024 * 1024,
    idleTimeout: 30,
    async fetch(req) {
      try {
        return await handle(req);
      } catch (error) {
        const status =
          error instanceof HttpError
            ? error.status
            : error instanceof z.ZodError
              ? 400
              : ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
                ? 400
                : 500;
        if (status === 500) log('request.error', { error: errorMessage(error) });
        return json(
          {
            error: status === 500 ? 'Internal server error; see service logs' : errorMessage(error),
          },
          status,
        );
      }
    },
  });
  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'Invalid URL encoding');
    }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      return json(
        { service: 'horadrictube', version: 2, status: stopping ? 'stopping' : 'ok' },
        stopping ? 503 : 200,
      );
    }
    if (stopping) throw new HttpError(503, 'Service is stopping');
    authorize(req, rt.apiKey);
    if (req.method === 'GET' && parts[0] === 'jobs') {
      if (parts.length === 1) {
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(500)
          .parse(url.searchParams.get('limit') ?? 100);
        const offset = z.coerce
          .number()
          .int()
          .min(0)
          .parse(url.searchParams.get('offset') ?? 0);
        return json({ counts: store.counts(), jobs: store.list(limit, offset) });
      }
      if (parts.length === 2) {
        const job = store.get(parts[1]!);
        if (!job) throw new HttpError(404, 'Job not found');
        return json(job);
      }
    }
    if (
      req.method === 'POST' &&
      parts.length === 3 &&
      parts[0] === 'jobs' &&
      parts[2] === 'retry'
    ) {
      return json(store.retry(parts[1]!, config.maxQueuedJobs), 202);
    }
    if (
      req.method !== 'POST' ||
      parts.length > 2 ||
      !['sonarr', 'radarr', 'manual', 'plan'].includes(parts[0] ?? '')
    )
      throw new HttpError(404, 'Route not found');
    const kind = parts[0]!;
    const profile = parts[1] ?? (config.ai.enabled ? 'auto' : config.defaultProfile);
    if (profile === 'skip') {
      return new Response(null, { status: 204 });
    }
    if (profile !== 'auto' && !Object.hasOwn(config.profiles, profile))
      throw new HttpError(400, `Unknown profile: ${profile}`);
    const routeConfig = routingConfig(config, profile);
    const payload = await body(req);
    let input: string;
    if (kind === 'sonarr' || kind === 'radarr') {
      const event = webhookPath(kind, payload);
      if (event.test) {
        return json({ success: true });
      }
      if (!event.path) {
        return new Response(null, { status: 204 });
      }
      input = event.path;
    } else input = z.object({ path: pathString }).parse(payload).path;
    if (kind === 'plan') {
      const path = mapPath(input, routeConfig, rt);
      const actual = await sourcePath(path, rt);
      if (!(await stat(actual)).isFile()) throw new HttpError(400, 'Plan requires a regular file');
      const media = await probe(actual, rt, controller.signal);
      const decision = await decide(profile, media, config, rt, controller.signal);
      try {
        if (isGenerated(path, config.suffix)) throw new SkipError('Generated companion');
        const plan = await createPlan(
          media,
          config.profiles[decision.profile]!,
          config,
          actual,
          '<temporary-output.mkv>',
          rt,
          controller.signal,
        );
        return json({
          source: path,
          output: outputPath(path, config, rt, config.profiles[decision.profile]),
          decision,
          ffmpeg: plan.args,
          toneMapBackend: plan.hdr ? rt.toneMapBackend : null,
          dolbyVision: plan.dolbyVision,
          note: 'Preview only. Publication also requires successful validation and minimum savings.',
        });
      } catch (error) {
        if (!(error instanceof SkipError)) throw error;
        return json({ skipped: true, reason: error.message, decision });
      }
    }
    // Webhooks are persisted even if the file has not become visible in this container yet.
    const paths =
      kind === 'manual'
        ? await collectFiles(input, routeConfig, rt)
        : [mapPath(input, routeConfig, rt)];
    const submissions: Submission[] = [];
    let ignored = 0;
    for (const path of paths) {
      if (!isVideo(path) || isGenerated(path, config.suffix)) {
        ignored++;
        continue;
      }
      let fingerprint = 'not-yet-visible';
      try {
        const info = await stat(await sourcePath(path, rt));
        if (!info.isFile()) {
          ignored++;
          continue;
        }
        fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      submissions.push({
        source: path,
        profile,
        fingerprint,
        delaySeconds:
          config.profiles[profile === 'auto' ? config.defaultProfile : profile]!.delaySeconds,
      });
    }
    const jobs = store.enqueueMany(submissions, config.maxQueuedJobs);
    return json({ jobs: jobs.map(({ id, status }) => ({ id, status })), ignored }, 202);
  }
  return {
    server,
    stop() {
      stopping = true;
      controller.abort();
      return server.stop(false);
    },
  };
}
