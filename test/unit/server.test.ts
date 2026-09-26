import { test, expect, afterEach } from 'bun:test';
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
import { join } from 'node:path';
import { createApp, webhookPath } from '../../src/server.ts';
import { Store } from '../../src/store.ts';
import { fixture } from '../helpers.ts';

test('normalizes modern and legacy webhook paths and ignores unrelated events', () => {
  expect(webhookPath('sonarr', { eventType: 'Test' })).toEqual({ test: true });
  expect(webhookPath('radarr', { eventType: 'Grab' })).toEqual({});
  expect(
    webhookPath('sonarr', {
      eventType: 'Download',
      series: { path: '/tv/show' },
      episodeFile: { relativePath: 'a.mkv' },
    }),
  ).toEqual({ path: '/tv/show/a.mkv' });
  expect(
    webhookPath('radarr', { eventType: 'Download', movieFile: { path: '/movies/a.mkv' } }),
  ).toEqual({ path: '/movies/a.mkv' });
  expect(() => webhookPath('radarr', { eventType: 'Download' })).toThrow();
});

test('HTTP auth, validation, test events, manual scans, deduplication and job inspection', async () => {
  const f = await fixture();
  cleanups.push(f.cleanup);
  f.rt.apiKey = 'secret';
  const store = new Store(join(f.rt.configDir, 'jobs.sqlite'));
  const app = createApp(f.config, f.rt, store);
  cleanups.push(async () => {
    await app.stop();
    store.close();
  });
  const base = `http://127.0.0.1:${app.server.port}`;
  const post = (path: string, payload: unknown, key = 'secret') =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
  expect((await fetch(base + '/health')).status).toBe(200);
  expect((await fetch(base + '/jobs')).status).toBe(401);
  expect((await post('/sonarr', { eventType: 'Test' })).status).toBe(200);
  expect((await post('/radarr', { eventType: 'Grab' })).status).toBe(204);
  expect((await post('/radarr', { eventType: 'Download' })).status).toBe(400);
  expect((await post('/manual/missing', { path: 'a.mkv' })).status).toBe(400);
  expect((await post('/manual', { path: '../../etc/passwd' })).status).toBe(400);
  expect((await post('/manual', { path: 'a.mkv' }, 'wrong')).status).toBe(401);
  await Bun.write(join(f.rt.dataDir, 'a.mkv'), 'fixture');
  await Bun.write(join(f.rt.dataDir, 'a HEVC.mkv'), 'fixture');
  const response = await post('/manual', { path: '.' });
  expect(response.status).toBe(202);
  const jobs = (await response.json()) as { jobs: { id: string }[] };
  expect(jobs.jobs.length).toBe(1);
  const duplicate = (await (
    await post('/radarr', {
      eventType: 'Download',
      movieFile: { path: join(f.rt.dataDir, 'a.mkv') },
    })
  ).json()) as typeof jobs;
  expect(duplicate.jobs[0]!.id).toBe(jobs.jobs[0]!.id);
  expect(store.list().length).toBe(1);
  expect(
    (
      await fetch(base + '/jobs/' + jobs.jobs[0]!.id, {
        headers: { Authorization: 'Basic ' + Buffer.from('sonarr:secret').toString('base64') },
      })
    ).status,
  ).toBe(200);
  expect((await fetch(base + '/manual/%zz', { method: 'POST' })).status).toBe(400);
  expect((await post('/manual', { path: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413);
  const missing = await post('/sonarr', {
    eventType: 'Download',
    episodeFile: { path: join(f.rt.dataDir, 'later.mkv') },
  });
  expect(missing.status).toBe(202);
});
